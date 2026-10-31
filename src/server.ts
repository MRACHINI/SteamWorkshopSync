import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ADMIN_PASSWORD, DATA_DIR, DEFAULT_SETTINGS, HOST, PORT, PUBLIC_ORIGIN, TLS_CERT_FILE, TLS_KEY_FILE, TRUST_PROXY } from './config.js';
import { encrypt, hashPassword, safeEqual, sign, verifyPassword } from './crypto.js';
import {
  STUCK, addEvent, getAccount, getAccountByName, getInternal, getSettings, numSetting, q, setInternal, setSettings, updateAccount,
} from './db.js';
import {
  type ItemAction, addToGroup, createGroup, deleteGroup, getGroup, groupAction, itemAction, listApprovals, listHeld,
  removeCollection, resolveApproval, resolveHeld, setMain, updateGroup, validateGroupInput,
} from './groups.js';
import { parseImportText, upsertAccount } from './importer.js';
import { cancelJob, createJob, jobFailureTotal, jobFailures, listJobs, previewJob, resolveForJob } from './jobs.js';
import { errMsg, log } from './log.js';
import { parseRefs } from './refs.js';
import { requestCheck, scanState, wakeScheduler } from './scheduler.js';
import { cancelSignin, getSignin, startPasswordSignin, startQrSignin, submitSigninCode } from './signin.js';
import { fetchCollections, fetchItemDetails } from './steam.js';
import { syncState, writesLastHour } from './sync.js';
import { failedCount, pendingCount, sendNow } from './telegram.js';
import { groupDetail, groupItemsList, groupSummaries, itemCells, publicAccounts } from './views.js';

const SESSION_MS = 30 * 24 * 3600_000;
/** How long a browser that signed in as admin keeps its own login limit. */
const DEVICE_MS = 365 * 24 * 3600_000;
/** With no sign of life from the sync for this long, the health check fails. */
const HEALTH_STALL_MS = 15 * 60_000;
/** Example values, which anyone could guess: treated as not set. */
const PLACEHOLDER_PASSWORDS = new Set(['change-me', 'changeme', 'change_me', 'password', 'admin']);
const MAIN_PASSWORD_REFUSED = "The main account's password is never stored. Leave it empty and sign the account in from the web UI.";
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60_000;
const SECRET_SETTINGS = new Set(['telegram_bot_token']);
const MAX_REFS = 500;

type Role = 'admin' | 'viewer';
// Routes reachable without a session.
const PUBLIC_ROUTES = new Set(['/api/login', '/api/logout']);
// The only routes a viewer may call (GET only). Everything else under /api/ is admin-only.
const VIEWER_ROUTES = new Set([
  '/api/me', '/api/state', '/api/events', '/api/groups', '/api/groups/:id', '/api/groups/:id/items',
  '/api/groups/:id/items/:item', '/api/approvals', '/api/jobs', '/api/jobs/:id',
]);

/** "example.com:443" and "example.com" are the same origin to a browser; compare them that way. */
function withoutDefaultPort(host: string, protocol: string): string {
  const scheme = protocol.replace(':', '');
  return host.replace(scheme === 'https' ? /:443$/ : /:80$/, '');
}

/**
 * What the login limiter counts failures by. A client on IPv6 usually controls a whole /64, so that is the unit
 * there; an IPv4 address written as IPv6 is the IPv4 address.
 */
function limiterKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return mapped;
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const start = head ? head.split(':') : [];
  const end = tail ? tail.split(':') : [];
  const groups = [...start, ...Array<string>(Math.max(0, 8 - start.length - end.length)).fill('0'), ...end];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function adminPassword(): string {
  if (ADMIN_PASSWORD && !PLACEHOLDER_PASSWORDS.has(ADMIN_PASSWORD.toLowerCase())) return ADMIN_PASSWORD;
  if (ADMIN_PASSWORD) log.warn(`ADMIN_PASSWORD is the example value "${ADMIN_PASSWORD}", which anyone could guess. It is ignored.`);
  const file = path.join(DATA_DIR, 'admin-password.txt');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(9).toString('base64url'), { mode: 0o600 });
  }
  const pw = fs.readFileSync(file, 'utf8').trim();
  log.warn(`ADMIN_PASSWORD is not set. Using the generated password stored in ${file}`);
  return pw;
}

