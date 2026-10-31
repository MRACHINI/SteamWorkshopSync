// Sync engine and session scenarios, each from an empty world.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginSession } from 'steam-session';
import {
  A, B, C, CS2, DAY, M, SQUAD, addAccount, brokenBody, c, cycle, decrypt, encrypt, eresult, fakeJwt, getAccount, groups, has, hooks,
  isPage, itemState, jobs, notify, pageUser, q, requestCheck, reset, round, rounds, s, setSettings, settle, sleep, started,
  steam, sync, telegram, trio, updateAccount, writeOf,
} from './harness.mjs';

const seed = (ids, appid, ...owners) => {
  for (const id of ids) {
    steam.addItem(id, appid);
    for (const o of owners) steam.subscribe(o, id);
  }
};
const REFRESH_AUD = ['web', 'renew', 'derive'];

test('a 429 stops the accounts still queued', async () => {
  reset();
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(addAccount(`acc${i}`, String(76561190000001000n + BigInt(i))));
  seed([c(1)], CS2, String(76561190000001000n));
  await started('g', [CS2], ids);
  let loads = 0;
  let after = 0;
  let throttled = false;
  hooks.fn = (url) => {
    if (!isPage(url)) return;
    loads++;
    if (loads <= 2) return;
    if (throttled) after++;
    throttled = true;
    return new Response('', { status: 429 });
  };
  await round();
  hooks.fn = null;
  const parked = q("SELECT COUNT(*) AS n FROM accounts WHERE status = 'rate_limited'").get().n;
  assert.ok(after <= 3, `${after} more page loads after the first 429, ${parked} of 12 accounts marked rate_limited`);
});

test('a short outage does not fail job items for good', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A, B);
  await jobs.resolveForJob([c(1)], 5000);
  jobs.createJob('unsubscribe', [c(1)], [idA, idB], false);
  hooks.fn = (url, init) => (writeOf(url, init) ? new Response('bad gateway', { status: 502 }) : undefined);
  await round();
  hooks.fn = null;
  assert.equal(q("SELECT COUNT(*) AS n FROM job_items WHERE state = 'pending'").get().n, 2, 'waiting for another try');
  q('UPDATE job_items SET next_at = 0').run();
  await rounds(3);
  const states = q('SELECT state, COUNT(*) AS n FROM job_items GROUP BY state').all();
  assert.ok(!has(A, c(1)) && !has(B, c(1)), `outage over, items still subscribed, job items: ${JSON.stringify(states)}`);
});

test('a read that still shows an unsubscribed item does not undo the removal', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  let lagged = false;
  hooks.fn = (url, init) => {
    const w = writeOf(url, init);
    if (w?.action === 'unsubscribe' && w.sid === A && !lagged) {
      lagged = true;
      return eresult(1); // accepted, but the list still shows it for a moment
    }
  };
  groups.itemAction(g, c(1), 'remove');
  await round();
  assert.ok(lagged, 'SETUP');
  await round();
  steam.unsubscribe(A, c(1));
  hooks.fn = null;
  await rounds(2);
  assert.notEqual(itemState(g, c(1)), 'active', `the removal was undone, main has it again: ${has(M, c(1))}`);
});

test('a failed early password renewal does not stop a working account', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  const u = steam.users.get(A);
  u.refresh = fakeJwt(A, REFRESH_AUD, 2 * DAY);
  updateAccount(idA, { refresh_token_enc: encrypt(u.refresh), token_expires_at: Date.now() + 2 * DAY, cookies_enc: null });
  const orig = LoginSession.prototype.startWithCredentials;
  LoginSession.prototype.startWithCredentials = async () => { throw new Error('connect ETIMEDOUT'); };
  try {
    steam.addItem(c(2), CS2);
    steam.subscribe(A, c(2));
    await round();
    assert.ok(groups.presentSet(idA, CS2).has(c(2)), `2 days of working sign-in left, but the run stopped: ${getAccount(idA).status_msg}`);
  } finally {
    LoginSession.prototype.startWithCredentials = orig;
  }
});

