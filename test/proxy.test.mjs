// What only applies behind a reverse proxy.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { installFakeSteam, tempDataDir } from './fake-steam.mjs';

tempDataDir();
installFakeSteam();
process.env.PORT = String(19500 + Math.floor(Math.random() * 400));
process.env.HOST = '127.0.0.1';
process.env.ADMIN_PASSWORD = 'admin-secret-1';
process.env.TRUST_PROXY = '127.0.0.1';
const { startServer } = await import('../dist/server.js');
const server = await startServer();
after(() => server.close());

const login = (password, headers = {}) => fetch(`http://127.0.0.1:${process.env.PORT}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  body: JSON.stringify({ password }),
});

test('rotating addresses cannot avoid the login limiter', async () => {
  const codes = [];
  for (let i = 1; i <= 30; i++) codes.push((await login('wrong', { 'x-forwarded-for': `2001:db8:1:1::${i.toString(16)}` })).status);
  assert.ok(codes.includes(429), `30 wrong logins from one /64 and never a 429 (${[...new Set(codes)].join(',')})`);
});

test('the session cookie is Secure on HTTPS', async () => {
  const r = await login('admin-secret-1', { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 200, 'SETUP');
  assert.match(r.headers.get('set-cookie'), /;\s*Secure/i, 'no Secure flag on an HTTPS session');
});
