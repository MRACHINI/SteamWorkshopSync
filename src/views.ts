import { type Account, listAccounts, q } from './db.js';
import { type Group, computeStart, groupApps, pendingCounts } from './groups.js';

/** Read models for the web UI. publicAccount() is the only account shape that leaves the server. */

function publicAccount(a: Account, extra: {
  pending: number; pending_bytes: number; failing: number; subscribed: number; groups: { id: number; name: string }[];
}) {
  return {
    id: a.id,
    username: a.username,
    note: a.note,
    enabled: !!a.enabled,
    is_main: !!a.is_main,
    steamid: a.steamid,
    has_password: !!a.password_enc,
    signed_in: !!a.refresh_token_enc,
    interactive: !!a.interactive,
    token_expires_at: a.token_expires_at,
    status: a.enabled ? a.status : 'disabled',
    status_msg: a.status_msg,
    fail_count: a.fail_count,
    next_attempt_at: a.next_attempt_at,
    next_check_at: a.next_check_at,
    last_check_at: a.last_check_at,
    last_ok_at: a.last_ok_at,
    ...extra,
  };
}

export function publicAccounts() {
  const counts = pendingCounts();
  const subscribed = new Map((q('SELECT account_id, COUNT(*) AS n FROM account_items WHERE present = 1 GROUP BY account_id').all() as
    { account_id: number; n: number }[]).map((r) => [r.account_id, r.n]));
  const groupsOf = new Map<number, { id: number; name: string }[]>();
  for (const r of q('SELECT gm.account_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id ORDER BY g.name COLLATE NOCASE').all() as
    { account_id: number; id: number; name: string }[]) {
    groupsOf.set(r.account_id, [...(groupsOf.get(r.account_id) ?? []), { id: r.id, name: r.name }]);
  }
  return listAccounts().map((a) => publicAccount(a, {
    pending: counts.get(a.id)?.pending ?? 0,
    pending_bytes: counts.get(a.id)?.bytes ?? 0,
    failing: counts.get(a.id)?.failing ?? 0,
    subscribed: subscribed.get(a.id) ?? 0,
    groups: groupsOf.get(a.id) ?? [],
  }));
}

function itemCounts(groupId: number): Record<string, number> {
  const out: Record<string, number> = { active: 0, blocked: 0, removing: 0, removed: 0 };
  for (const r of q(`SELECT gi.state, COUNT(*) AS n FROM group_items gi JOIN items i ON i.id = gi.item_id
                     JOIN group_apps ga ON ga.group_id = gi.group_id AND ga.appid = i.appid
                     WHERE gi.group_id = ? GROUP BY gi.state`).all(groupId) as { state: string; n: number }[]) {
    out[r.state] = r.n;
  }
  return out;
}

/** Total size of the group's synced items, and how many have no size from Steam (yet). */
function activeSize(groupId: number): { bytes: number; unsized: number } {
  return q(`SELECT COALESCE(SUM(i.file_size), 0) AS bytes, COALESCE(SUM(COALESCE(i.file_size, 0) = 0), 0) AS unsized
            FROM group_items gi JOIN items i ON i.id = gi.item_id
            JOIN group_apps ga ON ga.group_id = gi.group_id AND ga.appid = i.appid
            WHERE gi.group_id = ? AND gi.state = 'active'`).get(groupId) as { bytes: number; unsized: number };
}

/** Subscriptions of active items that are in place, summed over all members. */
function syncedCells(groupId: number): number {
  return (q(`SELECT COUNT(*) AS n FROM group_items gi
             JOIN items i ON i.id = gi.item_id
             JOIN group_apps ga ON ga.group_id = gi.group_id AND ga.appid = i.appid
             JOIN group_members gm ON gm.group_id = gi.group_id
             JOIN account_items ai ON ai.account_id = gm.account_id AND ai.item_id = gi.item_id AND ai.present = 1
             WHERE gi.group_id = ? AND gi.state = 'active'`).get(groupId) as { n: number }).n;
}

