import { EmbedBuilder } from 'discord.js';
import type { Tier } from '../geo/types.js';
import { escapeDiscord, flagEmoji, flightLevel, mapsLink, truncate } from '../util/format.js';
import type { AlertPayload } from './types.js';

const AREA: Record<Tier, string> = {
  land: 'Land',
  internal: 'Internal waters',
  archipelagic: 'Archipelagic waters',
  '12nm': 'Territorial waters (12 NM)',
};

export function formatAltitude(m: number | null): string {
  if (m === null) return 'Unknown';
  return `${flightLevel(m)} (${Math.round(m / 0.3048).toLocaleString('en-US')} ft)`;
}
export const formatSpeed = (kts: number | null) => (kts === null ? 'Unknown' : `${kts} KTS`);
export const formatHeading = (h: number | null) => (h === null ? 'Unknown' : `${String(Math.round(h) % 360).padStart(3, '0')}°`);

export function countryLabel(c: { name: string; iso2: string | null }): string {
  const f = flagEmoji(c.iso2);
  return f ? `${f} ${c.name}` : c.name;
}

export function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function buildAlertMessage(p: AlertPayload): { content: string; embeds: EmbedBuilder[]; allowedMentions: { roles: string[]; parse: never[] } } {
  let country = countryLabel(p.country);
  if (p.territory && p.territory !== p.country.name) country += ` (${escapeDiscord(p.territory)})`;
  if (p.otherClaimants.length) country += `\n⚠ Disputed / overlapping claim with ${p.otherClaimants.map(countryLabel).join(', ')}`;

  const embed = new EmbedBuilder()
    .setTitle(p.kind === 'entered' ? 'AIRCRAFT ENTERED MONITORED TERRITORY' : 'AIRCRAFT REMAINS IN MONITORED TERRITORY')
    .setColor(p.kind === 'entered' ? 0xd7263d : 0xf39c12)
    .addFields(
      { name: 'Callsign', value: truncate(escapeDiscord(p.callsign) || 'Unknown', 256), inline: true },
      { name: 'GeoFS Multiplayer ID', value: `\`${p.aircraftId}\``, inline: true },
      { name: 'Country', value: country, inline: true },
      { name: 'Area', value: AREA[p.tier] + (p.snapped ? ' (coastal)' : ''), inline: true },
      { name: 'Aircraft', value: truncate(escapeDiscord(p.aircraftTypeLabel), 256), inline: true },
      { name: 'Position', value: `[${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}](${mapsLink(p.lat, p.lon)})`, inline: true },
      { name: 'Speed', value: formatSpeed(p.speedKts), inline: true },
      { name: 'Altitude', value: formatAltitude(p.altitudeM), inline: true },
      { name: 'Heading', value: formatHeading(p.headingDeg), inline: true },
      { name: 'Matched identifier(s)', value: truncate(p.matchedIdentifiers.map(escapeDiscord).join(', ') || 'Unknown', 1024), inline: false },
      { name: 'Detected', value: `${utcStamp(p.detectedAt)} (<t:${Math.floor(p.detectedAt.getTime() / 1000)}:R>)`, inline: false },
    )
    .setFooter({ text: 'Source: GeoFS multiplayer map · Speed is indicated airspeed · FL from geometric altitude' })
    .setTimestamp(p.detectedAt);

  return {
    // The role is pinged on EVERY alert, repeats included. Only that role may be mentioned (callsigns can't ping anyone).
    content: `<@&${p.roleId}>`,
    embeds: [embed],
    allowedMentions: { roles: [p.roleId], parse: [] },
  };
}
