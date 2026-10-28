import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { EAuthSessionGuardType, EResult, type LoginSession } from 'steam-session';
import { encrypt } from './crypto.js';
import { addEvent, getAccount, updateAccount } from './db.js';
import { errMsg, log } from './log.js';
import { requestCheck } from './scheduler.js';
import { jwtExpiresAt, mapEresult, newLoginSession } from './steam.js';

/**
 * Interactive sign-in from the web UI, for accounts with Steam Guard (the main account): a QR code for the
 * Steam mobile app, or the password plus an emailed / mobile code. Only the resulting long-lived sign-in is
 * kept; the password is stored only when the admin ticks "remember".
 */
export type SigninState = 'starting' | 'waiting_scan' | 'scanned' | 'need_code' | 'need_confirm' | 'done' | 'failed';

interface Signin {
  id: string;
  accountId: number;
  session: LoginSession;
  state: SigninState;
  message: string;
  qrSvg?: string;
  codeType?: 'email' | 'device';
  password?: string;
  remember: boolean;
  interactive: boolean;
  createdAt: number;
}

const signins = new Map<string, Signin>();
const TTL_MS = 5 * 60_000;

setInterval(() => {
  for (const [id, s] of signins) {
    if (s.createdAt < Date.now() - 2 * TTL_MS) {
      cancelSession(s);
      signins.delete(id);
    }
  }
}, 60_000).unref();

function cancelSession(s: Signin): void {
  s.password = undefined;
  try {
    s.session.cancelLoginAttempt();
  } catch {
    // already finished
  }
}

function fail(s: Signin, message: string): void {
  if (s.state === 'done') return;
  s.state = 'failed';
  s.message = message;
  cancelSession(s);
}

async function finish(s: Signin): Promise<void> {
  try {
    const acc = getAccount(s.accountId);
    if (!acc) return fail(s, 'The account was deleted meanwhile.');
    const steamid = s.session.steamID.getSteamID64();
    const name = String((s.session as unknown as { accountName?: string }).accountName ?? '');
    if (name && name.toLowerCase() !== acc.username.toLowerCase()) {
      return fail(s, `This approved the Steam account "${name}", but the slot is for "${acc.username}". Nothing was saved.`);
    }
    if (acc.steamid && acc.steamid !== steamid) {
      return fail(s, `That is a different Steam account (${steamid}) than ${acc.username} (${acc.steamid}). Nothing was saved.`);
    }
    const token = s.session.refreshToken;
    updateAccount(acc.id, {
      steamid, refresh_token_enc: encrypt(token), cookies_enc: null, token_expires_at: jwtExpiresAt(token), token_warned: 0,
      interactive: s.interactive ? 1 : 0, status: 'new', status_msg: '', fail_count: 0, next_attempt_at: 0, next_check_at: 0,
      problem_notified: 0, ...(s.remember && s.password ? { password_enc: encrypt(s.password) } : {}),
    });
    s.state = 'done';
    s.message = name || acc.steamid ? 'Signed in.' : 'Signed in. The account name could not be checked: make sure it was the right account.';
    s.password = undefined;
    addEvent(acc, 'signin', `Signed in from the web UI${s.qrSvg ? ' with the QR code' : ''}`);
    log.info(`${acc.username}: signed in from the web UI`);
    requestCheck(acc.id);
  } catch (e) {
    fail(s, errMsg(e));
  }
}

function track(accountId: number, session: LoginSession, fields: Partial<Signin>): Signin {
  // One sign-in at a time per account.
  for (const [id, other] of signins) {
    if (other.accountId === accountId) {
      cancelSession(other);
      signins.delete(id);
    }
  }
  session.loginTimeout = TTL_MS;
  const s: Signin = {
    id: crypto.randomBytes(12).toString('hex'), accountId, session, state: 'starting', message: '', remember: false,
    interactive: true, createdAt: Date.now(), ...fields,
  };
  session.on('remoteInteraction', () => {
    if (s.state === 'waiting_scan') {
      s.state = 'scanned';
      s.message = 'Scanned. Now approve the sign-in in the Steam mobile app.';
    }
  });
  session.once('authenticated', () => void finish(s));
  session.once('timeout', () => fail(s, 'The sign-in timed out. Start again.'));
  session.once('error', (e) => fail(s, mapEresult(e).message));
  signins.set(s.id, s);
  return s;
}

export function publicSignin(s: Signin) {
  return { id: s.id, state: s.state, message: s.message, qrSvg: s.qrSvg, codeType: s.codeType };
}

export async function startQrSignin(accountId: number) {
  if (!getAccount(accountId)) throw new Error('not found');
  const session = newLoginSession();
  const s = track(accountId, session, {});
  try {
    const start = await session.startWithQR();
    s.qrSvg = await QRCode.toString(start.qrChallengeUrl ?? '', { type: 'svg', margin: 1, width: 240 });
    s.state = 'waiting_scan';
    s.message = 'In the Steam mobile app, open Steam Guard and scan this code.';
  } catch (e) {
    fail(s, mapEresult(e).message);
  }
  return publicSignin(s);
}

export async function startPasswordSignin(accountId: number, password: string, remember: boolean) {
  const acc = getAccount(accountId);
  if (!acc) throw new Error('not found');
  const session = newLoginSession();
  const s = track(accountId, session, { password, remember, interactive: false, message: 'Signing in…' });
  try {
    const start = await session.startWithCredentials({ accountName: acc.username, password });
    if (start.actionRequired) {
      s.interactive = true;
      const actions = start.validActions ?? [];
      const has = (t: EAuthSessionGuardType) => actions.some((a) => a.type === t);
      const email = actions.find((a) => a.type === EAuthSessionGuardType.EmailCode);
      if (has(EAuthSessionGuardType.DeviceCode)) {
        s.state = 'need_code';
        s.codeType = 'device';
        s.message = 'Enter the code from the Steam mobile app, or approve the sign-in there.';
      } else if (email) {
        s.state = 'need_code';
        s.codeType = 'email';
        s.message = `Enter the code Steam emailed${email.detail ? ` to ${email.detail}` : ''}.`;
      } else if (has(EAuthSessionGuardType.DeviceConfirmation) || has(EAuthSessionGuardType.EmailConfirmation)) {
        s.state = 'need_confirm';
        s.message = 'Approve the sign-in in the Steam mobile app (or with the link Steam emailed).';
      } else {
        fail(s, 'Steam asked for a kind of confirmation this app does not support.');
      }
    }
  } catch (e) {
    fail(s, mapEresult(e).message);
  }
  return publicSignin(s);
}

export async function submitSigninCode(id: string, code: string) {
  const s = signins.get(id);
  if (!s) throw new Error('This sign-in has expired. Start again.');
  if (s.state !== 'need_code') return publicSignin(s);
  try {
    await s.session.submitSteamGuardCode(code.trim());
    s.message = 'Code accepted, finishing…';
  } catch (e) {
    const eresult = (e as { eresult?: number }).eresult;
    if (eresult === EResult.InvalidLoginAuthCode || eresult === EResult.TwoFactorCodeMismatch) {
      s.message = 'That code was not accepted. Try again with a new code.';
    } else {
      fail(s, mapEresult(e).message);
    }
  }
  return publicSignin(s);
}

export function getSignin(id: string) {
  const s = signins.get(id);
  return s ? publicSignin(s) : null;
}

export function cancelSignin(id: string): void {
  const s = signins.get(id);
  if (!s) return;
  cancelSession(s);
  signins.delete(id);
}
