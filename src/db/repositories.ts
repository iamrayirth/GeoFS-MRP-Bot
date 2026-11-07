import { and, asc, eq, gt, lt, lte, sql, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import { aircraftCooldowns, aircraftTracking, identifiers, ignoredAircraft, monitoredCountries, settings } from './schema.js';

export const SETTING_CHANNEL = 'notification_channel_id';
export const SETTING_ROLE = 'notification_role_id';

export class SettingsRepo {
  constructor(private readonly db: Db) {}
  async get(key: string): Promise<string | null> {
    const [r] = await this.db.select().from(settings).where(eq(settings.key, key));
    return r?.value ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
  async clear(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}

export interface IdentifierRow { value: string; normalized: string; }
export class IdentifierRepo {
  constructor(private readonly db: Db) {}
  async list(): Promise<IdentifierRow[]> {
    return this.db.select({ value: identifiers.value, normalized: identifiers.normalized }).from(identifiers).orderBy(asc(identifiers.id));
  }
  async add(value: string, normalized: string, by: string | null): Promise<boolean> {
    const r = await this.db.insert(identifiers).values({ value, normalized, createdBy: by }).onConflictDoNothing().returning({ id: identifiers.id });
    return r.length > 0;
  }
  async remove(normalized: string): Promise<boolean> {
    const r = await this.db.delete(identifiers).where(eq(identifiers.normalized, normalized)).returning({ id: identifiers.id });
    return r.length > 0;
  }
}

export interface CountryRow { iso3: string; name: string; }
export class CountryRepo {
  constructor(private readonly db: Db) {}
  async list(): Promise<CountryRow[]> {
    return this.db.select({ iso3: monitoredCountries.iso3, name: monitoredCountries.name }).from(monitoredCountries).orderBy(asc(monitoredCountries.name));
  }
  async add(iso3: string, name: string, by: string | null): Promise<boolean> {
    const r = await this.db.insert(monitoredCountries).values({ iso3, name, createdBy: by }).onConflictDoNothing().returning({ iso3: monitoredCountries.iso3 });
    return r.length > 0;
  }
  async remove(iso3: string): Promise<boolean> {
    const r = await this.db.delete(monitoredCountries).where(eq(monitoredCountries.iso3, iso3)).returning({ iso3: monitoredCountries.iso3 });
    return r.length > 0;
  }
}

export interface ClaimResult {
  claimed: boolean;
  /** The previous lastAlertAt (null if never alerted) - needed to roll back if delivery fails. */
  previous: Date | null;
}

export class CooldownRepo {
  constructor(private readonly db: Db) {}

  async get(aircraftId: string) {
    const [r] = await this.db.select().from(aircraftCooldowns).where(eq(aircraftCooldowns.aircraftId, aircraftId));
    return r ?? null;
  }

  /** All cooldown rows still inside the window - used to warm the in-memory pre-check after a restart. */
  async loadActive(now: Date, cooldownMs: number) {
    return this.db.select().from(aircraftCooldowns).where(gt(aircraftCooldowns.lastAlertAt, new Date(now.getTime() - cooldownMs)));
  }

  /**
   * Atomically claim the right to alert for this aircraft. A single conditional upsert: the update only fires if the
   * existing lastAlertAt is at least `cooldownMs` old (>=, so exactly 10:00 later is eligible). Concurrent callers,
   * overlapping processes and post-restart replays cannot both succeed.
   */
  async tryClaim(aircraftId: string, callsign: string, countryIso3: string | null, now: Date, cooldownMs: number): Promise<ClaimResult> {
    const previous = (await this.get(aircraftId))?.lastAlertAt ?? null;
    const threshold = new Date(now.getTime() - cooldownMs);
    const rows = await this.db
      .insert(aircraftCooldowns)
      .values({ aircraftId, callsign, lastAlertAt: now, lastCountryIso3: countryIso3, alertCount: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: aircraftCooldowns.aircraftId,
        set: { callsign, lastAlertAt: now, lastCountryIso3: countryIso3, alertCount: sql`${aircraftCooldowns.alertCount} + 1`, updatedAt: now },
        setWhere: lte(aircraftCooldowns.lastAlertAt, threshold),
      })
      .returning({ aircraftId: aircraftCooldowns.aircraftId });
    return { claimed: rows.length > 0, previous };
  }

  /** Undo a claim whose notification could not be delivered, so the alert is retried next cycle. */
  async release(aircraftId: string, claimedAt: Date, previous: Date | null): Promise<void> {
    if (previous === null) {
      await this.db.delete(aircraftCooldowns).where(and(eq(aircraftCooldowns.aircraftId, aircraftId), eq(aircraftCooldowns.lastAlertAt, claimedAt)));
    } else {
      await this.db
        .update(aircraftCooldowns)
        .set({ lastAlertAt: previous, alertCount: sql`greatest(${aircraftCooldowns.alertCount} - 1, 1)` })
        .where(and(eq(aircraftCooldowns.aircraftId, aircraftId), eq(aircraftCooldowns.lastAlertAt, claimedAt)));
    }
  }

  async prune(olderThan: Date): Promise<number> {
    const r = await this.db.delete(aircraftCooldowns).where(lt(aircraftCooldowns.lastAlertAt, olderThan)).returning({ id: aircraftCooldowns.aircraftId });
    return r.length;
  }
}

export interface IgnoreRow { aircraftId: string; callsign: string; expiresAt: Date; createdBy: string | null; }
export class IgnoreRepo {
  constructor(private readonly db: Db) {}
  async upsert(aircraftId: string, callsign: string, expiresAt: Date, by: string | null): Promise<void> {
    await this.db
      .insert(ignoredAircraft)
      .values({ aircraftId, callsign, expiresAt, createdBy: by })
      .onConflictDoUpdate({ target: ignoredAircraft.aircraftId, set: { callsign, expiresAt, createdBy: by } });
  }
  async remove(aircraftId: string): Promise<boolean> {
    const r = await this.db.delete(ignoredAircraft).where(eq(ignoredAircraft.aircraftId, aircraftId)).returning({ id: ignoredAircraft.aircraftId });
    return r.length > 0;
  }
  /** Only ignores that have not yet expired. Expiry is evaluated against `now`, never by a cleanup job. */
  async listActive(now: Date): Promise<IgnoreRow[]> {
    return this.db.select().from(ignoredAircraft).where(gt(ignoredAircraft.expiresAt, now)).orderBy(asc(ignoredAircraft.expiresAt));
  }
  async prune(expiredBefore: Date): Promise<number> {
    const r = await this.db.delete(ignoredAircraft).where(lt(ignoredAircraft.expiresAt, expiredBefore)).returning({ id: ignoredAircraft.aircraftId });
    return r.length;
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
  constructor(private readonly db: Db) {}
  async upsertMany(records: TrackingRecord[]): Promise<void> {
    if (!records.length) return;
    await this.db
      .insert(aircraftTracking)
      .values(records)
      .onConflictDoUpdate({
        target: aircraftTracking.aircraftId,
        set: {
          callsign: sql`excluded.callsign`,
          accountId: sql`excluded.account_id`,
          aircraftTypeId: sql`excluded.aircraft_type_id`,
          matchedIdentifiers: sql`excluded.matched_identifiers`,
          lat: sql`excluded.lat`,
          lon: sql`excluded.lon`,
          altitudeM: sql`excluded.altitude_m`,
          speedKts: sql`excluded.speed_kts`,
          headingDeg: sql`excluded.heading_deg`,
          countryIso3: sql`excluded.country_iso3`,
          lastSeenAt: sql`excluded.last_seen_at`,
          active: sql`excluded.active`,
          lastAlertAt: sql`coalesce(excluded.last_alert_at, ${aircraftTracking.lastAlertAt})`,
        },
      });
  }
  async markInactive(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.update(aircraftTracking).set({ active: false }).where(inArray(aircraftTracking.aircraftId, ids));
  }
  async markAllInactive(): Promise<void> {
    await this.db.update(aircraftTracking).set({ active: false }).where(eq(aircraftTracking.active, true));
  }
  async get(aircraftId: string) {
    const [r] = await this.db.select().from(aircraftTracking).where(eq(aircraftTracking.aircraftId, aircraftId));
    return r ?? null;
  }
  async prune(olderThan: Date): Promise<number> {
    const r = await this.db.delete(aircraftTracking).where(lt(aircraftTracking.lastSeenAt, olderThan)).returning({ id: aircraftTracking.aircraftId });
    return r.length;
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

export function createRepos(db: Db): Repos {
  return {
    settings: new SettingsRepo(db),
    identifiers: new IdentifierRepo(db),
    countries: new CountryRepo(db),
    cooldowns: new CooldownRepo(db),
    ignores: new IgnoreRepo(db),
    tracking: new TrackingRepo(db),
  };
}
