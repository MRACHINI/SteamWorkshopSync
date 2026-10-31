import { decrypt, encrypt } from './crypto.js';
import {
  type Account, STUCK, addEvent, addEventOnce, getAccount, getInternal, getSettings, numSetting, q, setInternal, updateAccount,
} from './db.js';
import {
  type PendingWrite, failJobWrites, getAccountApp, hasPendingMissing, isPresent, pendingJobWrites, pendingSyncWrites, presentSet,
  recordFullRead, recordQuickRead, recordVerified, recordWrite, relevantApps, settleMainRemovals, shortList, writeStillWanted,
} from './groups.js';
import { errMsg, log } from './log.js';
import { flushUrgentNotifications, note } from './notify.js';
import {
  PAGE_SIZE, SteamError, type SubItem, type SubsPage, type Tokens, fetchSubsPage, jwtExpiresAt, jwtExpiresIn,
  loginWithPassword, profileBase, refreshCookies, setSubscription,
} from './steam.js';
import { enqueue, render } from './telegram.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Errors about the login/session itself; nothing else can run for the account this round.
const SESSION_ERRORS = new Set(['bad_credentials', 'needs_guard', 'needs_signin', 'rate_limited', 'login_throttled', 'token_invalid', 'token_suspect', 'not_logged_in']);
/** A quick check reads at most this many pages of new items before reading the whole list instead. */
const QUICK_MAX_PAGES = 5;
/** An item missing from a full read is confirmed by another full read this much later. */
const CONFIRM_DELAY = 2 * MIN;
const PAGE_GAP_MS = 600;
const PAGE_RETRY_MS = 3000;
/** Subscribes showed up on the list within seconds in testing; this leaves Steam a moment before checking. */
const VERIFY_DELAY_MS = 2000;
/** The list loaded to prove a sign-in works for an account that is in no group yet (any game would do). */
const PROBE_APPID = 730;
/** A saved sign-in that keeps failing to renew in an unclear way counts as dead after this many failed runs in a row. */
const TOKEN_SUSPECT_FAILS = 10;
/** With a stored password, the sign-in is renewed this long before it runs out, and tried again this often. */
const EARLY_RENEWAL = 3 * DAY;
const EARLY_RENEWAL_GAP = 6 * HOUR;
/** After this many network errors in a row, a batch of writes stops: Steam is down, not one item. */
const OUTAGE_WRITES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pause saved before a restart, capped in case the clock stepped since. */
const savedPause = (key: string) => Math.min(Number(getInternal(`pause_${key}`)) || 0, Date.now() + 2 * HOUR);

export const syncState = {
  /** Steam answered 429: only explicitly requested accounts run until then. */
  pausedUntil: savedPause('pausedUntil'),
  /** Steam is throttling password logins from this IP. */
  loginPausedUntil: savedPause('loginPausedUntil'),
  loginPauseMs: Number(getInternal('pause_loginPauseMs')) || 0,
  /** Steam throttled a write: no writes until then. */
  writePausedUntil: savedPause('writePausedUntil'),
  /** Last sign of life from the sync, for the health check. */
  lastBeatAt: Date.now(),
};

function savePauses(): void {
  for (const key of ['pausedUntil', 'loginPausedUntil', 'loginPauseMs', 'writePausedUntil'] as const) setInternal(`pause_${key}`, String(syncState[key]));
}

// Timestamps of the writes in the last hour, for the hourly cap. Survives a restart through write_log.
const writeTimes: number[] = (q('SELECT minute, n FROM write_log WHERE minute >= ? ORDER BY minute').all(Math.floor((Date.now() - HOUR) / MIN)) as
  { minute: number; n: number }[]).flatMap((r) => Array<number>(r.n).fill(r.minute * MIN));

function countWrite(now: number): void {
  writeTimes.push(now);
  q('INSERT INTO write_log (minute, n) VALUES (?, 1) ON CONFLICT(minute) DO UPDATE SET n = n + 1').run(Math.floor(now / MIN));
}

