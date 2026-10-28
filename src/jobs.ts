import { addEvent, getAccount, q, tx } from './db.js';
import { itemLabel, setGroupItem, shortList, upsertItemDetails } from './groups.js';
import { FILETYPE_COLLECTION, fetchCollections, fetchItemDetails } from './steam.js';

export type JobAction = 'subscribe' | 'unsubscribe';

/**
 * Resolves pasted ids into items, expanding collections. Unknown or removed items are reported, not added.
 * Items are stored so the job can reference them.
 */
export async function resolveForJob(ids: string[], timeoutMs: number): Promise<{ items: string[]; skipped: { id: string; reason: string }[] }> {
  const colls = await fetchCollections(ids, timeoutMs);
  const itemIds = new Set<string>();
  for (const id of ids) {
    const c = colls.get(id);
    if (c && c.result === 1 && c.children.length) {
      for (const ch of c.children) if (ch.filetype !== FILETYPE_COLLECTION) itemIds.add(ch.id);
    } else itemIds.add(id);
  }
  const details = await fetchItemDetails([...itemIds], timeoutMs);
  const items: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  tx(() => {
    for (const id of itemIds) {
      const d = details.get(id);
      if (!d || d.result !== 1 || !d.appid) {
        skipped.push({ id, reason: 'not found on Steam (removed or private)' });
        continue;
      }
      upsertItemDetails(d);
      items.push(id);
    }
  });
  return { items, skipped };
}

/**
 * Creates a one-shot job. Where it clashes with a group (the group would undo it), the clash is returned
 * instead, unless `confirm` is set. Unsubscribing an item from every member of a group also takes it out of
 * that group, which is the way to remove an item the main account never showed.
 */
export function createJob(action: JobAction, itemIds: string[], accountIds: number[], confirm: boolean): { jobId?: number; conflicts?: string[] } {
  const accounts = new Set(accountIds.filter((id) => getAccount(id)));
  if (!accounts.size) throw new Error('Select at least one account');
  if (!itemIds.length) throw new Error('No items to work on');
  const conflicts: string[] = [];
  const removeFrom: { groupId: number; groupName: string; itemId: string }[] = [];
  for (const itemId of itemIds) {
    const groups = q(`SELECT g.id, g.name, gi.state FROM group_items gi
                      JOIN groups g ON g.id = gi.group_id AND g.state = 'active'
                      JOIN items i ON i.id = gi.item_id
                      JOIN group_apps ga ON ga.group_id = g.id AND ga.appid = i.appid
                      WHERE gi.item_id = ? AND gi.state != 'removed'`).all(itemId) as { id: number; name: string; state: string }[];
    for (const g of groups) {
      const members = (q(`SELECT gm.account_id FROM group_members gm JOIN accounts a ON a.id = gm.account_id AND a.enabled = 1
                          WHERE gm.group_id = ?`).all(g.id) as { account_id: number }[]).map((r) => r.account_id);
      const covered = members.filter((m) => accounts.has(m));
      if (!covered.length) continue;
      const label = itemLabel(itemId);
      if (action === 'unsubscribe' && g.state === 'active') {
        if (covered.length === members.length) removeFrom.push({ groupId: g.id, groupName: g.name, itemId });
        else conflicts.push(`"${label}" is synced by group ${g.name}: ${covered.length} of its ${members.length} members are selected, ` +
          'and the group will subscribe them again. Select every member to take it out of the group.');
      }
      if (action === 'subscribe' && (g.state === 'blocked' || g.state === 'removing')) {
        conflicts.push(`"${label}" is ${g.state === 'blocked' ? 'blocked' : 'being removed'} in group ${g.name}: the group will unsubscribe it again.`);
      }
    }
  }
  if (conflicts.length && !confirm) return { conflicts };

  const label = `${action} ${itemIds.length} item(s) on ${accounts.size} account(s)`;
  const jobId = tx(() => {
    const id = Number(q('INSERT INTO jobs (action, label, created_at) VALUES (?, ?, ?)').run(action, label, Date.now()).lastInsertRowid);
    const ins = q('INSERT OR IGNORE INTO job_items (job_id, account_id, item_id) VALUES (?, ?, ?)');
    for (const accountId of accounts) for (const itemId of itemIds) ins.run(id, accountId, itemId);
    for (const r of removeFrom) setGroupItem(r.groupId, r.itemId, 'removed', `job ${id}`);
    return id;
  });
  addEvent(null, 'job', `Job ${jobId}: ${label}${removeFrom.length ? `; taken out of their group: ${shortList(removeFrom.map((r) => `${itemLabel(r.itemId)} (${r.groupName})`))}` : ''}`);
  return { jobId };
}

export function listJobs() {
  return q(`SELECT j.*, COUNT(ji.item_id) AS total,
              COALESCE(SUM(ji.state = 'done'), 0) AS done, COALESCE(SUM(ji.state = 'failed'), 0) AS failed,
              COALESCE(SUM(ji.state = 'pending'), 0) AS pending,
              COUNT(DISTINCT ji.account_id) AS accounts, COUNT(DISTINCT ji.item_id) AS items
            FROM jobs j LEFT JOIN job_items ji ON ji.job_id = j.id
            GROUP BY j.id ORDER BY j.id DESC LIMIT 100`).all();
}

export function jobFailures(jobId: number) {
  return q(`SELECT a.username, ji.item_id, i.title, ji.error, ji.state FROM job_items ji
            JOIN accounts a ON a.id = ji.account_id JOIN items i ON i.id = ji.item_id
            WHERE ji.job_id = ? AND ji.state IN ('failed', 'pending') ORDER BY ji.state, a.username LIMIT 500`).all(jobId);
}

export function cancelJob(jobId: number): void {
  tx(() => {
    q("UPDATE job_items SET state = 'cancelled' WHERE job_id = ? AND state = 'pending'").run(jobId);
    q("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), jobId);
  });
  addEvent(null, 'job', `Job ${jobId} cancelled`);
}

/** Running jobs with nothing left to do are done. */
export function finishJobs(): void {
  const done = q(`SELECT id, label FROM jobs j WHERE status = 'running'
                  AND NOT EXISTS (SELECT 1 FROM job_items WHERE job_id = j.id AND state = 'pending')`).all() as { id: number; label: string }[];
  for (const j of done) {
    q("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").run(Date.now(), j.id);
    const failed = (q("SELECT COUNT(*) AS n FROM job_items WHERE job_id = ? AND state = 'failed'").get(j.id) as { n: number }).n;
    addEvent(null, 'job', `Job ${j.id} finished: ${j.label}${failed ? `, ${failed} failed` : ''}`, failed > 0);
  }
}
