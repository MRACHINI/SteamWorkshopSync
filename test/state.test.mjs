// State machine scenarios, each from an empty world.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  A, B, C, CS2, M, N, SQUAD, addAccount, c, eresult, getAccount, groups, has, hooks, itemState, jobs, q, reset, round,
  rounds, s, setSettings, settle, started, steam, sync, trio, views, writeOf,
} from './harness.mjs';

const seed = (ids, appid, ...owners) => {
  for (const id of ids) {
    steam.addItem(id, appid);
    for (const o of owners) steam.subscribe(o, id);
  }
};

test('CONTROL a member pickup reaches everyone', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  steam.addItem(c(2), CS2);
  steam.subscribe(A, c(2));
  await settle();
  assert.ok(has(B, c(2)) && has(M, c(2)), 'SETUP: harness cannot sync');
});

test('removal hold counts across games', async () => {
  reset();
  const { idA, idB } = trio();
  const cs = [1, 2, 3, 4, 5, 6].map(c);
  const sq = [1, 2, 3, 4, 5, 6].map(s);
  seed(cs, CS2, M);
  seed(sq, SQUAD, M);
  await started('g', [CS2, SQUAD], [idA, idB]);
  const gone = [...cs.slice(0, 3), ...sq.slice(0, 3)];
  for (const id of gone) steam.unsubscribe(M, id);
  await rounds(3);
  assert.ok(gone.every((id) => has(A, id) && has(B, id)), `6 items left the main account (threshold 3), held ${groups.listHeld().length}, members were unsubscribed`);
});

test('removal hold counts items that go between two reads', async () => {
  reset();
  const { idA, idB } = trio();
  const cs = Array.from({ length: 12 }, (_, i) => c(i + 1));
  seed(cs, CS2, M);
  await started('g', [CS2], [idA, idB]);
  for (const id of cs.slice(0, 3)) steam.unsubscribe(M, id);
  await round();
  for (const id of cs.slice(3, 6)) steam.unsubscribe(M, id);
  await rounds(3);
  assert.ok(cs.slice(0, 6).every((id) => has(A, id)), `6 items left the main account across two reads, held ${groups.listHeld().length}, members were unsubscribed`);
});

test('the first read of a list does not revive a removed item', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2)], CS2, M); // a second item, so the list does not go empty (that path is held on purpose)
  const g = await started('g', [CS2], [idA, idB]);
  steam.unsubscribe(M, c(1));
  await rounds(4);
  assert.equal(itemState(g, c(1)), 'removed', 'SETUP');
  const idN = addAccount('november', N);
  steam.subscribe(N, c(1));
  groups.updateGroup(g, { memberIds: [idA, idB, idN] });
  await rounds(3);
  assert.equal(itemState(g, c(1)), 'removed', `a new member's first read revived an item removed through the main account (now ${itemState(g, c(1))}, main has it: ${has(M, c(1))})`);
});

test('a parked member is unsubscribed when it comes back', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1), c(2)], CS2, M);
  const g = await started('g', [CS2], [idA, idB]);
  q("UPDATE accounts SET status = 'needs_signin' WHERE id = ?").run(idB);
  steam.unsubscribe(M, c(1));
  await rounds(4);
  assert.equal(itemState(g, c(1)), 'removing', 'waits for the parked member');
  assert.ok(!has(A, c(1)), 'the others lose it meanwhile');
  q("UPDATE accounts SET status = 'ok' WHERE id = ?").run(idB);
  await rounds(3);
  assert.ok(!has(B, c(1)), 'the member still has the removed item after signing in again');
  assert.equal(itemState(g, c(1)), 'removed');
});

test('main cannot subscribe: held for approval, then members are unsubscribed', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('g', [CS2], [idA, idB]);
  steam.addItem(c(2), CS2);
  hooks.fn = (url, init) => {
    const w = writeOf(url, init);
    if (w?.action === 'subscribe' && w.sid === M) return eresult(15);
  };
  steam.subscribe(A, c(2));
  await rounds(4);
  const held = groups.listHeld();
  assert.equal(held.length, 1, 'held for the admin to decide');
  assert.match(held[0].held_reason, /refused/);
  assert.ok(has(A, c(2)), 'nobody loses it before the admin approves');
  groups.resolveHeld([c(2)], 'approve');
  await settle();
  assert.ok(!has(A, c(2)) && !has(B, c(2)), 'main was refused (eresult 15) and the members keep the item');
});

test('start preview counts items already added to the group', async () => {
  reset();
  const { idA, idB } = trio();
  steam.addItem(c(1), CS2);
  const g = groups.createGroup('g', [CS2], [idA, idB]);
  await groups.addToGroup(g, [c(1)], 5000);
  groups.groupAction(g, 'start');
  await round();
  const plan = JSON.parse(groups.getGroup(g).preview_json);
  groups.groupAction(g, 'confirm');
  await settle();
  assert.ok(plan.items.includes(c(1)), `preview said ${plan.items.length} items and ${plan.writes} subscriptions; confirming subscribed ${[M, A, B].filter((x) => has(x, c(1))).length} accounts`);
});