export function writesLastHour(now = Date.now()): number {
  while (writeTimes.length && writeTimes[0] <= now - HOUR) writeTimes.shift();
  return writeTimes.length;
}

/** When the hourly cap next allows a write (now, if it already does). */
export function writeCapFreeAt(now = Date.now()): number {
  const cap = numSetting('writes_per_hour', 1, 1_000_000);
  if (writesLastHour(now) < cap) return now;
  return writeTimes[writeTimes.length - cap] + HOUR;
}

/** True when writes may run at all right now (no throttle pause, hourly cap not reached). */
export function writesAllowed(now = Date.now()): boolean {
  return now >= syncState.writePausedUntil && writeCapFreeAt(now) <= now;
}

// ---------------------------------------------------------------------------
// Password logins: serialized and spaced out, and paused while Steam throttles them
// ---------------------------------------------------------------------------
let loginChain: Promise<unknown> = Promise.resolve();

function queuedLogin(username: string, password: string): Promise<Tokens> {
  const gap = numSetting('login_gap_seconds', 0, 600) * 1000;
  const run = loginChain.then(() => {
    if (Date.now() < syncState.loginPausedUntil) throw throttledError();
    return loginWithPassword(username, password);
  });
  loginChain = run.then(() => sleep(gap), () => sleep(gap));
  return run;
}

const throttledError = () => new SteamError('login_throttled',
  `Steam is throttling logins; password logins wait until ${new Date(syncState.loginPausedUntil).toISOString().slice(11, 16)} UTC`);

function noteLoginThrottle(): void {
  // 30 min, then doubling up to 2 h while Steam keeps refusing; reset by the next successful login.
  syncState.loginPauseMs = syncState.loginPauseMs ? Math.min(2 * HOUR, syncState.loginPauseMs * 2) : 30 * MIN;
  syncState.loginPausedUntil = Date.now() + syncState.loginPauseMs;
  savePauses();
  log.warn(`Steam is throttling logins: password logins paused for ${syncState.loginPauseMs / MIN} min`);
  addEvent(null, 'problem', `Steam is throttling logins: password logins paused for ${syncState.loginPauseMs / MIN} min`, true);
}

// When each account last tried its early renewal. Losing this on a restart costs one extra attempt.
const earlyRenewalAt = new Map<number, number>();
// Runs in a row that ended on an unclear renewal failure. Not fail_count: an outage of any kind raises that.
export const tokenSuspects = new Map<number, number>();

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------
export interface Task {
  /** Read the account's subscription lists. */
  check: boolean;
  /** Read every list in full (explicit "Check now"). */
  full: boolean;
  /** Writes may run (no throttle pause, hourly cap not reached). */
  writes: boolean;
  /** Explicitly requested: runs through a rate-limit pause. */
  forced: boolean;
}

interface Ctx {
  acc: Account;
  page: (appid: number, page: number) => Promise<SubsPage>;
  /** The next page starts from the profile's permanent address, which also shows if its custom URL changed. */
  useCanonicalBase: () => void;
  write: (w: PendingWrite) => ReturnType<typeof setSubscription>;
}

