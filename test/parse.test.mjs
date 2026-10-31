// Parsers and write classification.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installFakeSteam, tempDataDir } from './fake-steam.mjs';

tempDataDir();
const steam = installFakeSteam();
const { parseSubsPage, setSubscription, refreshCookies, SteamError } = await import('../dist/steam.js');
const { parseRefs } = await import('../dist/refs.js');

const SID = '76561190000000001';
const page = (body, owner = `"${SID}"`) => `<html><script>g_steamID = ${owner};</script>${body}</html>`;
const entry = (id) => `<div class="workshopItemSubscription" id="Subscription${id}"><div class="workshopItemTitle">T${id}</div></div>`;

test('reads entries and paging, including thousands separators', () => {
  const p = parseSubsPage(page(`<div class="workshopBrowsePagingInfo">Showing 31-32 of 2,013 entries</div>${entry(5)}${entry(6)}`), SID);
  assert.deepEqual(p.items.map((i) => i.id), ['5', '6']);
  assert.equal(p.total, 2013);
  assert.equal(p.items[0].title, 'T5');
});

test('the empty-list message is the only "empty" there is', () => {
  assert.equal(parseSubsPage(page('<div id="no_items">No matching files were found.</div>'), SID).total, null);
  assert.throws(() => parseSubsPage(page('<div>nothing</div>'), SID), (e) => e instanceof SteamError && e.kind === 'temporary');
});

test('anonymous or other-user pages mean "not logged in"', () => {
  assert.throws(() => parseSubsPage(page(entry(1), 'false'), SID), (e) => e.kind === 'not_logged_in');
  assert.throws(() => parseSubsPage(page(entry(1), '"76561190000000099"'), SID), (e) => e.kind === 'not_logged_in');
});

test('a page with fewer entries than it promises is flagged, one with more is refused', () => {
  const short = page(`<div class="workshopBrowsePagingInfo">Showing 1-30 of 41 entries</div>${entry(1)}`);
  assert.equal(parseSubsPage(short, SID).short, true);
  const full = page(`<div class="workshopBrowsePagingInfo">Showing 1-2 of 2 entries</div>${entry(1)}${entry(2)}`);
  assert.equal(parseSubsPage(full, SID).short, false);
  const more = page(`<div class="workshopBrowsePagingInfo">Showing 1-1 of 2 entries</div>${entry(1)}${entry(2)}`);
  assert.throws(() => parseSubsPage(more, SID), (e) => e.kind === 'temporary');
});

test('pasted links and ids', () => {
  const r = parseRefs('https://steamcommunity.com/sharedfiles/filedetails/?id=3070193546\n123, https://steamcommunity.com/workshop/filedetails/?id=42&searchtext=x junk');
  assert.deepEqual(r.ids, ['3070193546', '123', '42']);
  assert.deepEqual(r.invalid, ['junk']);
});

test('write results: success, not found, throttled, and the community fallback', async () => {
  const u = steam.addUser(SID);
  steam.addItem('1', 730);
  const { cookies } = await refreshCookies({ steamid: SID, refreshToken: u.refresh }, 5000);
  assert.equal((await setSubscription('subscribe', { id: '1', appid: 730 }, cookies, 5000)).outcome, 'ok');
  assert.deepEqual(steam.subs(SID, 730), ['1']);
  assert.equal((await setSubscription('subscribe', { id: '999', appid: 730 }, cookies, 5000)).outcome, 'not_found');
  steam.throttleWrites = true;
  await assert.rejects(setSubscription('subscribe', { id: '1', appid: 730 }, cookies, 5000), (e) => e.kind === 'rate_limited');
  steam.throttleWrites = false;
  steam.apiRefusesToken = true;
  const before = steam.count((r) => r.path === '/sharedfiles/unsubscribe');
  assert.equal((await setSubscription('unsubscribe', { id: '1', appid: 730 }, cookies, 5000)).outcome, 'ok');
  assert.equal(steam.count((r) => r.path === '/sharedfiles/unsubscribe'), before + 1, 'went through the community endpoint');
  assert.deepEqual(steam.subs(SID, 730), []);
});
