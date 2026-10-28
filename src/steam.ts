import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { EAuthTokenPlatformType, EResult, LoginSession } from 'steam-session';
import { USER_AGENT } from './config.js';

export type SteamErrorKind =
  | 'bad_credentials' // wrong password / disabled account: do not retry until the account is edited
  | 'needs_guard' // Steam Guard code requested: the account has to be signed in from the web UI
  | 'needs_signin' // no stored password and no usable sign-in
  | 'rate_limited' // Steam is throttling page loads or writes
  | 'login_throttled' // Steam is throttling password logins from this IP
  | 'not_logged_in' // session cookies rejected
  | 'token_invalid' // refresh token rejected
  | 'temporary'; // network / 5xx / unexpected page

export class SteamError extends Error {
  constructor(
    public kind: SteamErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface Tokens {
  steamid: string;
  refreshToken: string;
}

function jwtPayload(token: string): { exp?: number; sub?: string } {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Epoch ms at which the JWT expires (0 if unreadable). */
export function jwtExpiresAt(token: string): number {
  const exp = jwtPayload(token).exp;
  return exp ? exp * 1000 : 0;
}

/** Milliseconds until the JWT expires (negative if already expired, 0 if unreadable). */
export function jwtExpiresIn(token: string): number {
  const at = jwtExpiresAt(token);
  return at ? at - Date.now() : 0;
}

export function steamidFromToken(token: string): string | null {
  return jwtPayload(token).sub ?? null;
}

export function mapEresult(e: unknown): SteamError {
  const err = e as Error & { eresult?: number };
  if (err instanceof SteamError) return err;
  switch (err?.eresult) {
    case EResult.InvalidPassword:
    case EResult.AccountNotFound:
    case EResult.IllegalPassword:
    case EResult.AccountDisabled:
      return new SteamError('bad_credentials', `Steam rejected the credentials (${err.message})`);
    case EResult.RateLimitExceeded:
    case EResult.AccountLoginDeniedThrottle:
      return new SteamError('login_throttled', `Steam is throttling logins (${err.message})`);
    case EResult.AccessDenied:
    case EResult.Expired:
      return new SteamError('token_invalid', `Steam rejected the token (${err.message})`);
  }
  return new SteamError('temporary', err?.message ?? String(e));
}

export function newLoginSession(): LoginSession {
  return new LoginSession(EAuthTokenPlatformType.WebBrowser, { userAgent: USER_AGENT });
}

/** Full username/password login. Only used when there is no valid refresh token. */
export async function loginWithPassword(username: string, password: string): Promise<Tokens> {
  const session = newLoginSession();
  session.loginTimeout = 30_000;
  try {
    const start = await session.startWithCredentials({ accountName: username, password });
    if (start.actionRequired) {
      session.cancelLoginAttempt();
      throw new SteamError('needs_guard', 'Steam Guard is on for this account. Sign it in from the web UI.');
    }
    await new Promise<void>((resolve, reject) => {
      session.once('authenticated', () => resolve());
      session.once('timeout', () => reject(new SteamError('temporary', 'Login timed out')));
      session.once('error', (err) => reject(err));
    });
    return { steamid: session.steamID.getSteamID64(), refreshToken: session.refreshToken };
  } catch (e) {
    throw mapEresult(e);
  }
}

interface HttpOptions {
  cookie?: string;
  method?: 'GET' | 'POST';
  body?: URLSearchParams;
  headers?: Record<string, string>;
  timeoutMs: number;
}

async function http(url: string, o: HttpOptions): Promise<Response> {
  try {
    return await fetch(url, {
      method: o.method ?? 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(o.cookie ? { Cookie: o.cookie } : {}),
        ...(o.body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
        ...o.headers,
      },
      body: o.body,
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    throw new SteamError('temporary', `Network error: ${(e as Error).message}`);
  }
}

function checkStatus(res: Response): void {
  if (res.status === 429) throw new SteamError('rate_limited', 'HTTP 429 from Steam');
  if (res.status >= 500) throw new SteamError('temporary', `HTTP ${res.status} from Steam`);
}

async function drain(res: Response): Promise<void> {
  await res.arrayBuffer().catch(() => undefined);
}

function pickCookie(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m && m[1] !== 'deleted') return m[1];
  }
  return null;
}

export const profileBase = (steamid: string) => `https://steamcommunity.com/profiles/${steamid}/`;

/**
 * Trade the long-lived refresh token for a fresh steamcommunity.com session cookie.
 * Same flow a real browser runs: login.steampowered.com/jwt/refresh -> steamcommunity.com/login/settoken.
 */
export async function refreshCookies(tokens: Tokens, timeoutMs: number): Promise<{ cookies: string; refreshToken: string }> {
  const refreshCookie = `steamRefresh_steam=${tokens.steamid}%7C%7C${tokens.refreshToken}`;
  const redir = `${profileBase(tokens.steamid)}myworkshopfiles/`;
  const res = await http(`https://login.steampowered.com/jwt/refresh?redir=${encodeURIComponent(redir)}`, { cookie: refreshCookie, timeoutMs });
  checkStatus(res);
  await drain(res);
  const location = res.headers.get('location') ?? '';
  if (!location.includes('/login/settoken')) {
    return refreshCookiesFallback(tokens);
  }
  // Steam may rotate the refresh token here.
  const rotated = pickCookie(res, 'steamRefresh_steam');
  const newRefresh = rotated ? decodeURIComponent(rotated).split('||')[1] || tokens.refreshToken : tokens.refreshToken;

  const res2 = await http(location, { timeoutMs });
  checkStatus(res2);
  await drain(res2);
  const loginSecure = pickCookie(res2, 'steamLoginSecure');
  if (!loginSecure) return refreshCookiesFallback(tokens);
  // Steam accepts any sessionid as long as the cookie and the form field match (double-submit CSRF).
  const sessionid = crypto.randomBytes(12).toString('hex');
  return { cookies: `steamLoginSecure=${loginSecure}; sessionid=${sessionid}`, refreshToken: newRefresh };
}

async function refreshCookiesFallback(tokens: Tokens): Promise<{ cookies: string; refreshToken: string }> {
  try {
    const session = newLoginSession();
    session.refreshToken = tokens.refreshToken;
    const all = await session.getWebCookies();
    const wanted = all
      .filter((c) => /domain=steamcommunity\.com/i.test(c) || !/domain=/i.test(c))
      .map((c) => c.split(';')[0]);
    if (!wanted.some((c) => c.startsWith('steamLoginSecure='))) {
      throw new SteamError('token_invalid', 'No steamcommunity.com session cookie returned');
    }
    return { cookies: [...new Set(wanted)].join('; '), refreshToken: tokens.refreshToken };
  } catch (e) {
    const mapped = mapEresult(e);
    // Anything that is not clearly transient means the token is unusable.
    if (mapped.kind === 'temporary' && !/network|timeout|ECONN|ENOTFOUND|HTTP error 5/i.test(mapped.message)) {
      throw new SteamError('token_invalid', mapped.message);
    }
    throw mapped;
  }
}

/** The access token inside steamLoginSecure (`<steamid>%7C%7C<jwt>`). */
export function accessTokenOf(cookies: string): string | null {
  return cookies.match(/steamLoginSecure=\d+%7C%7C([^;]+)/)?.[1] ?? null;
}

const communityCookie = (cookies: string) => `${cookies}; Steam_Language=english`;

// ---------------------------------------------------------------------------
// Subscription lists
// ---------------------------------------------------------------------------
/** Steam accepts 10, 20 or 30 entries per page; anything else falls back to 10. */
export const PAGE_SIZE = 30;

export interface SubItem {
  id: string;
  title: string;
  preview: string;
}

export interface SubsPage {
  /** Total subscriptions for this game; null on an empty page (no list, or past the last page). */
  total: number | null;
  from: number;
  to: number;
  items: SubItem[];
}

export const subsUrl = (base: string, appid: number, page: number) =>
  `${base}myworkshopfiles/?browsefilter=mysubscriptions&appid=${appid}&sortmethod=subscriptiondate&numperpage=${PAGE_SIZE}&p=${page}`;

/**
 * Parse one page of "Subscribed Items". Newest subscriptions come first.
 * Never reads a broken, anonymous or other-user page as "nothing there".
 */
export function parseSubsPage(html: string, steamid: string): SubsPage {
  const loggedInAs = html.match(/g_steamID\s*=\s*"(\d+)"/)?.[1];
  if (!loggedInAs) throw new SteamError('not_logged_in', 'Subscriptions page rendered without a logged-in user');
  if (loggedInAs !== steamid) throw new SteamError('not_logged_in', `Subscriptions page rendered for another user (${loggedInAs})`);
  const $ = cheerio.load(html);
  const items = $('.workshopItemSubscription[id^="Subscription"]').toArray().map((el) => ({
    id: ($(el).attr('id') ?? '').slice('Subscription'.length),
    title: $(el).find('.workshopItemTitle').first().text().trim(),
    preview: $(el).find('img.workshopItemPreviewImage').attr('src') ?? '',
  }));
  if (items.some((i) => !/^\d+$/.test(i.id))) throw new SteamError('temporary', 'Unreadable item id on the subscriptions page');
  if (!items.length) {
    // The empty list and a page past the end both show this message.
    if ($('#no_items').length) return { total: null, from: 0, to: 0, items: [] };
    throw new SteamError('temporary', 'Subscriptions page shows neither items nor the empty-list message');
  }
  // "Showing 1-30 of 2,013 entries": read the three numbers, whatever the wording around them.
  const nums = ($('.workshopBrowsePagingInfo').first().text().match(/\d[\d,.]*/g) ?? []).map((n) => Number(n.replace(/[,.]/g, '')));
  if (nums.length < 3) throw new SteamError('temporary', 'Paging information missing from the subscriptions page');
  const [from, to, total] = nums;
  if (to - from + 1 !== items.length || total < to) {
    throw new SteamError('temporary', `Half-rendered subscriptions page (${items.length} entries for ${from}-${to} of ${total})`);
  }
  return { total, from, to, items };
}

/**
 * GET one page of the account's subscriptions. `base` is the cached profile URL; Steam redirects
 * /profiles/<id>/ to the custom URL, and a custom URL that changed is retried once under /profiles/<id>/.
 * Returns the base the page was finally served from, so the caller can cache it.
 */
export async function fetchSubsPage(
  steamid: string, base: string, appid: number, page: number, cookies: string, timeoutMs: number,
): Promise<{ page: SubsPage; base: string }> {
  const load = async (start: string) => {
    let url = subsUrl(start, appid, page);
    let res: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      res = await http(url, { cookie: communityCookie(cookies), timeoutMs });
      checkStatus(res);
      if (res.status < 300 || res.status >= 400) break;
      await drain(res);
      const location = new URL(res.headers.get('location') ?? '', url);
      if (location.hostname !== 'steamcommunity.com' || !location.pathname.includes('/myworkshopfiles')) {
        throw new SteamError('not_logged_in', `Redirected to ${location.origin}${location.pathname}`);
      }
      url = location.toString();
    }
    if (!res || res.status !== 200) {
      if (res) await drain(res);
      throw new SteamError('temporary', `Subscriptions page returned HTTP ${res?.status}`);
    }
    const parsed = parseSubsPage(await res.text(), steamid);
    return { page: parsed, base: url.slice(0, url.indexOf('myworkshopfiles')) };
  };
  const canonical = profileBase(steamid);
  if (base === canonical) return load(canonical);
  try {
    return await load(base);
  } catch (e) {
    if (e instanceof SteamError && (e.kind === 'not_logged_in' || e.kind === 'temporary')) return load(canonical);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe
// ---------------------------------------------------------------------------
export type WriteOutcome = 'ok' | 'not_found' | 'denied' | 'failed';

export interface WriteResult {
  outcome: WriteOutcome;
  /** Steam's EResult code, as a string. */
  code: string;
  message: string;
}

const eresultName = (code: string) => (EResult as unknown as Record<number, string>)[Number(code)] ?? `code ${code}`;

/** Steam's answer to a write, as an outcome. Session-level answers are thrown so the session can be renewed. */
function classify(code: string, action: string): WriteResult {
  const name = eresultName(code);
  switch (code) {
    case '1':
      return { outcome: 'ok', code, message: '' };
    case '84':
      throw new SteamError('rate_limited', `Steam is throttling ${action}s (${name})`);
    case '21':
      throw new SteamError('not_logged_in', `Steam says the session is not logged on (${name})`);
    case '9':
      return { outcome: 'not_found', code, message: 'Item not found on Steam (removed or private)' };
    case '15':
      return { outcome: 'denied', code, message: `Steam refused the ${action} (${name}); the account may not own the game` };
    default:
      return { outcome: 'failed', code, message: `Steam refused the ${action} (${name})` };
  }
}

/**
 * Subscribe or unsubscribe one item. Uses the Web API with the session's access token, which answers with
 * an exact EResult in the x-eresult header (the body is empty for success and failure alike). Falls back to
 * the community endpoint the item page's own button posts to when the Web API refuses the token.
 */
export async function setSubscription(
  action: 'subscribe' | 'unsubscribe', item: { id: string; appid: number }, cookies: string, timeoutMs: number,
): Promise<WriteResult> {
  const token = accessTokenOf(cookies);
  if (token) {
    const res = await http(`https://api.steampowered.com/IPublishedFileService/${action === 'subscribe' ? 'Subscribe' : 'Unsubscribe'}/v1/`, {
      method: 'POST',
      body: new URLSearchParams({
        access_token: token, publishedfileid: item.id, list_type: '1', appid: String(item.appid),
        // Lets a running Steam client start the download right away.
        notify_client: action === 'subscribe' ? '1' : '0',
      }),
      timeoutMs,
    });
    checkStatus(res);
    await drain(res);
    const code = res.headers.get('x-eresult');
    if (res.status === 200 && code) return classify(code, action);
    // 401/403 or no result code: the Web API did not accept the token. Try what the browser does.
  }

  const sessionid = cookies.match(/sessionid=([^;]+)/)?.[1];
  if (!sessionid) throw new SteamError('not_logged_in', 'No sessionid cookie for the write');
  const res = await http(`https://steamcommunity.com/sharedfiles/${action}`, {
    method: 'POST',
    cookie: communityCookie(cookies),
    body: new URLSearchParams({ id: item.id, appid: String(item.appid), sessionid }),
    headers: {
      Origin: 'https://steamcommunity.com',
      Referer: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeoutMs,
  });
  if (res.status >= 300 && res.status < 400) {
    await drain(res);
    throw new SteamError('not_logged_in', `The ${action} was redirected to ${res.headers.get('location') ?? 'elsewhere'}`);
  }
  checkStatus(res);
  const text = await res.text();
  if (res.status !== 200) throw new SteamError('temporary', `The ${action} returned HTTP ${res.status}`);
  let success: unknown;
  try {
    success = (JSON.parse(text) as { success?: unknown }).success;
  } catch {
    // Steam answers JSON to a logged-in session; a page instead means the session was not accepted.
    throw new SteamError('not_logged_in', `The ${action} did not return JSON`);
  }
  if (success === undefined || success === null) throw new SteamError('temporary', `The ${action} returned no result`);
  return classify(String(success), action);
}

// ---------------------------------------------------------------------------
// Free reads: item and collection details need no sign-in
// ---------------------------------------------------------------------------
export interface ItemDetails {
  id: string;
  /** EResult: 1 = ok, 9 = not found */
  result: number;
  appid: number;
  title: string;
  preview: string;
  size: number;
  banned: boolean;
}

async function remoteStorage(fn: string, body: URLSearchParams, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await http(`https://api.steampowered.com/ISteamRemoteStorage/${fn}/v1/`, { method: 'POST', body, timeoutMs });
  checkStatus(res);
  if (res.status !== 200) {
    await drain(res);
    throw new SteamError('temporary', `${fn} returned HTTP ${res.status}`);
  }
  try {
    return ((await res.json()) as { response?: Record<string, unknown> }).response ?? {};
  } catch {
    throw new SteamError('temporary', `${fn} did not return JSON`);
  }
}

const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function fetchItemDetails(ids: string[], timeoutMs: number): Promise<Map<string, ItemDetails>> {
  const out = new Map<string, ItemDetails>();
  for (const part of chunks(ids, 100)) {
    const body = new URLSearchParams({ itemcount: String(part.length) });
    part.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
    const r = await remoteStorage('GetPublishedFileDetails', body, timeoutMs);
    for (const d of (r.publishedfiledetails ?? []) as Record<string, unknown>[]) {
      const id = String(d.publishedfileid ?? '');
      if (!id) continue;
      out.set(id, {
        id,
        result: Number(d.result) || 0,
        appid: Number(d.consumer_app_id) || 0,
        title: String(d.title ?? ''),
        preview: String(d.preview_url ?? ''),
        size: Number(d.file_size) || 0,
        banned: !!Number(d.banned),
      });
    }
  }
  return out;
}

export interface CollectionDetails {
  result: number;
  children: { id: string; filetype: number }[];
}

export async function fetchCollections(ids: string[], timeoutMs: number): Promise<Map<string, CollectionDetails>> {
  const out = new Map<string, CollectionDetails>();
  for (const part of chunks(ids, 100)) {
    const body = new URLSearchParams({ collectioncount: String(part.length) });
    part.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
    const r = await remoteStorage('GetCollectionDetails', body, timeoutMs);
    for (const c of (r.collectiondetails ?? []) as Record<string, unknown>[]) {
      const children = ((c.children ?? []) as Record<string, unknown>[]).map((ch) => ({
        id: String(ch.publishedfileid ?? ''),
        filetype: Number(ch.filetype) || 0,
      }));
      out.set(String(c.publishedfileid ?? ''), { result: Number(c.result) || 0, children: children.filter((ch) => ch.id) });
    }
  }
  return out;
}

/** Workshop file type of a collection in GetCollectionDetails children. */
export const FILETYPE_COLLECTION = 2;
