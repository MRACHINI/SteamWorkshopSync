// Paths the other scenarios do not reach: session renewal, the hold threshold itself, held approvals, sign-in,
// routing of main-account items, plain item actions, batching of Telegram summaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginSession } from 'steam-session';
import {
  A, B, C, CS2, DAY, M, addAccount, c, decrypt, encrypt, fakeJwt, getAccount, groups, has, hooks, isPage, itemState, jobs, pageUser, q, reset, round,
  rounds, setSettings, settle, sleep, started, steam, sync, trio, updateAccount, writeOf,
} from './harness.mjs';

const { startPasswordSignin, startQrSignin, getSignin, submitSigninCode } = await import('../dist/signin.js');

const seed = (ids, appid, ...owners) => {
  for (const id of ids) {
    steam.addItem(id, appid);
    for (const o of owners) steam.subscribe(o, id);
  }
};
const REFRESH_AUD = ['web', 'renew', 'derive'];

test('a rejected session is renewed, and the run goes on', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  steam.users.get(A).access.clear(); // Steam dropped the session
  steam.addItem(c(2), CS2);
  steam.subscribe(A, c(2));
  await round();
  assert.equal(getAccount(idA).status, 'ok');
  assert.ok(groups.presentSet(idA, CS2).has(c(2)));
});

test('a token Steam rotates is kept, with its new expiry', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  const rotated = fakeJwt(A, REFRESH_AUD, 300 * DAY);
  updateAccount(idA, { cookies_enc: null, token_warned: 1 });
  hooks.fn = (url) => {
    if (url.pathname !== '/jwt/refresh') return;
    hooks.fn = null;
    steam.users.get(A).refresh = rotated;
    return new Response(null, { status: 302, headers: {
      location: `https://steamcommunity.com/login/settoken?steamid=${A}`, 'set-cookie': `steamRefresh_steam=${A}%7C%7C${rotated}; Path=/`,
    } });
  };
  await round();
  const a = getAccount(idA);
  assert.equal(decrypt(a.refresh_token_enc), rotated);
  assert.ok(a.token_expires_at > Date.now() + 250 * DAY);
  assert.equal(a.token_warned, 0);
});

test('a sign-in that keeps failing unclearly is finally treated as dead', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  updateAccount(idM, { password_enc: null, cookies_enc: null, fail_count: 10 });
  hooks.fn = (url) => (url.pathname === '/jwt/refresh' ? new Response('<html></html>', { status: 200 }) : undefined);
  const orig = LoginSession.prototype.getWebCookies;
  LoginSession.prototype.getWebCookies = async () => { throw new Error('Malformed login response'); };
  try {
    await round();
    assert.equal(getAccount(idM).status, 'error', 'failures of other kinds do not count against the token');
    sync.tokenSuspects.set(idM, 10);
    await round();
    assert.equal(getAccount(idM).status, 'needs_signin');
  } finally {
    LoginSession.prototype.getWebCookies = orig;
    sync.tokenSuspects.clear();
  }
});

test('an approved hold no longer counts towards the next one', async () => {
  reset();
  const { idA, idB } = trio();
  const cs = Array.from({ length: 12 }, (_, i) => c(i + 1));
  seed(cs, CS2, M);
  await started('g', [CS2], [idA, idB]);
  for (const id of cs.slice(0, 4)) steam.unsubscribe(M, id);
  await rounds(3);
  assert.equal(groups.resolveHeld('all', 'approve'), 4);
  await settle();
  steam.unsubscribe(M, cs[4]);
  await rounds(3);
  assert.equal(groups.listHeld().length, 0, 'one ordinary removal goes through');
  assert.ok(!has(A, cs[4]));
});

