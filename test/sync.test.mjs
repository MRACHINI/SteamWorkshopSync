// End-to-end sync scenarios against the fake Steam: group start, discovery, re-subscribe, removals through
// the main account, block list, held removals, group picks, jobs, throttling and broken pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installFakeSteam, tempDataDir } from './fake-steam.mjs';

tempDataDir();
const steam = installFakeSteam();
const { q, setSettings, getAccountByName } = await import('../dist/db.js');
const { encrypt } = await import('../dist/crypto.js');
const groups = await import('../dist/groups.js');
const { cycle } = await import('../dist/scheduler.js');
const { createJob } = await import('../dist/jobs.js');
const { syncState } = await import('../dist/sync.js');

setSettings({
  write_gap_ms: '0', login_gap_seconds: '0', removal_hold_threshold: '3',
  telegram_enabled: '1', telegram_bot_token: 'test', telegram_chat_id: '1',
});

const CS2 = 730;
const c = (n) => String(1000 + n);
const S1 = '2001';
const SQUAD = 393380;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addAccount(username, steamid, { main = false, vanity } = {}) {
  const u = steam.addUser(steamid, vanity);
  q(`INSERT INTO accounts (username, password_enc, steamid, refresh_token_enc, token_expires_at, status, is_main, created_at)
     VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`).run(username, encrypt('pw'), steamid, encrypt(u.refresh), Date.now() + 200 * 86400_000, main ? 1 : 0, Date.now());
  return getAccountByName(username).id;
}

/** One scheduler cycle with every account's check due. */
async function round() {
  q('UPDATE accounts SET next_check_at = 0, next_attempt_at = 0').run();
  await cycle();
  await sleep(20); // let queued Telegram sends go out
}
async function rounds(n) {
  for (let i = 0; i < n; i++) await round();
}
const pendingTotal = () => [...groups.pendingCounts().values()].reduce((n, c) => n + c.pending, 0);
async function settle() {
  for (let i = 0; i < 8; i++) {
    await round();
    if (!pendingTotal()) return;
  }
  assert.fail(`still ${pendingTotal()} pending writes after 8 rounds`);
}
const has = (sid, id) => steam.subs(sid, steam.items.get(id).appid).includes(id);
const itemState = (g, id) => q('SELECT state FROM group_items WHERE group_id = ? AND item_id = ?').get(g, id)?.state;
const tg = (tag) => steam.telegram.filter((t) => t.includes(tag));

const M = '76561190000000001';
const A = '76561190000000002';
const B = '76561190000000003';
const C = '76561190000000004';
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) steam.addItem(c(n), CS2, `CS2 map ${n}`);
steam.addItem(S1, SQUAD, 'Squad mod 1');

const idM = addAccount('mainacc', M, { main: true, vanity: 'mainvanity' });
const idA = addAccount('alpha', A);
const idB = addAccount('bravo', B);
const idC = addAccount('charlie', C);
steam.subscribe(A, c(1));
steam.subscribe(A, c(2));
steam.subscribe(B, c(2));
steam.subscribe(B, c(3));
steam.subscribe(M, c(4));
steam.subscribe(M, S1);

let g1;

test('a group that has not started changes nothing', async () => {
  g1 = groups.createGroup('team', [CS2], [idA, idB]);
  assert.deepEqual(groups.groupMembers(g1).map((m) => m.username).sort(), ['alpha', 'bravo', 'mainacc'], 'main joins every group');
  await round();
  assert.equal(steam.count((r) => r.host === 'api.steampowered.com' && r.path.includes('IPublishedFileService')), 0, 'no writes');
  assert.equal(groups.getGroup(g1).state, 'setup');
});

test('start: full read, preview, then the union reaches every member', async () => {
  groups.groupAction(g1, 'start');
  await round();
  const g = groups.getGroup(g1);
  assert.equal(g.state, 'preview');
  const plan = JSON.parse(g.preview_json);
  assert.deepEqual(plan.items.sort(), [c(1), c(2), c(3), c(4)], "members' items plus the main account's");
  assert.equal(plan.writes, 7);
  assert.equal(steam.count((r) => r.path.includes('IPublishedFileService')), 0, 'nothing written before confirming');

  groups.groupAction(g1, 'confirm');
  await settle();
  for (const sid of [M, A, B]) for (const id of [c(1), c(2), c(3), c(4)]) assert.ok(has(sid, id), `${sid} has ${id}`);
  assert.ok(has(M, S1), 'items of other games are left alone');
  assert.ok(!has(A, S1));
});

test('steady state costs one page per account and game', async () => {
  await round();
  steam.requests.length = 0;
  await round();
  const pages = steam.count((r) => r.path.includes('myworkshopfiles'));
  assert.equal(pages, 3, `expected 3 page loads, got ${pages}`);
  assert.equal(steam.count((r) => r.path.includes('/profiles/') && r.steamid === M), 0, "the main account's custom URL is cached");
});

