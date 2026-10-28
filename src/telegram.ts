import { MAX_SEND_ATTEMPTS, db, getSettings } from './db.js';
import { errMsg, log } from './log.js';

interface OutboxRow {
  id: number;
  text: string;
  attempts: number;
  soft_fails: number;
  created_at: number;
}

/** An alert older than this is history, not news: it is dropped instead of being delivered late. */
const STALE_MS = 24 * 3600_000;

const MAX_ATTEMPTS = MAX_SEND_ATTEMPTS;

/** Queue a message. It is persisted first, so a crash or Telegram outage never loses an alert. */
export function enqueue(text: string): void {
  // With notifications switched off there is nobody to deliver to; History still records everything.
  if (getSettings().telegram_enabled !== '1') return;
  db.prepare('INSERT INTO outbox (created_at, text) VALUES (?, ?)').run(Date.now(), text);
  void flush();
}

export async function sendNow(text: string): Promise<void> {
  const s = getSettings();
  if (!s.telegram_bot_token || !s.telegram_chat_id) throw new Error('Telegram bot token / chat id not configured');
  const res = await fetch(`https://api.telegram.org/bot${s.telegram_bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: s.telegram_chat_id, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
    const err = new Error(`Telegram HTTP ${res.status}: ${body.description ?? ''}`) as Error & { retryAfter?: number; status?: number };
    err.retryAfter = body.parameters?.retry_after;
    err.status = res.status;
    throw err;
  }
}

let flushing = false;

export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const s = getSettings();
    if (s.telegram_enabled !== '1' || !s.telegram_bot_token || !s.telegram_chat_id) return;
    const rows = db
      .prepare('SELECT id, text, attempts, soft_fails, created_at FROM outbox WHERE sent_at IS NULL AND attempts < ? AND next_try_at <= ? ORDER BY id LIMIT 20')
      .all(MAX_ATTEMPTS, Date.now()) as unknown as OutboxRow[];
    for (const row of rows) {
      if (row.created_at < Date.now() - STALE_MS) {
        db.prepare('DELETE FROM outbox WHERE id = ?').run(row.id);
        log.warn(`Telegram message dropped, too old to send (queued ${new Date(row.created_at).toISOString()})`);
        continue;
      }
      try {
        await sendNow(row.text);
        db.prepare('UPDATE outbox SET sent_at = ?, last_error = NULL WHERE id = ?').run(Date.now(), row.id);
      } catch (e) {
        const { retryAfter, status } = e as { retryAfter?: number; status?: number };
        // Only Telegram refusing the message counts towards giving up. A network problem, a 5xx or a 429
        // is Telegram being unavailable, and an outage must not burn through the attempts.
        const transient = status === undefined || status >= 500 || status === 429;
        const fails = transient ? row.soft_fails + 1 : row.attempts + 1;
        const delay = retryAfter ? retryAfter * 1000 : Math.min(15 * 60_000, 5000 * 2 ** Math.min(fails, 8));
        db.prepare(`UPDATE outbox SET ${transient ? 'soft_fails = soft_fails + 1' : 'attempts = attempts + 1'}, next_try_at = ?, last_error = ? WHERE id = ?`)
          .run(Date.now() + delay, errMsg(e), row.id);
        log.warn(`Telegram send ${transient ? 'postponed' : 'refused'} (${errMsg(e)})`);
        break; // keep ordering; try again later
      }
    }
  } finally {
    flushing = false;
  }
}

/** Messages Telegram never accepted; they stay until the history retention window passes. */
export function failedCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL AND attempts >= ?').get(MAX_ATTEMPTS) as { n: number };
  return row.n;
}

export function pendingCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL AND attempts < ?').get(MAX_ATTEMPTS) as { n: number };
  return row.n;
}

export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
