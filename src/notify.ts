import { getSettings, q } from './db.js';
import { enqueue, render } from './telegram.js';

/**
 * Telegram summaries. Sync work notes what happened during a scheduler cycle; flushNotifications() sends one
 * message per group and kind at the end of the cycle, so 500 new items become one message, not 500.
 */
type Kind = 'discovered' | 'reapplied' | 'removed';

interface Batch {
  accounts: Set<string>;
  items: string[];
}

const batches: Record<Kind, Map<number, Batch>> = { discovered: new Map(), reapplied: new Map(), removed: new Map() };
const held = new Map<string, string[]>();
const approvals: string[] = [];

const MAX_LISTED = 10;

export function note(kind: Kind, groupId: number, account: string, items: string[]): void {
  if (!items.length) return;
  let b = batches[kind].get(groupId);
  if (!b) batches[kind].set(groupId, (b = { accounts: new Set(), items: [] }));
  b.accounts.add(account);
  b.items.push(...items);
}

export function noteHeld(account: string, items: string[]): void {
  held.set(account, [...(held.get(account) ?? []), ...items]);
}

export function noteApproval(items: string[]): void {
  approvals.push(...items);
}

function listItems(items: string[]): string {
  const unique = [...new Set(items)];
  const shown = unique.slice(0, MAX_LISTED).map((t) => `• ${t}`);
  if (unique.length > MAX_LISTED) shown.push(`… and ${unique.length - MAX_LISTED} more`);
  return shown.join('\n');
}

/** A hashtag-friendly group name. */
const tag = (name: string) => name.replace(/[^\p{L}\p{N}_]+/gu, '_');

export function flushNotifications(): void {
  const s = getSettings();
  const templates: Record<Kind, [enabled: string, template: string]> = {
    discovered: [s.notify_discovered, s.template_discovered],
    reapplied: [s.notify_reapplied, s.template_reapplied],
    removed: [s.notify_removed, s.template_removed],
  };
  for (const kind of Object.keys(batches) as Kind[]) {
    const [enabled, template] = templates[kind];
    for (const [groupId, b] of batches[kind]) {
      if (enabled !== '1') continue;
      const group = (q('SELECT name FROM groups WHERE id = ?').get(groupId) as { name: string } | undefined)?.name ?? `group ${groupId}`;
      enqueue(render(template, {
        group: tag(group), count: new Set(b.items).size, accounts: [...b.accounts].join(', '), items: listItems(b.items),
      }));
    }
    batches[kind].clear();
  }
  if (s.notify_removed === '1') {
    for (const [account, items] of held) {
      enqueue(render(s.template_held, { account: tag(account), count: items.length, items: listItems(items) }));
    }
  }
  held.clear();
  if (approvals.length && s.notify_discovered === '1') {
    enqueue(render(s.template_approval, { count: new Set(approvals).size, items: listItems(approvals) }));
  }
  approvals.length = 0;
}
