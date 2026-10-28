// Web API: sign-in, roles, cross-site protection, and that secrets never leave the server.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { installFakeSteam, tempDataDir } from './fake-steam.mjs';

tempDataDir();
installFakeSteam();
process.env.PORT = String(18000 + Math.floor(Math.random() * 1000));
process.env.HOST = '127.0.0.1';
process.env.ADMIN_PASSWORD = 'admin-secret-1';
const { startServer } = await import('../dist/server.js');
const server = await startServer();
after(() => server.close());

const base = `http://127.0.0.1:${process.env.PORT}`;
const call = async (method, path, body, cookie, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), 'sec-fetch-site': 'same-origin', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

let admin;

test('wrong password is refused, the admin password signs in', async () => {
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  const r = await call('POST', '/api/login', { password: 'admin-secret-1' });
  assert.equal(r.status, 200);
  admin = r.cookie;
  assert.match(admin, /^sws_session=/);
});

test('every API route needs a session', async () => {
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('GET', '/api/groups')).status, 401);
});

test('cross-site writes are refused', async () => {
  const r = await call('POST', '/api/check', {}, admin, { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
});

test('accounts never expose passwords or tokens', async () => {
  assert.equal((await call('POST', '/api/accounts', { username: 'gamer_01', password: 'hunter22', note: 'x' }, admin)).status, 200);
  assert.equal((await call('POST', '/api/accounts', { username: 'mainone', is_main: true }, admin)).status, 200);
  const r = await call('GET', '/api/state', undefined, admin);
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes('hunter22'));
  assert.ok(!/password_enc|refresh_token|cookies_enc/.test(text));
  const main = r.json.accounts.find((a) => a.username === 'mainone');
  assert.equal(main.is_main, true);
  assert.equal(main.status, 'needs_signin', 'an account without a password waits for a web sign-in');
});

test('groups validate their games, and the main account joins automatically', async () => {
  assert.equal((await call('POST', '/api/groups', { name: 'g', appids: 'abc' }, admin)).status, 400);
  const r = await call('POST', '/api/groups', { name: 'CS team', appids: '730', members: [1] }, admin);
  assert.equal(r.status, 200);
  const d = await call('GET', `/api/groups/${r.json.id}`, undefined, admin);
  assert.deepEqual(d.json.members.map((m) => m.username).sort(), ['gamer_01', 'mainone']);
});

test('a viewer can look but not change anything', async () => {
  assert.equal((await call('PUT', '/api/settings', { viewer_password: 'viewer-pw-9' }, admin)).status, 200);
  const v = (await call('POST', '/api/login', { password: 'viewer-pw-9' })).cookie;
  assert.equal((await call('GET', '/api/state', undefined, v)).status, 200);
  assert.equal((await call('GET', '/api/groups/1/items', undefined, v)).status, 200);
  assert.equal((await call('POST', '/api/check', {}, v)).status, 403);
  assert.equal((await call('GET', '/api/settings', undefined, v)).status, 403);
  assert.equal((await call('POST', '/api/groups/1/start', {}, v)).status, 403);
});

test('settings are validated and secrets are not returned', async () => {
  assert.equal((await call('PUT', '/api/settings', { writes_per_hour: '0' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/settings', { telegram_bot_token: 'tok-123' }, admin)).status, 200);
  const s = await call('GET', '/api/settings', undefined, admin);
  assert.equal(s.json.settings.telegram_bot_token, '');
  assert.equal(s.json.settings.telegram_bot_token_set, true);
});

test('the UI is served', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Workshop Sync/);
});