test('a main-account list that counts more than it shows only asks the admin', async () => {
  reset();
  const { idA, idB } = trio();
  const cs = [1, 2, 3, 4].map(c);
  seed(cs, CS2, M);
  const g = await started('g', [CS2], [idA, idB]);
  hooks.fn = async (url, init) => {
    if (!isPage(url) || pageUser(init) !== M) return;
    const fake = hooks.fn;
    hooks.fn = null;
    const res = await globalThis.fetch(url.href, init);
    hooks.fn = fake;
    if (res.status !== 200) return res;
    // The oldest item is still counted, but no longer listed.
    const html = (await res.text()).replace(new RegExp(`<div class="workshopItemSubscription" id="Subscription${cs[0]}">[\\s\\S]*?</a>\\s*</div>`), '')
      .replace(/Showing 1-(\d+) of (\d+) entries/, (_, to, n) => `Showing 1-${Number(to) - 1} of ${n} entries`);
    return new Response(html, { status: 200 });
  };
  q('UPDATE account_apps SET full_due = 1').run(); // the total still adds up, so only the daily full read sees this
  await rounds(5);
  hooks.fn = null;
  const held = groups.listHeld();
  assert.equal(held.length, 1, 'held, whatever the threshold');
  assert.match(held[0].held_reason, /no longer shows/);
  assert.ok(has(A, cs[0]) && has(B, cs[0]), 'members keep it');
  assert.equal(itemState(g, cs[0]), 'active');
});

test('a half-rendered page is loaded again, and the read goes on', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  let broke = false;
  hooks.fn = async (url, init) => {
    if (!isPage(url) || pageUser(init) !== A || broke) return;
    broke = true;
    return new Response(`<html><script>g_steamID = "${A}";</script><div class="workshopBrowsePagingInfo">Showing 1-2 of 2 entries</div>
      <div class="workshopItemSubscription" id="Subscription${c(1)}"><div class="workshopItemTitle">x</div></div></html>`, { status: 200 });
  };
  q('UPDATE account_apps SET full_due = 1').run();
  await round();
  hooks.fn = null;
  assert.ok(broke, 'SETUP');
  assert.equal(getAccount(idA).status, 'ok');
  assert.equal(q('SELECT short_by FROM account_apps WHERE account_id = ?').get(idA).short_by, 0);
});

test('a list that stays short costs one page a check, not a full read', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2), c(3)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  hooks.fn = async (url, init) => {
    if (!isPage(url) || pageUser(init) !== A) return;
    const fake = hooks.fn;
    hooks.fn = null;
    const res = await globalThis.fetch(url.href, init);
    hooks.fn = fake;
    if (res.status !== 200) return res;
    return new Response((await res.text()).replace('Showing 1-3 of 3 entries', 'Showing 1-4 of 4 entries'), { status: 200 });
  };
  await rounds(3);
  assert.equal(getAccount(idA).status, 'ok');
  steam.requests.length = 0;
  await round();
  hooks.fn = null;
  assert.equal(steam.count((r) => r.path.includes('myworkshopfiles') && r.steamid === A), 1);
});

test('the hold threshold: exactly that many pass, one more is held', async () => {
  reset();
  const { idA, idB } = trio();
  const cs = Array.from({ length: 12 }, (_, i) => c(i + 1));
  seed(cs, CS2, M);
  await started('g', [CS2], [idA, idB]);
  for (const id of cs.slice(0, 3)) steam.unsubscribe(M, id);
  await rounds(3);
  await settle();
  assert.equal(groups.listHeld().length, 0, 'three at threshold 3 go through');
  assert.ok(!has(A, cs[0]));

  reset();
  const again = trio();
  seed(cs, CS2, M);
  await started('g', [CS2], [again.idA, again.idB]);
  for (const id of cs.slice(0, 4)) steam.unsubscribe(M, id);
  await rounds(3);
  assert.equal(groups.listHeld().length, 4, 'four are held, with items left on the list');
  assert.ok(has(A, cs[0]));
});

test('approving held removals takes them from the members, partly if asked', async () => {
  reset();
  const { idA, idB } = trio();
  const cs = [1, 2, 3, 4, 5, 6].map(c);
  seed(cs, CS2, M);
  const g = await started('g', [CS2], [idA, idB]);
  for (const id of cs.slice(0, 4)) steam.unsubscribe(M, id);
  await rounds(3);
  assert.equal(groups.resolveHeld([cs[0]], 'approve'), 1);
  await settle();
  assert.ok(!has(A, cs[0]) && has(A, cs[1]), 'only the approved one goes');
  assert.equal(itemState(g, cs[0]), 'removed');
  assert.equal(groups.listHeld().length, 3);
});