export async function runAccount(id: number, task: Task): Promise<void> {
  let acc = getAccount(id);
  if (!acc || !acc.enabled) return;
  const timeoutMs = numSetting('request_timeout_seconds', 5, 120) * 1000;
  const reload = () => (acc = getAccount(id)!);
  let phase: 'login' | 'read' | 'write' = 'login';

  try {
    let refreshToken = decrypt(acc.refresh_token_enc);
    let cookies = decrypt(acc.cookies_enc);
    const password = decrypt(acc.password_enc);

    const login = async () => {
      if (!password) {
        throw new SteamError('needs_signin', refreshToken
          ? 'The saved Steam sign-in no longer works. Sign in again from the web UI.'
          : 'Not signed in yet. Sign in from the web UI.');
      }
      if (Date.now() < syncState.loginPausedUntil) throw throttledError();
      log.info(`${acc!.username}: logging in with password`);
      let tokens: Tokens;
      try {
        tokens = await queuedLogin(acc!.username, password);
      } catch (e) {
        if (e instanceof SteamError && e.kind === 'login_throttled' && Date.now() >= syncState.loginPausedUntil) noteLoginThrottle();
        throw e;
      }
      syncState.loginPauseMs = 0;
      refreshToken = tokens.refreshToken;
      cookies = null;
      updateAccount(id, {
        steamid: tokens.steamid, refresh_token_enc: encrypt(tokens.refreshToken), cookies_enc: null,
        token_expires_at: jwtExpiresAt(tokens.refreshToken), token_warned: 0, interactive: 0,
      });
      addEvent(acc!, 'login', 'Logged in with password');
      reload();
    };
    const saveRotated = (token: string) => {
      // A sign-in from the web UI during this run is newer than anything this run holds.
      if (decrypt(getAccount(id)?.refresh_token_enc ?? null) !== refreshToken) return;
      refreshToken = token;
      updateAccount(id, { refresh_token_enc: encrypt(token), token_expires_at: jwtExpiresAt(token), token_warned: 0 });
      log.info(`${acc!.username}: Steam renewed the saved sign-in`);
    };
    const renewCookies = async () => {
      const r = await refreshCookies({ steamid: acc!.steamid!, refreshToken: refreshToken! }, timeoutMs, saveRotated);
      cookies = r.cookies;
      tokenSuspects.delete(id);
      updateAccount(id, { cookies_enc: encrypt(r.cookies) });
    };
    const cookiesFresh = () => {
      const jwt = cookies?.match(/steamLoginSecure=\d+%7C%7C([^;]+)/)?.[1];
      return !!jwt && jwtExpiresIn(jwt) > 10 * MIN;
    };

    const left = refreshToken ? jwtExpiresIn(refreshToken) : 0;
    if (!refreshToken || !acc.steamid || left <= 0) {
      await login();
    } else if (password && !acc.interactive && left < EARLY_RENEWAL && Date.now() - (earlyRenewalAt.get(id) ?? 0) > EARLY_RENEWAL_GAP) {
      // A courtesy while the sign-in still works, so failing it must not stop the account. Accounts that need
      // Steam Guard cannot renew unattended: they are warned instead and used until the sign-in runs out.
      earlyRenewalAt.set(id, Date.now());
      await login().catch((e) => {
        if (e instanceof SteamError && e.kind === 'needs_guard') updateAccount(id, { interactive: 1 });
        reload();
        log.warn(`${acc!.username}: early renewal of the sign-in failed: ${errMsg(e)}`);
        addEventOnce(acc!, 'problem', `Early renewal of the sign-in failed: ${errMsg(e)}`, DAY);
      });
    }

    // Retries a request while renewing the session.
    const withSession = async <T>(fn: () => Promise<T>): Promise<T> => {
      let retried = false;
      for (let attempt = 0; ; attempt++) {
        try {
          if (!cookiesFresh()) await renewCookies();
          return await fn();
        } catch (e) {
          if (!(e instanceof SteamError) || attempt >= 3) throw e;
          if (e.kind === 'not_logged_in') cookies = null;
          else if (e.kind === 'token_invalid' || (e.kind === 'token_suspect' && (tokenSuspects.get(id) ?? 0) >= TOKEN_SUSPECT_FAILS)) await login();
          else if ((e.kind === 'temporary' || e.kind === 'token_suspect') && !retried) {
            // Steam serves a half-rendered page now and then; one quiet retry avoids a pointless problem entry.
            retried = true;
            log.info(`${acc!.username}: ${errMsg(e)} - retrying once`);
            await sleep(3000);
          } else throw e;
        }
      }
    };

    let base = acc.profile_url || profileBase(acc.steamid!);
    const ctx: Ctx = {
      acc,
      page: async (appid, p) => {
        const r = await withSession(() => fetchSubsPage(acc!.steamid!, base, appid, p, cookies!, timeoutMs));
        syncState.lastBeatAt = Date.now();
        if (r.base !== base) {
          base = r.base;
          updateAccount(id, { profile_url: base });
        }
        return r.page;
      },
      useCanonicalBase: () => {
        base = profileBase(acc!.steamid!);
      },
      write: (w) => withSession(() => setSubscription(w.action, w, cookies!, timeoutMs)),
    };

    // A page problem with one game must not keep the account's other games and writes from running.
    let readError: unknown = null;
    if (task.check) {
      phase = 'read';
      const apps = relevantApps(id);
      const interval = numSetting('check_interval_seconds', 60, 7 * 86400) * 1000;
      let next = interval;
      if (!apps.length) {
        // Not in any group yet: one page proves the sign-in works.
        await ctx.page(PROBE_APPID, 1);
      }
      for (const appid of apps) {
        try {
          const r = await checkApp(ctx, appid, task.full);
          if (r === 'confirm') next = Math.min(next, CONFIRM_DELAY);
        } catch (e) {
          if (!(e instanceof SteamError) || e.kind !== 'temporary') throw e;
          readError ??= e;
          log.warn(`${acc.username}: app ${appid}: ${errMsg(e)}`);
        }
      }
      if (acc.is_main) settleMainRemovals();
      updateAccount(id, { ...(readError ? {} : { last_check_at: Date.now() }), next_check_at: Date.now() + next });
    }
    if (task.writes) {
      phase = 'write';
      try {
        await runWrites(ctx);
      } catch (e) {
        // With a failed read to report too, that one goes first: it is what the account's next check depends on.
        if (!readError || !(e instanceof SteamError) || e.kind !== 'temporary') throw e;
      }
    }
    if (readError) {
      phase = 'read';
      throw readError;
    }

    reload();
    // Only a read proves the account works: a run of writes alone must not wipe the record of a failing read.
    // An account in no group is never read again, so there its writes are all the proof there will be.
    if (task.check || !relevantApps(id).length) {
      if (acc.status !== 'ok') log.info(`${acc.username}: OK`);
      updateAccount(id, { status: 'ok', status_msg: '', fail_count: 0, next_attempt_at: 0, problem_notified: 0, last_ok_at: Date.now() });
      reload();
    }
    warnTokenExpiry(acc);
  } catch (e) {
    reload();
    handleFailure(acc, e, phase);
  } finally {
    if (acc.is_main) flushUrgentNotifications();
  }
}

