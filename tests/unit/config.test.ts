import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

/** Parse .env.example exactly as dotenv would (KEY=VALUE lines). */
function envExample(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(new URL('../../.env.example', import.meta.url), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe('configuration', () => {
  it('the shipped .env.example is valid once the required secrets are filled in', () => {
    const cfg = loadConfig({ ...envExample(), DISCORD_TOKEN: 'x'.repeat(40) });
    expect(cfg.DISCORD_GUILD_ID).toBeUndefined();
    expect(cfg.DISCORD_CLIENT_ID).toBeUndefined();
    expect(cfg.AUTHORIZED_USER_IDS).toEqual([]);
    expect(cfg.POLL_INTERVAL_MS).toBe(10_000);
    expect(cfg.GEOFS_API).toBe('https://mps.geo-fs.com/map');
    expect(cfg.STATE_DIR).toBe('./state');
    expect(cfg.OSPREY_BASE).toBe('https://api.gms-admin.net/api/v2');
    expect(cfg.OSPREY_ENABLED).toBe(true);
    expect(cfg.LOG_PRETTY).toBe(false);
  });

  it('reports every problem at once and never echoes secrets', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/);
    try { loadConfig({ DISCORD_TOKEN: 'secret-token-value-secret-token-value', POLL_INTERVAL_MS: '10' }); }
    catch (e) { expect(String(e)).toMatch(/POLL_INTERVAL_MS/); expect(String(e)).not.toContain('secret-token-value'); }
  });

  it('parses ids, booleans and numbers', () => {
    const cfg = loadConfig({ DISCORD_TOKEN: 'x'.repeat(40), AUTHORIZED_USER_IDS: '123456789012345678, 223456789012345678', OSPREY_ENABLED: 'false', REGISTER_COMMANDS: '0', HEALTH_PORT: '0' });
    expect(cfg.AUTHORIZED_USER_IDS).toHaveLength(2);
    expect(cfg.OSPREY_ENABLED).toBe(false);
    expect(cfg.REGISTER_COMMANDS).toBe(false);
    expect(cfg.HEALTH_PORT).toBe(0);
    expect(() => loadConfig({ DISCORD_TOKEN: 'x'.repeat(40), AUTHORIZED_USER_IDS: 'not-an-id' })).toThrow(/AUTHORIZED_USER_IDS/);
  });
});
