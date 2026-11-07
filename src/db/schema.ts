import { bigint, boolean, index, integer, jsonb, pgTable, serial, text, timestamp, doublePrecision } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Key/value application settings (notification channel & role). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Callsign identifiers, e.g. "[USAF]". `normalized` is the case-folded form used for uniqueness/matching. */
export const identifiers = pgTable('identifiers', {
  id: serial('id').primaryKey(),
  value: text('value').notNull(),
  normalized: text('normalized').notNull().unique(),
  createdBy: text('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Monitored countries keyed by sovereign ISO-3166 alpha-3 (Kosovo: XKX). */
export const monitoredCountries = pgTable('monitored_countries', {
  iso3: text('iso3').primaryKey(),
  name: text('name').notNull(),
  createdBy: text('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * One row per GeoFS multiplayer id that has ever been alerted: the single GLOBAL 10-minute cooldown.
 * Updated atomically (conditional upsert) so restarts and concurrent processing can never double-alert.
 */
export const aircraftCooldowns = pgTable(
  'aircraft_cooldowns',
  {
    aircraftId: text('aircraft_id').primaryKey(),
    callsign: text('callsign').notNull(),
    lastAlertAt: ts('last_alert_at').notNull(),
    lastCountryIso3: text('last_country_iso3'),
    alertCount: integer('alert_count').notNull().default(1),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('aircraft_cooldowns_last_alert_idx').on(t.lastAlertAt)],
);

/** Temporary ignores, keyed by multiplayer id (a reconnect gets a new id and is therefore NOT ignored). */
export const ignoredAircraft = pgTable(
  'ignored_aircraft',
  {
    aircraftId: text('aircraft_id').primaryKey(),
    callsign: text('callsign').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('ignored_aircraft_expires_idx').on(t.expiresAt)],
);

/** Persisted tracking history for aircraft that match a configured identifier. */
export const aircraftTracking = pgTable(
  'aircraft_tracking',
  {
    aircraftId: text('aircraft_id').primaryKey(),
    callsign: text('callsign').notNull(),
    accountId: bigint('account_id', { mode: 'number' }),
    aircraftTypeId: integer('aircraft_type_id'),
    matchedIdentifiers: jsonb('matched_identifiers').$type<string[]>().notNull().default([]),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    altitudeM: doublePrecision('altitude_m'),
    speedKts: doublePrecision('speed_kts'),
    headingDeg: doublePrecision('heading_deg'),
    countryIso3: text('country_iso3'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    active: boolean('active').notNull().default(true),
    lastAlertAt: ts('last_alert_at'),
  },
  (t) => [index('aircraft_tracking_last_seen_idx').on(t.lastSeenAt)],
);

export const schema = { settings, identifiers, monitoredCountries, aircraftCooldowns, ignoredAircraft, aircraftTracking };