/**
 * Reads one game's list. Usually one page: new subscriptions are listed first, and the total tells whether
 * anything disappeared. Only when the numbers do not add up (or a daily full read is due) is every page read.
 * Returns 'confirm' when a missing item needs a confirming read soon. A list that suddenly lost most of
 * itself is confirmed at the normal interval instead, in case Steam is having a bad moment.
 */
async function checkApp(ctx: Ctx, appid: number, forceFull: boolean): Promise<'ok' | 'confirm'> {
  const { acc } = ctx;
  const st = getAccountApp(acc.id, appid);
  const fullEvery = numSetting('full_read_hours', 1, 24 * 30) * HOUR;
  let full = forceFull || !st.initialized || !!st.full_due || hasPendingMissing(acc.id, appid) || Date.now() - st.last_full_at >= fullEvery;
  if (!full) {
    const known = presentSet(acc.id, appid);
    const fresh = new Map<string, SubItem>();
    let total = 0;
    for (let p = 1; ; p++) {
      const page = await ctx.page(appid, p);
      if (p === 1) total = page.total ?? 0;
      // A short page is a job for the full read, unless this list is known to be short anyway.
      if (page.short && !st.short_by) {
        full = true;
        break;
      }
      const unknown = page.items.filter((i) => !known.has(i.id));
      for (const i of unknown) fresh.set(i.id, i);
      // Newest first: once a page shows an item already known, the rest is known too.
      if (unknown.length < page.items.length || !page.items.length || page.to >= total) break;
      if (p >= QUICK_MAX_PAGES) {
        full = true;
        break;
      }
      await sleep(PAGE_GAP_MS);
    }
    if (!full && total === st.last_total + fresh.size) {
      recordQuickRead(acc, appid, [...fresh.values()], total);
      return 'ok';
    }
    if (!full) log.info(`${acc.username}: app ${appid} lists ${total} subscription(s), expected ${st.last_total + fresh.size}; reading the whole list`);
  }
  ctx.useCanonicalBase();
  const { items, total } = await readAll(ctx, appid);
  const r = recordFullRead(acc, appid, items, total);
  if (r.pending) {
    log.info(`${acc.username}: ${r.pending} item(s) missing from app ${appid}; confirming with another read` +
      `${r.suspicious ? ' at the normal interval (most of the list vanished at once)' : ''}`);
  }
  return r.pending && !r.suspicious ? 'confirm' : 'ok';
}

