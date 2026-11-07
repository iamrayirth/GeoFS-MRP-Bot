import { readFileSync } from 'node:fs';
import type { Log } from '../logger.js';

export interface AircraftNameResult {
  /** Display string. Never invented: unmapped types are explicitly "Unknown". */
  label: string;
  known: boolean;
}

/**
 * The aircraft id -> name table is embedded in the GeoFS page as
 *   geofs.aircraftList['4'] = {name: 'Boeing 737-700', dir: '...', ...};
 * (verified against the live page, see docs/GEOFS_INVESTIGATION.md). Community names are truncated by GeoFS itself.
 */
export function parseAircraftList(html: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /geofs\.aircraftList\['(\d+)'\]\s*=\s*\{\s*name:\s*'((?:[^'\\]|\\.)*)'/g;
  for (const m of html.matchAll(re)) {
    const name = m[2]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\').trim();
    if (name) map.set(Number(m[1]), name);
  }
  return map;
}

const SNAPSHOT_URL = new URL('../../data/aircraft-types.json', import.meta.url);

export class AircraftNames {
  private names = new Map<number, string>();
  private source: 'snapshot' | 'live' | 'none' = 'none';
  private refreshedAt: Date | null = null;

  constructor(private readonly log: Log, private readonly listUrl?: string, private readonly fetchImpl: typeof fetch = fetch) {
    try {
      const snap = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as { types: Record<string, string>; fetchedAt?: string };
      this.names = new Map(Object.entries(snap.types).map(([k, v]) => [Number(k), v]));
      this.source = 'snapshot';
      this.refreshedAt = snap.fetchedAt ? new Date(snap.fetchedAt) : null;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'aircraft snapshot unavailable; unmapped types will show as Unknown');
    }
  }

  get size() { return this.names.size; }
  get info() { return { source: this.source, size: this.names.size, refreshedAt: this.refreshedAt }; }

  /** Refresh from the live GeoFS page. On failure the existing table is kept. */
  async refresh(): Promise<boolean> {
    if (!this.listUrl) return false;
    try {
      const res = await this.fetchImpl(this.listUrl, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'GeoFS-MRP-Bot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseAircraftList(await res.text());
      // Guard against a page change silently emptying the table.
      if (parsed.size < 50) throw new Error(`only ${parsed.size} aircraft parsed; page format may have changed`);
      this.names = parsed;
      this.source = 'live';
      this.refreshedAt = new Date();
      this.log.info({ aircraftTypes: parsed.size }, 'aircraft type table refreshed from GeoFS');
      return true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'aircraft type refresh failed; keeping previous table');
      return false;
    }
  }

  resolve(typeId: number | null, raw: string | null): AircraftNameResult {
    if (typeId !== null) {
      const n = this.names.get(typeId);
      if (n) return { label: n, known: true };
      return { label: `Unknown (aircraft ID ${typeId})`, known: false };
    }
    return { label: raw ? `Unknown (aircraft ID ${raw})` : 'Unknown', known: false };
  }
}
