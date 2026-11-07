const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export const MIN_IGNORE_MS = 60_000; // 1 minute
export const MAX_IGNORE_MS = 30 * 86_400_000; // 30 days

/**
 * Parses "10m", "30m", "1h", "6h", "1d", "1h30m", "90s", "2d12h".
 * Returns null for anything that is not a well-formed positive duration.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s || !/^(\d+(\.\d+)?[smhdw])+$/.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)([smhdw])/g)) {
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
  }
  total = Math.round(total);
  return Number.isFinite(total) && total > 0 ? total : null;
}

export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(ms / 1000));
  for (const [label, sec] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    const n = Math.floor(rest / sec);
    if (n > 0) { parts.push(`${n}${label}`); rest -= n * sec; }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || '0s';
}
