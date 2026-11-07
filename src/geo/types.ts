export type Tier = 'land' | 'internal' | 'archipelagic' | '12nm';

export interface CountryRef {
  iso3: string;
  iso2: string | null;
  name: string;
}

export interface GeoResult {
  /**
   * resolved   - exactly one sovereign claims the point
   * ambiguous  - several sovereigns claim it (disputed / overlapping / joint regime); all are in `countries`
   * unresolved - not inside any country's land, internal/archipelagic waters or 12 NM territorial sea
   *              (e.g. high seas, an EEZ beyond 12 NM, or Antarctica). Never guessed.
   */
  status: 'resolved' | 'ambiguous' | 'unresolved';
  tier: Tier | null;
  countries: CountryRef[];
  /** Territory/administrative entity name when available (e.g. "Guam" under United States). */
  territory: string | null;
  /** True if the point was within the coastal tolerance of land but in a data gap between layers. */
  snapped: boolean;
}

export const UNRESOLVED: GeoResult = { status: 'unresolved', tier: null, countries: [], territory: null, snapped: false };
