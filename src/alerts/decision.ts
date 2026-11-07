import { ALERT_COOLDOWN_MS } from '../config.js';

export { ALERT_COOLDOWN_MS };

/**
 * The single, global, fixed cooldown: one window per aircraft (multiplayer id), shared across ALL countries.
 * Eligible again once `now - lastAlertAt >= 10 minutes` (so exactly 10:00 later is eligible).
 */
export function isCooldownActive(lastAlertAt: Date | null | undefined, now: Date, cooldownMs = ALERT_COOLDOWN_MS): boolean {
  if (!lastAlertAt) return false;
  return now.getTime() - lastAlertAt.getTime() < cooldownMs;
}

export function cooldownRemainingMs(lastAlertAt: Date | null | undefined, now: Date, cooldownMs = ALERT_COOLDOWN_MS): number {
  if (!lastAlertAt) return 0;
  return Math.max(0, lastAlertAt.getTime() + cooldownMs - now.getTime());
}

export type SkipReason =
  | 'inactive'
  | 'no-identifier-match'
  | 'ignored'
  | 'country-unresolved'
  | 'not-monitored'
  | 'not-configured'
  | 'cooldown'
  | 'send-backoff';

export interface DecisionInput {
  active: boolean;
  matchedIdentifierCount: number;
  /** Expiry of an ignore for this multiplayer id, if any. Ignores whose expiry has passed do NOT apply. */
  ignoredUntil: Date | null;
  countryResolved: boolean;
  inMonitoredCountry: boolean;
  notificationConfigured: boolean;
  lastAlertAt: Date | null;
  now: Date;
  /** Per-aircraft retry holdoff after a failed delivery (not a cooldown: the cooldown is only consumed on success). */
  sendBackoffUntil?: Date | null;
}

export type Decision = { alert: true } | { alert: false; reason: SkipReason };

/**
 * Pure decision function. Level-triggered, not edge-triggered: whenever an aircraft is inside a monitored country and
 * its global cooldown has elapsed, it alerts - which gives exactly the specified behaviour:
 *   12:00 India ALERT, 12:03 Pakistan -, 12:08 Nepal -, 12:10 still Nepal ALERT, 12:20 still Nepal ALERT.
 * Leaving all monitored countries emits nothing; re-entering later alerts immediately if the cooldown has elapsed.
 */
export function evaluateAlert(i: DecisionInput): Decision {
  if (!i.active) return { alert: false, reason: 'inactive' };
  if (i.matchedIdentifierCount === 0) return { alert: false, reason: 'no-identifier-match' };
  if (i.ignoredUntil && i.ignoredUntil.getTime() > i.now.getTime()) return { alert: false, reason: 'ignored' };
  if (!i.countryResolved) return { alert: false, reason: 'country-unresolved' };
  if (!i.inMonitoredCountry) return { alert: false, reason: 'not-monitored' };
  if (!i.notificationConfigured) return { alert: false, reason: 'not-configured' };
  if (isCooldownActive(i.lastAlertAt, i.now)) return { alert: false, reason: 'cooldown' };
  if (i.sendBackoffUntil && i.sendBackoffUntil.getTime() > i.now.getTime()) return { alert: false, reason: 'send-backoff' };
  return { alert: true };
}