test('an item picked up by a member is shared with the group', async () => {
  steam.subscribe(A, c(5));
  await settle();
  assert.equal(itemState(g1, c(5)), 'active');
  assert.ok(has(B, c(5)) && has(M, c(5)));
  assert.equal(tg('#NewItems').length, 1);
  assert.match(tg('#NewItems')[0], /CS2 map 5/);
});

test('an item a member loses is subscribed again, after two reads', async () => {
  steam.unsubscribe(B, c(2));
  await round();
  assert.ok(!has(B, c(2)), 'one read is not enough');
  await rounds(2);
  assert.ok(has(B, c(2)));
  assert.equal(tg('#Resubscribed').length, 1);
});

test('an item the main account drops is removed from every member', async () => {
  steam.unsubscribe(M, c(1));
  await settle();
  await round();
  assert.ok(!has(A, c(1)) && !has(B, c(1)));
  assert.equal(itemState(g1, c(1)), 'removed');
  assert.equal(tg('#Removed').length, 1);
});

test('a removed item that comes back on a member is synced again', async () => {
  steam.subscribe(A, c(1));
  await settle();
  assert.equal(itemState(g1, c(1)), 'active');
  assert.ok(has(M, c(1)) && has(B, c(1)));
});

test('a blocked item is removed everywhere and again when it comes back', async () => {
  groups.itemAction(g1, c(5), 'block');
  await settle();
  assert.ok(!has(A, c(5)) && !has(B, c(5)) && !has(M, c(5)));
  steam.subscribe(B, c(5));
  await rounds(2);
  await settle();
  assert.ok(!has(B, c(5)));
  assert.equal(itemState(g1, c(5)), 'blocked');
});

test('many items vanishing from the main account at once are held', async () => {
  for (const id of [c(1), c(2), c(3), c(4)]) steam.unsubscribe(M, id);
  await rounds(3);
  assert.equal(groups.listHeld().length, 4);
  for (const id of [c(1), c(2), c(3), c(4)]) assert.ok(has(A, id) && has(B, id), `members keep ${id}`);
  assert.ok(!has(M, c(1)), 'the main account is not re-subscribed while held');
  assert.equal(tg('#RemovalHeld').length, 1);
  groups.resolveHeld('all', 'restore');
  await settle();
  for (const id of [c(1), c(2), c(3), c(4)]) assert.ok(has(M, id), `main has ${id} again`);
  assert.equal(groups.listHeld().length, 0);
});

let g2;

test('a new main-account item matching two groups waits for a pick', async () => {
  g2 = groups.createGroup('second', [CS2], [idC]);
  groups.groupAction(g2, 'start');
  await round();
  const plan = JSON.parse(groups.getGroup(g2).preview_json);
  assert.deepEqual(plan.items, [], "the main account's items already belong to the first group");
  groups.groupAction(g2, 'confirm');
  await round();

  steam.subscribe(M, c(6));
  await round();
  const appr = groups.listApprovals();
  assert.equal(appr.length, 1);
  assert.equal(appr[0].item_id, c(6));
  assert.deepEqual(appr[0].groups.map((g) => g.name).sort(), ['second', 'team']);
  assert.equal(tg('#PickGroup').length, 1);

  groups.resolveApproval(c(6), g2);
  await settle();
  assert.ok(has(C, c(6)));
  assert.ok(!has(A, c(6)) && !has(B, c(6)));
});

test('jobs: a partial unsubscribe clashes; a full one takes the item out of the group', async () => {
  const partial = createJob('unsubscribe', [c(2)], [idA], false);
  assert.ok(partial.conflicts?.length, 'clash reported');
  assert.equal(q('SELECT COUNT(*) AS n FROM jobs').get().n, 0, 'nothing queued');

  const full = createJob('unsubscribe', [c(3)], [idM, idA, idB], false);
  assert.ok(full.jobId);
  assert.equal(itemState(g1, c(3)), 'removed');
  await settle();
  await round();
  assert.ok(!has(M, c(3)) && !has(A, c(3)) && !has(B, c(3)));
  assert.equal(q('SELECT status FROM jobs WHERE id = ?').get(full.jobId).status, 'done');
  await rounds(2);
  assert.ok(!has(A, c(3)), 'nothing brings it back');
});

test('a throttled write pauses all writes', async () => {
  steam.throttleWrites = true;
  steam.subscribe(A, c(7));
  await rounds(2);
  assert.ok(syncState.writePausedUntil > Date.now(), 'writes paused');
  assert.ok(!has(B, c(7)));
  steam.throttleWrites = false;
  syncState.writePausedUntil = 0;
  syncState.pausedUntil = 0;
  await settle();
  assert.ok(has(B, c(7)) && has(M, c(7)));
});

test('a half-rendered page is never read as "items gone"', async () => {
  steam.brokenPages = 6;
  await round();
  await round();
  assert.equal(q("SELECT COUNT(*) AS n FROM account_items WHERE lost_at > ?").get(Date.now() - 10_000).n, 0);
  steam.brokenPages = 0;
  await round();
  assert.equal(pendingTotal(), 0);
  for (const id of [c(1), c(2), c(4)]) assert.ok(has(A, id) && has(B, id) && has(M, id));
});

