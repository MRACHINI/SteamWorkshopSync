// Web API rules around passwords, sessions, the login limiter and what each route lets through.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { installFakeSteam, tempDataDir } from './fake-steam.mjs';

const dir = tempDataDir();
const steam = installFakeSteam();
process.env.PORT = String(19000 + Math.floor(Math.random() * 500));
process.env.HOST = '127.0.0.1';
process.env.ADMIN_PASSWORD = 'admin-secret-2';
const { q } = await import('../dist/db.js');
const { startServer } = await import('../dist/server.js');
const server = await startServer();
after(() => server.close());

const base = `http://127.0.0.1:${process.env.PORT}`;
const call = async (method, p, body, cookie, headers = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), 'sec-fetch-site': 'same-origin', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: cookies[0], device: cookies[1] };
};

let admin;
let device;
before(async () => {
  const r = await call('POST', '/api/login', { password: 'admin-secret-2' });
  admin = r.cookie;
  device = r.device;
});

const accountNamed = async (name) => (await call('GET', '/api/state', undefined, admin)).json.accounts.find((a) => a.username === name);

test('the main account password is refused when adding it', async () => {
  const r = await call('POST', '/api/accounts', { username: 'mainone', password: 'hunter22', is_main: true }, admin);
  assert.equal(r.status, 400);
  assert.equal(await accountNamed('mainone'), undefined);
  assert.equal((await call('POST', '/api/accounts', { username: 'mainone', is_main: true }, admin)).status, 200);
  assert.equal((await accountNamed('mainone')).has_password, false);
});

test('the main account password is refused through Edit', async () => {
  const a = await accountNamed('mainone');
  assert.equal((await call('PUT', `/api/accounts/${a.id}`, { password: 'hunter22' }, admin)).status, 400);
  assert.equal((await accountNamed('mainone')).has_password, false);
});

test('bulk import skips the main account and takes the rest', async () => {
  const r = await call('POST', '/api/accounts/import', { text: 'mainone:hunter22\nother_one:pw1' }, admin);
  assert.equal(r.json.count, 1);
  assert.deepEqual(r.json.skipped, ['mainone']);
  assert.equal((await accountNamed('mainone')).has_password, false);
  assert.equal((await accountNamed('other_one')).has_password, true);
});

test('an account made main loses its stored password', async () => {
  await call('POST', '/api/accounts', { username: 'promoted', password: 'pw1' }, admin);
  const a = await accountNamed('promoted');
  assert.equal((await call('PUT', `/api/accounts/${a.id}`, { is_main: true, password: 'pw2' }, admin)).status, 400, 'not with a new one either');
  assert.equal((await call('PUT', `/api/accounts/${a.id}`, { is_main: true }, admin)).status, 200);
  const after = await accountNamed('promoted');
  assert.equal(after.has_password, false);
  assert.equal(after.status, 'needs_signin');
  const events = (await call('GET', '/api/events?type=admin', undefined, admin)).json.events.map((e) => e.message).join('\n');
  assert.match(events, /promoted is now the main account, replacing mainone; its stored password was removed/);
  const m = await accountNamed('mainone');
  await call('PUT', `/api/accounts/${m.id}`, { is_main: true }, admin);
});

test('the Telegram token is encrypted and the database closed to other users', async () => {
  await call('PUT', '/api/settings', { telegram_bot_token: 'tok-123' }, admin);
  const row = q("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get();
  assert.notEqual(row.value, 'tok-123');
  assert.ok(!row.value.includes('tok-123'));
  assert.equal((await call('GET', '/api/settings', undefined, admin)).json.settings.telegram_bot_token_set, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'workshopsync.db')).mode & 0o077, 0);
});

test('the test message uses the values on screen', async () => {
  await call('POST', '/api/telegram/test', { telegram_bot_token: 'new-token', telegram_chat_id: '42' }, admin);
  assert.ok(steam.requests.some((r) => r.host === 'api.telegram.org' && r.path.startsWith('/botnew-token/')));
});

test('the Telegram token can be removed', async () => {
  await call('PUT', '/api/settings', { telegram_bot_token: '', telegram_bot_token_clear: true }, admin);
  assert.equal((await call('GET', '/api/settings', undefined, admin)).json.settings.telegram_bot_token_set, false);
});

test('Add account without a note keeps the existing note', async () => {
  await call('POST', '/api/accounts', { username: 'noted', password: 'pw1', note: 'keep me' }, admin);
  await call('POST', '/api/accounts', { username: 'noted', password: 'pw2', note: '' }, admin);
  assert.equal((await accountNamed('noted')).note, 'keep me');
});

test('tab re-import without a note keeps the existing note', async () => {
  await call('POST', '/api/accounts', { username: 'noted2', password: 'pw1', note: 'keep me' }, admin);
  await call('POST', '/api/accounts/import', { text: 'noted2\tpw2' }, admin);
  assert.equal((await accountNamed('noted2')).note, 'keep me');
});