/**
 * Every page of one game's list. A list that changes while it is read is read again later. A list can also
 * count items it never shows: a small shortfall that is exactly the same on the next read is taken as that,
 * since refusing it for good would stop the whole list.
 */
async function readAll(ctx: Ctx, appid: number): Promise<{ items: SubItem[]; total: number }> {
  const seen = new Map<string, SubItem>();
  const before = getAccountApp(ctx.acc.id, appid).short_by;
  let total = 0;
  for (let p = 1; ; p++) {
    let page = await ctx.page(appid, p);
    if (page.short && !before) {
      // Steam serves a half-rendered page now and then, and the next load gets it right.
      await sleep(PAGE_RETRY_MS);
      page = await ctx.page(appid, p);
    }
    if (p === 1) total = page.total ?? 0;
    else if (page.total !== null && page.total !== total) {
      throw new SteamError('temporary', `The list of app ${appid} changed while it was read (${total} -> ${page.total} subscriptions)`);
    }
    for (const i of page.items) seen.set(i.id, i);
    if (!page.items.length || page.to >= total || p > Math.ceil(total / PAGE_SIZE)) break;
    await sleep(PAGE_GAP_MS);
  }
  const shortBy = total - seen.size;
  const small = shortBy > 0 && shortBy <= Math.max(3, Math.ceil(total / 100));
  if (shortBy !== before) q('UPDATE account_apps SET short_by = ? WHERE account_id = ? AND appid = ?').run(small ? shortBy : 0, ctx.acc.id, appid);
  if (shortBy !== 0 && !(small && shortBy === before)) {
    throw new SteamError('temporary', `Read ${seen.size} of ${total} subscriptions of app ${appid}; reading again later`);
  }
  if (shortBy) addEventOnce(ctx.acc, 'lost', `App ${appid}: Steam counts ${shortBy} subscription(s) it does not list`, DAY);
  return { items: [...seen.values()], total };
}

