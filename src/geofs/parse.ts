import type { MapSnapshot, Observation, RejectCounts } from './types.js';

/** Plausibility limits. Values outside are reported as unknown (GeoFS clients can send arbitrary numbers). */
export const LIMITS = {
  maxAltitudeM: 30_480, // 100,000 ft
  minAltitudeM: -500,
  maxSpeedKts: 1500,
  maxAbsHeading: 720,
} as const;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function normalizeHeading(h: unknown): number | null {
  if (!isNum(h) || Math.abs(h) > LIMITS.maxAbsHeading) return null;
  const n = ((h % 360) + 360) % 360;
  return Math.round(n * 10) / 10 === 360 ? 0 : Math.round(n * 10) / 10;
}

/** Validates one raw `users[]` entry. Returns the observation or the rejection reason. */
export function parseUser(raw: unknown): { ok: true; obs: Observation } | { ok: false; reason: keyof RejectCounts } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'notObject' };
  const u = raw as Record<string, unknown>;

  const rawId = u.id;
  const id = typeof rawId === 'string' ? rawId.trim() : isNum(rawId) ? String(rawId) : '';
  if (!id) return { ok: false, reason: 'missingId' };

  const co = u.co;
  if (!Array.isArray(co) || co.length < 2 || !isNum(co[0]) || !isNum(co[1])) return { ok: false, reason: 'badPosition' };
  const lat = co[0];
  const lon = co[1];
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ok: false, reason: 'badPosition' };
  // GeoFS guest placeholders ("Foo") are sent as all-zero records.
  if (lat === 0 && lon === 0) return { ok: false, reason: 'placeholderPosition' };

  const alt = isNum(co[2]) && co[2] >= LIMITS.minAltitudeM && co[2] <= LIMITS.maxAltitudeM ? co[2] : null;
  const st = u.st && typeof u.st === 'object' && !Array.isArray(u.st) ? (u.st as Record<string, unknown>) : {};
  const as = st.as;
  const speed = isNum(as) && as >= 0 && as <= LIMITS.maxSpeedKts ? Math.round(as) : null;

  let typeId: number | null = null;
  let typeRaw: string | null = null;
  if (u.ac !== null && u.ac !== undefined && u.ac !== '') {
    typeRaw = String(u.ac);
    const n = typeof u.ac === 'number' ? u.ac : /^\d+$/.test(typeRaw) ? Number(typeRaw) : NaN;
    typeId = Number.isInteger(n) ? n : null;
  }

  return {
    ok: true,
    obs: {
      id,
      callsign: typeof u.cs === 'string' ? u.cs : '',
      accountId: isNum(u.acid) ? u.acid : null,
      aircraftTypeId: typeId,
      aircraftTypeRaw: typeRaw,
      lat,
      lon,
      altitudeM: alt,
      headingDeg: normalizeHeading(co[3]),
      speedKts: speed,
      serverTimeMs: isNum(u.ti) ? u.ti : null,
    },
  };
}

export function parseMapResponse(json: unknown, fetchedAt: Date): MapSnapshot {
  if (!json || typeof json !== 'object' || !Array.isArray((json as { users?: unknown }).users)) {
    throw new Error('Unexpected /map response shape: missing "users" array');
  }
  const body = json as { users: unknown[]; userCount?: unknown };
  const rejected: RejectCounts = { notObject: 0, missingId: 0, badPosition: 0, placeholderPosition: 0 };
  const byId = new Map<string, Observation>();
  let duplicateIds = 0;
  for (const raw of body.users) {
    const r = parseUser(raw);
    if (!r.ok) { rejected[r.reason]++; continue; }
    if (byId.has(r.obs.id)) duplicateIds++;
    byId.set(r.obs.id, r.obs); // last wins
  }
  return {
    fetchedAt,
    reportedUserCount: isNum(body.userCount) ? body.userCount : null,
    observations: [...byId.values()],
    rejected,
    duplicateIds,
  };
}