test('Steam Guard plus remembered password does not park early', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  const u = steam.users.get(A);
  u.refresh = fakeJwt(A, REFRESH_AUD, 2 * DAY);
  updateAccount(idA, { refresh_token_enc: encrypt(u.refresh), token_expires_at: Date.now() + 2 * DAY, interactive: 1, cookies_enc: null });
  const orig = LoginSession.prototype.startWithCredentials;
  LoginSession.prototype.startWithCredentials = async () => ({ actionRequired: true });
  try {
    await round();
    assert.notEqual(getAccount(idA).status, 'needs_signin', 'parked as needs_signin with 2 days of working sign-in left');
  } finally {
    LoginSession.prototype.startWithCredentials = orig;
  }
});

test('a transient fallback failure does not park the main account', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  updateAccount(idM, { password_enc: null, cookies_enc: null });
  hooks.fn = (url) => (url.pathname === '/jwt/refresh' ? new Response('<html>Steam is having a moment</html>', { status: 200 }) : undefined);
  const orig = LoginSession.prototype.getWebCookies;
  LoginSession.prototype.getWebCookies = async () => { throw new Error('Malformed login response'); };
  try {
    await round();
    assert.notEqual(getAccount(idM).status, 'needs_signin', `valid sign-in parked: ${getAccount(idM).status_msg}`);
  } finally {
    LoginSession.prototype.getWebCookies = orig;
  }
});

test('one counted but unlisted item does not stop a list', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  hooks.fn = async (url, init) => {
    if (!isPage(url) || pageUser(init) !== A) return;
    const plain = hooks.fn;
    hooks.fn = null;
    const res = await globalThis.fetch(url.href, init);
    hooks.fn = plain;
    if (res.status !== 200) return res;
    const html = (await res.text()).replace(/of (\d+) entries/, (_, n) => `of ${Number(n) + 1} entries`);
    return new Response(html, { status: 200 });
  };
  steam.addItem(c(3), CS2);
  steam.subscribe(A, c(3));
  await rounds(3);
  hooks.fn = null;
  assert.ok(has(B, c(3)), `the list can no longer be read: ${getAccount(idA).status_msg}`);
});

test('a custom URL taken by someone else is not read as this account', async () => {
  reset();
  const idM = addAccount('mainacc', M, { main: true, vanity: 'mainvanity' });
  const idA = addAccount('alpha', A);
  seed([c(1)], CS2, M);
  await started('g', [CS2], [idA]);
  assert.ok(getAccount(idM).profile_url?.includes('mainvanity'), 'SETUP');
  steam.users.get(M).vanity = 'newname';
  steam.addUser(C, 'mainvanity');
  seed([c(2)], CS2, C);
  await rounds(3);
  assert.ok(!groups.presentSet(idM, CS2).has(c(2)), "a stranger's list was accepted as the main account's (assumes Steam serves it, which is untested)");
});

test('forced reads do not log in with a password known to be wrong', async () => {
  reset();
  const { idA } = trio();
  updateAccount(idA, { status: 'bad_credentials', refresh_token_enc: null, cookies_enc: null });
  let logins = 0;
  const orig = LoginSession.prototype.startWithCredentials;
  LoginSession.prototype.startWithCredentials = async () => { logins++; throw new Error('Invalid password'); };
  try {
    requestCheck(idA, true);
    await cycle();
    assert.equal(logins, 0, `${logins} real password login(s) for an account parked as bad_credentials`);
  } finally {
    LoginSession.prototype.startWithCredentials = orig;
  }
});

test('pausing a group stops its running batch', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  const ids = [2, 3, 4, 5, 6].map(c);
  seed(ids, CS2);
  for (const id of ids) await groups.addToGroup(g, [id], 5000);
  let count = 0;
  hooks.fn = (url, init) => {
    const w = writeOf(url, init);
    if (w?.sid === A && w.action === 'subscribe' && ++count === 1) groups.groupAction(g, 'pause');
  };
  await round();
  assert.equal(count, 1, `${count - 1} more subscribes went out on a group the UI shows as paused`);
});

