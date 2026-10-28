// Offline Steam for the tests: replaces globalThis.fetch with a fake that serves the page and API shapes
// captured from the real Steam (subscriptions pages, Web API writes with x-eresult, free details API), and
// blocks every outbound socket except localhost, so a test can never reach the real Steam.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  const host = opts.host ?? 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !opts.path) throw new Error(`test blocked an outbound connection to ${host}`);
  return realConnect.apply(this, args);
};

export function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sws-test-'));
  process.env.DATA_DIR = dir;
  return dir;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeJwt = (sub, aud, ttlMs) => `${b64({ alg: 'none' })}.${b64({ sub, aud, exp: Math.floor((Date.now() + ttlMs) / 1000) })}.sig`;

export function installFakeSteam() {
  const realFetch = globalThis.fetch;
  let clock = 0;
  const steam = {
    users: new Map(), // steamid -> { vanity, refresh, access: Set, subs: Map<appid, Map<itemId, order>> }
    items: new Map(), // id -> { appid, title }
    collections: new Map(), // id -> [childIds]
    requests: [],
    telegram: [],
    throttleWrites: false,
    apiRefusesToken: false,
    /** Serve this many broken (half-rendered) subscription pages before answering normally. */
    brokenPages: 0,
    /** Answer subscribes with success without listing the item. */
    ghostWrites: false,
    /** Steam ids whose lists show the empty-list message, whatever they hold. */
    hidden: new Set(),

    addUser(steamid, vanity) {
      const u = { vanity, refresh: fakeJwt(steamid, ['web', 'renew', 'derive'], 200 * 86400_000), access: new Set(), subs: new Map() };
      steam.users.set(steamid, u);
      return u;
    },
    addItem(id, appid, title = `Item ${id}`) {
      steam.items.set(String(id), { appid, title });
    },
    subscribe(steamid, id) {
      const it = steam.items.get(String(id));
      const u = steam.users.get(steamid);
      if (!u.subs.has(it.appid)) u.subs.set(it.appid, new Map());
      const list = u.subs.get(it.appid);
      if (!list.has(String(id))) list.set(String(id), ++clock);
    },
    unsubscribe(steamid, id) {
      const it = steam.items.get(String(id));
      steam.users.get(steamid).subs.get(it.appid)?.delete(String(id));
    },
    subs(steamid, appid) {
      const list = steam.users.get(steamid).subs.get(appid) ?? new Map();
      return [...list.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    },
    count(filter) {
      return steam.requests.filter(filter).length;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };

  const reply = (status, body = '', headers = {}) => new Response(status === 204 || status === 302 ? null : body, { status, headers });
  const cookieOf = (init, name) => {
    const c = new Headers(init?.headers).get('cookie') ?? '';
    return c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] ?? null;
  };
  const formOf = (init) => new URLSearchParams(typeof init?.body === 'string' ? init.body : init?.body?.toString() ?? '');
  const userOfAccess = (token) => [...steam.users.entries()].find(([, u]) => u.access.has(token))?.[0] ?? null;

  function subsPage(steamid, viewer, url) {
    const appid = Number(url.searchParams.get('appid'));
    const page = Number(url.searchParams.get('p') || 1);
    const per = [10, 20, 30].includes(Number(url.searchParams.get('numperpage'))) ? Number(url.searchParams.get('numperpage')) : 10;
    const ids = steam.hidden.has(steamid) ? [] : steam.subs(steamid, appid);
    const slice = ids.slice((page - 1) * per, page * per);
    const head = `<html><head><title>Steam Community :: Someone :: Subscribed Items</title></head><body>
      <script>g_steamID = ${viewer ? `"${viewer}"` : 'false'};</script>`;
    if (steam.brokenPages > 0) {
      steam.brokenPages--;
      return `${head}<div class="workshopBrowsePagingInfo">Showing 1-30 of ${ids.length} entries</div></body></html>`;
    }
    if (!slice.length) return `${head}<div id="no_items">No matching files were found for Someone.</div></body></html>`;
    const from = (page - 1) * per + 1;
    return `${head}<div class="workshopBrowsePagingInfo">Showing ${from}-${from + slice.length - 1} of ${ids.length.toLocaleString('en-US')} entries</div>
      ${slice.map((id) => `<div class="workshopItemSubscription" id="Subscription${id}">
        <img class="workshopItemPreviewImage" src="https://img.example/${id}.jpg">
        <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${id}"><div class="workshopItemTitle">${steam.items.get(id)?.title ?? id}</div></a>
      </div>`).join('\n')}</body></html>`;
  }

  function write(action, steamid, id, appid) {
    if (steam.throttleWrites) return '84';
    const it = steam.items.get(String(id));
    if (!it) return action === 'subscribe' ? '9' : '1';
    if (Number(appid) !== it.appid) return '8';
    if (action === 'subscribe' && steam.ghostWrites) return '1';
    if (action === 'subscribe') steam.subscribe(steamid, id);
    else steam.unsubscribe(steamid, id);
    return '1';
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return realFetch(input, init);
    const rec = { method, host: url.hostname, path: url.pathname, query: url.search };
    steam.requests.push(rec);

    if (url.hostname === 'api.telegram.org') {
      steam.telegram.push(JSON.parse(init.body).text);
      return reply(200, '{"ok":true}');
    }

    if (url.hostname === 'login.steampowered.com' && url.pathname === '/jwt/refresh') {
      const [sid, token] = decodeURIComponent(cookieOf(init, 'steamRefresh_steam') ?? '').split('||');
      const u = steam.users.get(sid);
      if (!u || u.refresh !== token) return reply(302, '', { location: 'https://steamcommunity.com/login/home/' });
      return reply(302, '', { location: `https://steamcommunity.com/login/settoken?steamid=${sid}` });
    }

    if (url.hostname === 'steamcommunity.com') {
      if (url.pathname === '/login/settoken') {
        const sid = url.searchParams.get('steamid');
        const access = fakeJwt(sid, ['web:community'], 86400_000);
        steam.users.get(sid).access.add(access);
        return reply(302, '', { location: 'https://steamcommunity.com/', 'set-cookie': `steamLoginSecure=${sid}%7C%7C${access}; Path=/; Secure` });
      }
      const viewer = userOfAccess(decodeURIComponent(cookieOf(init, 'steamLoginSecure') ?? '').split('||')[1]);
      let m = url.pathname.match(/^\/profiles\/(\d+)\/myworkshopfiles\/?$/);
      if (m) {
        rec.steamid = m[1];
        const u = steam.users.get(m[1]);
        if (u?.vanity) return reply(302, '', { location: `https://steamcommunity.com/id/${u.vanity}/myworkshopfiles/${url.search}` });
        return reply(200, subsPage(m[1], viewer, url));
      }
      m = url.pathname.match(/^\/id\/([^/]+)\/myworkshopfiles\/?$/);
      if (m) {
        const sid = [...steam.users.entries()].find(([, u]) => u.vanity === m[1])?.[0];
        rec.steamid = sid;
        if (!sid) return reply(200, '<html><body><script>g_steamID = false;</script>The specified profile could not be found.</body></html>');
        return reply(200, subsPage(sid, viewer, url));
      }
      m = url.pathname.match(/^\/sharedfiles\/(subscribe|unsubscribe)$/);
      if (m && method === 'POST') {
        const f = formOf(init);
        if (!viewer || f.get('sessionid') !== cookieOf(init, 'sessionid')) return reply(200, '{"success":21}');
        rec.steamid = viewer;
        return reply(200, JSON.stringify({ success: Number(write(m[1], viewer, f.get('id'), f.get('appid'))) }));
      }
      return reply(404, 'not found');
    }

    if (url.hostname === 'api.steampowered.com') {
      const f = formOf(init);
      let m = url.pathname.match(/^\/IPublishedFileService\/(Subscribe|Unsubscribe)\/v1\/$/);
      if (m) {
        const sid = userOfAccess(f.get('access_token'));
        if (steam.apiRefusesToken || !sid) return reply(401, '<html>Unauthorized</html>');
        rec.steamid = sid;
        return reply(200, '{"response":{}}', { 'x-eresult': write(m[1].toLowerCase(), sid, f.get('publishedfileid'), f.get('appid')) });
      }
      if (url.pathname === '/ISteamRemoteStorage/GetPublishedFileDetails/v1/') {
        const n = Number(f.get('itemcount'));
        const details = Array.from({ length: n }, (_, i) => {
          const id = f.get(`publishedfileids[${i}]`);
          const it = steam.items.get(id);
          return it ? { publishedfileid: id, result: 1, consumer_app_id: it.appid, title: it.title, preview_url: '', file_size: '1000', banned: 0 }
            : { publishedfileid: id, result: 9 };
        });
        return reply(200, JSON.stringify({ response: { result: 1, resultcount: n, publishedfiledetails: details } }));
      }
      if (url.pathname === '/ISteamRemoteStorage/GetCollectionDetails/v1/') {
        const n = Number(f.get('collectioncount'));
        const details = Array.from({ length: n }, (_, i) => {
          const id = f.get(`publishedfileids[${i}]`);
          const children = steam.collections.get(id);
          return children ? { publishedfileid: id, result: 1, children: children.map((c, k) => ({ publishedfileid: c, sortorder: k, filetype: 0 })) }
            : { publishedfileid: id, result: 1 };
        });
        return reply(200, JSON.stringify({ response: { result: 1, resultcount: n, collectiondetails: details } }));
      }
    }
    throw new Error(`fake Steam has no route for ${method} ${url.href}`);
  };
  return steam;
}
