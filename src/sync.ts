import { decrypt, encrypt } from './crypto.js';
import { type Account, STUCK, addEvent, addEventOnce, getAccount, getSettings, numSetting, q, updateAccount } from './db.js';
import {
  type PendingWrite, getAccountApp, hasPendingMissing, pendingJobWrites, pendingSyncWrites, presentSet,
  recordFullRead, recordQuickRead, recordVerified, recordWrite, relevantApps, shortList,
} from './groups.js';
import { errMsg, log } from './log.js';
import { note } from './notify.js';
import {
  PAGE_SIZE, SteamError, type SubItem, type SubsPage, type Tokens, fetchSubsPage, jwtExpiresAt, jwtExpiresIn,
  loginWithPassword, profileBase, refreshCookies, setSubscription,
} from './steam.js';
import { enqueue, render } from './telegram.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Errors about the login/session itself; nothing else can run for the account this round.
const SESSION_ERRORS = new Set(['bad_credentials', 'needs_guard', 'needs_signin', 'rate_limited', 'login_throttled', 'token_invalid', 'not_logged_in']);
/** A quick check reads at most this many pages of new items before reading the whole list instead. */
const QUICK_MAX_PAGES = 5;
/** An item missing from a full read is confirmed by another full read this much later. */
const CONFIRM_DELAY = 2 * MIN;
const PAGE_GAP_MS = 600;
/** Subscribes showed up on the list within seconds in testing; this leaves Steam a moment before checking. */
const VERIFY_DELAY_MS = 2000;
/** The list loaded to prove a sign-in works for an account that is in no group yet (any game would do). */
const PROBE_APPID = 730;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const syncState = {
  /** Steam answered 429: only explicitly requested accounts run until then. */
  pausedUntil: 0,
  /** Steam is throttling password logins from this IP. */
  loginPausedUntil: 0,
  loginPauseMs: 0,
  /** Steam throttled a write: no writes until then. */
  writePausedUntil: 0,
};

// Timestamps of the writes in the last hour, for the hourly cap.
const writeTimes: number[] = [];

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
  log.warn(`Steam is throttling logins: password logins paused for ${syncState.loginPauseMs / MIN} min`);
  addEvent(null, 'problem', `Steam is throttling logins: password logins paused for ${syncState.loginPauseMs / MIN} min`, true);
}

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
}

interface Ctx {
  acc: Account;
  page: (appid: number, page: number) => Promise<SubsPage>;
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
    const renewCookies = async () => {
      const r = await refreshCookies({ steamid: acc!.steamid!, refreshToken: refreshToken! }, timeoutMs);
      cookies = r.cookies;
      const rotated = r.refreshToken !== refreshToken;
      refreshToken = r.refreshToken;
      updateAccount(id, {
        cookies_enc: encrypt(r.cookies), refresh_token_enc: encrypt(r.refreshToken),
        ...(rotated ? { token_expires_at: jwtExpiresAt(r.refreshToken), token_warned: 0 } : {}),
      });
      if (rotated) log.info(`${acc!.username}: Steam renewed the saved sign-in`);
    };
    const cookiesFresh = () => {
      const jwt = cookies?.match(/steamLoginSecure=\d+%7C%7C([^;]+)/)?.[1];
      return !!jwt && jwtExpiresIn(jwt) > 10 * MIN;
    };

    const left = refreshToken ? jwtExpiresIn(refreshToken) : 0;
    // With a password the sign-in is renewed 3 days early; without one it is used until it runs out.
    if (!refreshToken || !acc.steamid || left <= 0 || (password && left < 3 * DAY)) await login();

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
          else if (e.kind === 'token_invalid') await login();
          else if (e.kind === 'temporary' && !retried) {
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
        if (r.base !== base) {
          base = r.base;
          updateAccount(id, { profile_url: base });
        }
        return r.page;
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
      updateAccount(id, { last_check_at: Date.now(), next_check_at: Date.now() + next });
    }
    if (task.writes) {
      phase = 'write';
      await runWrites(ctx);
    }
    if (readError) {
      phase = 'read';
      throw readError;
    }

