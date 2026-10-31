// Shared setup for scenario tests that start from an empty world: a clean database and a clean fake Steam.
import assert from 'node:assert/strict';
import { fakeJwt, installFakeSteam, tempDataDir } from './fake-steam.mjs';

tempDataDir();
export const steam = installFakeSteam();
export { fakeJwt };
export const DAY = 86400_000;

const fakeFetch = globalThis.fetch;
export const hooks = { fn: null };
globalThis.fetch = async (input, init = {}) => {
  if (hooks.fn) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const r = await hooks.fn(url, init);
    if (r) return r;
  }
  return fakeFetch(input, init);
};

export const db = await import('../dist/db.js');
export const { q, setSettings, getAccountByName, getAccount, updateAccount } = db;
export const { encrypt, decrypt } = await import('../dist/crypto.js');
export const groups = await import('../dist/groups.js');
export const { cycle, requestCheck } = await import('../dist/scheduler.js');
export const jobs = await import('../dist/jobs.js');
export const sync = await import('../dist/sync.js');
export const views = await import('../dist/views.js');
export const telegram = await import('../dist/telegram.js');
export const notify = await import('../dist/notify.js');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CS2 = 730;
export const SQUAD = 393380;
export const c = (n) => String(1000 + n);
export const s = (n) => String(2000 + n);
export const M = '76561190000000001';
export const A = '76561190000000002';
export const B = '76561190000000003';
export const C = '76561190000000004';
export const N = '76561190000000005';

const TABLES = ['job_group_items', 'pending_notes', 'write_log', 'job_items', 'jobs', 'approvals', 'group_collections', 'group_items', 'group_members', 'group_apps', 'groups',
  'account_items', 'account_apps', 'accounts', 'items', 'events', 'outbox'];

export function reset() {
  hooks.fn = null;
  for (const t of TABLES) q(`DELETE FROM ${t}`).run();
  q("DELETE FROM settings WHERE key LIKE 'internal:pause_%'").run();
  steam.users.clear();
  steam.items.clear();
  steam.collections.clear();
  steam.requests.length = 0;
  steam.telegram.length = 0;
  steam.throttleWrites = false;
  steam.apiRefusesToken = false;
  steam.brokenPages = 0;
  steam.ghostWrites = false;
  steam.hidden.clear();
  Object.assign(sync.syncState, { pausedUntil: 0, loginPausedUntil: 0, loginPauseMs: 0, writePausedUntil: 0 });
  setSettings({
    write_gap_ms: '0', login_gap_seconds: '0', removal_hold_threshold: '3', writes_per_run: '30', concurrency: '4',
    telegram_enabled: '1', telegram_bot_token: 'test', telegram_chat_id: '1',
  });
}

export function addAccount(username, steamid, { main = false, vanity, password = 'pw' } = {}) {
  const u = steam.addUser(steamid, vanity);
  q(`INSERT INTO accounts (username, password_enc, steamid, refresh_token_enc, token_expires_at, status, is_main, created_at)
     VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`).run(username, password ? encrypt(password) : null, steamid, encrypt(u.refresh), Date.now() + 200 * DAY, main ? 1 : 0, Date.now());
  return getAccountByName(username).id;
}

export function trio() {
  return { idM: addAccount('mainacc', M, { main: true }), idA: addAccount('alpha', A), idB: addAccount('bravo', B) };
}

export async function round() {
  q('UPDATE accounts SET next_check_at = 0, next_attempt_at = 0').run();
  await cycle();
  await sleep(20);
}
export async function rounds(n) {
  for (let i = 0; i < n; i++) await round();
}
export const pendingTotal = () => [...groups.pendingCounts().values()].reduce((n, x) => n + x.pending, 0);
export async function settle(max = 8) {
  for (let i = 0; i < max; i++) {
    await round();
    if (!pendingTotal()) break;
  }
  await round();
}

export async function started(name, apps, memberIds) {
  const g = groups.createGroup(name, apps, memberIds);
  groups.groupAction(g, 'start');
  await round();
  assert.equal(groups.getGroup(g).state, 'preview', 'SETUP: group did not reach preview');
  groups.groupAction(g, 'confirm');
  await settle();
  return g;
}

export const has = (sid, id) => steam.subs(sid, steam.items.get(id).appid).includes(id);
export const itemState = (g, id) => q('SELECT state FROM group_items WHERE group_id = ? AND item_id = ?').get(g, id)?.state;

export function writeOf(url, init) {
  const m = url.pathname.match(/\/IPublishedFileService\/(Subscribe|Unsubscribe)\/v1\//);
  if (!m) return null;
  const f = new URLSearchParams(init.body?.toString() ?? '');
  const sid = JSON.parse(Buffer.from(f.get('access_token').split('.')[1], 'base64url')).sub;
  return { action: m[1].toLowerCase(), sid, id: f.get('publishedfileid'), appid: f.get('appid') };
}
export const eresult = (code) => new Response('{"response":{}}', { status: 200, headers: { 'x-eresult': String(code) } });
export const isPage = (url) => url.hostname === 'steamcommunity.com' && url.pathname.includes('/myworkshopfiles');
export const pageUser = (init) => new Headers(init.headers).get('cookie')?.match(/steamLoginSecure=(\d+)/)?.[1];
export const brokenBody = () => new Response(new ReadableStream({ pull(ctrl) { ctrl.error(new TypeError('terminated')); } }), { status: 200 });
