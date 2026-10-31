import { type Account, STUCK, listAccounts, numSetting, pruneHistory } from './db.js';
import { completeRemovals, hasPendingWrites, progressStarts, refreshCollections, refreshDetails, relevantApps, settleMainRemovals } from './groups.js';
import { finishJobs } from './jobs.js';
import { errMsg, log } from './log.js';
import { flushNotifications } from './notify.js';
import { type Task, runAccount, syncState, writeCapFreeAt, writesAllowed } from './sync.js';
import { flush } from './telegram.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The loop never sleeps longer than this, so housekeeping (group starts, removals, jobs) stays prompt. */
const MAX_SLEEP = MIN;

export const scanState = {
  running: false,
  lastCycleAt: 0,
  lastCycleMs: 0,
  cycles: 0,
};

let wake: (() => void) | null = null;
// Set when something asks for a run while a cycle is in progress (wake only exists between cycles).
let wakePending = false;
const nudge = () => {
  if (wake) wake();
  else wakePending = true;
};
// Explicit per-account checks (true = full read): run even while backing off, but never for an account
// parked with a known-bad password or no sign-in: that needs the admin, and a login would only fail again.
const forced = new Map<number, boolean>();
// "Check all now": skip back-off and the rate-limit pause, but leave parked accounts parked.
let forceAll = false;

export function requestCheck(id?: number, full = true): void {
  if (id !== undefined) forced.set(id, full || (forced.get(id) ?? false));
  else forceAll = true;
  nudge();
}

/** Start the next cycle now; accounts are picked with the normal rules. */
export function wakeScheduler(): void {
  nudge();
}

/**
 * A timestamp written by a previous run is meaningless once the clock steps backwards (host resume, NTP),
 * so anything impossibly far ahead counts as "due now" rather than freezing the account.
 */
const sane = (ts: number | null, now: number, maxAhead: number) => (ts == null || ts > now + maxAhead ? 0 : ts);

const checkInterval = () => numSetting('check_interval_seconds', 60, 7 * 86400) * 1000;

/** What an account is due for right now, if anything. */
function taskFor(a: Account, now: number): Task | null {
  if (!a.enabled) return null;
  if (STUCK.has(a.status)) return null;
  const force = forced.has(a.id);
  if (!force && !forceAll && sane(a.next_attempt_at, now, 3 * HOUR) > now) return null;
  if (!force && !forceAll && now < syncState.pausedUntil) return null;
  // Accounts in no group are only read once, to prove the sign-in works.
  const readable = relevantApps(a.id).length > 0 || a.last_check_at == null;
  const check = force || (readable && (forceAll || sane(a.next_check_at, now, checkInterval() + DAY) <= now));
  const writes = writesAllowed(now) && sane(a.write_next_at, now, 2 * HOUR) <= now;
  if (!check && !(writes && hasPendingWrites(a.id, now))) return null;
  return { check, full: forced.get(a.id) ?? false, writes, forced: force || forceAll };
}

/** When the next piece of work is due, so the sleep below matches what cycle() will pick up. */
function nextDueAt(now: number): number {
  let soonest = Infinity;
  const writeFree = Math.max(syncState.writePausedUntil, writeCapFreeAt(now));
  for (const a of listAccounts()) {
    if (!a.enabled || STUCK.has(a.status)) continue;
    const attempt = Math.max(sane(a.next_attempt_at, now, 3 * HOUR), syncState.pausedUntil);
    if (relevantApps(a.id).length || a.last_check_at == null) {
      soonest = Math.min(soonest, Math.max(attempt, sane(a.next_check_at, now, checkInterval() + DAY)));
    }
    if (hasPendingWrites(a.id, now)) soonest = Math.min(soonest, Math.max(attempt, writeFree, sane(a.write_next_at, now, 2 * HOUR)));
  }
  return soonest;
}

/** Free-API and database chores that need no account session. */
async function housekeeping(): Promise<void> {
  settleMainRemovals(); // anything a crash left undecided
  progressStarts();
  completeRemovals();
  finishJobs();
  const timeoutMs = numSetting('request_timeout_seconds', 5, 120) * 1000;
  await refreshDetails(timeoutMs);
  await refreshCollections(timeoutMs);
}

export async function cycle(): Promise<void> {
  const now = Date.now();
  await housekeeping();
  const queue: { id: number; task: Task }[] = [];
  for (const a of listAccounts()) {
    const task = taskFor(a, now);
    if (task) queue.push({ id: a.id, task });
  }
  forced.clear();
  forceAll = false;

  if (queue.length) {
    scanState.running = true;
    const workers = Math.min(queue.length, numSetting('concurrency', 1, 16));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          // Steam asked for less while this account waited in the queue.
          if (!item.task.forced && Date.now() < syncState.pausedUntil) continue;
          await runAccount(item.id, item.task).catch((e) => log.error(`account run crashed: ${errMsg(e)}`));
          syncState.lastBeatAt = Date.now();
          await new Promise((r) => setTimeout(r, 150 + Math.random() * 350)); // small jitter between accounts
        }
      }),
    );
    scanState.running = false;
  }
  // Reads may have finished a group's first scan or a removal: settle them in the same cycle.
  progressStarts();
  completeRemovals();
  finishJobs();
  flushNotifications();
  scanState.lastCycleAt = Date.now();
  scanState.lastCycleMs = scanState.lastCycleAt - now;
  scanState.cycles++;
}

export async function runScheduler(): Promise<never> {
  let lastPrune = 0;
  for (;;) {
    const started = Date.now();
    syncState.lastBeatAt = started;
    try {
      await cycle();
      await flush();
      if (started - lastPrune > HOUR) {
        pruneHistory(numSetting('history_retention_days', 1, 3650));
        lastPrune = started;
      }
    } catch (e) {
      scanState.running = false;
      log.error(`cycle failed: ${errMsg(e)}`);
    }
    if (wakePending) {
      wakePending = false; // something was requested while the cycle ran: start the next one at once
      continue;
    }
    let due = Infinity;
    try {
      due = nextDueAt(Date.now());
    } catch (e) {
      log.error(`could not work out the next run: ${errMsg(e)}`);
    }
    const wait = Math.min(MAX_SLEEP, Math.max(1000, due - Date.now()));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  }
}