test('sign-in: a Steam Guard code signs the main account in, and its password is not kept', async () => {
  reset();
  const idM = addAccount('mainacc', M, { main: true, password: '' });
  const token = fakeJwt(M, REFRESH_AUD, 200 * DAY);
  const start = LoginSession.prototype.startWithCredentials;
  const submit = LoginSession.prototype.submitSteamGuardCode;
  LoginSession.prototype.startWithCredentials = async () => ({ actionRequired: true, validActions: [{ type: 3 }] });
  LoginSession.prototype.submitSteamGuardCode = async function submitted() {
    this.refreshToken = token;
    setImmediate(() => this.emit('authenticated'));
  };
  try {
    const s = await startPasswordSignin(idM, 'hunter22', true);
    assert.equal(s.state, 'need_code');
    await submitSigninCode(s.id, 'ABC12');
    await sleep(20);
    assert.equal(getSignin(s.id).state, 'done');
    const a = getAccount(idM);
    assert.equal(decrypt(a.refresh_token_enc), token);
    assert.equal(a.password_enc, null, 'remember does nothing for the main account');
    assert.equal(a.interactive, 1);
  } finally {
    LoginSession.prototype.startWithCredentials = start;
    LoginSession.prototype.submitSteamGuardCode = submit;
  }
});

test('sign-in: a different Steam account saves nothing', async () => {
  reset();
  const idA = addAccount('alpha', A);
  const before = getAccount(idA).refresh_token_enc;
  const start = LoginSession.prototype.startWithCredentials;
  LoginSession.prototype.startWithCredentials = async function other() {
    this.refreshToken = fakeJwt(B, REFRESH_AUD, 200 * DAY);
    setImmediate(() => this.emit('authenticated'));
    return { actionRequired: false };
  };
  try {
    const s = await startPasswordSignin(idA, 'pw', false);
    await sleep(20);
    assert.equal(getSignin(s.id).state, 'failed');
    assert.equal(getAccount(idA).refresh_token_enc, before);
  } finally {
    LoginSession.prototype.startWithCredentials = start;
  }
});

test('sign-in: an expired code asks for another, a duplicate does not end it', async () => {
  reset();
  const idA = addAccount('alpha', A);
  const start = LoginSession.prototype.startWithCredentials;
  const submit = LoginSession.prototype.submitSteamGuardCode;
  LoginSession.prototype.startWithCredentials = async () => ({ actionRequired: true, validActions: [{ type: 3 }] });
  try {
    const s = await startPasswordSignin(idA, 'pw', false);
    LoginSession.prototype.submitSteamGuardCode = async () => { throw Object.assign(new Error('Expired'), { eresult: 27 }); };
    let r = await submitSigninCode(s.id, 'OLD12');
    assert.equal(r.state, 'need_code');
    assert.match(r.message, /expired/);
    LoginSession.prototype.submitSteamGuardCode = async () => { throw Object.assign(new Error('DuplicateRequest'), { eresult: 29 }); };
    r = await submitSigninCode(s.id, 'NEW12');
    assert.equal(r.state, 'need_code');
  } finally {
    LoginSession.prototype.startWithCredentials = start;
    LoginSession.prototype.submitSteamGuardCode = submit;
  }
});

test('sign-in: the QR code follows a new challenge from Steam', async () => {
  reset();
  const idM = addAccount('mainacc', M, { main: true, password: '' });
  let session;
  const start = LoginSession.prototype.startWithQR;
  LoginSession.prototype.startWithQR = async function qr() {
    session = this;
    return { actionRequired: true, qrChallengeUrl: 'https://s.team/q/1/1' };
  };
  try {
    const s = await startQrSignin(idM);
    const first = s.qrSvg;
    session.emit('debug', 'poll response', { newChallengeUrl: 'https://s.team/q/1/2' });
    await sleep(50);
    assert.notEqual(getSignin(s.id).qrSvg, first);
  } finally {
    LoginSession.prototype.startWithQR = start;
  }
});