const INT_SETTINGS: Record<string, [min: number, max: number, label: string]> = {
  check_interval_seconds: [60, 604800, 'Check interval'],
  full_read_hours: [1, 720, 'Full read interval'],
  concurrency: [1, 16, 'Accounts in parallel'],
  request_timeout_seconds: [5, 120, 'Request timeout'],
  write_gap_ms: [0, 60000, 'Pause between writes'],
  writes_per_run: [1, 1000, 'Writes per account per round'],
  writes_per_hour: [1, 100000, 'Writes per hour'],
  login_gap_seconds: [0, 600, 'Pause between password logins'],
  removal_hold_threshold: [0, 100000, 'Removal hold threshold'],
  token_warn_days: [1, 180, 'Sign-in expiry warning'],
  collection_refresh_hours: [1, 720, 'Collection refresh interval'],
  history_retention_days: [1, 3650, 'History retention'],
};
const FLAG_SETTINGS = ['telegram_enabled', 'notify_discovered', 'notify_reapplied', 'notify_removed', 'notify_account_problems'];
const REQUIRED_TEXT_SETTINGS: Record<string, string> = {
  template_discovered: 'New items template',
  template_reapplied: 'Subscribed again template',
  template_removed: 'Removed template',
  template_held: 'Removal held template',
  template_approval: 'Pick a group template',
  template_problem: 'Account problem template',
};

/** Returns an error message for the first invalid value in a settings update, or null. Only keys present are checked. */
function validateSettings(b: Record<string, unknown>): string | null {
  for (const [key, [min, max, label]] of Object.entries(INT_SETTINGS)) {
    if (!(key in b)) continue;
    const raw = String(b[key] ?? '').trim();
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < min || n > max) return `${label} must be a whole number from ${min} to ${max}`;
    b[key] = String(n);
  }
  for (const key of FLAG_SETTINGS) {
    if (key in b && b[key] !== '0' && b[key] !== '1') return `${key} must be 0 or 1`;
  }
  for (const [key, label] of Object.entries(REQUIRED_TEXT_SETTINGS)) {
    if (key in b && !String(b[key] ?? '').trim()) return `${label} cannot be empty`;
  }
  if ('timezone' in b) {
    const tz = String(b.timezone ?? '').trim();
    try {
      if (!tz) throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return `Unknown timezone "${tz}"`;
    }
    b.timezone = tz;
  }
  return null;
}

const idParam = (req: FastifyRequest, key = 'id') => Number((req.params as Record<string, string>)[key]);
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
const idList = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

