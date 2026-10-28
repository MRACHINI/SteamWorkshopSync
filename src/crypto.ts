import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SECRET_KEY } from './config.js';

let key: Buffer | null = null;

// Key comes from SECRET_KEY env, otherwise a random one is generated once and kept in the data dir.
function getKey(): Buffer {
  if (key) return key;
  if (SECRET_KEY) {
    key = crypto.createHash('sha256').update(SECRET_KEY).digest();
    return key;
  }
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  return key;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(enc: string | null): string | null {
  if (!enc) return null;
  const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sign(value: string): string {
  return crypto.createHmac('sha256', getKey()).update(value).digest('base64url');
}

/** scrypt hash for passwords that must be verifiable but never readable (viewer password). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  if (expected.length !== 32) return false;
  // Async so a burst of failed logins cannot stall the scanner and web server.
  const actual = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, Buffer.from(salt, 'base64'), expected.length, (err, key) => (err ? reject(err) : resolve(key))),
  );
  return crypto.timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