test('resuming a group does not override the admin group pick', async () => {
  reset();
  const { idA, idB } = trio();
  const idS = addAccount('shared', C);
  seed([c(1)], CS2, A);
  const g1 = await started('one', [CS2], [idA, idS]);
  const g2 = await started('two', [CS2], [idB, idS]);
  steam.addItem(c(2), CS2);
  steam.subscribe(M, c(2));
  await round();
  assert.equal(groups.listApprovals().length, 1, 'SETUP');
  groups.resolveApproval(c(2), g1);
  await settle();
  assert.ok(has(C, c(2)) && !has(B, c(2)), 'SETUP');
  groups.groupAction(g2, 'pause');
  groups.groupAction(g2, 'resume');
  await settle();
  assert.ok(!has(B, c(2)), `resume added the item to the group the admin did not pick (state ${itemState(g2, c(2))})`);
});

test('an unsubscribe job on a paused group is not undone on resume', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1), c(2)], CS2, M);
  const g = await started('g', [CS2], [idA, idB]);
  groups.groupAction(g, 'pause');
  const r = jobs.createJob('unsubscribe', [c(1)], [idM, idA, idB], false);
  assert.ok(r.jobId, 'SETUP');
  await settle();
  assert.ok(!has(A, c(1)), 'SETUP');
  groups.groupAction(g, 'resume');
  await settle();
  assert.ok(!has(A, c(1)) && !has(B, c(1)), 'resume subscribed every member again, the job was undone with no warning');
});

test('a job can unsubscribe an item that is gone from Steam', async () => {
  reset();
  groups.upsertItem(c(1), CS2, 'gone', '');
  const r = await jobs.resolveForJob([c(1)], 5000, 'unsubscribe');
  assert.ok(r.items.includes(c(1)), `skipped: ${JSON.stringify(r.skipped)}`);
  assert.equal((await jobs.resolveForJob([c(1)], 5000)).items.length, 0, 'it cannot be subscribed');
});

test('a never-verified main subscribe does not become a removal from everyone', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(3)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  steam.addItem(c(1), CS2);
  steam.addItem(c(2), CS2);
  let n = 0;
  hooks.fn = (url, init) => {
    const w = writeOf(url, init);
    if (!w || w.sid !== M || w.action !== 'subscribe') return;
    n++;
    return eresult(n === 1 ? 1 : 84); // accepted, never listed; then Steam throttles before verification runs
  };
  steam.subscribe(A, c(1));
  steam.subscribe(A, c(2));
  await rounds(2);
  assert.ok(n >= 2, `SETUP: only ${n} main writes`);
  hooks.fn = null;
  Object.assign(sync.syncState, { pausedUntil: 0, writePausedUntil: 0 });
  await rounds(4);
  assert.equal(itemState(g, c(1)), 'active', `item left the group (${itemState(g, c(1))}), members have it: ${has(A, c(1))}`);
});

test('a job handles collections nested inside a collection', async () => {
  reset();
  for (const n of [1, 2, 3]) steam.addItem(c(n), CS2);
  hooks.fn = (url, init) => {
    if (!url.pathname.endsWith('/GetCollectionDetails/v1/')) return;
    const f = new URLSearchParams(init.body.toString());
    const tree = {
      9001: [{ publishedfileid: c(1), filetype: 0 }, { publishedfileid: '9002', filetype: 2 }],
      9002: [{ publishedfileid: c(2), filetype: 0 }, { publishedfileid: c(3), filetype: 0 }],
    };
    const n = Number(f.get('collectioncount'));
    const collectiondetails = Array.from({ length: n }, (_, i) => {
      const id = f.get(`publishedfileids[${i}]`);
      return { publishedfileid: id, result: 1, ...(tree[id] ? { children: tree[id] } : {}) };
    });
    return new Response(JSON.stringify({ response: { result: 1, resultcount: n, collectiondetails } }), { status: 200 });
  };
  const r = await jobs.resolveForJob(['9001'], 5000);
  const seen = r.items.includes(c(2)) || r.skipped.some((x) => x.id === c(2) || x.id === '9002');
  assert.ok(seen, `nested items are neither in the job nor reported: items ${JSON.stringify(r.items)}, skipped ${JSON.stringify(r.skipped)}`);
});

test('pasting a blocked item keeps it blocked', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  groups.itemAction(g, c(1), 'block');
  await settle();
  await groups.addToGroup(g, [c(1)], 5000);
  await settle();
  assert.equal(itemState(g, c(1)), 'blocked', `block lifted silently, every member subscribed: ${has(A, c(1))}`);
});

test('a job with a parked account finishes or reports it', async () => {
  reset();
  const { idA, idB } = trio();
  steam.addItem(c(1), CS2);
  await jobs.resolveForJob([c(1)], 5000);
  q("UPDATE accounts SET status = 'needs_signin' WHERE id = ?").run(idB);
  const { jobId } = jobs.createJob('subscribe', [c(1)], [idA, idB], false);
  await rounds(3);
  const job = q('SELECT status FROM jobs WHERE id = ?').get(jobId);
  assert.notEqual(job.status, 'running', 'the job stays running with one item waiting on a parked account');
});

