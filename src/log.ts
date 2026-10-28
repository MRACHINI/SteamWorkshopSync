export interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const MAX_LINES = 1000;
const lines: LogLine[] = [];

function push(level: LogLine['level'], msg: string) {
  const line = { ts: Date.now(), level, msg };
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  const out = `${new Date(line.ts).toISOString()} [${level}] ${msg}`;
  if (level === 'error') console.error(out);
  else console.log(out);
}

export const log = {
  info: (msg: string) => push('info', msg),
  warn: (msg: string) => push('warn', msg),
  error: (msg: string) => push('error', msg),
  tail: (n = 300) => lines.slice(-n),
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