test('the same job sent twice creates one job', async () => {
  steam.addItem('1001', 730);
  const a = await accountNamed('noted');
  const job = { action: 'subscribe', text: '1001', accounts: [a.id] };
  await Promise.all([call('POST', '/api/jobs', job, admin), call('POST', '/api/jobs', job, admin)]);
  assert.equal((await call('GET', '/api/jobs', undefined, admin)).json.jobs.length, 1);
});

test('an unsubscribe job can be previewed without creating it', async () => {
  steam.addItem('1002', 730);
  const a = await accountNamed('noted');
  const r = await call('POST', '/api/jobs', { action: 'unsubscribe', text: '1002', accounts: [a.id], preview: true }, admin);
  assert.deepEqual([r.json.items, r.json.accounts, r.json.writes], [1, 1, 1]);
  assert.equal((await call('GET', '/api/jobs', undefined, admin)).json.jobs.length, 1, 'nothing queued');
  const details = await call('GET', '/api/jobs/1', undefined, admin);
  assert.equal(details.json.total, details.json.items.length);
});

test('Check on a disabled account says so', async () => {
  await call('POST', '/api/accounts', { username: 'offline', password: 'pw1' }, admin);
  const a = await accountNamed('offline');
  await call('PUT', `/api/accounts/${a.id}`, { enabled: false }, admin);
  assert.equal((await call('POST', `/api/accounts/${a.id}/check`, {}, admin)).status, 409);
});

test('the health check answers', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('every route needs a session, and a view-only one writes nothing', async () => {
  const reads = ['/api/state', '/api/groups', '/api/groups/1', '/api/groups/1/items', '/api/approvals', '/api/jobs', '/api/jobs/1', '/api/events', '/api/settings', '/api/logs'];
  for (const p of reads) assert.equal((await call('GET', p)).status, 401, p);
  const writes = [
    ['POST', '/api/accounts'], ['POST', '/api/accounts/import'], ['PUT', '/api/accounts/1'], ['DELETE', '/api/accounts/1'], ['POST', '/api/accounts/1/check'],
    ['POST', '/api/accounts/1/relogin'], ['POST', '/api/accounts/1/signin/qr'], ['POST', '/api/check'], ['POST', '/api/groups'], ['PUT', '/api/groups/1'],
    ['DELETE', '/api/groups/1'], ['POST', '/api/groups/1/start'], ['POST', '/api/groups/1/items'], ['POST', '/api/approvals/1'], ['POST', '/api/held'],
    ['POST', '/api/jobs'], ['POST', '/api/jobs/1/cancel'], ['PUT', '/api/settings'], ['POST', '/api/telegram/test'],
  ];
  await call('PUT', '/api/settings', { viewer_password: 'viewer-pw-9' }, admin);
  const viewer = (await call('POST', '/api/login', { password: 'viewer-pw-9' })).cookie;
  for (const [m, p] of writes) {
    assert.equal((await call(m, p, m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
    assert.equal((await call(m, p, m === 'DELETE' ? undefined : {}, viewer)).status, 403, `${m} ${p} as viewer`);
  }
  assert.equal((await call('GET', '/api/logs', undefined, viewer)).status, 403);
});

test('a session token cannot be altered or used after its time', async () => {
  const [role, exp, sig] = admin.replace('sws_session=', '').split('.');
  const forged = (r, e, s) => `sws_session=${r}.${e}.${s}`;
  assert.equal((await call('GET', '/api/state', undefined, forged(role, exp, `${sig}x`))).status, 401);
  assert.equal((await call('GET', '/api/state', undefined, forged(role, String(Number(exp) + 1000), sig))).status, 401);
  assert.equal((await call('GET', '/api/state', undefined, forged(role, String(Date.now() - 1000), sig))).status, 401);
  assert.equal((await call('GET', '/api/state', undefined, forged('viewer', exp, sig))).status, 401);
});

test('signing out ends the session', async () => {
  const session = (await call('POST', '/api/login', { password: 'admin-secret-2' })).cookie;
  assert.equal((await call('GET', '/api/state', undefined, session)).status, 200);
  await call('POST', '/api/logout', {}, session);
  assert.equal((await call('GET', '/api/state', undefined, session)).status, 401);
  assert.equal((await call('GET', '/api/state', undefined, admin)).status, 200, 'other sessions stay');
});

test('failed logins from a shared address do not lock out a known admin browser', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'wrong' })).status, 429, 'the limit holds for everyone else');
  assert.equal((await call('POST', '/api/login', { password: 'admin-secret-2' }, device)).status, 200);
  assert.equal((await call('POST', '/api/login', { password: 'admin-secret-2' }, 'sws_device=1.forged')).status, 429, 'a made-up device gets no way in');
});
