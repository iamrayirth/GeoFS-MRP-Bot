import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { cooldownRemainingMs } from '../../alerts/decision.js';
import { countryLabel, formatAltitude, formatHeading, formatSpeed, utcStamp } from '../../alerts/embed.js';
import type { TrackedAircraft } from '../../tracking/tracker.js';
import { formatDuration, MAX_IGNORE_MS, MIN_IGNORE_MS, parseDuration } from '../../util/duration.js';
import { escapeDiscord, mapsLink, truncate } from '../../util/format.js';
import type { BotContext } from '../context.js';
import { reply, requireAdmin, respondChoices } from '../reply.js';
import type { Command } from './types.js';

const AREA: Record<string, string> = { land: 'land', internal: 'internal waters', archipelagic: 'archipelagic waters', '12nm': 'territorial waters' };
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export function where(a: TrackedAircraft): string {
  if (a.geo.status === 'unresolved') return 'Unknown (not in any country’s land or territorial waters)';
  const names = a.geo.countries.map(countryLabel).join(' / ');
  const ter = a.geo.territory && a.geo.countries.length === 1 && a.geo.territory !== a.geo.countries[0]!.name ? ` (${escapeDiscord(a.geo.territory)})` : '';
  return `${names}${ter} — ${AREA[a.geo.tier!]}${a.geo.status === 'ambiguous' ? ' ⚠ disputed' : ''}`;
}

type Resolved = { kind: 'one'; a: TrackedAircraft } | { kind: 'many'; list: TrackedAircraft[] } | { kind: 'none' };

/** Resolve a user-typed callsign or multiplayer id (autocomplete supplies the id). */
export function resolveAircraft(ctx: BotContext, query: string, activeOnly: boolean): Resolved {
  const q = query.trim();
  const byId = ctx.tracker.get(q);
  if (byId && (!activeOnly || byId.active)) return { kind: 'one', a: byId };
  const byCs = ctx.tracker.findByCallsign(q, activeOnly);
  if (byCs.length === 1) return { kind: 'one', a: byCs[0]! };
  if (byCs.length > 1) return { kind: 'many', list: byCs };
  return { kind: 'none' };
}