function memberCount(groupId: number): number {
  return (q('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(groupId) as { n: number }).n;
}

export function groupSummaries() {
  return (q('SELECT * FROM groups ORDER BY name COLLATE NOCASE').all() as unknown as Group[]).map((g) => {
    const counts = itemCounts(g.id);
    const members = memberCount(g.id);
    return {
      id: g.id, name: g.name, state: g.state, created_at: g.created_at, apps: groupApps(g.id), members, items: counts,
      synced: syncedCells(g.id), cells: counts.active * members, ...activeSize(g.id),
    };
  });
}

export function groupDetail(id: number) {
  const g = q('SELECT * FROM groups WHERE id = ?').get(id) as unknown as Group | undefined;
  if (!g) return null;
  const counts = itemCounts(id);
  const stats = new Map((q(`SELECT gm.account_id,
                              COALESCE(SUM(ai.present = 1), 0) AS has,
                              COALESCE(SUM(ai.present = 0 AND ai.write_error != ''), 0) AS failing,
                              COALESCE(SUM(CASE WHEN COALESCE(ai.present, 0) = 0 THEN COALESCE(i.file_size, 0) ELSE 0 END), 0) AS missing_bytes
                            FROM group_members gm
                            JOIN group_items gi ON gi.group_id = gm.group_id AND gi.state = 'active'
                            JOIN items i ON i.id = gi.item_id
                            JOIN group_apps ga ON ga.group_id = gi.group_id AND ga.appid = i.appid
                            LEFT JOIN account_items ai ON ai.account_id = gm.account_id AND ai.item_id = gi.item_id
                            WHERE gm.group_id = ? GROUP BY gm.account_id`).all(id) as
    { account_id: number; has: number; failing: number; missing_bytes: number }[])
    .map((r) => [r.account_id, r]));
  const apps = groupApps(id);
  const members = (q(`SELECT a.id, a.username, a.is_main, a.enabled, a.status, a.status_msg, a.last_check_at FROM group_members gm
                      JOIN accounts a ON a.id = gm.account_id WHERE gm.group_id = ?
                      ORDER BY a.is_main DESC, a.username COLLATE NOCASE`).all(id) as
    { id: number; username: string; is_main: number; enabled: number; status: string; status_msg: string; last_check_at: number | null }[])
    .map((m) => {
      const read = apps.every((appid) =>
        !!(q('SELECT initialized FROM account_apps WHERE account_id = ? AND appid = ?').get(m.id, appid) as { initialized: number } | undefined)?.initialized);
      return {
        ...m, is_main: !!m.is_main, enabled: !!m.enabled, status: m.enabled ? m.status : 'disabled', read,
        has: stats.get(m.id)?.has ?? 0, failing: stats.get(m.id)?.failing ?? 0, missing_bytes: stats.get(m.id)?.missing_bytes ?? 0,
      };
    });
  return {
    group: {
      id: g.id, name: g.name, state: g.state, created_at: g.created_at, start_requested_at: g.start_requested_at,
      // Recomputed while it waits, so sizes Steam reports after the first read show up, and it matches what
      // confirming will do.
      preview: g.state === 'preview' ? computeStart(g) : null, apps,
    },
    items: counts,
    ...activeSize(id),
    synced: syncedCells(id),
    cells: counts.active * members.length,
    members,
    collections: q('SELECT collection_id, title, child_count, resolved_at, last_error, added_at FROM group_collections WHERE group_id = ? ORDER BY added_at').all(id),
  };
}

export function groupItemsList(id: number) {
  return q(`SELECT gi.item_id AS id, gi.state, gi.source, gi.updated_at, i.title, i.appid, i.status, i.preview_url, i.file_size,
              CASE WHEN ga.appid IS NULL THEN 0 ELSE 1 END AS in_filter,
              COALESCE(SUM(ai.present = 1), 0) AS present,
              COALESCE(SUM(ai.write_error != '' AND COALESCE(ai.present, 0) = CASE gi.state WHEN 'active' THEN 0 ELSE 1 END), 0) AS failing
            FROM group_items gi
            JOIN items i ON i.id = gi.item_id
            LEFT JOIN group_apps ga ON ga.group_id = gi.group_id AND ga.appid = i.appid
            LEFT JOIN group_members gm ON gm.group_id = gi.group_id
            LEFT JOIN account_items ai ON ai.account_id = gm.account_id AND ai.item_id = gi.item_id
            WHERE gi.group_id = ?
            GROUP BY gi.item_id
            ORDER BY CASE gi.state WHEN 'removing' THEN 0 WHEN 'active' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, i.title COLLATE NOCASE`)
    .all(id);
}

export function itemCells(groupId: number, itemId: string) {
  return q(`SELECT a.id, a.username, a.is_main, a.status, COALESCE(ai.present, 0) AS present, ai.write_error, ai.write_next_at,
              ai.lost_at, COALESCE(ai.removal_held, 0) AS removal_held, ai.added_by, ai.seen_at, COALESCE(aa.initialized, 0) AS read
            FROM group_members gm
            JOIN accounts a ON a.id = gm.account_id
            JOIN items i ON i.id = ?
            LEFT JOIN account_apps aa ON aa.account_id = a.id AND aa.appid = i.appid
            LEFT JOIN account_items ai ON ai.account_id = a.id AND ai.item_id = i.id
            WHERE gm.group_id = ? ORDER BY a.is_main DESC, a.username COLLATE NOCASE`).all(itemId, groupId);
}
