import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { countryLabel, formatAltitude, formatHeading, formatSpeed, ospreyLines } from '../../alerts/embed.js';
import type { OspreyLookup } from '../../osprey/client.js';
import { escapeDiscord, mapsLink, truncate } from '../../util/format.js';
import { reply, respondChoices } from '../reply.js';
import { aircraftChoices, manyMsg, resolveAircraft, where } from './aircraft-commands.js';
import type { Command } from './types.js';

const OFF = '❌ The Osprey integration is disabled on this bot (`OSPREY_ENABLED=false`).';

// ---- /ident --------------------------------------------------------------------------------------------------------
export const identCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ident')
    .setDescription('Identity card: live GeoFS data + Osprey account info (aliases, last login)')
    .setContexts(0)
    .addStringOption((o) => o.setName('pilot').setDescription('Callsign or multiplayer ID (pick from the list for online aircraft)').setRequired(true).setAutocomplete(true).setMaxLength(64)),

  async execute(i, ctx) {
    if (!ctx.osprey) return reply(i, OFF);
    const q = i.options.getString('pilot', true);
    const r = resolveAircraft(ctx, q, false);
    if (r.kind === 'many') return reply(i, manyMsg(r.list));
    const live = r.kind === 'one' ? r.a : null;
    const lookup: OspreyLookup = await ctx.osprey.lookup({ accountId: live?.accountId ?? null, callsign: live?.callsign ?? q.trim() });
    if (!live && lookup.status === 'not_found') return reply(i, `❌ “${escapeDiscord(q)}” is not online in GeoFS and Osprey has no exact-callsign match.`);

    const e = new EmbedBuilder().setColor(live ? 0x0057a8 : 0x95a5a6).setTitle(`IDENT — ${escapeDiscord(live?.callsign ?? (lookup.status === 'ok' ? lookup.identity.callsign : null) ?? q)}`);
    const src = ['GeoFS Live'];
    if (live) {
      e.addFields(
        { name: 'Flight data', value: [
          `Multiplayer ID: \`${live.id}\``,
          `Aircraft: ${escapeDiscord(live.aircraftTypeLabel)}`,
          `Altitude: ${formatAltitude(live.altitudeM)} · Speed: ${formatSpeed(live.speedKts)} · Heading: ${formatHeading(live.headingDeg)}`,
          `Position: [${live.lat.toFixed(4)}, ${live.lon.toFixed(4)}](${mapsLink(live.lat, live.lon)})`,
          `Country: ${where(live)}`,
          live.matchedIdentifiers.length ? `Matched identifiers: ${live.matchedIdentifiers.map((x) => `\`${x}\``).join(', ')}` : 'Matched identifiers: none',
        ].join('\n'), inline: false },
      );
    } else {
      e.setDescription('Not currently online in GeoFS (no live position).');
    }
    if (lookup.status === 'ok') {
      src.push('Osprey V2');
      const lines = ospreyLines(lookup.identity, live?.callsign);
      e.addFields({ name: `Osprey identity (matched by ${lookup.via === 'acid' ? 'account ID' : 'exact callsign'})`, value: truncate(lines.join('\n') || 'No further details returned.', 1024), inline: false });
    } else if (lookup.status === 'not_found') {
      e.addFields({ name: 'Osprey identity', value: 'No Osprey record found.', inline: false });
    } else {
      e.addFields({ name: 'Osprey identity', value: `Unavailable right now (${escapeDiscord(truncate(lookup.error, 120))}).`, inline: false });
    }
    e.setFooter({ text: `Source: ${src.join(' + ')}` }).setTimestamp();
    await reply(i, { embeds: [e] });
  },

  async autocomplete(i, ctx) { await respondChoices(i, aircraftChoices(ctx, String(i.options.getFocused()))); },
};

// ---- /roster -------------------------------------------------------------------------------------------------------
export const rosterCommand: Command = {
  data: new SlashCommandBuilder().setName('roster').setDescription('Osprey accounts whose callsign matches a configured identifier').setContexts(0),

  async execute(i, ctx) {
    if (!ctx.osprey) return reply(i, OFF);
    const ids = ctx.runtime.identifiers.map((x) => x.value);
    if (!ids.length) return reply(i, 'No identifiers configured. Add one with `/identifier add`.');
    const r = await ctx.osprey.roster(ids);
    if (r.status === 'unavailable') return reply(i, `⚠ Osprey is unavailable right now (${escapeDiscord(truncate(r.error, 150))}).`);
    if (!r.entries.length) return reply(i, `Osprey has no accounts matching ${ids.map((x) => `\`${x}\``).join(', ')}.`);
    const rows = r.entries
      .map((e) => ({ e, live: e.callsign ? ctx.tracker.findByCallsign(e.callsign, true) : [] }))
      .sort((a, b) => Number(b.live.length > 0) - Number(a.live.length > 0) || (a.e.callsign ?? '').localeCompare(b.e.callsign ?? ''));
    const lines = rows.slice(0, 25).map(({ e, live }) => {
      const on = live.length ? `✈ in GeoFS${live[0]!.geo.status === 'resolved' ? ` · ${live[0]!.geo.countries.map(countryLabel).join('/')}` : ''}` : e.online === true ? 'online (Osprey)' : e.online === false ? 'offline' : '—';
      return `• **${escapeDiscord(truncate(e.callsign ?? '(unknown)', 32))}** ${e.accountId ? `(\`${e.accountId}\`) ` : ''}— ${on}`;
    });
    const online = rows.filter((x) => x.live.length).length;
    await reply(i, truncate([`**${r.entries.length} Osprey account(s)** matching ${ids.map((x) => `\`${x}\``).join(', ')} — ${online} visible in GeoFS now${r.truncated ? ' (list truncated at 500)' : ''}`, ...lines, rows.length > 25 ? `…and ${rows.length - 25} more` : ''].filter(Boolean).join('\n'), 1990));
  },
};
