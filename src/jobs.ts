import crypto from 'node:crypto';
import { addEvent, getAccount, q, tx } from './db.js';
import { collectionItems, itemLabel, setGroupItem, shortList, upsertItemDetails } from './groups.js';
import { fetchCollections, fetchItemDetails } from './steam.js';

export type JobAction = 'subscribe' | 'unsubscribe';

/** The same job sent again within this time is the same click, not a second job. */
const DUPLICATE_WINDOW = 60_000;

/**
 * Resolves pasted ids into items, expanding collections. Unknown or removed items are reported, not added.
 * Items are stored so the job can reference them. An item gone from Steam can still sit on accounts, and
 * unsubscribing it only takes the game a read recorded for it, so that one still counts.
 */
export async function resolveForJob(ids: string[], timeoutMs: number, action: JobAction = 'subscribe'): Promise<{ items: string[]; skipped: { id: string; reason: string }[] }> {
  const colls = await fetchCollections(ids, timeoutMs);
  const itemIds = new Set<string>();
  for (const id of ids) {
    const c = colls.get(id);
    if (c && c.result === 1 && c.children.length) {
      for (const child of await collectionItems(id, timeoutMs)) itemIds.add(child);
    } else itemIds.add(id);
  }
  const details = await fetchItemDetails([...itemIds], timeoutMs);
  const items: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  tx(() => {
    for (const id of itemIds) {
      const d = details.get(id);
      if (!d || d.result !== 1 || !d.appid) {
        if (action === 'unsubscribe' && q('SELECT 1 FROM items WHERE id = ?').get(id)) items.push(id);
        else skipped.push({ id, reason: 'not found on Steam (removed or private)' });
        continue;
      }
      upsertItemDetails(d);
      items.push(id);
    }
  });
  return { items, skipped };
}

interface JobPlan {
  accounts: Set<number>;
  conflicts: string[];
  removeFrom: { groupId: number; groupName: string; itemId: string }[];
}

/** What a job would clash with, and which groups it takes items out of. A paused group resumes later, so it counts. */
function planJob(action: JobAction, itemIds: string[], accountIds: number[]): JobPlan {
  const accounts = new Set(accountIds.filter((id) => getAccount(id)));
  if (!accounts.size) throw new Error('Select at least one account');
  if (!itemIds.length) throw new Error('No items to work on');
  const conflicts: string[] = [];
  const removeFrom: { groupId: number; groupName: string; itemId: string }[] = [];
  for (const itemId of itemIds) {
    const groups = q(`SELECT g.id, g.name, gi.state FROM group_items gi
                      JOIN groups g ON g.id = gi.group_id AND g.state IN ('active', 'paused')
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
  return { accounts, conflicts, removeFrom };
}

/** What the web UI shows before an unsubscribe job runs. */
export function previewJob(action: JobAction, itemIds: string[], accountIds: number[]) {
  const { accounts, conflicts, removeFrom } = planJob(action, itemIds, accountIds);
  return {
    items: itemIds.length, accounts: accounts.size, writes: itemIds.length * accounts.size, conflicts,
    groups: [...new Set(removeFrom.map((r) => r.groupName))],
    takenOut: new Set(removeFrom.map((r) => r.itemId)).size,
  };
}

/**
 * Creates a one-shot job. Where it clashes with a group (the group would undo it), the clash is returned
 * instead, unless `confirm` is set. Unsubscribing an item from every member of a group also takes it out of
 * that group, which is the way to remove an item the main account never showed: it is being removed from then
 * on, so members the job cannot reach lose it when they come back, and cancelling the job puts it back.
 */
export function createJob(action: JobAction, itemIds: string[], accountIds: number[], confirm: boolean): { jobId?: number; conflicts?: string[] } {
  const { accounts, conflicts, removeFrom } = planJob(action, itemIds, accountIds);
  if (conflicts.length && !confirm) return { conflicts };

  const signature = crypto.createHash('sha256')
    .update(JSON.stringify([action, [...itemIds].sort(), [...accounts].sort((a, b) => a - b)])).digest('base64url');
  const same = q("SELECT id FROM jobs WHERE signature = ? AND status = 'running' AND created_at > ?").get(signature, Date.now() - DUPLICATE_WINDOW) as { id: number } | undefined;
  if (same) return { jobId: same.id };

  const label = `${action} ${itemIds.length} item(s) on ${accounts.size} account(s)`;
  const jobId = tx(() => {
    const id = Number(q('INSERT INTO jobs (action, label, signature, created_at) VALUES (?, ?, ?, ?)').run(action, label, signature, Date.now()).lastInsertRowid);
    const ins = q('INSERT OR IGNORE INTO job_items (job_id, account_id, item_id) VALUES (?, ?, ?)');
    for (const accountId of accounts) for (const itemId of itemIds) ins.run(id, accountId, itemId);
    for (const r of removeFrom) {
      setGroupItem(r.groupId, r.itemId, 'removing', `job ${id}`);
      q('INSERT OR IGNORE INTO job_group_items (job_id, group_id, item_id) VALUES (?, ?, ?)').run(id, r.groupId, r.itemId);
    }
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

/** How many rows jobFailures would return without its limit. */
export function jobFailureTotal(jobId: number): number {
  return (q("SELECT COUNT(*) AS n FROM job_items WHERE job_id = ? AND state IN ('failed', 'pending')").get(jobId) as { n: number }).n;
}

export function cancelJob(jobId: number): void {
  const running = tx(() => {
    q("UPDATE job_items SET state = 'cancelled' WHERE job_id = ? AND state = 'pending'").run(jobId);
    if (!q("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), jobId).changes) return false;
    // The group goes on syncing what the job was taking out of it.
    q(`UPDATE group_items SET state = 'active', updated_at = ? WHERE state = 'removing' AND EXISTS (
         SELECT 1 FROM job_group_items j WHERE j.job_id = ? AND j.group_id = group_items.group_id AND j.item_id = group_items.item_id)`).run(Date.now(), jobId);
    return true;
  });
  if (running) addEvent(null, 'job', `Job ${jobId} cancelled`);
}

/** Running jobs with nothing left to do are done. What only waits for disabled or parked accounts fails, with the reason. */
export function finishJobs(): void {
  q(`UPDATE job_items SET state = 'failed', error = 'The account is disabled or needs the admin', done_at = ?
     WHERE state = 'pending'
       AND job_id IN (SELECT id FROM jobs WHERE status = 'running')
       AND account_id IN (SELECT id FROM accounts WHERE enabled = 0 OR status IN ('bad_credentials', 'needs_signin'))
       AND NOT EXISTS (SELECT 1 FROM job_items o JOIN accounts a ON a.id = o.account_id
                       WHERE o.job_id = job_items.job_id AND o.state = 'pending' AND a.enabled = 1
                         AND a.status NOT IN ('bad_credentials', 'needs_signin'))`).run(Date.now());
  const done = q(`SELECT id, label FROM jobs j WHERE status = 'running'
                  AND NOT EXISTS (SELECT 1 FROM job_items WHERE job_id = j.id AND state = 'pending')`).all() as { id: number; label: string }[];
  for (const j of done) {
    q("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").run(Date.now(), j.id);
    const failed = (q("SELECT COUNT(*) AS n FROM job_items WHERE job_id = ? AND state = 'failed'").get(j.id) as { n: number }).n;
    addEvent(null, 'job', `Job ${j.id} finished: ${j.label}${failed ? `, ${failed} failed` : ''}`, failed > 0);
  }
}
