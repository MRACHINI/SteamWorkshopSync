import { encrypt } from './crypto.js';
import { getAccountByName, q, updateAccount } from './db.js';

export interface ImportAccount {
  username: string;
  password: string;
  note?: string;
}

/**
 * Parse the bulk-import box. Passwords may contain any character, so lines are never split on spaces, commas or ';'.
 *   [ {username, password, note?}, ... ]   JSON
 *   username<TAB>password[<TAB>note]       one per line, e.g. pasted from a spreadsheet
 *   username:password                      one per line, everything after the first ':' is the password
 */
export function parseImportText(input: string): ImportAccount[] {
  const text = input.trim();
  if (text.startsWith('[')) {
    const items = JSON.parse(text) as Partial<ImportAccount>[];
    return items.map((it) => ({ username: String(it.username ?? ''), password: String(it.password ?? ''), note: it.note }));
  }
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line, i) => {
      const l = line.trim();
      if (l.includes('\t')) {
        const [username, password = '', ...rest] = l.split('\t');
        return { username: username.trim(), password, note: rest.join(' ').trim() };
      }
      const sep = l.indexOf(':');
      if (sep < 0) throw new Error(`Line ${i + 1}: expected username:password`);
      return { username: l.slice(0, sep).trim(), password: l.slice(sep + 1) };
    });
}

/**
 * Insert or update an account. Without a password the account is signed in from the web UI instead
 * (Steam Guard accounts). Returns 'added' | 'updated'.
 */
export function upsertAccount(a: { username: string; password?: string; note?: string }): 'added' | 'updated' {
  const username = a.username.trim();
  if (!username) throw new Error('username is required');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(username)) throw new Error(`"${username}" is not a Steam account name (letters, digits and _ only)`);
  const existing = getAccountByName(username);
  if (existing) {
    updateAccount(existing.id, {
      ...(a.password ? { password_enc: encrypt(a.password), status: 'new', status_msg: '', fail_count: 0, next_attempt_at: 0, problem_notified: 0 } : {}),
      note: a.note ?? existing.note,
    });
    return 'updated';
  }
  q('INSERT INTO accounts (username, password_enc, note, status, status_msg, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    username,
    a.password ? encrypt(a.password) : null,
    a.note ?? '',
    a.password ? 'new' : 'needs_signin',
    a.password ? '' : 'Sign in from the web UI',
    Date.now(),
  );
  return 'added';
}