/** Pending job items first, then what the groups need, paced and capped. */
async function runWrites(ctx: Ctx): Promise<void> {
  const { acc } = ctx;
  if (!writesAllowed()) return;
  const perRun = numSetting('writes_per_run', 1, 1000);
  const gap = numSetting('write_gap_ms', 0, 60_000);
  const now = Date.now();
  const list = pendingJobWrites(acc.id, now, perRun);
  if (list.length < perRun) {
    // An item leaving the group through a job is also wanted gone by the group: one write does for both.
    const queued = new Set(list.map((w) => w.id));
    list.push(...pendingSyncWrites(acc.id, now, perRun - list.length).filter((w) => !queued.has(w.id)));
  }
  if (!list.length) return;

  const done = { subscribe: 0, unsubscribe: 0 };
  const failed: string[] = [];
  const subscribed = new Map<number, PendingWrite[]>();
  let reapplied: PendingWrite[] = [];
  let outage = 0;
  let networkError: SteamError | null = null;
  try {
    for (const [i, w] of list.entries()) {
      if (!writesAllowed()) break;
      if (i && gap) await sleep(gap);
      if (!writeStillWanted(acc.id, w)) continue;
      const wasPresent = isPresent(acc.id, w.id);
      let result;
      try {
        result = await ctx.write(w);
        outage = 0;
      } catch (e) {
        // A network error or 5xx on one item gets that item's back-off; it must not block the others.
        if (!(e instanceof SteamError) || e.kind !== 'temporary') throw e;
        networkError = e;
        outage++;
        result = { outcome: 'network' as const, code: '', message: errMsg(e) };
      }
      syncState.lastBeatAt = Date.now();
      countWrite(syncState.lastBeatAt);
      if (recordWrite(acc, w, result.outcome, result.message)) reapplied.push(w);
      if (result.outcome === 'ok') {
        done[w.action]++;
        if (w.action === 'subscribe' && !wasPresent) subscribed.set(w.appid, [...(subscribed.get(w.appid) ?? []), w]);
      } else {
        failed.push(`${w.title || w.id}: ${result.message}`);
      }
      if (outage >= OUTAGE_WRITES) break;
    }
    // Steam has answered OK for items that then never showed up: check the subscribes on the list itself.
    for (const [appid, ws] of subscribed) {
      const missing = await verifySubscribes(ctx, appid, ws.map((w) => w.id));
      if (missing.length) {
        const notListed = ws.filter((w) => missing.includes(w.id));
        failJobWrites(acc.id, notListed, 'Steam accepted the subscription, but the item did not show up in the list');
        failed.push(...notListed.map((w) => `${w.title || w.id}: accepted by Steam but not on the list`));
        reapplied = reapplied.filter((w) => !missing.includes(w.id));
        done.subscribe -= missing.length;
      }
    }
    if (outage >= OUTAGE_WRITES) throw networkError;
  } finally {
    const parts = [];
    if (done.subscribe) parts.push(`subscribed ${done.subscribe}`);
    if (done.unsubscribe) parts.push(`unsubscribed ${done.unsubscribe}`);
    if (parts.length) addEvent(acc, 'write', `${parts.join(', ')} item(s)`);
    if (failed.length) addEvent(acc, 'write_failed', `${failed.length} write(s) failed: ${shortList(failed, 5)}`);
    const byGroup = new Map<number, string[]>();
    for (const w of reapplied) {
      for (const g of q(`SELECT gi.group_id FROM group_items gi JOIN group_members gm ON gm.group_id = gi.group_id AND gm.account_id = ?
                         JOIN groups g ON g.id = gi.group_id AND g.state = 'active'
                         WHERE gi.item_id = ? AND gi.state = 'active'`).all(acc.id, w.id) as { group_id: number }[]) {
        byGroup.set(g.group_id, [...(byGroup.get(g.group_id) ?? []), w.title || w.id]);
      }
    }
    for (const [groupId, labels] of byGroup) {
      addEvent(acc, 'reapplied', `${labels.length} item(s) subscribed again: ${shortList(labels)}`);
      note('reapplied', groupId, acc.username, labels);
    }
    // More left (batch size or hourly cap): the scheduler picks the account up again.
    const freeAt = writeCapFreeAt();
    updateAccount(acc.id, { write_next_at: freeAt > Date.now() ? freeAt : 0 });
  }
}

/**
 * Reads the newest page(s) of a list right after subscribing, where new subscriptions are listed first.
 * Anything not found there is looked for in the whole list before it counts as missing. Returns the
 * subscribes that did not show up (recorded as failed writes).
 */
async function verifySubscribes(ctx: Ctx, appid: number, ids: string[]): Promise<string[]> {
  await sleep(VERIFY_DELAY_MS);
  const seen = new Set<string>();
  const pages = Math.min(6, Math.ceil(ids.length / PAGE_SIZE) + 1);
  let wholeList = false;
  for (let p = 1; p <= pages; p++) {
    const page = await ctx.page(appid, p);
    for (const i of page.items) seen.add(i.id);
    if (ids.every((id) => seen.has(id))) break;
    if (!page.items.length || page.to >= (page.total ?? 0)) {
      wholeList = true;
      break;
    }
    await sleep(PAGE_GAP_MS);
  }
  if (!wholeList && !ids.every((id) => seen.has(id))) {
    for (const i of (await readAll(ctx, appid)).items) seen.add(i.id);
  }
  const missing = recordVerified(ctx.acc, appid, ids, seen);
  if (missing.length) log.warn(`${ctx.acc.username}: ${missing.length} subscribe(s) accepted by Steam but not on the list of app ${appid}`);
  return missing;
}