export async function startServer(): Promise<{ close: () => Promise<void> }> {
  const password = adminPassword();

  // An admin password that also unlocks viewer access would turn every viewer into an admin.
  const viewerHashAtStart = getInternal('viewer_password_hash');
  if (viewerHashAtStart && (await verifyPassword(password, viewerHashAtStart))) {
    setInternal('viewer_password_hash', '');
    addEvent(null, 'admin', 'Viewer access disabled: the admin password equals the viewer password');
    log.warn('The admin password equals the viewer password. Viewer access has been disabled; set a new viewer password.');
  }

  let trustProxy: string | false = false;
  if (/^(1|true|yes|on)$/i.test(TRUST_PROXY)) {
    log.warn('TRUST_PROXY must list the proxy address(es), e.g. "127.0.0.1" or "172.16.0.0/12". Ignoring it.');
  } else if (TRUST_PROXY && !/^(0|false|no|off)$/i.test(TRUST_PROXY)) {
    trustProxy = TRUST_PROXY;
  }
  const https = TLS_CERT_FILE && TLS_KEY_FILE ? { https: { cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) } } : {};
  const options = { logger: false, bodyLimit: 2 * 1024 * 1024, ...https } as { logger: false; bodyLimit: number };
  let app;
  try {
    app = Fastify({ ...options, trustProxy });
  } catch (e) {
    log.error(`Invalid TRUST_PROXY "${TRUST_PROXY}" (${errMsg(e)}). Ignoring it.`);
    app = Fastify(options);
  }

  // --- auth ---------------------------------------------------------------
  // Session cookie = role.expiry.signature. The signature also covers the current password (hash) of that
  // role, so changing the admin or viewer password signs out every session of that role.
  // Login limiter: at most LOGIN_MAX_FAILURES failed attempts per IP in any sliding LOGIN_WINDOW_MS. A browser
  // that signed in as admin before has a limit of its own, so others failing from the same address (everyone
  // behind one proxy or NAT) cannot lock the admin out.
  const failures = new Map<string, { fails: number[]; pending: number }>();
  const dropOldFailures = (entry: { fails: number[] }, now: number) => {
    entry.fails = entry.fails.filter((t) => t > now - LOGIN_WINDOW_MS);
  };
  // Full cleanup only when the map has doubled since the last one, so a flood of distinct IPs cannot make
  // every login request walk the whole map.
  let pruneAbove = 1000;
  const pruneFailures = () => {
    const now = Date.now();
    for (const [ip, entry] of failures) {
      dropOldFailures(entry, now);
      if (!entry.fails.length && !entry.pending) failures.delete(ip);
    }
    pruneAbove = Math.max(1000, 2 * failures.size);
  };
  const passwordEpoch = (role: Role) =>
    role === 'admin' ? crypto.createHash('sha256').update(password).digest('base64url') : getInternal('viewer_password_hash');
  const makeToken = (role: Role) => {
    const exp = String(Date.now() + SESSION_MS);
    return `${role}.${exp}.${sign(`session:${role}:${exp}:${passwordEpoch(role)}`)}`;
  };
  const roleOf = (token: string | undefined): Role | null => {
    const [role, exp, sig] = (token ?? '').split('.');
    if ((role !== 'admin' && role !== 'viewer') || !exp || !sig || !(Number(exp) > Date.now())) return null;
    const epoch = passwordEpoch(role);
    if (!epoch) return null; // viewer access disabled
    if (!safeEqual(sig, sign(`session:${role}:${exp}:${epoch}`))) return null;
    return q('SELECT 1 FROM revoked_sessions WHERE sig = ?').get(sig) ? null : role;
  };
  const cookieOf = (req: FastifyRequest, name = 'sws_session') => req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
  const secure = (req: FastifyRequest) => (req.protocol === 'https' ? '; Secure' : '');
  const setSession = (req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) =>
    reply.header('Set-Cookie', `sws_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req)}`);
  const deviceSig = (exp: string) => sign(`device:${exp}:${passwordEpoch('admin')}`);
  const setDevice = (req: FastifyRequest, reply: FastifyReply) => {
    const exp = String(Date.now() + DEVICE_MS);
    reply.header('Set-Cookie', `sws_device=${exp}.${deviceSig(exp)}; Path=/api/login; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_MS / 1000}${secure(req)}`);
  };
  const knownDevice = (req: FastifyRequest) => {
    const [exp, sig] = (cookieOf(req, 'sws_device') ?? '').split('.');
    return !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, deviceSig(exp));
  };
  let proxyWarned = false;

  app.decorateRequest('role', null);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Decide by the matched route pattern, not the raw URL, so path tricks cannot skip the check.
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/')) return;
    // Cookie auth + JSON-only bodies, so state-changing calls must come from this app's own pages.
    if (req.method !== 'GET') {
      // Browsers set Sec-Fetch-Site themselves and scripts cannot forge it, and unlike Origin it survives a
      // reverse proxy that rewrites Host.
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string') {
        if (site !== 'same-origin' && site !== 'none') return reply.code(403).send({ error: 'cross-origin request refused' });
      } else if (req.headers.origin !== undefined) {
        // Older browsers send only Origin. req.host honours X-Forwarded-Host when the request came through a
        // trusted proxy; PUBLIC_ORIGIN covers a proxy that rewrites Host and sets neither.
        let origin = '';
        try {
          const u = new URL(req.headers.origin);
          origin = withoutDefaultPort(u.host, u.protocol);
        } catch {
          // "null" or garbage origin: refuse below
        }
        const allowed = [withoutDefaultPort(req.host, req.protocol)];
        if (PUBLIC_ORIGIN) {
          try {
            const p = new URL(PUBLIC_ORIGIN);
            allowed.push(withoutDefaultPort(p.host, p.protocol));
          } catch {
            // misconfigured; the host comparison still applies
          }
        }
        if (!origin || !allowed.includes(origin)) return reply.code(403).send({ error: 'cross-origin request refused' });
      }
    }
    if (PUBLIC_ROUTES.has(route)) return;
    const role = roleOf(cookieOf(req));
    if (!role) return reply.code(401).send({ error: 'unauthorized' });
    if (role === 'viewer' && !(req.method === 'GET' && VIEWER_ROUTES.has(route))) {
      return reply.code(403).send({ error: 'View-only access' });
    }
    (req as FastifyRequest & { role: Role }).role = role;
  });

  app.post('/api/login', async (req, reply) => {
    if (failures.size > pruneAbove) pruneFailures();
    if (!trustProxy && req.headers['x-forwarded-for'] && !proxyWarned) {
      proxyWarned = true;
      log.warn("Sign-ins come through a reverse proxy, but TRUST_PROXY is not set: every visitor shares one login limit. Set it to the proxy's address.");
    }
    const key = `${knownDevice(req) ? 'device:' : ''}${limiterKey(req.ip)}`;
    let entry = failures.get(key);
    if (!entry) failures.set(key, (entry = { fails: [], pending: 0 }));
    dropOldFailures(entry, Date.now());
    // Attempts still being checked count too: the viewer check is async, and concurrent requests must not
    // all get past this line before any of them has recorded its failure.
    if (entry.fails.length + entry.pending >= LOGIN_MAX_FAILURES) {
      return reply.code(429).send({ error: 'Too many attempts. Try again later.' });
    }
    entry.pending++;
    let role: Role | null = null;
    try {
      const { password: given } = (req.body ?? {}) as { password?: string };
      if (typeof given === 'string' && given) {
        const viewerHash = getInternal('viewer_password_hash');
        if (safeEqual(given, password)) role = 'admin';
        else if (viewerHash && (await verifyPassword(given, viewerHash))) role = 'viewer';
      }
    } finally {
      entry.pending--;
      if (!role) entry.fails.push(Date.now());
      // Only the admin password clears earlier failures. A viewer login leaves them (and their age) untouched,
      // so a viewer cannot reset the count between guesses at the admin password.
      if (role === 'admin') entry.fails = [];
      if (!entry.fails.length && !entry.pending && failures.get(key) === entry) failures.delete(key);
    }
    if (!role) {
      log.warn(`Failed web login from ${req.ip}`);
      return reply.code(401).send({ error: 'Wrong password' });
    }
    setSession(req, reply, makeToken(role), SESSION_MS / 1000);
    if (role === 'admin') setDevice(req, reply);
    return { ok: true, role };
  });

  app.post('/api/logout', async (req, reply) => {
    const token = cookieOf(req);
    if (roleOf(token)) {
      const [, exp, sig] = token!.split('.');
      q('INSERT OR IGNORE INTO revoked_sessions (sig, exp) VALUES (?, ?)').run(sig, Number(exp));
    }
    setSession(req, reply, '', 0);
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ role: (req as FastifyRequest & { role: Role }).role }));

  // --- state ---------------------------------------------------------------
  app.get('/api/state', async (req) => {
    const s = getSettings();
    return {
      now: Date.now(),
      role: (req as FastifyRequest & { role: Role }).role,
      timezone: s.timezone,
      tokenWarnDays: numSetting('token_warn_days', 1, 180),
      scan: {
        ...scanState,
        pausedUntil: syncState.pausedUntil,
        loginPausedUntil: syncState.loginPausedUntil,
        writePausedUntil: syncState.writePausedUntil,
        writesLastHour: writesLastHour(),
        writesPerHour: numSetting('writes_per_hour', 1, 1_000_000),
        checkInterval: Number(s.check_interval_seconds),
      },
      telegram: {
        configured: !!s.telegram_bot_token && !!s.telegram_chat_id, enabled: s.telegram_enabled === '1',
        pending: pendingCount(), failed: failedCount(),
      },
      approvals: (q("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n,
      held: (q('SELECT COUNT(*) AS n FROM account_items WHERE removal_held != 0').get() as { n: number }).n,
      runningJobs: (q("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'").get() as { n: number }).n,
      accounts: publicAccounts(),
      groups: groupSummaries(),
    };
  });

  // --- accounts ------------------------------------------------------------
  app.post('/api/accounts', async (req, reply) => {
    const b = body(req);
    try {
      const username = String(b.username ?? '').trim();
      const accountPassword = typeof b.password === 'string' ? b.password : '';
      if (b.is_main === true && accountPassword) return reply.code(400).send({ error: MAIN_PASSWORD_REFUSED });
      const result = upsertAccount({ username, password: accountPassword, note: typeof b.note === 'string' ? b.note : undefined });
      const saved = getAccountByName(username)!;
      if (b.is_main === true && !saved.is_main) setMain(saved.id);
      addEvent(null, 'admin', `Account ${username} ${result}`);
      if (saved.password_enc && b.is_main !== true) requestCheck(saved.id);
      return { ok: true, result, id: saved.id };
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e) });
    }
  });

  app.post('/api/accounts/import', async (req, reply) => {
    const added: string[] = [];
    const skipped: string[] = [];
    try {
      for (const it of parseImportText(String(body(req).text ?? ''))) {
        if (!it.password) throw new Error(`${it.username}: no password (add accounts without a password one at a time and sign them in)`);
        // Its password is never stored, and one line of a long list should not stop the rest.
        if (getAccountByName(it.username.trim())?.is_main) {
          skipped.push(it.username);
          continue;
        }
        upsertAccount(it);
        added.push(it.username);
      }
    } catch (e) {
      return reply.code(400).send({ error: `${errMsg(e)} (imported so far: ${added.length})` });
    }
    addEvent(null, 'admin', `Bulk import: ${added.length} accounts`);
    wakeScheduler();
    return { ok: true, count: added.length, skipped };
  });

  app.put('/api/accounts/:id', async (req, reply) => {
    const id = idParam(req);
    const acc = getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'not found' });
    const b = body(req);
    if (b.password && (b.is_main === true || (acc.is_main && b.is_main !== false))) return reply.code(400).send({ error: MAIN_PASSWORD_REFUSED });
    const fields: Parameters<typeof updateAccount>[1] = {};
    if (typeof b.note === 'string') fields.note = b.note;
    const enabling = b.enabled === true && !acc.enabled;
    if (typeof b.enabled === 'boolean') fields.enabled = b.enabled ? 1 : 0;
    if (typeof b.password === 'string' && b.password) {
      Object.assign(fields, {
        password_enc: encrypt(b.password), status: 'new', status_msg: '', fail_count: 0, next_attempt_at: 0, problem_notified: 0,
      });
    } else if (b.forget_password === true && acc.password_enc) {
      fields.password_enc = null;
    }
    updateAccount(id, fields);
    if (b.is_main === true && !acc.is_main) setMain(id);
    if (b.is_main === false && acc.is_main) setMain(null);
    if (b.password || enabling) requestCheck(id);
    else wakeScheduler();
    return { ok: true };
  });

  app.delete('/api/accounts/:id', async (req) => {
    const id = idParam(req);
    const acc = getAccount(id);
    if (acc) {
      q('DELETE FROM accounts WHERE id = ?').run(id);
      addEvent(null, 'admin', `Account ${acc.username} deleted (nothing was unsubscribed)`);
    }
    return { ok: true };
  });

  app.post('/api/accounts/:id/check', async (req, reply) => {
    const id = idParam(req);
    const acc = getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'not found' });
    if (!acc.enabled) return reply.code(409).send({ error: 'This account is disabled' });
    if (STUCK.has(acc.status)) {
      return reply.code(409).send({ error: acc.status === 'needs_signin' ? 'Sign this account in first' : 'Fix the account password first' });
    }
    updateAccount(id, { next_attempt_at: 0 });
    requestCheck(id, true);
    return { ok: true };
  });

  app.post('/api/accounts/:id/relogin', async (req, reply) => {
    const id = idParam(req);
    const acc = getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'not found' });
    updateAccount(id, {
      refresh_token_enc: null, cookies_enc: null, next_attempt_at: 0, fail_count: 0, problem_notified: 0,
      status: acc.password_enc ? 'new' : 'needs_signin', status_msg: acc.password_enc ? '' : 'Sign in from the web UI',
    });
    if (acc.password_enc) requestCheck(id);
    return { ok: true };
  });

  app.post('/api/check', async () => {
    syncState.pausedUntil = 0;
    requestCheck(); // every enabled account except the ones parked with a bad password or no sign-in
    return { ok: true };
  });

  // --- interactive sign-in (Steam Guard) -------------------------------------
  app.post('/api/accounts/:id/signin/qr', async (req, reply) => {
    try {
      return await startQrSignin(idParam(req));
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e) });
    }
  });

  app.post('/api/accounts/:id/signin/password', async (req, reply) => {
    const b = body(req);
    if (typeof b.password !== 'string' || !b.password) return reply.code(400).send({ error: 'Enter the password' });
    try {
      return await startPasswordSignin(idParam(req), b.password, b.remember === true);
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e) });
    }
  });

  app.get('/api/signin/:sid', async (req, reply) => {
    const s = getSignin(String((req.params as { sid: string }).sid));
    return s ?? reply.code(404).send({ error: 'This sign-in has expired. Start again.' });
  });

  app.post('/api/signin/:sid/code', async (req, reply) => {
    try {
      return await submitSigninCode(String((req.params as { sid: string }).sid), String(body(req).code ?? ''));
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e) });
    }
  });

  app.delete('/api/signin/:sid', async (req) => {
    cancelSignin(String((req.params as { sid: string }).sid));
    return { ok: true };
  });

  // --- groups --------------------------------------------------------------
  app.get('/api/groups', async () => ({ groups: groupSummaries() }));

  app.post('/api/groups', async (req, reply) => {
    const b = body(req);
    const v = validateGroupInput(b.name, b.appids);
    if (typeof v === 'string') return reply.code(400).send({ error: v });
    if (q('SELECT 1 FROM groups WHERE name = ?').get(v.name)) return reply.code(400).send({ error: 'A group with this name already exists' });
    const id = createGroup(v.name, v.appids, idList(b.members));
    return { ok: true, id };
  });

  app.get('/api/groups/:id', async (req, reply) => groupDetail(idParam(req)) ?? reply.code(404).send({ error: 'not found' }));

  app.put('/api/groups/:id', async (req, reply) => {
    const id = idParam(req);
    const g = getGroup(id);
    if (!g) return reply.code(404).send({ error: 'not found' });
    const b = body(req);
    const name = b.name !== undefined ? String(b.name).trim() : g.name;
    if (!name || name.length > 64) return reply.code(400).send({ error: 'Group name must be 1 to 64 characters' });
    let appids: number[] | undefined;
    if (b.appids !== undefined) {
      const v = validateGroupInput(name, b.appids);
      if (typeof v === 'string') return reply.code(400).send({ error: v });
      appids = v.appids;
    }
    const clash = q('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined;
    if (clash && clash.id !== id) return reply.code(400).send({ error: 'A group with this name already exists' });
    const toRead = updateGroup(id, { name, appids, memberIds: Array.isArray(b.members) ? idList(b.members) : undefined });
    for (const m of toRead) requestCheck(m, false);
    wakeScheduler();
    return { ok: true };
  });

  app.delete('/api/groups/:id', async (req) => {
    deleteGroup(idParam(req));
    return { ok: true };
  });

  app.post('/api/groups/:id/:action', async (req, reply) => {
    const action = String((req.params as { action: string }).action);
    if (!['start', 'confirm', 'pause', 'resume'].includes(action)) return reply.code(404).send({ error: 'not found' });
    try {
      const toRead = groupAction(idParam(req), action as 'start' | 'confirm' | 'pause' | 'resume');
      for (const m of toRead) requestCheck(m, action === 'start' || action === 'resume');
      wakeScheduler();
      return { ok: true };
    } catch (e) {
      return reply.code(409).send({ error: errMsg(e) });
    }
  });

  app.get('/api/groups/:id/items', async (req, reply) => {
    if (!getGroup(idParam(req))) return reply.code(404).send({ error: 'not found' });
    return { items: groupItemsList(idParam(req)) };
  });

  app.get('/api/groups/:id/items/:item', async (req) => ({
    cells: itemCells(idParam(req), String((req.params as { item: string }).item)),
  }));

  app.post('/api/groups/:id/items', async (req, reply) => {
    const id = idParam(req);
    const g = getGroup(id);
    if (!g) return reply.code(404).send({ error: 'not found' });
    const { ids, invalid } = parseRefs(String(body(req).text ?? ''));
    if (invalid.length) return reply.code(400).send({ error: `Not a Workshop link or id: ${invalid.slice(0, 5).join(', ')}` });
    if (!ids.length) return reply.code(400).send({ error: 'Paste Workshop item or collection links or ids' });
    if (ids.length > MAX_REFS) return reply.code(400).send({ error: `At most ${MAX_REFS} at a time` });
    try {
      const result = await addToGroup(id, ids, numSetting('request_timeout_seconds', 5, 120) * 1000);
      wakeScheduler();
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(502).send({ error: `Steam did not answer: ${errMsg(e)}` });
    }
  });

  app.post('/api/groups/:id/items/:item/:action', async (req, reply) => {
    const { item, action } = req.params as { item: string; action: string };
    if (!['block', 'unblock', 'remove', 'restore'].includes(action)) return reply.code(404).send({ error: 'not found' });
    try {
      itemAction(idParam(req), item, action as ItemAction);
      wakeScheduler();
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ error: errMsg(e) });
    }
  });

  app.delete('/api/groups/:id/collections/:cid', async (req) => {
    removeCollection(idParam(req), String((req.params as { cid: string }).cid));
    return { ok: true };
  });

  // --- main account: approvals and held removals ------------------------------
  app.get('/api/approvals', async () => ({ approvals: listApprovals(), held: listHeld() }));

  app.post('/api/approvals/:item', async (req, reply) => {
    const b = body(req);
    const groupId = b.group_id === null ? null : Number(b.group_id);
    if (groupId !== null && !Number.isInteger(groupId)) return reply.code(400).send({ error: 'group_id must be a group id or null' });
    try {
      resolveApproval(String((req.params as { item: string }).item), groupId);
      wakeScheduler();
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ error: errMsg(e) });
    }
  });

  app.post('/api/held', async (req, reply) => {
    const b = body(req);
    if (b.action !== 'approve' && b.action !== 'restore') return reply.code(400).send({ error: 'action must be approve or restore' });
    const items = b.items === 'all' ? 'all' : Array.isArray(b.items) ? b.items.map(String) : null;
    if (!items) return reply.code(400).send({ error: 'items must be a list or "all"' });
    const n = resolveHeld(items, b.action);
    wakeScheduler();
    return { ok: true, count: n };
  });

  // --- one-shot jobs --------------------------------------------------------
  app.get('/api/jobs', async () => ({ jobs: listJobs() }));

  app.get('/api/jobs/:id', async (req) => ({ items: jobFailures(idParam(req)), total: jobFailureTotal(idParam(req)) }));

  app.post('/api/jobs', async (req, reply) => {
    const b = body(req);
    if (b.action !== 'subscribe' && b.action !== 'unsubscribe') return reply.code(400).send({ error: 'action must be subscribe or unsubscribe' });
    const { ids, invalid } = parseRefs(String(b.text ?? ''));
    if (invalid.length) return reply.code(400).send({ error: `Not a Workshop link or id: ${invalid.slice(0, 5).join(', ')}` });
    if (!ids.length) return reply.code(400).send({ error: 'Paste Workshop item or collection links or ids' });
    if (ids.length > MAX_REFS) return reply.code(400).send({ error: `At most ${MAX_REFS} at a time` });
    const accounts = idList(b.accounts);
    if (!accounts.length) return reply.code(400).send({ error: 'Select at least one account' });
    let resolved;
    try {
      resolved = await resolveForJob(ids, numSetting('request_timeout_seconds', 5, 120) * 1000, b.action);
    } catch (e) {
      return reply.code(502).send({ error: `Steam did not answer: ${errMsg(e)}` });
    }
    if (!resolved.items.length) return reply.code(400).send({ error: 'None of these items exist on Steam', skipped: resolved.skipped });
    try {
      if (b.preview === true) return { ...previewJob(b.action, resolved.items, accounts), skipped: resolved.skipped };
      const r = createJob(b.action, resolved.items, accounts, b.confirm === true);
      if (r.conflicts) return reply.code(409).send({ error: 'This job clashes with a group', conflicts: r.conflicts });
      wakeScheduler();
      return { ok: true, id: r.jobId, skipped: resolved.skipped };
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e) });
    }
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    cancelJob(idParam(req));
    return { ok: true };
  });

  // Looks items up on Steam (free API) so the UI can show what an id is before adding it.
  app.post('/api/resolve', async (req, reply) => {
    const { ids, invalid } = parseRefs(String(body(req).text ?? ''));
    if (ids.length > MAX_REFS) return reply.code(400).send({ error: `At most ${MAX_REFS} at a time` });
    try {
      const timeoutMs = numSetting('request_timeout_seconds', 5, 120) * 1000;
      const [details, colls] = await Promise.all([fetchItemDetails(ids, timeoutMs), fetchCollections(ids, timeoutMs)]);
      return {
        invalid,
        items: ids.map((id) => {
          const d = details.get(id);
          const c = colls.get(id);
          return {
            id, found: d?.result === 1, title: d?.title ?? '', appid: d?.appid ?? 0,
            collection: !!(c && c.result === 1 && c.children.length), children: c?.children.length ?? 0,
          };
        }),
      };
    } catch (e) {
      return reply.code(502).send({ error: `Steam did not answer: ${errMsg(e)}` });
    }
  });

  // --- settings --------------------------------------------------------------
  app.get('/api/settings', async () => {
    const s: Record<string, string | boolean> = { ...getSettings() };
    for (const k of SECRET_SETTINGS) {
      s[`${k}_set`] = !!s[k];
      s[k] = '';
    }
    s.viewer_password = '';
    s.viewer_password_set = !!getInternal('viewer_password_hash');
    return { settings: s, defaults: DEFAULT_SETTINGS };
  });

  app.put('/api/settings', async (req, reply) => {
    const b = { ...body(req) };
    for (const k of SECRET_SETTINGS) if (!b[k]) delete b[k]; // blank = keep current secret
    const invalid = validateSettings(b);
    if (invalid) return reply.code(400).send({ error: invalid });
    // Viewer password: blank = keep, viewer_password_clear = disable viewer access.
    const viewerPw = typeof b.viewer_password === 'string' ? b.viewer_password : '';
    if (viewerPw) {
      if (viewerPw.length < 6) return reply.code(400).send({ error: 'Viewer password must be at least 6 characters' });
      if (safeEqual(viewerPw, password)) return reply.code(400).send({ error: 'Viewer password must differ from the admin password' });
    }
    setSettings(b);
    if (b.telegram_bot_token_clear === true) {
      setSettings({ telegram_bot_token: '' });
      addEvent(null, 'admin', 'Telegram bot token removed');
    }
    if (b.viewer_password_clear === true) {
      setInternal('viewer_password_hash', '');
      addEvent(null, 'admin', 'Viewer access disabled');
    } else if (viewerPw) {
      setInternal('viewer_password_hash', hashPassword(viewerPw));
      addEvent(null, 'admin', 'Viewer password changed');
    }
    addEvent(null, 'admin', 'Settings updated');
    wakeScheduler(); // apply a new interval right away without forcing extra Steam requests
    return { ok: true };
  });

  // Uses the values on screen where given, so they can be tried before saving them.
  app.post('/api/telegram/test', async (req, reply) => {
    const b = body(req);
    try {
      await sendNow('✅ SteamWorkshopSync test message', { token: String(b.telegram_bot_token ?? '').trim(), chatId: String(b.telegram_chat_id ?? '').trim() });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e) });
    }
  });

  // --- history / logs --------------------------------------------------------
  app.get('/api/events', async (req) => {
    const qs = req.query as { limit?: string; account?: string; type?: string; alerts?: string };
    const limit = Math.min(1000, Math.max(1, Number(qs.limit) || 200));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (qs.account) {
      where.push('username = ?');
      args.push(qs.account);
    }
    if (qs.type) {
      where.push('type = ?');
      args.push(qs.type);
    }
    if (qs.alerts === '1') where.push('alerted = 1');
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return { events: q(sql).all(...args, limit) };
  });

  app.get('/api/logs', async () => ({ logs: log.tail(400) }));

  app.get('/healthz', async (_req, reply) => {
    const ok = Date.now() - syncState.lastBeatAt < HEALTH_STALL_MS;
    return reply.code(ok ? 200 : 503).send({ ok, lastCycleAt: scanState.lastCycleAt });
  });

  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, '..', 'public') });

  await app.listen({ port: PORT, host: HOST });
  log.info(`Web interface listening on ${TLS_CERT_FILE && TLS_KEY_FILE ? 'https' : 'http'}://${HOST}:${PORT}`);
  return app;
}
