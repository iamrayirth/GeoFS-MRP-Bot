import { PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { BotContext } from '../../src/discord/context.js';
import { commandJson, commandMap } from '../../src/discord/commands/index.js';
import { createHarness, geo, log, obs, PLACE, snapshot, t, type Harness } from '../helpers/harness.js';

let h: Harness;
let ctx: BotContext;
const baseCfg = (extra: Record<string, string> = {}) => loadConfig({ DISCORD_TOKEN: 'x'.repeat(30), ...extra });

beforeEach(async () => {
  h = await createHarness({ identifiers: [], countries: [], configured: false });
  ctx = {
    cfg: baseCfg(), log, repos: h.repos, runtime: h.config, tracker: h.tracker, alerts: h.manager, directory: h.dir, geo: geo(), names: h.names, osprey: null, startedAt: new Date(),
    monitor: { poller: { state: { lastSuccessAt: new Date(), totalPolls: 1, totalFailures: 0, lastError: null } }, stats: { totalAlertsSent: 0, lastCycle: null } } as never,
    health: { check: async () => ({ status: 'ok', checks: { storage: { ok: true, lastWriteAt: null, lastWriteError: null }, osprey: { enabled: false, ok: null, lastSuccessAt: null, consecutiveFailures: 0, lastError: null }, discord: { ok: true, wsPingMs: 40 }, geofs: { ok: true, ageSeconds: 3, consecutiveFailures: 0, lastError: null, lastSuccessAt: null }, geodata: { ok: true, polygons: 6154 } }, uptimeSeconds: 5, memoryMb: 300 }) } as never,
  };
});
afterEach(async () => { await h.close(); });

interface Fake { replies: any[]; i: any; }
function call(name: string, sub: string | null, opts: Record<string, unknown> = {}, who: { id?: string; admin?: boolean; roles?: string[] } = {}, guild?: any): Fake {
  const replies: any[] = [];
  const i: any = {
    commandName: name, user: { id: who.id ?? 'user1' }, guildId: 'G', inGuild: () => true,
    memberPermissions: { has: (f: bigint) => !!who.admin && f === PermissionFlagsBits.Administrator },
    member: { roles: { cache: new Map((who.roles ?? []).map((r) => [r, {}])) } },
    guild: guild ?? null,
    options: {
      getSubcommand: () => sub, getSubcommandGroup: () => null,
      getString: (n: string) => opts[n] ?? null, getChannel: (n: string) => opts[n] ?? null, getRole: (n: string) => opts[n] ?? null,
    },
    editReply: async (x: any) => { replies.push(typeof x === 'string' ? { content: x } : x); },
  };
  return { replies, i };
}
const run = async (name: string, sub: string | null, opts = {}, who = {}, guild?: any) => {
  const f = call(name, sub, opts, who, guild);
  await commandMap.get(name)!.execute(f.i, ctx);
  return f.replies.map((r) => r.content ?? JSON.stringify(r.embeds?.[0]?.toJSON?.() ?? r)).join('\n');
};
const ADMIN = { admin: true };

describe('command definitions', () => {
  it('all commands serialise to valid Discord payloads (builders validate)', () => {
    const j = commandJson();
    expect(j.map((c) => c.name).sort()).toEqual(['aircraft', 'country', 'health', 'help', 'ident', 'identifier', 'ignore', 'ignored', 'roster', 'settings', 'status', 'unignore']);
    const sub = (n: string) => j.find((c) => c.name === n)!.options!.map((o: any) => o.name).sort();
    expect(sub('identifier')).toEqual(['add', 'list', 'remove']);
    expect(sub('country')).toEqual(['add', 'list', 'remove']);
    expect(sub('aircraft')).toEqual(['info', 'list']);
    expect(sub('settings')).toEqual(['channel', 'role', 'view']);
    expect(sub('ignore')).toEqual(['callsign', 'duration']);
  });
});

describe('authorisation', () => {
  it('regular members cannot change configuration', async () => {
    expect(await run('identifier', 'add', { value: '[USAF]' })).toMatch(/not authorised/);
    expect(await run('country', 'add', { country: 'India' })).toMatch(/not authorised/);
    expect(await run('settings', 'role', { role: { id: 'R' } })).toMatch(/not authorised/);
    expect(await run('ignore', null, { callsign: 'x', duration: '10m' })).toMatch(/not authorised/);
    expect(await run('unignore', null, { callsign: 'x' })).toMatch(/not authorised/);
    expect(h.config.identifiers).toHaveLength(0);
    expect(h.config.countries).toHaveLength(0);
  });

  it('administrators, authorised users and authorised roles can', async () => {
    expect(await run('identifier', 'add', { value: '[A]' }, ADMIN)).toMatch(/Added/);
    ctx = { ...ctx, cfg: baseCfg({ AUTHORIZED_USER_IDS: '123456789012345678', ADMIN_ROLE_IDS: '223456789012345678' }) };
    expect(await run('identifier', 'add', { value: '[B]' }, { id: '123456789012345678' })).toMatch(/Added/);
    expect(await run('identifier', 'add', { value: '[C]' }, { roles: ['223456789012345678'] })).toMatch(/Added/);
    expect(await run('identifier', 'add', { value: '[D]' }, { id: '999999999999999999', roles: ['1'] })).toMatch(/not authorised/);
    expect(h.config.identifiers.map((x) => x.value)).toEqual(['[A]', '[B]', '[C]']);
  });

  it('read-only commands work for everyone', async () => {
    expect(await run('identifier', 'list')).toMatch(/No identifiers/);
    expect(await run('country', 'list')).toMatch(/No countries/);
    expect(await run('ignored', null)).toMatch(/No aircraft/);
    expect(await run('settings', 'view')).toMatch(/not set/);
    expect(await run('help', null)).toContain('GeoFS MRP Bot');
    expect(await run('status', null)).toContain('GeoFS monitor status');
    expect(await run('health', null)).toContain('OK');
  });
});

describe('/identifier', () => {
  it('add, duplicate (case-insensitive), invalid, list, remove', async () => {
    expect(await run('identifier', 'add', { value: ' [USAF] ' }, ADMIN)).toMatch(/Added identifier `\[USAF\]`/);
    expect(await run('identifier', 'add', { value: '[usaf]' }, ADMIN)).toMatch(/already configured/);
    expect(await run('identifier', 'add', { value: '   ' }, ADMIN)).toMatch(/empty/);
    expect(await run('identifier', 'list')).toContain('[USAF]');
    expect(await run('identifier', 'remove', { value: '[Usaf]' }, ADMIN)).toMatch(/Removed/);
    expect(await run('identifier', 'remove', { value: '[Usaf]' }, ADMIN)).toMatch(/not a configured/);
    expect(h.config.identifiers).toHaveLength(0);
  });
});

describe('/country', () => {
  it('adds by name/alias/ISO, rejects territories and ambiguity, removes', async () => {
    expect(await run('country', 'add', { country: 'india' }, ADMIN)).toMatch(/Now monitoring 🇮🇳 India/);
    expect(await run('country', 'add', { country: 'USA' }, ADMIN)).toMatch(/United States/);
    expect(await run('country', 'add', { country: 'Guam' }, ADMIN)).toMatch(/territory of \*\*United States\*\*/);
    expect(await run('country', 'add', { country: 'Congo' }, ADMIN)).toMatch(/ambiguous/);
    expect(await run('country', 'add', { country: 'Atlantis' }, ADMIN)).toMatch(/No country matches/);
    expect(await run('country', 'add', { country: 'IN' }, ADMIN)).toMatch(/already monitored/);
    expect(h.config.countries.map((c) => c.iso3).sort()).toEqual(['IND', 'USA']);
    expect(await run('country', 'list')).toMatch(/India[\s\S]*United States/);
    expect(await run('country', 'remove', { country: 'India' }, ADMIN)).toMatch(/Stopped/);
    expect(await run('country', 'remove', { country: 'India' }, ADMIN)).toMatch(/was not being monitored/);
    expect(h.config.isMonitored('IND')).toBe(false);
  });
});

describe('/settings', () => {
  const me = { permissions: { has: () => false } };
  const guildWith = (roleMentionable: boolean) => ({ members: { me, fetchMe: async () => me }, roles: { cache: new Map([['R1', { mentionable: roleMentionable }]]), fetch: async () => ({ mentionable: roleMentionable }) } });
  const chan = (perms: bigint[]) => ({ id: 'C1', guildId: 'G', permissionsFor: () => ({ has: (f: bigint) => perms.includes(f) }) });
  const allPerms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

  it('refuses a channel the bot cannot post in, and names the missing permissions', async () => {
    const out = await run('settings', 'channel', { channel: chan([PermissionFlagsBits.ViewChannel]) }, ADMIN, guildWith(true));
    expect(out).toMatch(/SendMessages, EmbedLinks/);
    expect(h.config.channelId).toBeNull();
  });

  it('refuses a channel from another server', async () => {
    expect(await run('settings', 'channel', { channel: { ...chan(allPerms), guildId: 'OTHER' } }, ADMIN, guildWith(true))).toMatch(/must be in this server/);
  });

  it('stores channel and role; both are needed for alerts to become active', async () => {
    expect(await run('settings', 'channel', { channel: chan(allPerms) }, ADMIN, guildWith(true))).toMatch(/Alerts will be posted in <#C1>/);
    expect(h.config.isNotificationConfigured).toBe(false);
    expect(await run('settings', 'role', { role: { id: 'R1' } }, ADMIN, guildWith(true))).toMatch(/<@&R1> will be pinged/);
    expect(h.config.isNotificationConfigured).toBe(true);
    const view = await run('settings', 'view');
    expect(view).toContain('<#C1>'); expect(view).toContain('<@&R1>'); expect(view).toContain('yes');
  });

  it('rejects @everyone as the ping role, warns about a non-mentionable role', async () => {
    expect(await run('settings', 'role', { role: { id: 'G' } }, ADMIN, guildWith(true))).toMatch(/@everyone is not allowed/);
    expect(await run('settings', 'role', { role: { id: 'R1' } }, ADMIN, guildWith(false))).toMatch(/not mentionable/);
  });

  it('settings persist across a restart', async () => {
    await run('settings', 'channel', { channel: chan(allPerms) }, ADMIN, guildWith(true));
    await run('settings', 'role', { role: { id: 'R1' } }, ADMIN, guildWith(true));
    await h.restart();
    expect([h.config.channelId, h.config.roleId]).toEqual(['C1', 'R1']);
  });
});

describe('/ignore, /unignore, /ignored', () => {
  async function seed() {
    await h.config.addIdentifier('[USAF]', '[usaf]', 'u');
    const at = t('12:00');
    h.tracker.ingest(snapshot([
      obs({ id: 'A1', callsign: 'Charlie[USAF]', ...PLACE.delhi }),
      obs({ id: 'B1', callsign: 'twin', ...PLACE.paris }),
      obs({ id: 'B2', callsign: 'TWIN', ...PLACE.paris }),
    ], at), h.config.identifiers, at);
  }

  it('ignores by callsign, shows expiry, lists, and unignores', async () => {
    await seed();
    const out = await run('ignore', null, { callsign: 'charlie[usaf]', duration: '30m' }, ADMIN);
    expect(out).toMatch(/Ignoring \*\*Charlie\\\[USAF\\\]\*\* \(`A1`\) until <t:\d+:f>/);
    const list = await run('ignored', null);
    expect(list).toMatch(/Charlie.*`A1`.*until <t:\d+:f> \(<t:\d+:R>\)/);
    expect((await h.repos.ignores.listActive(new Date()))[0]!.aircraftId).toBe('A1');
    expect(await run('unignore', null, { callsign: 'Charlie[USAF]' }, ADMIN)).toMatch(/No longer ignoring/);
    expect(await run('ignored', null)).toMatch(/No aircraft/);
    expect(await run('unignore', null, { callsign: 'A1' }, ADMIN)).toMatch(/not currently ignored/);
  });

  it('shared callsigns are ambiguous; the multiplayer ID disambiguates', async () => {
    await seed();
    expect(await run('ignore', null, { callsign: 'twin', duration: '1h' }, ADMIN)).toMatch(/2 aircraft share that callsign/);
    expect(await run('ignore', null, { callsign: 'B2', duration: '1h' }, ADMIN)).toMatch(/\(`B2`\)/);
    expect((await h.repos.ignores.listActive(new Date())).map((x) => x.aircraftId)).toEqual(['B2']);
  });

  it('validates durations and unknown aircraft', async () => {
    await seed();
    expect(await run('ignore', null, { callsign: 'A1', duration: 'soon' }, ADMIN)).toMatch(/Invalid duration/);
    expect(await run('ignore', null, { callsign: 'A1', duration: '10s' }, ADMIN)).toMatch(/between 1m and 30d/);
    expect(await run('ignore', null, { callsign: 'A1', duration: '90d' }, ADMIN)).toMatch(/between 1m and 30d/);
    expect(await run('ignore', null, { callsign: 'ghost', duration: '1h' }, ADMIN)).toMatch(/No active aircraft/);
  });
});

describe('/aircraft', () => {
  it('lists matching aircraft and shows full info including cooldown and ignore state', async () => {
    await h.config.addIdentifier('[USAF]', '[usaf]', 'u');
    await h.config.addCountry('IND', 'India', 'u');
    await h.config.setChannel('1'); await h.config.setRole('2');
    await h.tick([obs({ id: 'A1', callsign: 'Charlie[USAF]', ...PLACE.delhi }), obs({ id: 'N1', callsign: 'Nobody', ...PLACE.paris })], new Date());
    const list = await run('aircraft', 'list');
    expect(list).toContain('1 active aircraft'); expect(list).toContain('Charlie'); expect(list).not.toContain('Nobody');
    expect(await run('aircraft', 'list', { scope: 'all' })).toContain('Nobody');
    const info = await run('aircraft', 'info', { aircraft: 'A1' });
    for (const needle of ['Boeing 737-700', 'India', 'FL350', '420 KTS', '270°', 'remaining', 'Not ignored', '[USAF]']) expect(info).toContain(needle);
    expect(await run('aircraft', 'info', { aircraft: 'zzz' })).toMatch(/No tracked aircraft/);
  });
});

describe('/ident and /roster (Osprey)', () => {
  const identity = { accountId: '2145266', callsign: 'Charlie[USAF]', online: true, pastCallsigns: ['OldName'], lastLoginAt: new Date('2026-11-05T09:30:00Z'), createdAt: null };
  const withOsprey = (o: Record<string, unknown>) => { ctx = { ...ctx, osprey: o as never }; };
  async function seed() {
    await h.config.addIdentifier('[USAF]', '[usaf]', 'u');
    const at = t('12:00');
    h.tracker.ingest(snapshot([obs({ id: 'A1', callsign: 'Charlie[USAF]', accountId: 2145266, ...PLACE.delhi })], at), h.config.identifiers, at);
  }

  it('say so when the integration is disabled', async () => {
    expect(await run('ident', null, { pilot: 'x' })).toMatch(/disabled/);
    expect(await run('roster', null)).toMatch(/disabled/);
  });

  it('/ident combines live GeoFS data with the Osprey identity (looked up by account id, then callsign)', async () => {
    await seed();
    const lookup = vi.fn(async () => ({ status: 'ok', identity, via: 'acid' }));
    withOsprey({ lookup });
    const out = await run('ident', null, { pilot: 'charlie[usaf]' });
    expect(lookup).toHaveBeenCalledWith({ accountId: 2145266, callsign: 'Charlie[USAF]' });
    for (const needle of ['IDENT', '`A1`', 'Boeing 737-700', 'India', 'FL350', 'Account ID: `2145266`', '`OldName`', 'Last login', 'GeoFS Live + Osprey V2', 'matched by account ID']) expect(out).toContain(needle);
  });

  it('/ident for an offline pilot uses Osprey only; unknown pilots and outages are explicit', async () => {
    const lookup = vi.fn();
    withOsprey({ lookup });
    lookup.mockResolvedValueOnce({ status: 'ok', identity: { ...identity, callsign: 'Ghost' }, via: 'callsign' });
    const out = await run('ident', null, { pilot: 'Ghost' });
    expect(lookup).toHaveBeenCalledWith({ accountId: null, callsign: 'Ghost' });
    expect(out).toContain('Not currently online in GeoFS'); expect(out).toContain('exact callsign');
    lookup.mockResolvedValueOnce({ status: 'not_found' });
    expect(await run('ident', null, { pilot: 'Nobody' })).toMatch(/not online in GeoFS and Osprey has no exact-callsign match/);
    await seed();
    lookup.mockResolvedValueOnce({ status: 'unavailable', error: 'HTTP 502' });
    const down = await run('ident', null, { pilot: 'A1' });
    expect(down).toContain('Unavailable right now (HTTP 502)');
    expect(down).toContain('Boeing 737-700'); // the GeoFS half still works
  });

  it('/roster lists Osprey accounts for the configured identifiers and flags the ones visible in GeoFS', async () => {
    await seed();
    const roster = vi.fn(async () => ({ status: 'ok', truncated: false, entries: [
      { ...identity },
      { accountId: '9', callsign: 'Sleepy[USAF]', online: false, pastCallsigns: [], lastLoginAt: null, createdAt: null },
    ] }));
    withOsprey({ roster });
    const out = await run('roster', null);
    expect(roster).toHaveBeenCalledWith(['[USAF]']);
    expect(out).toContain('2 Osprey account(s)'); expect(out).toContain('1 visible in GeoFS now');
    expect(out).toMatch(/Charlie.*in GeoFS.*India/); expect(out).toMatch(/Sleepy.*offline/);
  });

  it('/roster edge cases: no identifiers, outage, empty result', async () => {
    const roster = vi.fn();
    withOsprey({ roster });
    expect(await run('roster', null)).toMatch(/No identifiers configured/);
    await h.config.addIdentifier('[USAF]', '[usaf]', 'u');
    roster.mockResolvedValueOnce({ status: 'unavailable', error: 'timeout' });
    expect(await run('roster', null)).toMatch(/Osprey is unavailable right now \(timeout\)/);
    roster.mockResolvedValueOnce({ status: 'ok', entries: [], truncated: false });
    expect(await run('roster', null)).toMatch(/no accounts matching/);
  });
});