/** Records a failed run. Credential problems park the account until the admin fixes it. */
function handleFailure(acc: Account, e: unknown, phase: 'login' | 'read' | 'write'): void {
  const s = getSettings();
  const kind = e instanceof SteamError ? e.kind : 'temporary';
  const now = Date.now();
  if (kind === 'login_throttled' && now >= syncState.loginPausedUntil) noteLoginThrottle();
  if (kind === 'token_suspect') tokenSuspects.set(acc.id, (tokenSuspects.get(acc.id) ?? 0) + 1);
  let fails = acc.fail_count + 1;
  let status = 'error';
  let backoff = Math.min(15 * MIN, MIN * 2 ** Math.min(fails - 1, 4));

  if (kind === 'bad_credentials') {
    status = kind;
    backoff = 0;
  } else if (kind === 'needs_guard' || kind === 'needs_signin') {
    status = 'needs_signin';
    backoff = 0;
  } else if (kind === 'login_throttled') {
    // Not the account's fault: waits for the pause without counting as a failure.
    status = 'login_wait';
    fails = acc.fail_count;
    backoff = Math.max(MIN, syncState.loginPausedUntil - now);
  } else if (kind === 'rate_limited') {
    status = 'rate_limited';
    backoff = Math.max(backoff, 5 * MIN);
    syncState.pausedUntil = Math.max(syncState.pausedUntil, now + 2 * MIN);
    if (phase === 'write') syncState.writePausedUntil = Math.max(syncState.writePausedUntil, now + 10 * MIN);
    savePauses();
  }

  log.warn(`${acc.username}: ${status} - ${errMsg(e)}${backoff ? ` (retry in ${Math.round(backoff / 1000)}s)` : ''}`);
  if (status !== acc.status) addEventOnce(acc, 'problem', `${status}: ${errMsg(e)}`);

  // Tell Telegram once per incident: immediately for credential problems, after sustained failure otherwise.
  let notified = acc.problem_notified;
  if (!notified && s.notify_account_problems === '1' && (STUCK.has(status) || fails >= 10)) {
    enqueue(render(s.template_problem, { account: acc.username, message: `${status}: ${errMsg(e)}` }));
    notified = 1;
  }
  updateAccount(acc.id, {
    status, status_msg: errMsg(e), fail_count: fails, next_attempt_at: backoff ? now + backoff : 0, problem_notified: notified,
    // A broken session also delays the next check, so the account is not hammered.
    ...(SESSION_ERRORS.has(kind) && backoff ? { next_check_at: Math.max(acc.next_check_at, now + backoff) } : {}),
    // A read that failed for a passing reason is tried again on the back-off, not a full interval later.
    ...(kind === 'temporary' && phase === 'read' && backoff ? { next_check_at: now + backoff } : {}),
  });
}

/** A sign-in that cannot renew itself unattended gets one warning before it expires. */
function warnTokenExpiry(acc: Account): void {
  if (!acc.token_expires_at || acc.token_warned) return;
  if (acc.password_enc && !acc.interactive) return; // renewed with the password before it runs out
  const days = numSetting('token_warn_days', 1, 180);
  if (acc.token_expires_at - Date.now() > days * DAY) return;
  const msg = `The saved Steam sign-in expires on ${new Date(acc.token_expires_at).toISOString().slice(0, 10)}. ` +
    'Sign this account in again from the web UI before then.';
  addEvent(acc, 'token_expiring', msg, true);
  const s = getSettings();
  if (s.notify_account_problems === '1') enqueue(render(s.template_problem, { account: acc.username, message: msg }));
  updateAccount(acc.id, { token_warned: 1 });
}
