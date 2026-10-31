import { getSettings, q, tx } from './db.js';
import { enqueue, render } from './telegram.js';

/**
 * Telegram summaries. Sync work notes what happened during a scheduler cycle; flushNotifications() sends one
 * message per group and kind at the end of the cycle, so 500 new items become one message, not 500. Notes are
 * kept in the database, so a restart during a long cycle loses nothing. What needs the admin (held removals,
 * group picks) does not wait for the cycle to end.
 */
type Kind = 'discovered' | 'reapplied' | 'removed' | 'held' | 'approval';

interface Note {
  kind: Kind;
  group_id: number;
  account: string;
  item: string;
}

const MAX_LISTED = 10;

function store(kind: Kind, groupId: number, account: string, items: string[]): void {
  const st = q('INSERT INTO pending_notes (kind, group_id, account, item) VALUES (?, ?, ?, ?)');
  for (const item of items) st.run(kind, groupId, account, item);
}

export function note(kind: 'discovered' | 'reapplied' | 'removed', groupId: number, account: string, items: string[]): void {
  store(kind, groupId, account, items);
}

export function noteHeld(account: string, items: string[]): void {
  store('held', 0, account, items);
}

export function noteApproval(items: string[]): void {
  store('approval', 0, '', items);
}

/** Takes the notes of these kinds out of the table. */
function take(kinds: Kind[]): Note[] {
  const marks = kinds.map(() => '?').join(', ');
  return tx(() => {
    const rows = q(`SELECT kind, group_id, account, item FROM pending_notes WHERE kind IN (${marks}) ORDER BY id`).all(...kinds) as unknown as Note[];
    q(`DELETE FROM pending_notes WHERE kind IN (${marks})`).run(...kinds);
    return rows;
  });
}

function listItems(items: string[]): string {
  const unique = [...new Set(items)];
  const shown = unique.slice(0, MAX_LISTED).map((t) => `• ${t}`);
  if (unique.length > MAX_LISTED) shown.push(`… and ${unique.length - MAX_LISTED} more`);
  return shown.join('\n');
}

function listAccounts(accounts: string[]): string {
  const unique = [...new Set(accounts)];
  const shown = unique.slice(0, MAX_LISTED).join(', ');
  return unique.length > MAX_LISTED ? `${shown} and ${unique.length - MAX_LISTED} more` : shown;
}

/** A hashtag-friendly group name. */
const tag = (name: string) => name.replace(/[^\p{L}\p{N}_]+/gu, '_');

/** Groups notes by a key, in the order they were made. */
function by<K>(notes: Note[], key: (n: Note) => K): Map<K, Note[]> {
  const out = new Map<K, Note[]>();
  for (const n of notes) out.set(key(n), [...(out.get(key(n)) ?? []), n]);
  return out;
}

export function flushUrgentNotifications(): void {
  const s = getSettings();
  const notes = take(['held', 'approval']);
  if (s.notify_removed === '1') {
    for (const [account, rows] of by(notes.filter((n) => n.kind === 'held'), (n) => n.account)) {
      enqueue(render(s.template_held, { account: tag(account), count: rows.length, items: listItems(rows.map((r) => r.item)) }));
    }
  }
  const approvals = notes.filter((n) => n.kind === 'approval').map((n) => n.item);
  if (approvals.length && s.notify_discovered === '1') {
    enqueue(render(s.template_approval, { count: new Set(approvals).size, items: listItems(approvals) }));
  }
}

export function flushNotifications(): void {
  const s = getSettings();
  const templates: Record<'discovered' | 'reapplied' | 'removed', [enabled: string, template: string]> = {
    discovered: [s.notify_discovered, s.template_discovered],
    reapplied: [s.notify_reapplied, s.template_reapplied],
    removed: [s.notify_removed, s.template_removed],
  };
  const notes = take(['discovered', 'reapplied', 'removed']);
  for (const kind of ['discovered', 'reapplied', 'removed'] as const) {
    const [enabled, template] = templates[kind];
    if (enabled !== '1') continue;
    for (const [groupId, rows] of by(notes.filter((n) => n.kind === kind), (n) => n.group_id)) {
      const group = (q('SELECT name FROM groups WHERE id = ?').get(groupId) as { name: string } | undefined)?.name ?? `group ${groupId}`;
      const items = rows.map((r) => r.item);
      enqueue(render(template, {
        group: tag(group), count: new Set(items).size, accounts: listAccounts(rows.map((r) => r.account)), items: listItems(items),
      }));
    }
  }
  flushUrgentNotifications();
}
