import {
  type Account, STUCK, addEvent, getAccount, getMainAccount, numSetting, q, tx,
} from './db.js';
import { errMsg, log } from './log.js';
import { note, noteApproval, noteHeld } from './notify.js';
import { FILETYPE_COLLECTION, type ItemDetails, type SubItem, fetchCollections, fetchItemDetails } from './steam.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface Group {
  id: number;
  name: string;
  state: 'setup' | 'scanning' | 'preview' | 'active' | 'paused';
  start_requested_at: number | null;
  preview_json: string | null;
  created_at: number;
}

export type ItemState = 'active' | 'blocked' | 'removing' | 'removed';

/** Short list of titles for History messages. */
export function shortList(labels: string[], max = 8): string {
  const shown = labels.slice(0, max).join(', ');
  return labels.length > max ? `${shown} … (+${labels.length - max})` : shown;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
/** Records an item seen on a subscriptions page. Titles and previews only fill in what is missing. */
export function upsertItem(id: string, appid: number, title = '', preview = ''): void {
  q(`INSERT INTO items (id, appid, title, preview_url, first_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
       preview_url = CASE WHEN items.preview_url = '' THEN excluded.preview_url ELSE items.preview_url END`)
    .run(id, appid, title, preview, Date.now());
}

/** Records Steam's item details (free API). */
export function upsertItemDetails(d: ItemDetails): void {
  const status = d.result === 1 && !d.banned ? 'ok' : 'unavailable';
  q(`INSERT INTO items (id, appid, title, preview_url, file_size, status, details_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
       preview_url = CASE WHEN excluded.preview_url != '' THEN excluded.preview_url ELSE items.preview_url END,
       file_size = excluded.file_size, status = excluded.status, details_at = excluded.details_at`)
    .run(d.id, d.appid, d.title, d.preview, d.size || null, status, Date.now(), Date.now());
}

export function itemLabel(id: string): string {
  const row = q('SELECT title FROM items WHERE id = ?').get(id) as { title: string } | undefined;
  return row?.title || id;
}

// ---------------------------------------------------------------------------
// Groups: lookups
// ---------------------------------------------------------------------------
export function getGroup(id: number): Group | undefined {
  return q('SELECT * FROM groups WHERE id = ?').get(id) as unknown as Group | undefined;
}

export function groupApps(groupId: number): number[] {
  return (q('SELECT appid FROM group_apps WHERE group_id = ? ORDER BY appid').all(groupId) as { appid: number }[]).map((r) => r.appid);
}

export function groupMembers(groupId: number): Account[] {
  return q(`SELECT a.* FROM group_members gm JOIN accounts a ON a.id = gm.account_id
            WHERE gm.group_id = ? ORDER BY a.is_main DESC, a.username COLLATE NOCASE`).all(groupId) as unknown as Account[];
}

/** Active groups of this account that sync this game. */
export function activeGroupsFor(accountId: number, appid: number): Group[] {
  return q(`SELECT g.* FROM groups g
            JOIN group_members gm ON gm.group_id = g.id AND gm.account_id = ?
            JOIN group_apps ga ON ga.group_id = g.id AND ga.appid = ?
            WHERE g.state = 'active' ORDER BY g.id`).all(accountId, appid) as unknown as Group[];
}

/** Active and paused groups: a removal through the main account applies to a paused group too. */
function syncingGroupsFor(accountId: number, appid: number): Group[] {
  return q(`SELECT g.* FROM groups g
            JOIN group_members gm ON gm.group_id = g.id AND gm.account_id = ?
            JOIN group_apps ga ON ga.group_id = g.id AND ga.appid = ?
            WHERE g.state IN ('active', 'paused') ORDER BY g.id`).all(accountId, appid) as unknown as Group[];
}

/** Games whose subscription list this account has to be read for. Paused and unstarted groups read nothing. */
export function relevantApps(accountId: number): number[] {
  return (q(`SELECT DISTINCT ga.appid FROM group_apps ga
             JOIN group_members gm ON gm.group_id = ga.group_id AND gm.account_id = ?
             JOIN groups g ON g.id = ga.group_id
             WHERE g.state IN ('scanning', 'preview', 'active') ORDER BY ga.appid`).all(accountId) as { appid: number }[])
    .map((r) => r.appid);
}

function groupItemState(groupId: number, itemId: string): ItemState | undefined {
  return (q('SELECT state FROM group_items WHERE group_id = ? AND item_id = ?').get(groupId, itemId) as { state: ItemState } | undefined)?.state;
}

/** Sets an item's state in a group. Activating it also settles a pending "which group?" question. */
export function setGroupItem(groupId: number, itemId: string, state: ItemState, source: string): void {
  const now = Date.now();
  q(`INSERT INTO group_items (group_id, item_id, state, source, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, item_id) DO UPDATE SET
       source = CASE WHEN group_items.state = 'removed' THEN excluded.source ELSE group_items.source END,
       state = excluded.state, updated_at = excluded.updated_at`)
    .run(groupId, itemId, state, source, now, now);
  if (state === 'active') q('DELETE FROM approvals WHERE item_id = ?').run(itemId);
}

/** Schedules a full read of these games for these accounts (new member, new game, group start). */
export function ensureReads(accountIds: number[], appids: number[]): void {
  for (const accountId of accountIds) {
    for (const appid of appids) {
      q(`INSERT INTO account_apps (account_id, appid, full_due) VALUES (?, ?, 1)
         ON CONFLICT(account_id, appid) DO UPDATE SET full_due = 1`).run(accountId, appid);
    }
    q('UPDATE accounts SET next_check_at = 0 WHERE id = ?').run(accountId);
  }
}

// ---------------------------------------------------------------------------
// Subscription lists
// ---------------------------------------------------------------------------
export interface AccountApp {
  account_id: number;
  appid: number;
  initialized: number;
  last_total: number;
  last_check_at: number | null;
  last_full_at: number;
  full_due: number;
}

export function getAccountApp(accountId: number, appid: number): AccountApp {
  q('INSERT OR IGNORE INTO account_apps (account_id, appid) VALUES (?, ?)').run(accountId, appid);
  return q('SELECT * FROM account_apps WHERE account_id = ? AND appid = ?').get(accountId, appid) as unknown as AccountApp;
}

/** Items currently subscribed on this account for this game, as far as the app knows. */
export function presentSet(accountId: number, appid: number): Set<string> {
  const rows = q(`SELECT ai.item_id FROM account_items ai JOIN items i ON i.id = ai.item_id
                  WHERE ai.account_id = ? AND i.appid = ? AND ai.present = 1`).all(accountId, appid) as { item_id: string }[];
  return new Set(rows.map((r) => r.item_id));
}

/** True while an item missed on the last full read still waits for the confirming second read. */
export function hasPendingMissing(accountId: number, appid: number): boolean {
  return !!q(`SELECT 1 FROM account_items ai JOIN items i ON i.id = ai.item_id
              WHERE ai.account_id = ? AND i.appid = ? AND ai.present = 1 AND ai.missing_count > 0 LIMIT 1`).get(accountId, appid);
}

/** Items a read showed. Being on the list settles any earlier write problem with them. */
function markPresent(accountId: number, appid: number, items: SubItem[], now: number): void {
  const st = q(`INSERT INTO account_items (account_id, item_id, present, seen_at, updated_at) VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(account_id, item_id) DO UPDATE SET present = 1, missing_count = 0, removal_held = 0,
                  write_error = '', write_fails = 0, write_next_at = 0,
                  seen_at = excluded.seen_at, updated_at = excluded.updated_at`);
  for (const it of items) {
    upsertItem(it.id, appid, it.title, it.preview);
    st.run(accountId, it.id, now, now);
  }
}

export interface FullReadResult {
  added: number;
  lost: number;
  pending: number;
  /** The list suddenly shows nothing, or lost most of itself: confirmed slowly, in case Steam is having a bad moment. */
  suspicious: boolean;
}

/**
 * A full read of one game's list. Items missing from it count as gone only on the second full read in a row
 * (the third, spaced at the normal interval, when most of the list vanished at once), so a bad read can never
 * trigger re-subscribes or removals.
 */
export function recordFullRead(acc: Account, appid: number, items: SubItem[], total: number): FullReadResult {
  return tx(() => {
    const now = Date.now();
    const before = presentSet(acc.id, appid);
    const seen = new Set(items.map((i) => i.id));
    const dropped = [...before].filter((id) => !seen.has(id)).length;
    const suspicious = before.size >= 3 && (seen.size === 0 || (dropped >= 5 && dropped > before.size / 2));
    const needed = suspicious ? 3 : 2;
    markPresent(acc.id, appid, items, now);
    const added = items.filter((i) => !before.has(i.id)).map((i) => i.id);
    const lost: string[] = [];
    let pending = 0;
    for (const id of before) {
      if (seen.has(id)) continue;
      const row = q('SELECT missing_count FROM account_items WHERE account_id = ? AND item_id = ?').get(acc.id, id) as { missing_count: number };
      if (row.missing_count + 1 >= needed) {
        q('UPDATE account_items SET present = 0, missing_count = 0, lost_at = ?, updated_at = ? WHERE account_id = ? AND item_id = ?')
          .run(now, now, acc.id, id);
        lost.push(id);
      } else {
        q('UPDATE account_items SET missing_count = missing_count + 1, updated_at = ? WHERE account_id = ? AND item_id = ?').run(now, acc.id, id);
        pending++;
      }
    }
    q(`UPDATE account_apps SET initialized = 1, last_total = ?, last_full_at = ?, last_check_at = ?, full_due = ?
       WHERE account_id = ? AND appid = ?`).run(total, now, now, pending ? 1 : 0, acc.id, appid);
    onItemsAppeared(acc, appid, added);
    onItemsLost(acc, appid, lost, total === 0);
    return { added: added.length, lost: lost.length, pending, suspicious };
  });
}

/**
 * Checks subscribes against a read made right after them. Steam has answered OK for an item that then never
 * showed up; such a write is recorded as failed (and retried later) instead of being trusted, so it can never
 * look like the main account dropping the item, nor loop as "subscribed again" on a member.
 */
export function recordVerified(acc: Account, appid: number, written: string[], seen: Set<string>): string[] {
  return tx(() => {
    const now = Date.now();
    const missing: string[] = [];
    for (const id of written) {
      if (seen.has(id)) {
        q('UPDATE account_items SET seen_at = ?, missing_count = 0 WHERE account_id = ? AND item_id = ?').run(now, acc.id, id);
        continue;
      }
      const row = q('SELECT present, write_fails FROM account_items WHERE account_id = ? AND item_id = ?').get(acc.id, id) as
        { present: number; write_fails: number } | undefined;
      if (!row?.present) continue;
      const fails = row.write_fails + 1;
      q(`UPDATE account_items SET present = 0, write_error = ?, write_fails = ?, write_next_at = ?, updated_at = ?
         WHERE account_id = ? AND item_id = ?`)
        .run('Steam accepted the subscription, but the item did not show up in the list', fails, now + Math.min(DAY, HOUR * 2 ** Math.min(fails - 1, 5)), now, acc.id, id);
      q('UPDATE account_apps SET last_total = MAX(0, last_total - 1) WHERE account_id = ? AND appid = ?').run(acc.id, appid);
      missing.push(id);
    }
    return missing;
  });
}

/**
 * Shares what accounts already have for these games with their groups, as if it had just appeared: used when
 * an account joins a running group, a running group adds a game, or a group resumes. Only items the group has
 * never had are added (a removed item an account kept for another group stays removed). Lists not read yet
 * are shared on their first read anyway.
 */
export function shareExisting(accountIds: number[], appids: number[]): void {
  for (const accountId of accountIds) {
    const acc = getAccount(accountId);
    if (!acc) continue;
    for (const appid of appids) {
      const st = q('SELECT initialized FROM account_apps WHERE account_id = ? AND appid = ?').get(accountId, appid) as { initialized: number } | undefined;
      if (st?.initialized) onItemsAppeared(acc, appid, [...presentSet(accountId, appid)], true);
    }
  }
}

/** A quick read: only the newest page(s), when the total shows nothing disappeared. */
export function recordQuickRead(acc: Account, appid: number, fresh: SubItem[], total: number): void {
  tx(() => {
    const now = Date.now();
    markPresent(acc.id, appid, fresh, now);
    q('UPDATE account_apps SET last_total = ?, last_check_at = ? WHERE account_id = ? AND appid = ?').run(total, now, acc.id, appid);
    onItemsAppeared(acc, appid, fresh.map((i) => i.id));
  });
}

/**
 * New subscriptions found on an account: shared with its groups (the main account's ones may need a pick).
 * onlyNew: only items the groups never had (for items already on the account, not just picked up).
 */
function onItemsAppeared(acc: Account, appid: number, ids: string[], onlyNew = false): void {
  if (!ids.length) return;
  const groups = activeGroupsFor(acc.id, appid);
  if (!groups.length) return;

  const addedTo = new Map<number, string[]>();
  const add = (g: Group, id: string, source: string) => {
    setGroupItem(g.id, id, 'active', source);
    addedTo.set(g.id, [...(addedTo.get(g.id) ?? []), itemLabel(id)]);
  };

  // A removed item, or one still being removed, that an account picks up again is synced again.
  const reusable = (s: ItemState | undefined) => !s || (!onlyNew && (s === 'removed' || s === 'removing'));
  if (!acc.is_main) {
    for (const g of groups) {
      const back: string[] = [];
      for (const id of ids) {
        const state = groupItemState(g.id, id);
        if (reusable(state)) add(g, id, `found on ${acc.username}`);
        else if (state === 'blocked') back.push(itemLabel(id));
      }
      if (back.length) addEvent(acc, 'blocked_back', `${back.length} blocked item(s) came back and will be unsubscribed (${g.name}): ${shortList(back)}`);
    }
  } else {
    // The main account plays every game: an item goes to the one group for its game, or waits for a pick.
    const pick: string[] = [];
    for (const id of ids) {
      const states = groups.map((g) => groupItemState(g.id, id));
      if (states.some((s) => s === 'active' || s === 'blocked')) continue;
      if (onlyNew && states.some((s) => s)) continue;
      // Being removed in one of the groups: the main account taking it again puts it back there.
      const removing = groups.filter((g, i) => states[i] === 'removing');
      if (removing.length) {
        for (const g of removing) add(g, id, 'found on the main account');
        continue;
      }
      const approval = q('SELECT status FROM approvals WHERE item_id = ?').get(id) as { status: string } | undefined;
      if (approval?.status === 'ignored') continue;
      if (groups.length === 1) {
        add(groups[0], id, 'found on the main account');
      } else {
        q(`INSERT INTO approvals (item_id, account_id, group_ids, status, created_at) VALUES (?, ?, ?, 'pending', ?)
           ON CONFLICT(item_id) DO UPDATE SET group_ids = excluded.group_ids`)
          .run(id, acc.id, groups.map((g) => g.id).join(','), Date.now());
        pick.push(itemLabel(id));
      }
    }
    if (pick.length) {
      addEvent(acc, 'approval', `${pick.length} new item(s) match more than one group, waiting for a pick: ${shortList(pick)}`);
      noteApproval(pick);
    }
  }
  for (const [groupId, labels] of addedTo) {
    const g = groups.find((x) => x.id === groupId)!;
    addEvent(acc, 'discovered', `${labels.length} new item(s) shared with ${g.name}: ${shortList(labels)}`);
    note('discovered', groupId, acc.username, labels);
  }
}

/**
 * Subscriptions confirmed gone. On a member they come back by themselves; on the main account they are
 * removals (held for approval when many go at once, or when the whole list emptied).
 */
function onItemsLost(acc: Account, appid: number, ids: string[], listEmpty: boolean): void {
  if (!ids.length) return;
  const groups = acc.is_main ? syncingGroupsFor(acc.id, appid) : activeGroupsFor(acc.id, appid);
  const activeIn = (id: string) => groups.filter((g) => groupItemState(g.id, id) === 'active');
  const synced = ids.filter((id) => activeIn(id).length);
  if (!acc.is_main) {
    if (synced.length) addEvent(acc, 'lost', `${synced.length} synced item(s) disappeared and will be subscribed again: ${shortList(synced.map(itemLabel))}`);
    if (ids.length > synced.length) addEvent(acc, 'lost', `${ids.length - synced.length} other subscription(s) disappeared`);
    return;
  }
  // A pick still waiting for an item the main account no longer has would subscribe it again.
  for (const id of ids) q("DELETE FROM approvals WHERE item_id = ? AND status = 'pending'").run(id);
  if (!synced.length) return;
  const threshold = numSetting('removal_hold_threshold', 0, 1_000_000);
  if (synced.length > threshold || listEmpty) {
    for (const id of synced) q('UPDATE account_items SET removal_held = 1 WHERE account_id = ? AND item_id = ?').run(acc.id, id);
    const labels = synced.map(itemLabel);
    addEvent(acc, 'removal_held', `${synced.length} synced item(s) disappeared from the main account${listEmpty ? ', leaving its list empty' : ' at once'}. ` +
      `Waiting for approval before removing them from the members: ${shortList(labels)}`, true);
    noteHeld(acc.username, labels);
    return;
  }
  removeFromGroups(acc, synced);
}

/** The main account dropped these items: every group that syncs them (paused ones too) unsubscribes its members. */
function removeFromGroups(main: Account, ids: string[]): void {
  const byGroup = new Map<number, { g: Group; labels: string[] }>();
  for (const id of ids) {
    const appid = (q('SELECT appid FROM items WHERE id = ?').get(id) as { appid: number }).appid;
    for (const g of syncingGroupsFor(main.id, appid)) {
      if (groupItemState(g.id, id) !== 'active') continue;
      setGroupItem(g.id, id, 'removing', '');
      const entry = byGroup.get(g.id) ?? { g, labels: [] };
      entry.labels.push(itemLabel(id));
      byGroup.set(g.id, entry);
    }
  }
  for (const { g, labels } of byGroup.values()) {
    addEvent(main, 'removed', `${labels.length} item(s) removed from the main account, unsubscribing every member of ${g.name}: ${shortList(labels)}`, true);
    note('removed', g.id, main.username, labels);
  }
}

// ---------------------------------------------------------------------------
// Desired state and writes
// ---------------------------------------------------------------------------
// What every member should have: an item active in any of its active groups is wanted; blocked or being
// removed (and active nowhere) is unwanted. Only items of the group's games count.
const WANT = `
  SELECT gm.account_id, gi.item_id, i.appid,
         MAX(gi.state = 'active') AS sub,
         MAX(gi.state IN ('blocked', 'removing')) AS unsub
  FROM group_items gi
  JOIN groups g ON g.id = gi.group_id AND g.state = 'active'
  JOIN items i ON i.id = gi.item_id
  JOIN group_apps ga ON ga.group_id = gi.group_id AND ga.appid = i.appid
  JOIN group_members gm ON gm.group_id = gi.group_id
  WHERE gi.state != 'removed' %FILTER%
  GROUP BY gm.account_id, gi.item_id`;

// Writes only once the account's list for that game has been read, so "present" is known.
const NEEDED = `(COALESCE(ai.removal_held, 0) = 0 AND (
    (w.sub = 1 AND COALESCE(ai.present, 0) = 0 AND i.status = 'ok')
    OR (w.sub = 0 AND w.unsub = 1 AND COALESCE(ai.present, 0) = 1)))`;

export interface PendingWrite {
  id: string;
  appid: number;
  title: string;
  action: 'subscribe' | 'unsubscribe';
  jobId?: number;
  lostAt?: number | null;
}

export function pendingJobWrites(accountId: number, limit: number): PendingWrite[] {
  const rows = q(`SELECT ji.job_id, ji.item_id, i.appid, i.title, j.action FROM job_items ji
                  JOIN jobs j ON j.id = ji.job_id AND j.status = 'running'
                  JOIN items i ON i.id = ji.item_id
                  WHERE ji.account_id = ? AND ji.state = 'pending' ORDER BY ji.job_id, ji.item_id LIMIT ?`)
    .all(accountId, limit) as { job_id: number; item_id: string; appid: number; title: string; action: 'subscribe' | 'unsubscribe' }[];
  return rows.map((r) => ({ id: r.item_id, appid: r.appid, title: r.title, action: r.action, jobId: r.job_id }));
}

export function pendingSyncWrites(accountId: number, now: number, limit: number): PendingWrite[] {
  const rows = q(`WITH w AS (${WANT.replace('%FILTER%', 'AND gm.account_id = ?')})
                  SELECT w.item_id, w.appid, w.sub, i.title, ai.lost_at FROM w
                  JOIN items i ON i.id = w.item_id
                  JOIN account_apps aa ON aa.account_id = w.account_id AND aa.appid = w.appid AND aa.initialized = 1
                  LEFT JOIN account_items ai ON ai.account_id = w.account_id AND ai.item_id = w.item_id
                  WHERE ${NEEDED} AND COALESCE(ai.write_next_at, 0) <= ?
                  ORDER BY w.sub, w.item_id LIMIT ?`)
    .all(accountId, now, limit) as { item_id: string; appid: number; sub: number; title: string; lost_at: number | null }[];
  return rows.map((r) => ({ id: r.item_id, appid: r.appid, title: r.title, action: r.sub ? 'subscribe' : 'unsubscribe', lostAt: r.lost_at }));
}

export function hasPendingWrites(accountId: number, now: number): boolean {
  return pendingJobWrites(accountId, 1).length > 0 || pendingSyncWrites(accountId, now, 1).length > 0;
}

/** Per account: writes still needed, and how many of them last failed. */
export function pendingCounts(): Map<number, { pending: number; failing: number }> {
  const out = new Map<number, { pending: number; failing: number }>();
  const rows = q(`WITH w AS (${WANT.replace('%FILTER%', '')})
                  SELECT w.account_id,
                    SUM(CASE WHEN ${NEEDED} THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN ${NEEDED} AND ai.write_error != '' THEN 1 ELSE 0 END) AS failing
                  FROM w JOIN items i ON i.id = w.item_id
                  JOIN account_apps aa ON aa.account_id = w.account_id AND aa.appid = w.appid AND aa.initialized = 1
                  LEFT JOIN account_items ai ON ai.account_id = w.account_id AND ai.item_id = w.item_id
                  GROUP BY w.account_id`).all() as { account_id: number; pending: number; failing: number }[];
  for (const r of rows) out.set(r.account_id, { pending: r.pending, failing: r.failing });
  const jobs = q("SELECT account_id, COUNT(*) AS n FROM job_items ji JOIN jobs j ON j.id = ji.job_id AND j.status = 'running' WHERE ji.state = 'pending' GROUP BY account_id")
    .all() as { account_id: number; n: number }[];
  for (const r of jobs) {
    const e = out.get(r.account_id) ?? { pending: 0, failing: 0 };
    e.pending += r.n;
    out.set(r.account_id, e);
  }
  return out;
}

/**
 * Stores the result of one write. A successful write updates what the app knows and the list's expected
 * total, so the next quick read of that list still adds up. Returns true for a successful re-subscribe.
 */
export function recordWrite(
  acc: Account, w: PendingWrite, outcome: 'ok' | 'not_found' | 'denied' | 'failed', message: string,
): boolean {
  return tx(() => {
    const now = Date.now();
    const row = q('SELECT present, write_fails FROM account_items WHERE account_id = ? AND item_id = ?').get(acc.id, w.id) as
      { present: number; write_fails: number } | undefined;
    const wasPresent = row?.present === 1;
    let reapplied = false;
    if (outcome === 'ok') {
      const sub = w.action === 'subscribe';
      q(`INSERT INTO account_items (account_id, item_id, present, added_by, written_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, item_id) DO UPDATE SET present = excluded.present, missing_count = 0,
           added_by = CASE WHEN excluded.present = 1 THEN excluded.added_by ELSE account_items.added_by END,
           written_at = CASE WHEN excluded.present = 1 THEN excluded.written_at ELSE account_items.written_at END,
           write_error = '', write_fails = 0, write_next_at = 0, removal_held = 0,
           lost_at = CASE WHEN excluded.present = 1 THEN NULL ELSE account_items.lost_at END,
           updated_at = excluded.updated_at`)
        .run(acc.id, w.id, sub ? 1 : 0, w.jobId ? 'job' : 'sync', sub ? now : null, now);
      if (sub !== wasPresent) {
        q(`UPDATE account_apps SET last_total = MAX(0, last_total + ?) WHERE account_id = ? AND appid = ?`).run(sub ? 1 : -1, acc.id, w.appid);
      }
      reapplied = sub && !w.jobId && !!w.lostAt;
    } else {
      const fails = (row?.write_fails ?? 0) + 1;
      // An item gone from Steam is re-checked through its details; anything else backs off up to a day.
      const backoff = outcome === 'not_found' ? DAY : Math.min(DAY, HOUR * 2 ** Math.min(fails - 1, 5));
      if (outcome === 'not_found') q("UPDATE items SET status = 'unavailable', details_at = 0 WHERE id = ?").run(w.id);
      q(`INSERT INTO account_items (account_id, item_id, write_error, write_fails, write_next_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, item_id) DO UPDATE SET write_error = excluded.write_error, write_fails = excluded.write_fails,
           write_next_at = excluded.write_next_at, updated_at = excluded.updated_at`)
        .run(acc.id, w.id, message, fails, now + backoff, now);
    }
    if (w.jobId) {
      q('UPDATE job_items SET state = ?, error = ?, done_at = ? WHERE job_id = ? AND account_id = ? AND item_id = ?')
        .run(outcome === 'ok' ? 'done' : 'failed', message, now, w.jobId, acc.id, w.id);
    }
    return reapplied;
  });
}

// ---------------------------------------------------------------------------
// Housekeeping (run every scheduler cycle)
// ---------------------------------------------------------------------------
/**
 * "Removing" becomes "removed" once no member still has the item, except members that cannot be signed in
 * and members that another active group still syncs it to (those keep it, and must not hold the removal up).
 */
export function completeRemovals(): void {
  const done = q(`SELECT gi.group_id, gi.item_id FROM group_items gi
                  JOIN groups g ON g.id = gi.group_id AND g.state = 'active'
                  JOIN items i ON i.id = gi.item_id
                  WHERE gi.state = 'removing' AND NOT EXISTS (
                    SELECT 1 FROM group_members gm
                    JOIN accounts a ON a.id = gm.account_id AND a.enabled = 1 AND a.status NOT IN ('bad_credentials', 'needs_signin')
                    LEFT JOIN account_apps aa ON aa.account_id = gm.account_id AND aa.appid = i.appid
                    LEFT JOIN account_items ai ON ai.account_id = gm.account_id AND ai.item_id = gi.item_id
                    WHERE gm.group_id = gi.group_id
                      AND (COALESCE(aa.initialized, 0) = 0 OR COALESCE(ai.present, 0) = 1)
                      AND NOT EXISTS (
                        SELECT 1 FROM group_items gi2
                        JOIN groups g2 ON g2.id = gi2.group_id AND g2.state = 'active'
                        JOIN group_apps ga2 ON ga2.group_id = gi2.group_id AND ga2.appid = i.appid
                        JOIN group_members gm2 ON gm2.group_id = gi2.group_id AND gm2.account_id = gm.account_id
                        WHERE gi2.item_id = gi.item_id AND gi2.group_id != gi.group_id AND gi2.state = 'active'))`)
    .all() as { group_id: number; item_id: string }[];
  for (const r of done) {
    q("UPDATE group_items SET state = 'removed', updated_at = ? WHERE group_id = ? AND item_id = ? AND state = 'removing'")
      .run(Date.now(), r.group_id, r.item_id);
  }
  if (done.length) log.info(`${done.length} item removal(s) completed`);
}

const unreadable = (a: Account) => !a.enabled || STUCK.has(a.status) || a.fail_count >= 3;

export interface StartPlan {
  items: string[];
  approvals: { item: string; groups: number[] }[];
  perAccount: { id: number; username: string; is_main: boolean; has: number; missing: number; unreadable: boolean }[];
  writes: number;
  computed_at: number;
}

/**
 * What starting a group would do: every member's items for the group's games are shared with all members.
 * The main account's items join unless they already belong to another group, or another group plays the
 * same game (then the admin picks the group, as for any new item on the main account).
 */
export function computeStart(g: Group): StartPlan {
  const apps = new Set(groupApps(g.id));
  const members = groupMembers(g.id);
  const presentOf = (accountId: number) =>
    (q(`SELECT ai.item_id, i.appid FROM account_items ai JOIN items i ON i.id = ai.item_id
        WHERE ai.account_id = ? AND ai.present = 1`).all(accountId) as { item_id: string; appid: number }[])
      .filter((r) => apps.has(r.appid));
  const union = new Set<string>();
  const approvals: StartPlan['approvals'] = [];
  // Items the admin blocked here before the start stay blocked.
  const blocked = (id: string) => groupItemState(g.id, id) === 'blocked';
  for (const m of members.filter((x) => !x.is_main)) for (const r of presentOf(m.id)) if (!blocked(r.item_id)) union.add(r.item_id);
  const main = members.find((x) => x.is_main);
  if (main) {
    for (const r of presentOf(main.id)) {
      if (union.has(r.item_id) || blocked(r.item_id)) continue;
      if (q("SELECT 1 FROM group_items WHERE item_id = ? AND group_id != ? AND state != 'removed' LIMIT 1").get(r.item_id, g.id)) continue;
      if (q("SELECT 1 FROM approvals WHERE item_id = ? AND status = 'ignored'").get(r.item_id)) continue;
      const others = activeGroupsFor(main.id, r.appid).filter((x) => x.id !== g.id);
      if (others.length) approvals.push({ item: r.item_id, groups: [g.id, ...others.map((x) => x.id)] });
      else union.add(r.item_id);
    }
  }
  const perAccount = members.map((m) => {
    const has = presentOf(m.id).filter((r) => union.has(r.item_id)).length;
    return { id: m.id, username: m.username, is_main: !!m.is_main, has, missing: union.size - has, unreadable: unreadable(m) };
  });
  return {
    items: [...union], approvals, perAccount,
    writes: perAccount.reduce((n, a) => n + a.missing, 0), computed_at: Date.now(),
  };
}

/** Groups being started move to "preview" once every readable member's lists were read in full. */
export function progressStarts(): void {
  for (const g of q("SELECT * FROM groups WHERE state = 'scanning'").all() as unknown as Group[]) {
    const apps = groupApps(g.id);
    const since = g.start_requested_at ?? 0;
    const ready = groupMembers(g.id).every((m) => unreadable(m) || apps.every((appid) => {
      const st = q('SELECT last_full_at FROM account_apps WHERE account_id = ? AND appid = ?').get(m.id, appid) as { last_full_at: number } | undefined;
      return (st?.last_full_at ?? 0) >= since;
    }));
    if (!ready) continue;
    const plan = computeStart(g);
    q("UPDATE groups SET state = 'preview', preview_json = ? WHERE id = ? AND state = 'scanning'").run(JSON.stringify(plan), g.id);
    addEvent(null, 'group', `${g.name}: first read done. Starting it would share ${plan.items.length} item(s) with ${plan.writes} subscription(s). Waiting for confirmation.`);
  }
}

/** Free API: titles, previews and availability of items, a batch per cycle. */
export async function refreshDetails(timeoutMs: number): Promise<void> {
  const ids = (q('SELECT id FROM items WHERE details_at < ? ORDER BY details_at LIMIT 100').all(Date.now() - 7 * DAY) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return;
  try {
    const details = await fetchItemDetails(ids, timeoutMs);
    tx(() => {
      for (const id of ids) {
        const d = details.get(id);
        // The game an item is stored under never changes here: the subscription lists are keyed on it.
        if (d) upsertItemDetails(d);
        else q('UPDATE items SET details_at = ? WHERE id = ?').run(Date.now(), id);
      }
    });
  } catch (e) {
    log.warn(`Item details refresh failed: ${errMsg(e)}`);
  }
}

/** Adds a collection's items (and those of collections inside it) that the group does not have yet. */
async function expandCollection(groupId: number, collectionId: string, timeoutMs: number): Promise<number> {
  const apps = new Set(groupApps(groupId));
  const itemIds = new Set<string>();
  let level = [collectionId];
  const visited = new Set<string>();
  for (let depth = 0; depth < 3 && level.length; depth++) {
    level.forEach((id) => visited.add(id));
    const details = await fetchCollections(level, timeoutMs);
    const next: string[] = [];
    for (const id of level) {
      for (const ch of details.get(id)?.children ?? []) {
        if (ch.filetype === FILETYPE_COLLECTION) {
          if (!visited.has(ch.id)) next.push(ch.id);
        } else itemIds.add(ch.id);
      }
    }
    level = next;
  }
  const details = await fetchItemDetails([...itemIds], timeoutMs);
  let added = 0;
  tx(() => {
    for (const d of details.values()) {
      if (d.result !== 1 || !apps.has(d.appid)) continue;
      upsertItemDetails(d);
      // Items the admin blocked or removed stay that way when the collection is read again.
      if (groupItemState(groupId, d.id)) continue;
      setGroupItem(groupId, d.id, 'active', `collection ${collectionId}`);
      added++;
    }
    q('UPDATE group_collections SET child_count = ?, resolved_at = ?, last_error = ? WHERE group_id = ? AND collection_id = ?')
      .run(itemIds.size, Date.now(), '', groupId, collectionId);
  });
  return added;
}

/** Collections are read again every few hours, so items added to them later are synced too. */
export async function refreshCollections(timeoutMs: number): Promise<void> {
  const hours = numSetting('collection_refresh_hours', 1, 24 * 30);
  const due = q(`SELECT gc.group_id, gc.collection_id FROM group_collections gc JOIN groups g ON g.id = gc.group_id
                 WHERE g.state = 'active' AND gc.resolved_at < ? LIMIT 5`).all(Date.now() - hours * HOUR) as { group_id: number; collection_id: string }[];
  for (const c of due) {
    try {
      const added = await expandCollection(c.group_id, c.collection_id, timeoutMs);
      if (added) addEvent(null, 'collection', `Collection ${c.collection_id}: ${added} new item(s) added to ${getGroup(c.group_id)?.name}`);
    } catch (e) {
      q('UPDATE group_collections SET resolved_at = ?, last_error = ? WHERE group_id = ? AND collection_id = ?')
        .run(Date.now(), errMsg(e), c.group_id, c.collection_id);
      log.warn(`Collection ${c.collection_id} refresh failed: ${errMsg(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------
export function validateGroupInput(name: unknown, appids: unknown): { name: string; appids: number[] } | string {
  const n = String(name ?? '').trim();
  if (!n || n.length > 64) return 'Group name must be 1 to 64 characters';
  const list = Array.isArray(appids) ? appids : String(appids ?? '').split(/[\s,;]+/);
  const ids = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) return 'Enter at least one game (Steam app ID, e.g. 730 for Counter-Strike 2)';
  if (ids.some((x) => !/^\d{1,10}$/.test(x) || Number(x) <= 0)) return 'App IDs must be whole numbers';
  return { name: n, appids: ids.map(Number) };
}

/** Creates a group. The main account is a member of every group. Returns the new id. */
export function createGroup(name: string, appids: number[], memberIds: number[]): number {
  return tx(() => {
    const now = Date.now();
    const id = Number(q("INSERT INTO groups (name, state, created_at) VALUES (?, 'setup', ?)").run(name, now).lastInsertRowid);
    for (const appid of appids) q('INSERT INTO group_apps (group_id, appid) VALUES (?, ?)').run(id, appid);
    const main = getMainAccount();
    for (const accountId of new Set([...memberIds, ...(main ? [main.id] : [])])) {
      if (getAccount(accountId)) q('INSERT OR IGNORE INTO group_members (group_id, account_id, added_at) VALUES (?, ?, ?)').run(id, accountId, now);
    }
    addEvent(null, 'admin', `Group ${name} created`);
    return id;
  });
}

/** Changes name, games and members. New members and games are read before anything is written for them. */
export function updateGroup(id: number, fields: { name?: string; appids?: number[]; memberIds?: number[] }): number[] {
  return tx(() => {
    const g = getGroup(id);
    if (!g) throw new Error('not found');
    const now = Date.now();
    if (fields.name !== undefined && fields.name !== g.name) q('UPDATE groups SET name = ? WHERE id = ?').run(fields.name, id);
    const oldApps = groupApps(id);
    const oldMembers = groupMembers(id).map((m) => m.id);
    if (fields.appids) {
      q('DELETE FROM group_apps WHERE group_id = ?').run(id);
      for (const appid of fields.appids) q('INSERT INTO group_apps (group_id, appid) VALUES (?, ?)').run(id, appid);
    }
    if (fields.memberIds) {
      const main = getMainAccount();
      const want = new Set([...fields.memberIds.filter((m) => getAccount(m)), ...(main ? [main.id] : [])]);
      for (const m of oldMembers) if (!want.has(m)) q('DELETE FROM group_members WHERE group_id = ? AND account_id = ?').run(id, m);
      for (const m of want) q('INSERT OR IGNORE INTO group_members (group_id, account_id, added_at) VALUES (?, ?, ?)').run(id, m, now);
    }
    const apps = groupApps(id);
    const members = groupMembers(id).map((m) => m.id);
    const newApps = apps.filter((a) => !oldApps.includes(a));
    const newMembers = members.filter((m) => !oldMembers.includes(m));
    const stayed = members.filter((m) => !newMembers.includes(m));
    if (g.state !== 'setup') {
      ensureReads(newMembers, apps);
      ensureReads(stayed, newApps);
    }
    if (g.state === 'active') {
      // What they already have is shared like anything new (lists read before; the rest on their first read).
      shareExisting(newMembers, apps);
      shareExisting(stayed, newApps);
    }
    addEvent(null, 'admin', `Group ${fields.name ?? g.name} updated`);
    return g.state === 'setup' ? [] : [...new Set([...newMembers, ...(newApps.length ? members : [])])];
  });
}

export function deleteGroup(id: number): void {
  const g = getGroup(id);
  if (!g) return;
  tx(() => {
    q('DELETE FROM groups WHERE id = ?').run(id);
    // Approvals that only offered this group have nowhere to go now.
    for (const a of q("SELECT item_id, group_ids FROM approvals WHERE status = 'pending'").all() as { item_id: string; group_ids: string }[]) {
      const left = a.group_ids.split(',').filter((x) => Number(x) !== id);
      if (!left.length) q('DELETE FROM approvals WHERE item_id = ?').run(a.item_id);
      else q('UPDATE approvals SET group_ids = ? WHERE item_id = ?').run(left.join(','), a.item_id);
    }
  });
  addEvent(null, 'admin', `Group ${g.name} deleted (nothing was unsubscribed)`);
}

/** start / confirm / pause / resume. Returns the accounts that need a read now. */
export function groupAction(id: number, action: 'start' | 'confirm' | 'pause' | 'resume'): number[] {
  const g = getGroup(id);
  if (!g) throw new Error('not found');
  const members = groupMembers(id).map((m) => m.id);
  if (action === 'start') {
    if (g.state !== 'setup' && g.state !== 'preview') throw new Error('Only a group that has not started yet can be started');
    if (!groupApps(id).length) throw new Error('Add at least one game first');
    tx(() => {
      q("UPDATE groups SET state = 'scanning', start_requested_at = ?, preview_json = NULL WHERE id = ?").run(Date.now(), id);
      ensureReads(members, groupApps(id));
    });
    addEvent(null, 'group', `${g.name}: reading every member's subscriptions before the first sync`);
    return members;
  }
  if (action === 'confirm') {
    if (g.state !== 'preview') throw new Error('The group is not waiting for confirmation');
    const plan = computeStart(g);
    tx(() => {
      for (const item of plan.items) setGroupItem(id, item, 'active', 'group start');
      for (const a of plan.approvals) {
        q(`INSERT INTO approvals (item_id, account_id, group_ids, status, created_at) VALUES (?, ?, ?, 'pending', ?)
           ON CONFLICT(item_id) DO UPDATE SET group_ids = excluded.group_ids WHERE approvals.status = 'pending'`)
          .run(a.item, getMainAccount()?.id ?? null, a.groups.join(','), Date.now());
      }
      q("UPDATE groups SET state = 'active', preview_json = NULL WHERE id = ?").run(id);
    });
    addEvent(null, 'group', `${g.name} started: ${plan.items.length} item(s) shared, ${plan.writes} subscription(s) to make` +
      `${plan.approvals.length ? `, ${plan.approvals.length} main-account item(s) waiting for a group pick` : ''}`);
    return members;
  }
  if (action === 'pause') {
    if (g.state !== 'active') throw new Error('Only an active group can be paused');
    q("UPDATE groups SET state = 'paused' WHERE id = ?").run(id);
    addEvent(null, 'group', `${g.name} paused`);
    return [];
  }
  if (g.state !== 'paused') throw new Error('The group is not paused');
  tx(() => {
    q("UPDATE groups SET state = 'active' WHERE id = ?").run(id);
    // Lists were not read for this group while paused: read them in full before acting on them again, and
    // share what members picked up meanwhile that another group's reads already recorded.
    ensureReads(members, groupApps(id));
    shareExisting(members, groupApps(id));
  });
  addEvent(null, 'group', `${g.name} resumed`);
  return members;
}

/** Makes this account the main account (or none) and adds it to every group. */
export function setMain(accountId: number | null): void {
  tx(() => {
    q('UPDATE accounts SET is_main = CASE WHEN id = ? THEN 1 ELSE 0 END').run(accountId ?? -1);
    if (accountId === null) return;
    const now = Date.now();
    for (const g of q('SELECT * FROM groups').all() as unknown as Group[]) {
      const added = Number(q('INSERT OR IGNORE INTO group_members (group_id, account_id, added_at) VALUES (?, ?, ?)').run(g.id, accountId, now).changes);
      if (added && g.state !== 'setup') ensureReads([accountId], groupApps(g.id));
      if (added && g.state === 'active') shareExisting([accountId], groupApps(g.id));
    }
  });
}

export type ItemAction = 'block' | 'unblock' | 'remove' | 'restore';

export function itemAction(groupId: number, itemId: string, action: ItemAction): void {
  const g = getGroup(groupId);
  const state = groupItemState(groupId, itemId);
  if (!g || !state) throw new Error('not found');
  const next: Record<ItemAction, ItemState> = { block: 'blocked', unblock: 'active', remove: 'removing', restore: 'active' };
  tx(() => {
    setGroupItem(groupId, itemId, next[action], 'admin');
    // A fresh decision deserves a fresh try on every member, not the back-off of earlier failures.
    q(`UPDATE account_items SET write_next_at = 0, write_fails = 0, write_error = ''
       WHERE item_id = ? AND account_id IN (SELECT account_id FROM group_members WHERE group_id = ?)`).run(itemId, groupId);
  });
  addEvent(null, 'admin', `${g.name}: ${itemLabel(itemId)} ${{ block: 'blocked', unblock: 'unblocked', remove: 'removed from every member', restore: 'added back' }[action]}`);
}

export interface AddResult {
  added: number;
  collections: number;
  skipped: { id: string; reason: string }[];
}

/** Adds items and collections (by id) to a group, checking each against Steam and the group's games. */
export async function addToGroup(groupId: number, ids: string[], timeoutMs: number): Promise<AddResult> {
  const g = getGroup(groupId);
  if (!g) throw new Error('not found');
  const apps = new Set(groupApps(groupId));
  const [details, colls] = await Promise.all([fetchItemDetails(ids, timeoutMs), fetchCollections(ids, timeoutMs)]);
  const out: AddResult = { added: 0, collections: 0, skipped: [] };
  for (const id of ids) {
    const d = details.get(id);
    const c = colls.get(id);
    if (c && c.result === 1 && c.children.length) {
      q(`INSERT INTO group_collections (group_id, collection_id, title, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id, collection_id) DO UPDATE SET title = excluded.title`).run(groupId, id, d?.title ?? '', Date.now());
      out.added += await expandCollection(groupId, id, timeoutMs);
      out.collections++;
      continue;
    }
    if (!d || d.result !== 1) {
      out.skipped.push({ id, reason: 'not found on Steam (removed or private)' });
      continue;
    }
    if (!apps.has(d.appid)) {
      out.skipped.push({ id, reason: `belongs to app ${d.appid}, which this group does not sync` });
      continue;
    }
    tx(() => {
      upsertItemDetails(d);
      const state = groupItemState(groupId, id);
      if (state !== 'active') setGroupItem(groupId, id, 'active', 'added by the admin');
    });
    out.added++;
  }
  addEvent(null, 'admin', `${g.name}: added ${out.added} item(s)${out.collections ? ` from ${out.collections} collection(s) and items` : ''}` +
    `${out.skipped.length ? `, skipped ${out.skipped.length}` : ''}`);
  return out;
}

export function removeCollection(groupId: number, collectionId: string): void {
  // The items stay in the group; only the automatic refresh stops.
  q('DELETE FROM group_collections WHERE group_id = ? AND collection_id = ?').run(groupId, collectionId);
}

// ---------------------------------------------------------------------------
// Approvals and held removals (main account)
// ---------------------------------------------------------------------------
export function listApprovals() {
  const rows = q(`SELECT a.item_id, a.group_ids, a.created_at, i.title, i.appid, i.preview_url FROM approvals a
                  JOIN items i ON i.id = a.item_id WHERE a.status = 'pending' ORDER BY a.created_at`).all() as
    { item_id: string; group_ids: string; created_at: number; title: string; appid: number; preview_url: string }[];
  return rows.map((r) => ({
    ...r,
    groups: r.group_ids.split(',').map(Number).map((id) => ({ id, name: getGroup(id)?.name ?? `#${id}` })),
  }));
}

/** groupId = null ignores the item for good (it stays on the main account, nothing else happens). */
export function resolveApproval(itemId: string, groupId: number | null): void {
  const a = q("SELECT * FROM approvals WHERE item_id = ? AND status = 'pending'").get(itemId) as { group_ids: string } | undefined;
  if (!a) throw new Error('not found');
  if (groupId === null) {
    q("UPDATE approvals SET status = 'ignored' WHERE item_id = ?").run(itemId);
    addEvent(null, 'admin', `${itemLabel(itemId)}: ignored (not shared with any group)`);
    return;
  }
  if (!a.group_ids.split(',').map(Number).includes(groupId)) throw new Error('That group was not offered for this item');
  const g = getGroup(groupId);
  if (!g) throw new Error('Group not found');
  setGroupItem(groupId, itemId, 'active', 'picked from the main account');
  addEvent(null, 'admin', `${itemLabel(itemId)}: shared with ${g.name}`);
}

export function listHeld() {
  return q(`SELECT ai.account_id, a.username, ai.item_id, ai.lost_at, i.title, i.appid FROM account_items ai
            JOIN accounts a ON a.id = ai.account_id JOIN items i ON i.id = ai.item_id
            WHERE ai.removal_held = 1 ORDER BY ai.lost_at, i.title`).all() as
    { account_id: number; username: string; item_id: string; lost_at: number; title: string; appid: number }[];
}

/** approve: remove the items from every member. restore: subscribe the main account to them again. */
export function resolveHeld(itemIds: string[] | 'all', action: 'approve' | 'restore'): number {
  const held = listHeld().filter((h) => itemIds === 'all' || itemIds.includes(h.item_id));
  if (!held.length) return 0;
  tx(() => {
    for (const h of held) q('UPDATE account_items SET removal_held = 0 WHERE account_id = ? AND item_id = ?').run(h.account_id, h.item_id);
    if (action === 'approve') {
      const byAccount = new Map<number, string[]>();
      for (const h of held) byAccount.set(h.account_id, [...(byAccount.get(h.account_id) ?? []), h.item_id]);
      for (const [accountId, ids] of byAccount) removeFromGroups(getAccount(accountId)!, ids);
    } else {
      addEvent(null, 'admin', `${held.length} held item(s) restored: the main account is subscribed to them again`);
    }
  });
  return held.length;
}
