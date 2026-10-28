import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DATA_DIR, DEFAULT_SETTINGS, type SettingKey } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'workshopsync.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- NULL = signed in from the web UI only (Steam Guard accounts, the main account): never stored.
  password_enc TEXT,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  is_main INTEGER NOT NULL DEFAULT 0,
  steamid TEXT,
  refresh_token_enc TEXT,
  cookies_enc TEXT,
  token_expires_at INTEGER,
  token_warned INTEGER NOT NULL DEFAULT 0,
  -- 1 = the last sign-in needed a Steam Guard code or the mobile app, so it cannot be renewed unattended.
  interactive INTEGER NOT NULL DEFAULT 0,
  -- Where Steam serves this account's pages (its custom URL); saves a redirect per page.
  profile_url TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  status_msg TEXT NOT NULL DEFAULT '',
  problem_notified INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  write_next_at INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_ok_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- setup -> scanning (first full reads) -> preview (waits for the admin) -> active <-> paused
  state TEXT NOT NULL DEFAULT 'setup',
  start_requested_at INTEGER,
  preview_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_apps (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  appid INTEGER NOT NULL,
  PRIMARY KEY (group_id, appid)
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_members_account ON group_members(account_id);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  appid INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  preview_url TEXT NOT NULL DEFAULT '',
  file_size INTEGER,
  -- ok | unavailable (removed, private or banned on Steam)
  status TEXT NOT NULL DEFAULT 'ok',
  details_at INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_items (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  -- active: every member gets it. blocked: every member loses it, also when it comes back.
  -- removing: being unsubscribed from every member. removed: done; found again = synced again.
  state TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_group_items_item ON group_items(item_id);

CREATE TABLE IF NOT EXISTS group_collections (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  child_count INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, collection_id)
);

-- One subscription list per account and game.
CREATE TABLE IF NOT EXISTS account_apps (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appid INTEGER NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0,
  last_total INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_full_at INTEGER NOT NULL DEFAULT 0,
  full_due INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, appid)
);

-- What Steam showed for one account and item, plus the state of writes to it.
CREATE TABLE IF NOT EXISTS account_items (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  present INTEGER NOT NULL DEFAULT 0,
  -- Consecutive full reads that did not show a present item; it only counts as gone at 2.
  missing_count INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER,
  lost_at INTEGER,
  -- '' = found on Steam, sync / job = subscribed by this app
  added_by TEXT NOT NULL DEFAULT '',
  removal_held INTEGER NOT NULL DEFAULT 0,
  -- When this app last subscribed it; such an item counts only once a read has shown it (seen_at later).
  written_at INTEGER,
  write_error TEXT NOT NULL DEFAULT '',
  write_fails INTEGER NOT NULL DEFAULT 0,
  write_next_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_account_items_item ON account_items(item_id);

-- Items new on the main account that match more than one group: the admin picks the group.
CREATE TABLE IF NOT EXISTS approvals (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  group_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS job_items (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  state TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  done_at INTEGER,
  PRIMARY KEY (job_id, account_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_job_items_pending ON job_items(account_id, state);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id INTEGER,
  username TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id, ts);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  soft_fails INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/** Adds missing columns in place, so later versions upgrade a database without losing data. */
export function addColumns(table: string, columns: [string, string][]): void {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/** Account statuses that need the admin (password, sign-in) before anything is retried. */
export const STUCK = new Set(['bad_credentials', 'needs_signin']);

/** After this many failed sends a Telegram message is given up on. */
export const MAX_SEND_ATTEMPTS = 20;

const statements = new Map<string, StatementSync>();
/** Prepared statement, compiled once per SQL text. */
export function q(sql: string): StatementSync {
  let st = statements.get(sql);
  if (!st) statements.set(sql, (st = db.prepare(sql)));
  return st;
}

let txDepth = 0;
/** Runs fn in a transaction. Nested calls become savepoints, so helpers can use it freely. */
export function tx<T>(fn: () => T): T {
  const sp = `sp${txDepth++}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${sp}`);
    return result;
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}`);
    db.exec(`RELEASE ${sp}`);
    throw e;
  } finally {
    txDepth--;
  }
}

export interface Account {
  id: number;
  username: string;
  password_enc: string | null;
  note: string;
  enabled: number;
  is_main: number;
  steamid: string | null;
  refresh_token_enc: string | null;
  cookies_enc: string | null;
  token_expires_at: number | null;
  token_warned: number;
  interactive: number;
  profile_url: string | null;
  status: string;
  status_msg: string;
  problem_notified: number;
  fail_count: number;
  next_attempt_at: number;
  next_check_at: number;
  write_next_at: number;
  last_check_at: number | null;
  last_ok_at: number | null;
  created_at: number;
}

export function listAccounts(): Account[] {
  return q('SELECT * FROM accounts ORDER BY is_main DESC, username COLLATE NOCASE').all() as unknown as Account[];
}

export function getAccount(id: number): Account | undefined {
  return q('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as Account | undefined;
}

export function getAccountByName(username: string): Account | undefined {
  return q('SELECT * FROM accounts WHERE username = ?').get(username) as unknown as Account | undefined;
}

export function getMainAccount(): Account | undefined {
  return q('SELECT * FROM accounts WHERE is_main = 1 LIMIT 1').get() as unknown as Account | undefined;
}

export function updateAccount(id: number, fields: Partial<Account>): void {
  const keys = Object.keys(fields) as (keyof Account)[];
  if (!keys.length) return;
  const sql = `UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k] ?? null), id);
}

