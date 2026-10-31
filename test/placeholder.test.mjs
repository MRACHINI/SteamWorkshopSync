// The example password from older compose files is not accepted. A process of its own: the password is read once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { installFakeSteam, tempDataDir } from './fake-steam.mjs';

const dir = tempDataDir();
installFakeSteam();
process.env.PORT = String(19900 + Math.floor(Math.random() * 90));
process.env.HOST = '127.0.0.1';
process.env.ADMIN_PASSWORD = 'change-me';
const { startServer } = await import('../dist/server.js');
const server = await startServer();
after(() => server.close());

const login = (password) => fetch(`http://127.0.0.1:${process.env.PORT}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password }),
});

test('change-me does not sign in, the generated password does', async () => {
  assert.equal((await login('change-me')).status, 401);
  assert.equal((await login(fs.readFileSync(path.join(dir, 'admin-password.txt'), 'utf8').trim())).status, 200);
});
