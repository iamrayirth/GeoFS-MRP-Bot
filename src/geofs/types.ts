/** One validated aircraft record from the GeoFS multiplayer map. Nothing here is invented: unknown => null. */
export interface Observation {
  /** GeoFS multiplayer ID (`id` in the /map payload). Session-scoped: reconnecting yields a new one. */
  id: string;
  callsign: string;
  /** GeoFS account id (`acid`); null for guests. */
  accountId: number | null;
  /** Numeric aircraft type id (`ac`), null when absent/malformed. */
  aircraftTypeId: number | null;
  /** Raw `ac` value as received, kept so unmapped types can be shown verbatim. */
  aircraftTypeRaw: string | null;
  lat: number;
  lon: number;
  /** Metres above sea level (`co[2]`), null if implausible. */
  altitudeM: number | null;
  /** Degrees 0..<360 (`co[3]`, normalised), null if implausible. */
  headingDeg: number | null;
  /** Indicated airspeed in knots (`st.as`), null if implausible. */
  speedKts: number | null;
  /** Server timestamp of last update in epoch ms (`ti`), null if absent. */
  serverTimeMs: number | null;
}

export interface RejectCounts {
  notObject: number;
  missingId: number;
  badPosition: number;
  placeholderPosition: number;
}

export interface MapSnapshot {
  fetchedAt: Date;
  /** `userCount` reported by the server (may include null entries). */
  reportedUserCount: number | null;
  observations: Observation[];
  rejected: RejectCounts;
  duplicateIds: number;
}
