/**
 * Pick Workshop ids out of pasted text: item or collection URLs (…/filedetails/?id=123) and bare ids,
 * separated by spaces, commas or new lines.
 */
export function parseRefs(text: string): { ids: string[]; invalid: string[] } {
  const ids = new Set<string>();
  const invalid: string[] = [];
  for (const token of String(text ?? '').split(/[\s,;]+/)) {
    if (!token) continue;
    const m = token.match(/[?&]id=(\d{1,20})\b/) ?? token.match(/^(\d{1,20})$/);
    if (m) ids.add(m[1]);
    else invalid.push(token.length > 60 ? `${token.slice(0, 57)}...` : token);
  }
  return { ids: [...ids], invalid };
}