    reload();
    if (acc.status !== 'ok') log.info(`${acc.username}: OK`);
    updateAccount(id, { status: 'ok', status_msg: '', fail_count: 0, next_attempt_at: 0, problem_notified: 0, last_ok_at: Date.now() });
    reload();
    warnTokenExpiry(acc);
  } catch (e) {
    reload();
    handleFailure(acc, e, phase);
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
  const { items, total } = await readAll(ctx, appid);
  const r = recordFullRead(acc, appid, items, total);
  if (r.pending) {
    log.info(`${acc.username}: ${r.pending} item(s) missing from app ${appid}; confirming with another read` +
      `${r.suspicious ? ' at the normal interval (most of the list vanished at once)' : ''}`);
  }
  return r.pending && !r.suspicious ? 'confirm' : 'ok';
}

/** Every page of one game's list. A list that changes while it is read is read again later. */
async function readAll(ctx: Ctx, appid: number): Promise<{ items: SubItem[]; total: number }> {
  const seen = new Map<string, SubItem>();
  let total = 0;
  for (let p = 1; ; p++) {
    const page = await ctx.page(appid, p);
    if (p === 1) total = page.total ?? 0;
    else if (page.total !== null && page.total !== total) {
      throw new SteamError('temporary', `The list of app ${appid} changed while it was read (${total} -> ${page.total} subscriptions)`);
    }
    for (const i of page.items) seen.set(i.id, i);
    if (!page.items.length || page.to >= total || p > Math.ceil(total / PAGE_SIZE)) break;
    await sleep(PAGE_GAP_MS);
  }
  if (seen.size !== total) throw new SteamError('temporary', `Read ${seen.size} of ${total} subscriptions of app ${appid}; reading again later`);
  return { items: [...seen.values()], total };
}

/** Pending job items first, then what the groups need, paced and capped. */
async function runWrites(ctx: Ctx): Promise<void> {
  const { acc } = ctx;
  if (!writesAllowed()) return;
  const perRun = numSetting('writes_per_run', 1, 1000);
  const gap = numSetting('write_gap_ms', 0, 60_000);
  const list = pendingJobWrites(acc.id, perRun);
  if (list.length < perRun) list.push(...pendingSyncWrites(acc.id, Date.now(), perRun - list.length));
  if (!list.length) return;

  const done = { subscribe: 0, unsubscribe: 0 };
  const failed: string[] = [];
  const subscribed = new Map<number, PendingWrite[]>();
  let reapplied: PendingWrite[] = [];
  try {
    for (const [i, w] of list.entries()) {
      if (!writesAllowed()) break;
      if (i && gap) await sleep(gap);
      let result;
      try {
        result = await ctx.write(w);
      } catch (e) {
        // A network error or 5xx on one item gets that item's back-off; it must not block the others.
        if (!(e instanceof SteamError) || e.kind !== 'temporary') throw e;
        result = { outcome: 'failed' as const, code: '', message: errMsg(e) };
      }
      writeTimes.push(Date.now());
      if (recordWrite(acc, w, result.outcome, result.message)) reapplied.push(w);
      if (result.outcome === 'ok') {
        done[w.action]++;
        if (w.action === 'subscribe') subscribed.set(w.appid, [...(subscribed.get(w.appid) ?? []), w]);
      } else {
        failed.push(`${w.title || w.id}: ${result.message}`);
      }
    }
    // Steam has answered OK for items that then never showed up: check the subscribes on the list itself.
    for (const [appid, ws] of subscribed) {
      const missing = await verifySubscribes(ctx, appid, ws.map((w) => w.id));
      if (missing.length) {
        failed.push(...ws.filter((w) => missing.includes(w.id)).map((w) => `${w.title || w.id}: accepted by Steam but not on the list`));
        reapplied = reapplied.filter((w) => !missing.includes(w.id));
        done.subscribe -= missing.length;
      }
    }
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