test('cancelling a job leaves the group consistent', async () => {
  reset();
  const { idM, idA, idB } = trio();
  seed([c(1), c(2)], CS2, M);
  const g = await started('g', [CS2], [idA, idB]);
  const { jobId } = jobs.createJob('unsubscribe', [c(1)], [idM, idA, idB], false);
  jobs.cancelJob(jobId);
  await rounds(2);
  const allGone = !has(A, c(1)) && !has(B, c(1)) && !has(M, c(1));
  assert.ok(allGone || itemState(g, c(1)) === 'active', `group says ${itemState(g, c(1))} but members still have the item`);
});

test('a job does not report done for a subscribe that never showed up', async () => {
  reset();
  const { idA } = trio();
  steam.addItem(c(1), CS2);
  await jobs.resolveForJob([c(1)], 5000);
  steam.ghostWrites = true;
  const { jobId } = jobs.createJob('subscribe', [c(1)], [idA], false);
  await rounds(2);
  steam.ghostWrites = false;
  const row = q('SELECT state FROM job_items WHERE job_id = ?').get(jobId);
  assert.equal(row.state, 'failed', `job item is ${row.state}, the item is not on the account`);
});

test('routing asks when a paused group shares the game', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  await started('one', [CS2], [idA]);
  const g2 = await started('two', [CS2], [idB]);
  groups.groupAction(g2, 'pause');
  steam.addItem(c(2), CS2);
  steam.subscribe(M, c(2));
  await round();
  assert.equal(groups.listApprovals().length, 1, 'the item went straight to the active group, the paused one was never offered');
});

test('a pick cannot choose a group that no longer syncs the game', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g1 = await started('one', [CS2], [idA]);
  await started('two', [CS2], [idB]);
  steam.addItem(c(2), CS2);
  steam.subscribe(M, c(2));
  await round();
  assert.equal(groups.listApprovals().length, 1, 'SETUP');
  groups.updateGroup(g1, { appids: [SQUAD] });
  let refused = false;
  try {
    groups.resolveApproval(c(2), g1);
  } catch {
    refused = true;
  }
  assert.ok(refused, 'the pick was accepted for a group that no longer syncs the game, so the item never syncs');
});

test('a removal finishes when its game leaves the group', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  seed([s(1)], SQUAD, A);
  const g = await started('g', [CS2, SQUAD], [idA, idB]);
  groups.itemAction(g, s(1), 'remove');
  groups.updateGroup(g, { appids: [CS2] });
  await rounds(3);
  assert.notEqual(itemState(g, s(1)), 'removing', `stuck in removing, member still has it: ${has(A, s(1))}`);
});

test('a stale held flag does not block the main account', async () => {
  reset();
  const { idA, idB } = trio();
  const cs = [1, 2, 3, 4, 5, 6].map(c);
  seed(cs, CS2, M);
  const g = await started('g', [CS2], [idA, idB]);
  for (const id of cs.slice(0, 4)) steam.unsubscribe(M, id);
  await rounds(3);
  assert.equal(groups.listHeld().length, 4, 'SETUP');
  groups.itemAction(g, cs[0], 'remove');
  await settle();
  q('UPDATE account_items SET unsubscribed_at = NULL').run();
  steam.subscribe(A, cs[0]);
  await rounds(4);
  assert.equal(itemState(g, cs[0]), 'active', 'SETUP');
  assert.ok(has(M, cs[0]), 'the item is active again but the main account is never subscribed');
});

test('items gone from Steam do not keep a group below 100%', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  steam.addItem(c(2), CS2);
  await groups.addToGroup(g, [c(2)], 5000);
  q("UPDATE items SET status = 'unavailable' WHERE id = ?").run(c(2));
  await rounds(2);
  const d = views.groupDetail(g);
  assert.equal(d.synced, d.cells, `group shows ${d.synced} of ${d.cells} in place forever, no write will ever close the gap`);
});

test('adding an item already in the group is not counted as added', async () => {
  reset();
  const { idA, idB } = trio();
  seed([c(1)], CS2, A);
  const g = await started('g', [CS2], [idA, idB]);
  const r = await groups.addToGroup(g, [c(1)], 5000);
  assert.equal(r.added, 0, `reported ${r.added} added`);
});

test('job details report the total when the list is cut off', async () => {
  reset();
  const { idM, idA, idB } = trio();
  const ids = Array.from({ length: 200 }, (_, i) => String(5000 + i));
  for (const id of ids) steam.addItem(id, CS2);
  await jobs.resolveForJob(ids, 5000);
  const { jobId } = jobs.createJob('subscribe', ids, [idM, idA, idB], false);
  assert.equal(jobs.jobFailures(jobId).length, 500);
  assert.equal(jobs.jobFailureTotal(jobId), 600);
  jobs.cancelJob(jobId);
});