test('an expiring sign-in without a password warns once on Telegram', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  const soon = fakeJwt(M, REFRESH_AUD, 10 * DAY);
  steam.users.get(M).refresh = soon;
  updateAccount(idM, { password_enc: null, refresh_token_enc: encrypt(soon), token_expires_at: Date.now() + 10 * DAY, cookies_enc: null });
  await rounds(2);
  await sleep(50);
  assert.equal(steam.telegram.filter((t) => t.includes('expires on')).length, 1);
});

test('broken pages round after round never read as items gone', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1), c(2), c(3)], CS2, M);
  await started('g', [CS2], [idA, idB]);
  steam.brokenPages = 1000;
  await rounds(3);
  steam.brokenPages = 0;
  assert.equal(q('SELECT COUNT(*) AS n FROM account_items WHERE lost_at IS NOT NULL OR missing_count > 0').get().n, 0);
  assert.equal(groups.presentSet(idM, CS2).size, 3);
  await round();
  assert.equal(getAccount(idA).status, 'ok');
});

test('a throttled write stops the other accounts writing too', async () => {
  reset();
  const { idA, idB } = trio();
  const idC = addAccount('charlie', C);
  seed([c(1)], CS2, A);
  const g = await started('g', [CS2], [idA, idB, idC]);
  steam.addItem(c(2), CS2);
  await groups.addToGroup(g, [c(2)], 5000);
  setSettings({ concurrency: '1' });
  steam.throttleWrites = true;
  await round();
  const attempts = () => steam.count((r) => r.path.includes('IPublishedFileService'));
  assert.ok(sync.syncState.writePausedUntil > Date.now());
  const during = attempts();
  await round();
  assert.equal(attempts(), during, 'nothing is written during the pause');
  steam.throttleWrites = false;
});

test('main account items: one group takes them, a removed one comes back, an ignored one stays out', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g1 = await started('one', [CS2], [idA]);
  seed([c(2)], CS2, M);
  await settle();
  assert.equal(itemState(g1, c(2)), 'active', 'one group for the game: it decides');
  assert.ok(has(A, c(2)));

  steam.unsubscribe(M, c(2));
  await rounds(3);
  assert.equal(itemState(g1, c(2)), 'removed');
  steam.subscribe(M, c(2));
  await settle();
  assert.equal(itemState(g1, c(2)), 'active', 'the main account taking it again brings it back');

  const g2 = await started('two', [CS2], [idB]);
  seed([c(3)], CS2, M);
  await round();
  groups.resolveApproval(c(3), null);
  await rounds(2);
  assert.equal(groups.listApprovals().length, 0);
  assert.equal(itemState(g1, c(3)), undefined);
  assert.equal(itemState(g2, c(3)), undefined);
});

test('the preview offers a main-account item of a shared game as a pick', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('one', [CS2], [idA]);
  seed([c(2)], CS2, M);
  await settle();
  const g2 = groups.createGroup('two', [CS2], [idB]);
  q('DELETE FROM group_items WHERE item_id = ?').run(c(2));
  groups.groupAction(g2, 'start');
  await round();
  const plan = JSON.parse(groups.getGroup(g2).preview_json);
  assert.equal(plan.approvals.length, 1);
  groups.groupAction(g2, 'confirm');
  assert.equal(groups.listApprovals().length, 1);
});

test('the preview counts blocked items a member holds, and skips items gone from Steam', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2)], CS2, A);
  steam.addItem(c(3), CS2);
  const g = groups.createGroup('g', [CS2], [idA, idB]);
  await groups.addToGroup(g, [c(1), c(3)], 5000);
  groups.itemAction(g, c(1), 'block');
  q("UPDATE items SET status = 'unavailable' WHERE id = ?").run(c(3));
  groups.groupAction(g, 'start');
  await round();
  const plan = JSON.parse(groups.getGroup(g).preview_json);
  assert.equal(plan.unsubscribes, 1, "alpha's blocked item");
  assert.deepEqual(plan.items.sort(), [c(2), c(3)]);
  assert.equal(plan.writes, 2, 'bravo and the main account get the one available item');
});

