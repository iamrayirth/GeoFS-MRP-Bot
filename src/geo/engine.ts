import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { polygon as turfPolygon } from '@turf/helpers';
import type { Feature, Polygon, Position } from 'geojson';
import { UNRESOLVED, type CountryRef, type GeoResult, type Tier } from './types.js';

const DEFAULT_DATA = new URL('../../data/geodata.json.gz', import.meta.url);
const TIER_RANK: Record<Tier, number> = { land: 0, internal: 1, archipelagic: 2, '12nm': 3 };
const CELL_DEG = 2;
/** Max distance for attributing a point that falls in a hairline gap between the land and sea layers. */
export const COASTAL_SNAP_METERS = 1000;

interface Poly {
  tier: Tier;
  rank: number;
  sov: string[];
  ter: string;
  bbox: [number, number, number, number]; // minLon minLat maxLon maxLat
  coords: Position[][];
  feature: Feature<Polygon> | null; // built lazily for turf
}

export interface GeoData {
  type: 'FeatureCollection';
  meta: Record<string, unknown>;
  sovereigns: { iso3: string; iso2: string | null; name: string }[];
  features: { properties: { tier: Tier; sov: string[]; ter: string }; geometry: { type: string; coordinates: any } }[];
}

export class GeoEngine {
  private polys: Poly[] = [];
  private grid = new Map<number, number[]>();
  readonly sovereigns = new Map<string, CountryRef>();
  /** territory name -> sovereign iso3 list */
  readonly territories = new Map<string, string[]>();
  readonly meta: Record<string, unknown>;

  constructor(data: GeoData) {
    this.meta = data.meta;
    for (const s of data.sovereigns) this.sovereigns.set(s.iso3, { iso3: s.iso3, iso2: s.iso2, name: s.name });
    for (const f of data.features) {
      const { tier, sov, ter } = f.properties;
      const parts: Position[][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      if (!this.territories.has(ter)) this.territories.set(ter, sov);
      for (const coords of parts) {
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const [lon, lat] of coords[0]!) {
          if (lon! < minLon) minLon = lon!; if (lon! > maxLon) maxLon = lon!;
          if (lat! < minLat) minLat = lat!; if (lat! > maxLat) maxLat = lat!;
        }
        const idx = this.polys.length;
        this.polys.push({ tier, rank: TIER_RANK[tier], sov, ter, bbox: [minLon, minLat, maxLon, maxLat], coords, feature: null });
        for (let cx = this.cellX(minLon); cx <= this.cellX(maxLon); cx++) {
          for (let cy = this.cellY(minLat); cy <= this.cellY(maxLat); cy++) {
            const key = cx * 1000 + cy;
            const arr = this.grid.get(key);
            if (arr) arr.push(idx); else this.grid.set(key, [idx]);
          }
        }
      }
    }
  }

  static load(path: URL | string = DEFAULT_DATA): GeoEngine {
    const buf = readFileSync(path);
    const json = path.toString().endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    return new GeoEngine(JSON.parse(json) as GeoData);
  }

  get polygonCount() { return this.polys.length; }

  private cellX(lon: number) { return Math.floor((lon + 180) / CELL_DEG); }
  private cellY(lat: number) { return Math.floor((lat + 90) / CELL_DEG); }

  private asFeature(p: Poly): Feature<Polygon> {
    return (p.feature ??= turfPolygon(p.coords as Position[][]));
  }

  private candidates(lon: number, lat: number): number[] {
    return this.grid.get(this.cellX(lon) * 1000 + this.cellY(lat)) ?? [];
  }

  /**
   * Which country is this coordinate in? Precedence: land > internal waters > archipelagic waters > 12 NM territorial sea.
   * Several claimants at the winning tier => `ambiguous` listing all of them. No hit => `unresolved` (never guessed).
   */
  resolve(lat: number, lon: number): GeoResult {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return UNRESOLVED;
    const pt: Position = [lon, lat];
    let bestRank = Infinity;
    const hits: Poly[] = [];
    for (const i of this.candidates(lon, lat)) {
      const p = this.polys[i]!;
      if (p.rank > bestRank) continue;
      const [minLon, minLat, maxLon, maxLat] = p.bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      // boundary counts as inside (ignoreBoundary: false) so a point exactly on a border is never dropped.
      if (!booleanPointInPolygon(pt, this.asFeature(p), { ignoreBoundary: false })) continue;
      if (p.rank < bestRank) { bestRank = p.rank; hits.length = 0; }
      hits.push(p);
    }
    if (hits.length) return this.toResult(hits, false);

    // No polygon contains the point. Land/sea layers come from different sources, so a hairline gap can exist at the
    // coast. Attribute only if a land/internal/archipelagic polygon is within COASTAL_SNAP_METERS - the outer edge of
    // the 12 NM zone is deliberately NOT extended.
    const snapped = this.nearestInner(lat, lon);
    return snapped ? this.toResult(snapped, true) : UNRESOLVED;
  }

  private toResult(hits: Poly[], snapped: boolean): GeoResult {
    const ids: string[] = [];
    for (const h of hits) for (const s of h.sov) if (!ids.includes(s)) ids.push(s);
    const countries = ids.map((id) => this.sovereigns.get(id)).filter((c): c is CountryRef => !!c);
    if (!countries.length) return UNRESOLVED;
    const territories = [...new Set(hits.map((h) => h.ter))];
    return {
      status: countries.length > 1 ? 'ambiguous' : 'resolved',
      tier: hits[0]!.tier,
      countries,
      territory: territories.length === 1 ? territories[0]! : null,
      snapped,
    };
  }

  private nearestInner(lat: number, lon: number): Poly[] | null {
    const dLat = COASTAL_SNAP_METERS / 110_540;
    const dLon = COASTAL_SNAP_METERS / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    const seen = new Set<number>();
    let best = Infinity;
    let bestPolys: Poly[] = [];
    for (const cx of new Set([this.cellX(lon - dLon), this.cellX(lon + dLon)])) {
      for (const cy of new Set([this.cellY(lat - dLat), this.cellY(lat + dLat)])) {
        for (const i of this.grid.get(cx * 1000 + cy) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const p = this.polys[i]!;
          if (p.tier === '12nm') continue;
          const [minLon, minLat, maxLon, maxLat] = p.bbox;
          if (lon < minLon - dLon || lon > maxLon + dLon || lat < minLat - dLat || lat > maxLat + dLat) continue;
          const d = ringDistanceMeters(lat, lon, p.coords[0]!);
          if (d > COASTAL_SNAP_METERS) continue;
          if (d < best - 1e-6) { best = d; bestPolys = [p]; } else if (Math.abs(d - best) <= 1e-6) bestPolys.push(p);
        }
      }
    }
    return bestPolys.length ? bestPolys : null;
  }
}

/** Minimum distance (m) from a point to a ring's edges using a local equirectangular projection (fine at ~1 km). */
export function ringDistanceMeters(lat: number, lon: number, ring: Position[]): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_540;
  let min = Infinity;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const ax = (ring[i]![0]! - lon) * kx, ay = (ring[i]![1]! - lat) * ky;
    const bx = (ring[i + 1]![0]! - lon) * kx, by = (ring[i + 1]![1]! - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(px, py);
    if (d < min) min = d;
  }
  return min;
}