/** Adds an event unless the very same one was already recorded for this account recently (keeps History readable). */
export function addEventOnce(acc: { id: number; username: string }, type: string, message: string, withinMs = 3600_000): void {
  const seen = q('SELECT 1 FROM events WHERE account_id = ? AND type = ? AND message = ? AND ts > ? LIMIT 1')
    .get(acc.id, type, message, Date.now() - withinMs);
  if (!seen) addEvent(acc, type, message);
}

export function addEvent(acc: { id: number; username: string } | null, type: string, message: string, alerted = false): void {
  q('INSERT INTO events (ts, account_id, username, type, message, alerted) VALUES (?, ?, ?, ?, ?, ?)').run(
    Date.now(),
    acc?.id ?? null,
    acc?.username ?? '',
    type,
    message,
    alerted ? 1 : 0,
  );
}

export function getSettings(): Record<SettingKey, string> {
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of q('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    if (row.key in DEFAULT_SETTINGS) out[row.key] = row.value;
  }
  return out as Record<SettingKey, string>;
}

/** A numeric setting, clamped to [min, max]; the default is used when the stored value is not a number. */
export function numSetting(key: SettingKey, min: number, max: number): number {
  const n = Number(getSettings()[key]);
  const fallback = Number(DEFAULT_SETTINGS[key]);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
}

export function setSettings(values: Record<string, unknown>): void {
  const stmt = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) {
    if (k in DEFAULT_SETTINGS && v !== undefined && v !== null) stmt.run(k, String(v));
  }
}

// Internal values kept in the settings table but outside DEFAULT_SETTINGS,
// so they are never returned by getSettings() or writable through setSettings().
export function getInternal(key: string): string {
  const row = q('SELECT value FROM settings WHERE key = ?').get(`internal:${key}`) as { value: string } | undefined;
  return row?.value ?? '';
}

export function setInternal(key: string, value: string): void {
  if (value) {
    q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`internal:${key}`, value);
  } else {
    q('DELETE FROM settings WHERE key = ?').run(`internal:${key}`);
  }
}

export function pruneHistory(days: number): void {
  const cutoff = Date.now() - days * 86400_000;
  q('DELETE FROM events WHERE ts < ?').run(cutoff);
  q('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?').run(cutoff);
  // Messages that were never delivered would otherwise sit in the table for ever.
  q('DELETE FROM outbox WHERE sent_at IS NULL AND created_at < ?').run(cutoff);
  q("DELETE FROM jobs WHERE status != 'running' AND finished_at < ?").run(cutoff);
}
