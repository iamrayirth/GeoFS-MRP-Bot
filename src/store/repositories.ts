import type { JsonStore, StateFile } from './json-store.js';

export const SETTING_CHANNEL = 'notification_channel_id';
export const SETTING_ROLE = 'notification_role_id';

const d = (s: string) => new Date(s);
const iso = (x: Date) => x.toISOString();

export class SettingsRepo {
  constructor(private readonly store: JsonStore) {}
  async get(key: string): Promise<string | null> { return this.store.state.settings[key] ?? null; }
  async set(key: string, value: string): Promise<void> {
    const prev = this.store.state.settings[key];
    this.store.state.settings[key] = value;
    await this.store.commit(true).catch((e) => { if (prev === undefined) delete this.store.state.settings[key]; else this.store.state.settings[key] = prev; throw e; });
  }
  async clear(key: string): Promise<void> {
    const prev = this.store.state.settings[key];
    delete this.store.state.settings[key];
    await this.store.commit(true).catch((e) => { if (prev !== undefined) this.store.state.settings[key] = prev; throw e; });
  }
}

export interface IdentifierRow { value: string; normalized: string; }
export class IdentifierRepo {
  constructor(private readonly store: JsonStore) {}
  async list(): Promise<IdentifierRow[]> { return this.store.state.identifiers.map(({ value, normalized }) => ({ value, normalized })); }
  async add(value: string, normalized: string, by: string | null): Promise<boolean> {
    const list = this.store.state.identifiers;
    if (list.some((x) => x.normalized === normalized)) return false;
    const row = { value, normalized, createdBy: by, createdAt: iso(new Date()) };
    list.push(row);
    await this.store.commit(true).catch((e) => { list.splice(list.indexOf(row), 1); throw e; });
    return true;
  }
  async remove(normalized: string): Promise<boolean> {
    const list = this.store.state.identifiers;
    const i = list.findIndex((x) => x.normalized === normalized);
    if (i < 0) return false;
    const [row] = list.splice(i, 1);
    await this.store.commit(true).catch((e) => { list.splice(i, 0, row!); throw e; });
    return true;
  }
}

