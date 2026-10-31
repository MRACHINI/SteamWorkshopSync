// An error outside the scheduler's try block. Runs alone because it drops a table.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { q, sleep } from './harness.mjs';

const { runScheduler } = await import('../dist/scheduler.js');

test('a database error does not end the scheduler for good', async () => {
  q('DROP TABLE job_items').run();
  q('DROP TABLE accounts').run();
  let ended = null;
  runScheduler().catch((e) => { ended = e; });
  await sleep(1500);
  assert.equal(ended, null, `runScheduler ended (${ended?.message}) while the web UI and /healthz stay up`);
  process.exit(0); // the scheduler runs for ever
});
