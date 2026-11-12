import type { CountryRef, Tier } from '../geo/types.js';
import type { OspreyIdentity } from '../osprey/client.js';

/** Optional Osprey enrichment attached to an alert. Alerts never depend on it. */
export type OspreyAlertInfo =
  | { status: 'ok'; identity: OspreyIdentity }
  | { status: 'not_found' }
  | { status: 'unavailable' }
  | { status: 'disabled' };

export interface AlertPayload {
  /** entered = was not inside monitored territory at the previous observation; remains = still inside (repeat alert). */
  kind: 'entered' | 'remains';
  aircraftId: string;
  callsign: string;
  matchedIdentifiers: string[];
  aircraftTypeLabel: string;
  lat: number;
  lon: number;
  altitudeM: number | null;
  speedKts: number | null;
  headingDeg: number | null;
  /** The monitored country that triggered the alert. */
  country: CountryRef;
  /** Other sovereigns claiming the same spot (disputed / overlapping / joint regime). */
  otherClaimants: CountryRef[];
  territory: string | null;
  tier: Tier;
  snapped: boolean;
  detectedAt: Date;
  osprey: OspreyAlertInfo;
  channelId: string;
  roleId: string;
}

export interface Notifier {
  /** Resolves once the message is delivered; throws (after internal retries) if it could not be. */
  send(payload: AlertPayload): Promise<void>;
}

export class PermanentNotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentNotifyError';
  }
}
