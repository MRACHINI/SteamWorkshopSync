// Small rules that need no sync run.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { tempDataDir } from './fake-steam.mjs';

tempDataDir();
const { parseImportText } = await import('../dist/importer.js');
const { DEFAULT_SETTINGS } = await import('../dist/config.js');

test('a password keeps trailing whitespace on import', () => {
  assert.equal(parseImportText('gamer_01:pass word ')[0].password, 'pass word ', 'trailing whitespace dropped (matters only if Steam allows it)');
});

test('the test socket guard blocks plain net.connect', () => {
  let blocked = false;
  try {
    const s = net.connect({ host: 'example.invalid', port: 80 });
    s.on('error', () => {});
    s.destroy();
  } catch (e) {
    blocked = /test blocked/.test(e.message);
  }
  assert.ok(blocked, 'plain connections pass the guard');
});

test('the default write cap stays below the tested rate', () => {
  const tested = 160 / 4 * 60; // 160 writes in 4 minutes
  assert.ok(Number(DEFAULT_SETTINGS.writes_per_hour) <= tested, `default ${DEFAULT_SETTINGS.writes_per_hour}/h, tested average ${tested}/h`);
});
