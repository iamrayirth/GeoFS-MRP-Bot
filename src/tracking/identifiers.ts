export const MAX_IDENTIFIER_LENGTH = 32;

export function normalizeIdentifier(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export function validateIdentifier(raw: string): { ok: true; value: string; normalized: string } | { ok: false; error: string } {
  const value = raw.normalize('NFKC').trim();
  if (!value) return { ok: false, error: 'Identifier cannot be empty.' };
  if (value.length > MAX_IDENTIFIER_LENGTH) return { ok: false, error: `Identifier is too long (max ${MAX_IDENTIFIER_LENGTH} characters).` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: 'Identifier contains control characters.' };
  return { ok: true, value, normalized: value.toLowerCase() };
}

export interface IdentifierEntry { value: string; normalized: string; }

/**
 * Case-insensitive SUBSTRING match anywhere in the callsign - no format is required.
 * "Charlie[USAF]", "Delta[usaf]" and "[RAF]Charlie" all match; an aircraft may match several identifiers.
 * Returns the configured display values of every identifier that matched.
 */
export function matchIdentifiers(callsign: string, identifiers: readonly IdentifierEntry[]): string[] {
  if (!callsign || identifiers.length === 0) return [];
  const hay = callsign.normalize('NFKC').toLowerCase();
  const out: string[] = [];
  for (const id of identifiers) if (id.normalized && hay.includes(id.normalized)) out.push(id.value);
  return out;
}