test('plain item actions: remove, block, unblock, add back', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2), c(3)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  groups.itemAction(g, c(1), 'remove');
  await settle();
  assert.ok(!has(M, c(1)) && !has(A, c(1)), 'the main account loses it too');
  assert.equal(itemState(g, c(1)), 'removed');
  assert.equal(q('SELECT COUNT(*) AS n FROM account_items WHERE lost_at IS NOT NULL').get().n, 0, 'not read as lost');
  await round();
  assert.equal(itemState(g, c(1)), 'removed', 'our own unsubscribe is not taken for the main account dropping it');

  groups.itemAction(g, c(1), 'restore');
  await settle();
  assert.ok(has(A, c(1)) && has(M, c(1)));

  groups.itemAction(g, c(2), 'block');
  await settle();
  assert.ok(!has(B, c(2)));
  groups.itemAction(g, c(2), 'unblock');
  await settle();
  assert.ok(has(B, c(2)));
});

test('a job removes an item from all accounts when the main account never showed it', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1), c(2)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  steam.unsubscribe(M, c(1));
  q('UPDATE account_items SET present = 0 WHERE account_id = ? AND item_id = ?').run(idM, c(1)); // the list never showed it
  const { jobId } = jobs.createJob('unsubscribe', [c(1)], [idA, idB, idM], false);
  await settle();
  await round();
  assert.ok(!has(A, c(1)) && !has(B, c(1)));
  assert.equal(itemState(g, c(1)), 'removed');
  assert.equal(q('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'done');
});

test('Telegram: one summary for a batch, none when switched off', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  steam.telegram.length = 0;
  seed([c(2), c(3), c(4)], CS2, A);
  await settle();
  await sleep(50);
  const summaries = steam.telegram.filter((t) => t.includes('#NewItems'));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /3 new/);
  setSettings({ telegram_enabled: '0' });
  steam.telegram.length = 0;
  seed([c(5)], CS2, A);
  await settle();
  await sleep(50);
  assert.equal(steam.telegram.length, 0);
});

test('a network failure on a page keeps everything and retries', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  hooks.fn = (url, init) => {
    if (isPage(url) && pageUser(init) === A) throw new TypeError('fetch failed');
  };
  await round();
  hooks.fn = null;
  assert.equal(getAccount(idA).status, 'error');
  assert.equal(groups.presentSet(idA, CS2).size, 2);
  await round();
  assert.equal(getAccount(idA).status, 'ok');
});

test('a custom URL that stopped existing falls back to the permanent address', async () => {
  reset();
  const idM = addAccount('mainacc', M, { main: true, vanity: 'oldname' });
  const idA = addAccount('alpha', A);
  seed([c(1)], CS2, M);
  await started('g', [CS2], [idA]);
  steam.users.get(M).vanity = 'newname';
  await round();
  assert.equal(getAccount(idM).status, 'ok');
  assert.match(getAccount(idM).profile_url, /newname/);
});

test('one write failing does not stop the next', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  steam.addItem(c(2), CS2);
  steam.addItem(c(3), CS2);
  await groups.addToGroup(g, [c(2), c(3)], 5000);
  hooks.fn = (url, init) => {
    const w = writeOf(url, init);
    if (w?.sid === B && w.id === c(2)) return new Response('bad gateway', { status: 502 });
  };
  await round();
  hooks.fn = null;
  assert.ok(has(B, c(3)), 'one item failing does not stop the next');
  assert.ok(!has(B, c(2)));
  assert.equal(getAccount(idB).status, 'ok', 'one item failing is not the account failing');
  assert.match(q('SELECT write_error FROM account_items WHERE account_id = ? AND item_id = ?').get(idB, c(2)).write_error, /502/);
});