test('a write-only run keeps the failure record of a failing read', async () => {
  reset();
  setSettings({ writes_per_run: '1' });
  const { idA, idB } = trio();
  const ids = [1, 2, 3, 4, 5].map(c);
  seed(ids, CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  for (const id of ids) groups.itemAction(g, id, 'remove');
  hooks.fn = (url, init) => (isPage(url) && pageUser(init) === A ? new Response('oops', { status: 500 }) : undefined);
  await round();
  assert.ok(getAccount(idA).fail_count >= 1, 'SETUP');
  q('UPDATE accounts SET next_attempt_at = 0 WHERE id = ?').run(idA);
  await cycle();
  assert.ok(getAccount(idA).fail_count >= 1, 'a write-only run wiped the failure count, though no read has worked');
});

test('a held-removal alert survives a restart before the cycle ends', async () => {
  reset();
  const { idM, idA, idB } = trio();
  const ids = [1, 2, 3, 4, 5, 6].map(c);
  seed(ids, CS2, M);
  await started('g', [CS2], [idA, idB]);
  for (const id of ids.slice(0, 4)) steam.unsubscribe(M, id);
  q('DELETE FROM outbox').run();
  await sync.runAccount(idM, { check: true, full: true, writes: false });
  await sync.runAccount(idM, { check: true, full: true, writes: false });
  assert.equal(groups.listHeld().length, 4, 'SETUP');
  const queued = q('SELECT COUNT(*) AS n FROM outbox').get().n;
  notify.flushNotifications();
  assert.ok(queued > 0, 'the alert exists only in memory until the cycle ends');
});

test('every message of a batch goes out promptly', async () => {
  reset();
  telegram.enqueue('one');
  telegram.enqueue('two');
  telegram.enqueue('three');
  await telegram.flush();
  await sleep(200);
  assert.equal(steam.telegram.length, 3, `${steam.telegram.length} of 3 sent; the rest wait for the next flush`);
  await telegram.flush();
  await sleep(100);
});

test('the write pause and the hourly count survive a restart', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  steam.addItem(c(2), CS2);
  await groups.addToGroup(g, [c(2)], 5000);
  steam.throttleWrites = true;
  await round();
  steam.throttleWrites = false;
  assert.ok(sync.syncState.writePausedUntil > Date.now(), 'SETUP');
  const fresh = await import('../dist/sync.js?restart=1');
  assert.ok(fresh.syncState.writePausedUntil > Date.now(), 'a restart clears the 10 minute write pause');
  assert.ok(fresh.writesLastHour() > 0, 'a restart forgets the writes of this hour');
});

test('a failed read is retried on the back-off, not a full interval later', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  hooks.fn = (url, init) => (isPage(url) && pageUser(init) === A ? new Response('oops', { status: 500 }) : undefined);
  await round();
  hooks.fn = null;
  const a = getAccount(idA);
  assert.ok(a.next_check_at <= a.next_attempt_at + 1000, `retry after ${Math.round((a.next_attempt_at - Date.now()) / 1000)}s is ignored; next read in ${Math.round((a.next_check_at - Date.now()) / 1000)}s`);
});

test('a failed read keeps its quick retry when a write fails as well', async () => {
  reset();
  setSettings({ writes_per_run: '5' });
  const { idA, idB } = trio();
  const ids = [1, 2, 3, 4, 5].map(c);
  seed(ids, CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  for (const id of ids) groups.itemAction(g, id, 'remove');
  hooks.fn = (url, init) => {
    if (isPage(url) && pageUser(init) === A) return new Response('oops', { status: 500 });
    if (writeOf(url, init)?.sid === A) return new Response('bad gateway', { status: 502 });
  };
  await round();
  hooks.fn = null;
  const a = getAccount(idA);
  assert.ok(a.next_check_at <= a.next_attempt_at + 1000, 'the next read waits for the full interval');
});

test('a job write on an account in no group clears its error once it works', async () => {
  reset();
  const { idA } = trio();
  const ids = [1, 2, 3, 4].map(c);
  seed(ids, CS2);
  await jobs.resolveForJob(ids, 5000);
  await round();
  jobs.createJob('subscribe', ids, [idA], false);
  hooks.fn = (url, init) => (writeOf(url, init) ? new Response('bad gateway', { status: 502 }) : undefined);
  await round();
  hooks.fn = null;
  assert.equal(getAccount(idA).status, 'error', 'SETUP');
  q('UPDATE job_items SET next_at = 0').run();
  await round();
  assert.equal(getAccount(idA).status, 'ok');
});

test('cancelling a job stops writes already queued in a run', async () => {
  reset();
  const { idA } = trio();
  const ids = [1, 2, 3, 4, 5].map(c);
  seed(ids, CS2);
  await jobs.resolveForJob(ids, 5000);
  const { jobId } = jobs.createJob('subscribe', ids, [idA], false);
  let count = 0;
  hooks.fn = (url, init) => {
    if (writeOf(url, init) && ++count === 1) jobs.cancelJob(jobId);
  };
  await round();
  assert.equal(count, 1, `${count - 1} more writes went out after Cancel`);
});

test('a summary stays within the Telegram limit', async () => {
  reset();
  trio();
  const g = groups.createGroup('g', [CS2], []);
  for (let i = 0; i < 100; i++) notify.note('reapplied', g, `${'u'.repeat(60)}${i}`, [`Item number ${i % 20}`]);
  notify.flushNotifications();
  await sleep(100);
  const longest = Math.max(0, ...steam.telegram.map((t) => t.length));
  assert.ok(steam.telegram.length && longest <= 4096, `${longest} characters, Telegram refuses anything over 4096`);
});

test('a run does not overwrite a newer sign-in with the old token', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  const NEW = fakeJwt(M, REFRESH_AUD, 200 * DAY);
  updateAccount(idM, { password_enc: null, cookies_enc: null });
  hooks.fn = (url) => {
    if (url.pathname !== '/jwt/refresh') return;
    hooks.fn = null;
    updateAccount(idM, { refresh_token_enc: encrypt(NEW), cookies_enc: null, token_expires_at: Date.now() + 200 * DAY }); // what signin finish() stores
  };
  await round();
  assert.equal(decrypt(getAccount(idM).refresh_token_enc), NEW, 'the run wrote the old token back over the new sign-in');
});

