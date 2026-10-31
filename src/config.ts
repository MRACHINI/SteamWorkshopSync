import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
export const PORT = Number(process.env.PORT ?? 8080);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
export const SECRET_KEY = process.env.SECRET_KEY ?? '';
// Certificate and key files, to serve HTTPS directly instead of through a reverse proxy.
export const TLS_CERT_FILE = (process.env.TLS_CERT_FILE ?? '').trim();
export const TLS_KEY_FILE = (process.env.TLS_KEY_FILE ?? '').trim();
// Address(es) of the reverse proxy in front of the app, e.g. "127.0.0.1" or "172.18.0.5" (comma separated).
// Name the proxy itself: a wide range can include clients, which could then fake their address.
// Only requests coming from these addresses may set X-Forwarded-For / X-Forwarded-Host. Empty = no proxy.
// Deliberately not a yes/no switch: trusting every hop would let clients fake their IP and dodge the login limit.
export const TRUST_PROXY = (process.env.TRUST_PROXY ?? '').trim();
// The address people open the app at, e.g. "https://sync.example.com". Only needed behind a reverse proxy
// that rewrites Host, for browsers too old to send Sec-Fetch-Site; without it their sign-in is refused.
export const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? '').trim();

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Settings editable from the web UI. Values are stored as strings in the DB.
export const DEFAULT_SETTINGS = {
  // How often each account's subscription lists are checked. A check normally costs one page per game.
  check_interval_seconds: '900',
  // Every list is read in full at least this often, even when the counts add up.
  full_read_hours: '24',
  concurrency: '4',
  request_timeout_seconds: '20',
  // Subscribe/unsubscribe pacing. Steam took 160 writes in 4 minutes without throttling in testing, a rate of
  // 2400 per hour. The hourly cap stays at that rate because longer limits are unknown.
  write_gap_ms: '2000',
  writes_per_run: '30',
  writes_per_hour: '2400',
  // Password logins are spaced out so a batch of new accounts does not trip Steam's login throttle.
  login_gap_seconds: '15',
  // More items than this disappearing from the main account at once waits for approval instead of
  // being removed from every member.
  removal_hold_threshold: '10',
  // Warn this many days before a sign-in that cannot renew itself (no stored password) expires.
  token_warn_days: '14',
  collection_refresh_hours: '6',
  timezone: 'Asia/Beirut',
  telegram_enabled: '1',
  telegram_bot_token: '',
  telegram_chat_id: '',
  notify_discovered: '1',
  notify_reapplied: '1',
  notify_removed: '1',
  notify_account_problems: '1',
  history_retention_days: '90',
  template_discovered: ['📥 #NewItems #{group}', '{count} new from {accounts}', '{items}'].join('\n'),
  template_reapplied: ['🔁 #Resubscribed #{group}', '{count} subscribed again on {accounts}', '{items}'].join('\n'),
  template_removed: ['🗑 #Removed #{group}', '{count} removed from the main account, unsubscribing every member', '{items}'].join('\n'),
  template_held: [
    '✋ #RemovalHeld #{account}',
    '{count} items left the main account at once, or Steam refused them. Approve or restore them in the web UI.',
    '{items}',
  ].join('\n'),
  template_approval: ['❓ #PickGroup', '{count} new items on the main account match more than one group. Pick the group in the web UI.', '{items}'].join('\n'),
  template_problem: ['⚠️ #AccountProblem #{account}', '{message}'].join('\n'),
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