test('long lists are read page by page', async () => {
  const D = '76561190000000009';
  const idD = addAccount('delta', D);
  for (let n = 0; n < 75; n++) {
    steam.addItem(String(3000 + n), SQUAD);
    steam.subscribe(D, String(3000 + n));
  }
  const g3 = groups.createGroup('squad', [SQUAD], [idD]);
  groups.groupAction(g3, 'start');
  await round();
  assert.equal(groups.presentSet(idD, SQUAD).size, 75);
  const plan = JSON.parse(groups.getGroup(g3).preview_json);
  assert.equal(plan.items.length, 76, "delta's 75 plus the main account's Squad item");
});

// --- cases from the code review --------------------------------------------------------------------------

test('removing an item another group still syncs completes, and that group keeps it', async () => {
  groups.setGroupItem(g2, c(2), 'active', 'test');
  await settle();
  assert.ok(has(C, c(2)), 'the second group syncs it');
  groups.itemAction(g1, c(2), 'remove');
  await settle();
  await round();
  assert.equal(itemState(g1, c(2)), 'removed', 'not stuck in "removing"');
  assert.ok(!has(A, c(2)) && !has(B, c(2)), 'members of the first group lose it');
  assert.ok(has(M, c(2)) && has(C, c(2)), 'the second group (with the main account) keeps it');
});

test('a paused group still takes removals from the main account, and applies them on resume', async () => {
  groups.groupAction(g2, 'pause');
  steam.unsubscribe(M, c(6));
  await rounds(3);
  assert.equal(itemState(g2, c(6)), 'removing');
  assert.ok(has(C, c(6)), 'nothing changes while paused');
  groups.groupAction(g2, 'resume');
  await settle();
  await round();
  assert.ok(!has(C, c(6)) && !has(M, c(6)), 'not subscribed again on resume');
  assert.equal(itemState(g2, c(6)), 'removed');
});

test('an account joining a running group shares what it already has', async () => {
  steam.subscribe(C, c(8));
  await settle();
  assert.equal(itemState(g2, c(8)), 'active');
  groups.updateGroup(g1, { memberIds: [idA, idB, idC] });
  assert.equal(itemState(g1, c(8)), 'active');
  assert.equal(itemState(g1, c(2)), 'removed', 'an item removed from this group stays removed');
  await settle();
  assert.ok(has(A, c(8)) && has(B, c(8)));
});

test('a subscribe Steam accepts but never lists is a failed write, not a removal or a loop', async () => {
  const removedBefore = tg('#Removed').length;
  const resubBefore = tg('#Resubscribed').length;
  steam.ghostWrites = true;
  steam.subscribe(A, c(9));
  await rounds(3);
  steam.ghostWrites = false;
  const cell = q('SELECT present, write_error, write_next_at FROM account_items WHERE account_id = ? AND item_id = ?').get(idB, c(9));
  assert.equal(cell.present, 0);
  assert.match(cell.write_error, /did not show up/);
  assert.ok(cell.write_next_at > Date.now() + 30 * 60_000, 'retried later, not every round');
  assert.equal(tg('#Removed').length, removedBefore);
  assert.equal(tg('#Resubscribed').length, resubBefore);
  assert.equal(itemState(g1, c(9)), 'active');
});

test('a main-account list that suddenly shows nothing is held, not removed from everyone', async () => {
  steam.hidden.add(M);
  await rounds(4);
  assert.ok(groups.listHeld().length >= 3, `held ${groups.listHeld().length}`);
  assert.ok(has(A, c(4)) && has(A, c(7)) && has(B, c(4)), 'members keep everything');
  steam.hidden.delete(M);
  await round();
  assert.equal(groups.listHeld().length, 0, 'the items came back, nothing left to decide');
  assert.equal(itemState(g1, c(4)), 'active');
});

test('sizes: group total, still to download per member, and per account', async () => {
  const views = await import('../dist/views.js');
  steam.addItem(c(10), CS2, 'CS2 map 10');
  const r = await groups.addToGroup(g1, [c(10)], 5000);
  assert.equal(r.added, 1);
  const d = views.groupDetail(g1);
  assert.ok(d.bytes >= 1000, `group total ${d.bytes}`);
  for (const m of d.members) assert.ok(m.missing_bytes >= 1000, `${m.username} still has to download the new map`);
  const acc = views.publicAccounts().find((a) => a.username === 'alpha');
  assert.ok(acc.pending_bytes >= 1000);
  // Not settle(): the earlier "never listed" writes stay pending until their retry an hour later.
  await rounds(3);
  assert.ok(has(A, c(10)) && has(B, c(10)) && has(M, c(10)));
  assert.equal(views.publicAccounts().find((a) => a.username === 'alpha').pending_bytes, 0);
  assert.equal(views.groupDetail(g1).members.find((m) => m.username === 'alpha').missing_bytes, 0);
});