test('a rotated token is kept when the second renewal step fails', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  const ROT = fakeJwt(M, REFRESH_AUD, 200 * DAY);
  updateAccount(idM, { cookies_enc: null });
  let once = true;
  hooks.fn = (url) => {
    if (!once) return;
    if (url.pathname === '/jwt/refresh') {
      steam.users.get(M).refresh = ROT;
      return new Response(null, { status: 302, headers: {
        location: `https://steamcommunity.com/login/settoken?steamid=${M}`, 'set-cookie': `steamRefresh_steam=${M}%7C%7C${ROT}; Path=/`,
      } });
    }
    if (url.pathname === '/login/settoken') {
      once = false;
      return new Response('', { status: 502 });
    }
  };
  await round();
  assert.equal(decrypt(getAccount(idM).refresh_token_enc), ROT, 'the rotated token was dropped (matters only if Steam rotates here)');
});

test('a subscribe job on items already held does not read the whole list', async () => {
  reset();
  const idA = addAccount('alpha', A);
  const ids = Array.from({ length: 90 }, (_, i) => String(6000 + i));
  seed(ids, CS2, A);
  await started('g', [CS2], [idA]);
  const oldest = steam.subs(A, CS2).slice(-30);
  await jobs.resolveForJob(oldest, 5000);
  jobs.createJob('subscribe', oldest, [idA], false);
  steam.requests.length = 0;
  await round();
  const pages = steam.count((r) => r.path.includes('myworkshopfiles') && r.steamid === A);
  assert.ok(pages <= 3, `${pages} page loads to re-subscribe items already on the list (assumes Steam keeps their date)`);
});

test('a dropped connection mid-page does not abort the rest of the run', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  seed([s(1)], SQUAD, A);
  const g = await started('g', [CS2, SQUAD], [idA, idB]);
  steam.addItem(s(2), SQUAD);
  await groups.addToGroup(g, [s(2)], 5000);
  hooks.fn = (url, init) => (isPage(url) && pageUser(init) === A && url.searchParams.get('appid') === String(CS2) ? brokenBody() : undefined);
  await round();
  hooks.fn = null;
  assert.ok(has(A, s(2)), `one broken page stopped the other game's read and all writes: ${getAccount(idA).status_msg}`);
});

test('throttling seen during renewal pauses logins', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  updateAccount(idA, { cookies_enc: null });
  hooks.fn = (url) => (url.pathname === '/jwt/refresh' ? new Response('<html></html>', { status: 200 }) : undefined);
  const orig = LoginSession.prototype.getWebCookies;
  LoginSession.prototype.getWebCookies = async () => { throw Object.assign(new Error('RateLimitExceeded'), { eresult: 84 }); };
  try {
    await round();
    assert.ok(sync.syncState.loginPausedUntil > Date.now(), `no global pause, account status ${getAccount(idA).status}, retrying every minute`);
  } finally {
    LoginSession.prototype.getWebCookies = orig;
  }
});
