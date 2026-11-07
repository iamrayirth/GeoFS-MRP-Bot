import { describe, expect, it } from 'vitest';
import { cooldownRemainingMs, evaluateAlert, isCooldownActive, type DecisionInput } from '../../src/alerts/decision.js';
import { ALERT_COOLDOWN_MS } from '../../src/config.js';

const t = (hhmmss: string) => new Date(`2026-01-01T${hhmmss}Z`);
const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  active: true, matchedIdentifierCount: 1, ignoredUntil: null, countryResolved: true, inMonitoredCountry: true,
  notificationConfigured: true, lastAlertAt: null, now: t('12:00:00'), ...over,
});

describe('global cooldown', () => {
  it('is fixed at exactly 10 minutes', () => expect(ALERT_COOLDOWN_MS).toBe(600_000));

  it('boundary: active at 9:59.999, eligible at exactly 10:00', () => {
    const last = t('12:00:00');
    expect(isCooldownActive(last, new Date(last.getTime() + 599_999))).toBe(true);
    expect(isCooldownActive(last, new Date(last.getTime() + 600_000))).toBe(false);
    expect(cooldownRemainingMs(last, t('12:03:00'))).toBe(7 * 60_000);
    expect(cooldownRemainingMs(null, t('12:03:00'))).toBe(0);
  });

  it('never-alerted aircraft is eligible', () => expect(evaluateAlert(base())).toEqual({ alert: true }));

  it('suppresses during cooldown regardless of which monitored country it is in', () => {
    const lastAlertAt = t('12:00:00');
    expect(evaluateAlert(base({ lastAlertAt, now: t('12:03:00') }))).toEqual({ alert: false, reason: 'cooldown' });
    expect(evaluateAlert(base({ lastAlertAt, now: t('12:08:00') }))).toEqual({ alert: false, reason: 'cooldown' });
    expect(evaluateAlert(base({ lastAlertAt, now: t('12:10:00') }))).toEqual({ alert: true });
  });

  it('after expiry: no alert if outside monitored countries, alert immediately on a later entry', () => {
    const lastAlertAt = t('12:00:00');
    expect(evaluateAlert(base({ lastAlertAt, now: t('12:15:00'), inMonitoredCountry: false }))).toEqual({ alert: false, reason: 'not-monitored' });
    expect(evaluateAlert(base({ lastAlertAt, now: t('12:16:00'), inMonitoredCountry: true }))).toEqual({ alert: true });
  });
});

describe('other gates', () => {
  it('no identifier match', () => expect(evaluateAlert(base({ matchedIdentifierCount: 0 }))).toEqual({ alert: false, reason: 'no-identifier-match' }));
  it('inactive', () => expect(evaluateAlert(base({ active: false }))).toEqual({ alert: false, reason: 'inactive' }));
  it('unresolved country is never guessed', () => expect(evaluateAlert(base({ countryResolved: false, inMonitoredCountry: false }))).toEqual({ alert: false, reason: 'country-unresolved' }));
  it('unmonitored country', () => expect(evaluateAlert(base({ inMonitoredCountry: false }))).toEqual({ alert: false, reason: 'not-monitored' }));
  it('notifications not configured', () => expect(evaluateAlert(base({ notificationConfigured: false }))).toEqual({ alert: false, reason: 'not-configured' }));
});

describe('ignore expiry', () => {
  it('ignored while the expiry is in the future', () => {
    expect(evaluateAlert(base({ ignoredUntil: t('12:30:00'), now: t('12:29:59') }))).toEqual({ alert: false, reason: 'ignored' });
  });
  it('eligible again at/after expiry', () => {
    expect(evaluateAlert(base({ ignoredUntil: t('12:30:00'), now: t('12:30:00') }))).toEqual({ alert: true });
    expect(evaluateAlert(base({ ignoredUntil: t('12:30:00'), now: t('13:00:00') }))).toEqual({ alert: true });
  });
  it('an ignore takes precedence over everything downstream', () => {
    expect(evaluateAlert(base({ ignoredUntil: t('13:00:00'), lastAlertAt: null }))).toEqual({ alert: false, reason: 'ignored' });
  });
});