export interface CountryRow { iso3: string; name: string; }
export class CountryRepo {
  constructor(private readonly store: JsonStore) {}
  async list(): Promise<CountryRow[]> {
    return this.store.state.countries.map(({ iso3, name }) => ({ iso3, name })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async add(iso3: string, name: string, by: string | null): Promise<boolean> {
    const list = this.store.state.countries;
    if (list.some((x) => x.iso3 === iso3)) return false;
    const row = { iso3, name, createdBy: by, createdAt: iso(new Date()) };
    list.push(row);
    await this.store.commit(true).catch((e) => { list.splice(list.indexOf(row), 1); throw e; });
    return true;
  }
  async remove(iso3: string): Promise<boolean> {
    const list = this.store.state.countries;
    const i = list.findIndex((x) => x.iso3 === iso3);
    if (i < 0) return false;
    const [row] = list.splice(i, 1);
    await this.store.commit(true).catch((e) => { list.splice(i, 0, row!); throw e; });
    return true;
  }
}

export interface ClaimResult {
  claimed: boolean;
  /** The previous lastAlertAt (null if never alerted) - needed to roll back if delivery fails. */
  previous: Date | null;
}

export interface CooldownRow { aircraftId: string; callsign: string; lastAlertAt: Date; lastCountryIso3: string | null; alertCount: number; }

export class CooldownRepo {
  constructor(private readonly store: JsonStore) {}

  private row(id: string, r: StateFile['cooldowns'][string]): CooldownRow {
    return { aircraftId: id, callsign: r.callsign, lastAlertAt: d(r.lastAlertAt), lastCountryIso3: r.lastCountryIso3, alertCount: r.alertCount };
  }

  async get(aircraftId: string): Promise<CooldownRow | null> {
    const r = this.store.state.cooldowns[aircraftId];
    return r ? this.row(aircraftId, r) : null;
  }

  /** All cooldown rows still inside the window - used to warm the in-memory pre-check after a restart. */
  async loadActive(now: Date, cooldownMs: number): Promise<CooldownRow[]> {
    const cutoff = now.getTime() - cooldownMs;
    return Object.entries(this.store.state.cooldowns).filter(([, r]) => d(r.lastAlertAt).getTime() > cutoff).map(([id, r]) => this.row(id, r));
  }

  /**
   * Atomically claim the right to alert for this aircraft. The check and the write happen in one synchronous section, so
   * concurrent callers cannot both succeed; the single-instance lock extends that across processes. The claim is
   * eligible when the existing lastAlertAt is at least `cooldownMs` old (>=: exactly 10:00 later is allowed). The claim is
   * flushed to disk before returning; if that fails the in-memory change is reverted and the error propagates.
   */
  async tryClaim(aircraftId: string, callsign: string, countryIso3: string | null, now: Date, cooldownMs: number): Promise<ClaimResult> {
    const rows = this.store.state.cooldowns;
    const prev = rows[aircraftId];
    const previous = prev ? d(prev.lastAlertAt) : null;
    if (prev && now.getTime() - d(prev.lastAlertAt).getTime() < cooldownMs) return { claimed: false, previous };
    rows[aircraftId] = { callsign, lastAlertAt: iso(now), lastCountryIso3: countryIso3, alertCount: (prev?.alertCount ?? 0) + 1, updatedAt: iso(now) };
    try { await this.store.commit(true); }
    catch (e) { if (prev) rows[aircraftId] = prev; else delete rows[aircraftId]; throw e; }
    return { claimed: true, previous };
  }

  /** Undo a claim whose notification could not be delivered, so the alert is retried next cycle. */
  async release(aircraftId: string, claimedAt: Date, previous: Date | null): Promise<void> {
    const rows = this.store.state.cooldowns;
    const cur = rows[aircraftId];
    if (!cur || cur.lastAlertAt !== iso(claimedAt)) return; // a newer claim exists: leave it alone
    if (previous === null) delete rows[aircraftId];
    else rows[aircraftId] = { ...cur, lastAlertAt: iso(previous), alertCount: Math.max(cur.alertCount - 1, 1) };
    await this.store.commit(true);
  }

  async prune(olderThan: Date): Promise<number> {
    let n = 0;
    for (const [id, r] of Object.entries(this.store.state.cooldowns)) if (d(r.lastAlertAt) < olderThan) { delete this.store.state.cooldowns[id]; n++; }
    if (n) await this.store.commit(false);
    return n;
  }
}

export interface IgnoreRow { aircraftId: string; callsign: string; expiresAt: Date; createdBy: string | null; }
export class IgnoreRepo {
  constructor(private readonly store: JsonStore) {}
  async upsert(aircraftId: string, callsign: string, expiresAt: Date, by: string | null): Promise<void> {
    const rows = this.store.state.ignores;
    const prev = rows[aircraftId];
    rows[aircraftId] = { callsign, expiresAt: iso(expiresAt), createdBy: by, createdAt: prev?.createdAt ?? iso(new Date()) };
    await this.store.commit(true).catch((e) => { if (prev) rows[aircraftId] = prev; else delete rows[aircraftId]; throw e; });
  }
  async remove(aircraftId: string): Promise<boolean> {
    const rows = this.store.state.ignores;
    const prev = rows[aircraftId];
    if (!prev) return false;
    delete rows[aircraftId];
    await this.store.commit(true).catch((e) => { rows[aircraftId] = prev; throw e; });
    return true;
  }
  /** Only ignores that have not yet expired. Expiry is evaluated against `now`, never by a cleanup job. */
  async listActive(now: Date): Promise<IgnoreRow[]> {
    return Object.entries(this.store.state.ignores)
      .filter(([, r]) => d(r.expiresAt).getTime() > now.getTime())
      .map(([aircraftId, r]) => ({ aircraftId, callsign: r.callsign, expiresAt: d(r.expiresAt), createdBy: r.createdBy }))
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  }
  async prune(expiredBefore: Date): Promise<number> {
    let n = 0;
    for (const [id, r] of Object.entries(this.store.state.ignores)) if (d(r.expiresAt) < expiredBefore) { delete this.store.state.ignores[id]; n++; }
    if (n) await this.store.commit(false);
    return n;
  }
}

export interface TrackingRecord {
  aircraftId: string;
  callsign: string;
  accountId: number | null;
  aircraftTypeId: number | null;
  matchedIdentifiers: string[];
  lat: number | null;
  lon: number | null;
  altitudeM: number | null;
  speedKts: number | null;
  headingDeg: number | null;
  countryIso3: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  active: boolean;
  lastAlertAt: Date | null;
}

export class TrackingRepo {
  constructor(private readonly store: JsonStore) {}

  private rec(id: string, r: StateFile['tracking'][string]): TrackingRecord {
    return { ...r, aircraftId: id, firstSeenAt: d(r.firstSeenAt), lastSeenAt: d(r.lastSeenAt), lastAlertAt: r.lastAlertAt ? d(r.lastAlertAt) : null };
  }

  /** History only: written with a short debounce rather than on every poll. */
  async upsertMany(records: TrackingRecord[]): Promise<void> {
    if (!records.length) return;
    const rows = this.store.state.tracking;
    for (const r of records) {
      const prev = rows[r.aircraftId];
      rows[r.aircraftId] = {
        callsign: r.callsign, accountId: r.accountId, aircraftTypeId: r.aircraftTypeId, matchedIdentifiers: [...r.matchedIdentifiers],
        lat: r.lat, lon: r.lon, altitudeM: r.altitudeM, speedKts: r.speedKts, headingDeg: r.headingDeg, countryIso3: r.countryIso3,
        firstSeenAt: prev?.firstSeenAt ?? r.firstSeenAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), active: r.active,
        lastAlertAt: r.lastAlertAt ? r.lastAlertAt.toISOString() : prev?.lastAlertAt ?? null,
      };
    }
    await this.store.commit(false);
  }
  async markInactive(ids: string[]): Promise<void> {
    let n = 0;
    for (const id of ids) { const r = this.store.state.tracking[id]; if (r?.active) { r.active = false; n++; } }
    if (n) await this.store.commit(false);
  }
  async markAllInactive(): Promise<void> {
    let n = 0;
    for (const r of Object.values(this.store.state.tracking)) if (r.active) { r.active = false; n++; }
    if (n) await this.store.commit(false);
  }
  async get(aircraftId: string): Promise<TrackingRecord | null> {
    const r = this.store.state.tracking[aircraftId];
    return r ? this.rec(aircraftId, r) : null;
  }
  async prune(olderThan: Date): Promise<number> {
    let n = 0;
    for (const [id, r] of Object.entries(this.store.state.tracking)) if (d(r.lastSeenAt) < olderThan) { delete this.store.state.tracking[id]; n++; }
    if (n) await this.store.commit(false);
    return n;
  }
}

export interface Repos {
  settings: SettingsRepo;
  identifiers: IdentifierRepo;
  countries: CountryRepo;
  cooldowns: CooldownRepo;
  ignores: IgnoreRepo;
  tracking: TrackingRepo;
}

export function createRepos(store: JsonStore): Repos {
  return {
    settings: new SettingsRepo(store),
    identifiers: new IdentifierRepo(store),
    countries: new CountryRepo(store),
    cooldowns: new CooldownRepo(store),
    ignores: new IgnoreRepo(store),
    tracking: new TrackingRepo(store),
  };
}