export const manyMsg = (list: TrackedAircraft[]) =>
  `❓ ${list.length} aircraft share that callsign (callsigns are not unique in GeoFS). Pick one from the autocomplete list, or use its multiplayer ID:\n${list.slice(0, 10).map((a) => `• \`${a.id}\` — ${escapeDiscord(a.callsign)} — ${where(a)}`).join('\n')}`;

export function aircraftChoices(ctx: BotContext, q: string) {
  const list = ctx.tracker.search(q, { activeOnly: true, limit: 500 });
  list.sort((a, b) => b.matchedIdentifiers.length - a.matchedIdentifiers.length || a.callsign.localeCompare(b.callsign));
  return list.slice(0, 25).map((a) => ({
    name: `${a.callsign || '(no callsign)'} · ${a.id}${a.geo.status === 'resolved' ? ` · ${a.geo.countries[0]!.name}` : ''}`,
    value: a.id,
  }));
}

// ---- /aircraft -----------------------------------------------------------------------------------------------------
export const aircraftCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('aircraft')
    .setDescription('Look at tracked GeoFS aircraft')
    .setContexts(0)
    .addSubcommand((s) =>
      s.setName('list').setDescription('List currently active aircraft')
        .addStringOption((o) => o.setName('filter').setDescription('Callsign contains…').setMaxLength(40))
        .addStringOption((o) => o.setName('scope').setDescription('Which aircraft (default: only those matching an identifier)').addChoices({ name: 'Matching identifiers (default)', value: 'matching' }, { name: 'All active aircraft', value: 'all' })),
    )
    .addSubcommand((s) => s.setName('info').setDescription('Detailed information for one aircraft').addStringOption((o) => o.setName('aircraft').setDescription('Callsign or multiplayer ID').setRequired(true).setAutocomplete(true))),

  async execute(i, ctx) {
    if (i.options.getSubcommand() === 'list') {
      const filter = i.options.getString('filter') ?? '';
      const all = (i.options.getString('scope') ?? 'matching') === 'all';
      const found = ctx.tracker.search(filter, { activeOnly: true, matchingOnly: !all });
      found.sort((a, b) => a.callsign.localeCompare(b.callsign));
      const shown = found.slice(0, 20);
      const lines = shown.map((a) => `\`${a.id}\` **${escapeDiscord(truncate(a.callsign || '(none)', 32))}** · ${a.aircraftTypeLabel} · ${a.geo.status === 'resolved' ? a.geo.countries.map((c) => c.name).join('/') : 'Unknown'}${a.ignored ? ' · 🔕 ignored' : ''}`);
      const head = `**${found.length} active aircraft** ${all ? '' : 'matching an identifier '}${filter ? `containing “${escapeDiscord(filter)}” ` : ''}(of ${ctx.tracker.activeCount} online)`;
      return reply(i, { content: truncate([head, ...lines, found.length > shown.length ? `…and ${found.length - shown.length} more — narrow with \`filter\`.` : ''].filter(Boolean).join('\n'), 1990) });
    }
    const q = i.options.getString('aircraft', true);
    const r = resolveAircraft(ctx, q, false);
    if (r.kind === 'many') return reply(i, manyMsg(r.list));
    if (r.kind === 'none') {
      const row = await ctx.repos.tracking.get(q.trim());
      if (!row) return reply(i, `❌ No tracked aircraft matches “${escapeDiscord(q)}”. Only aircraft seen since the bot started (or matching an identifier earlier) are known.`);
      return reply(i, `ℹ️ \`${row.aircraftId}\` (${escapeDiscord(row.callsign)}) is **not online**. Last seen <t:${unix(row.lastSeenAt)}:R> in ${row.countryIso3 ?? 'an unknown country'}; last alert ${row.lastAlertAt ? `<t:${unix(row.lastAlertAt)}:R>` : 'never'}.`);
    }
    const a = r.a;
    const now = new Date();
    const cd = cooldownRemainingMs(ctx.alerts.lastAlertFor(a.id) ?? a.lastAlertAt, now);
    const ign = (await ctx.repos.ignores.listActive(now)).find((x) => x.aircraftId === a.id);
    const embed = new EmbedBuilder()
      .setTitle(`${escapeDiscord(a.callsign) || 'Aircraft'} ${a.active ? '' : '(offline)'}`)
      .setColor(a.active ? 0x2ecc71 : 0x95a5a6)
      .addFields(
        { name: 'GeoFS Multiplayer ID', value: `\`${a.id}\``, inline: true },
        { name: 'Status', value: a.active ? 'Active' : `Inactive since <t:${unix(a.inactiveSince!)}:R>`, inline: true },
        { name: 'Matched identifiers', value: a.matchedIdentifiers.length ? a.matchedIdentifiers.map((x) => `\`${x}\``).join(', ') : 'None (not monitored)', inline: true },
        { name: 'Aircraft', value: escapeDiscord(a.aircraftTypeLabel), inline: true },
        { name: 'Country', value: where(a), inline: false },
        { name: 'Position', value: `[${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}](${mapsLink(a.lat, a.lon)})`, inline: true },
        { name: 'Altitude', value: formatAltitude(a.altitudeM), inline: true },
        { name: 'Speed', value: formatSpeed(a.speedKts), inline: true },
        { name: 'Heading', value: formatHeading(a.headingDeg), inline: true },
        { name: 'First seen', value: utcStamp(a.firstSeenAt), inline: true },
        { name: 'Last update', value: utcStamp(a.lastSeenAt), inline: true },
        { name: 'Last alert', value: a.lastAlertAt ?? ctx.alerts.lastAlertFor(a.id) ? utcStamp((a.lastAlertAt ?? ctx.alerts.lastAlertFor(a.id))!) : 'Never', inline: true },
        { name: 'Cooldown', value: cd > 0 ? `${formatDuration(cd)} remaining` : 'Not in cooldown', inline: true },
        { name: 'Ignore status', value: ign ? `🔕 Ignored until <t:${unix(ign.expiresAt)}:f> (<t:${unix(ign.expiresAt)}:R>)` : 'Not ignored', inline: true },
      );
    return reply(i, { embeds: [embed] });
  },

  async autocomplete(i, ctx) {
    if (i.options.getSubcommand() !== 'info') return respondChoices(i, []);
    await respondChoices(i, aircraftChoices(ctx, String(i.options.getFocused())));
  },
};

