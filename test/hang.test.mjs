// U2: a library call that never settles. Runs alone because the stuck cycle cannot be recovered in-process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginSession } from 'steam-session';
import { A, CS2, c, cycle, getAccount, hooks, reset, setSettings, sleep, started, steam, trio, updateAccount } from './harness.mjs';

test('a stalled login library call does not freeze the scheduler', async () => {
  reset();
  const { idA, idB } = trio();
  steam.addItem(c(1), CS2);
  steam.subscribe(A, c(1));
  await started('g', [CS2], [idA, idB]);
  updateAccount(idA, { cookies_enc: null, next_check_at: 0 });
  hooks.fn = (url) => (url.pathname === '/jwt/refresh' ? new Response('<html></html>', { status: 200 }) : undefined);
  LoginSession.prototype.getWebCookies = () => new Promise(() => {});
  setSettings({ request_timeout_seconds: '5' });
  const r = await Promise.race([cycle().then(() => 'finished'), sleep(30_000).then(() => 'hung')]);
  assert.equal(r, 'finished', `the cycle never finished, so no account is read or written again (account ${getAccount(idA).username})`);
  assert.match(getAccount(idA).status_msg, /timeout/i);
});