// ---- /ignore, /unignore, /ignored ------------------------------------------------------------------------------------
export const ignoreCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ignore')
    .setDescription('Temporarily ignore one aircraft (by its multiplayer ID)')
    .setContexts(0)
    .addStringOption((o) => o.setName('callsign').setDescription('Callsign (pick from the list to target the exact aircraft)').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 30m, 1h, 6h, 1d (1m – 30d)').setRequired(true).setMaxLength(20)),

  async execute(i, ctx) {
    if (!(await requireAdmin(i, ctx))) return;
    const ms = parseDuration(i.options.getString('duration', true));
    if (ms === null) return reply(i, '❌ Invalid duration. Use e.g. `10m`, `30m`, `1h`, `6h`, `1d`, or `1h30m`.');
    if (ms < MIN_IGNORE_MS || ms > MAX_IGNORE_MS) return reply(i, `❌ Duration must be between ${formatDuration(MIN_IGNORE_MS)} and ${formatDuration(MAX_IGNORE_MS)}.`);
    const q = i.options.getString('callsign', true);
    const r = resolveAircraft(ctx, q, true);
    if (r.kind === 'many') return reply(i, manyMsg(r.list));
    if (r.kind === 'none') return reply(i, `❌ No active aircraft with callsign or ID “${escapeDiscord(q)}”. The aircraft must be online so its multiplayer ID is known.`);
    const expiresAt = new Date(Date.now() + ms);
    await ctx.repos.ignores.upsert(r.a.id, r.a.callsign, expiresAt, i.user.id);
    ctx.log.info({ event: 'ignore_added', aircraftId: r.a.id, callsign: r.a.callsign, expiresAt, by: i.user.id }, 'aircraft ignored');
    return reply(i, `🔕 Ignoring **${escapeDiscord(r.a.callsign)}** (\`${r.a.id}\`) until <t:${unix(expiresAt)}:f> (<t:${unix(expiresAt)}:R>). If it reconnects it gets a new ID and will not be ignored.`);
  },
  async autocomplete(i, ctx) { await respondChoices(i, aircraftChoices(ctx, String(i.options.getFocused()))); },
};

export const unignoreCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('unignore')
    .setDescription('Remove a temporary ignore')
    .setContexts(0)
    .addStringOption((o) => o.setName('callsign').setDescription('Ignored aircraft').setRequired(true).setAutocomplete(true)),

  async execute(i, ctx) {
    if (!(await requireAdmin(i, ctx))) return;
    const q = i.options.getString('callsign', true).trim();
    const active = await ctx.repos.ignores.listActive(new Date());
    const hits = active.filter((x) => x.aircraftId === q || x.callsign.trim().toLowerCase() === q.toLowerCase());
    if (hits.length === 0) return reply(i, `❌ “${escapeDiscord(q)}” is not currently ignored. See \`/ignored\`.`);
    if (hits.length > 1) return reply(i, `❓ Several ignored aircraft share that callsign; pick one from the list or use its ID:\n${hits.map((h) => `• \`${h.aircraftId}\` — ${escapeDiscord(h.callsign)}`).join('\n')}`);
    const h = hits[0]!;
    await ctx.repos.ignores.remove(h.aircraftId);
    ctx.log.info({ event: 'ignore_removed', aircraftId: h.aircraftId, by: i.user.id }, 'ignore removed');
    return reply(i, `🔔 No longer ignoring **${escapeDiscord(h.callsign)}** (\`${h.aircraftId}\`).`);
  },
  async autocomplete(i, ctx) {
    const q = String(i.options.getFocused()).toLowerCase();
    const list = await ctx.repos.ignores.listActive(new Date());
    await respondChoices(i, list.filter((x) => !q || x.callsign.toLowerCase().includes(q) || x.aircraftId.includes(q)).map((x) => ({ name: `${x.callsign} · ${x.aircraftId}`, value: x.aircraftId })));
  },
};

export const ignoredCommand: Command = {
  data: new SlashCommandBuilder().setName('ignored').setDescription('List aircraft currently being ignored').setContexts(0),
  async execute(i, ctx) {
    const list = await ctx.repos.ignores.listActive(new Date());
    if (!list.length) return reply(i, 'No aircraft are being ignored.');
    const lines = list.slice(0, 25).map((x) => `• **${escapeDiscord(x.callsign)}** (\`${x.aircraftId}\`) — until <t:${unix(x.expiresAt)}:f> (<t:${unix(x.expiresAt)}:R>)`);
    return reply(i, `**Ignored aircraft (${list.length})**\n${lines.join('\n')}${list.length > 25 ? `\n…and ${list.length - 25} more` : ''}`);
  },
};
