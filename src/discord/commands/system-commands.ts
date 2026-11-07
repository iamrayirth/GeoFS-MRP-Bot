import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { formatDuration } from '../../util/duration.js';
import { reply } from '../reply.js';
import type { Command } from './types.js';

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export const statusCommand: Command = {
  data: new SlashCommandBuilder().setName('status').setDescription('Bot and monitoring status').setContexts(0),
  async execute(i, ctx) {
    const p = ctx.monitor.poller.state;
    const s = ctx.monitor.stats;
    const c = s.lastCycle;
    const embed = new EmbedBuilder()
      .setTitle('GeoFS monitor status')
      .setColor(0x3498db)
      .addFields(
        { name: 'Uptime', value: formatDuration(Date.now() - ctx.startedAt.getTime()), inline: true },
        { name: 'Last GeoFS poll', value: p.lastSuccessAt ? `<t:${unix(p.lastSuccessAt)}:R>` : 'never', inline: true },
        { name: 'Poll interval', value: `${ctx.cfg.POLL_INTERVAL_MS / 1000}s`, inline: true },
        { name: 'Aircraft online', value: String(ctx.tracker.activeCount), inline: true },
        { name: 'Matching identifiers', value: String(c?.matching ?? 0), inline: true },
        { name: 'Stale records skipped', value: String(c?.staleSkipped ?? 0), inline: true },
        { name: 'Identifiers', value: String(ctx.runtime.identifiers.length), inline: true },
        { name: 'Monitored countries', value: String(ctx.runtime.countries.length), inline: true },
        { name: 'Alerts sent (this run)', value: String(s.totalAlertsSent), inline: true },
        { name: 'Notifications', value: ctx.runtime.isNotificationConfigured ? `✅ <#${ctx.runtime.channelId}> → <@&${ctx.runtime.roleId}>` : '❌ channel and/or role not set', inline: false },
        { name: 'Polls / failures', value: `${p.totalPolls} / ${p.totalFailures}${p.lastError ? ` — last error: ${p.lastError.slice(0, 120)}` : ''}`, inline: false },
      );
    await reply(i, { embeds: [embed] });
  },
};

export const healthCommand: Command = {
  data: new SlashCommandBuilder().setName('health').setDescription('Health checks (database, Discord, GeoFS, geodata)').setContexts(0),
  async execute(i, ctx) {
    const r = await ctx.health.check();
    const ok = (b: boolean) => (b ? '✅' : '❌');
    const icon = r.status === 'ok' ? '🟢' : r.status === 'degraded' ? '🟡' : '🔴';
    const g = r.checks.geofs;
    await reply(i, [
      `${icon} **${r.status.toUpperCase()}**`,
      `${ok(r.checks.database.ok)} Database`,
      `${ok(r.checks.discord.ok)} Discord gateway${r.checks.discord.wsPingMs !== null ? ` (${r.checks.discord.wsPingMs} ms)` : ''}`,
      `${ok(g.ok)} GeoFS data — last success ${g.ageSeconds === null ? 'never' : `${g.ageSeconds}s ago`}, ${g.consecutiveFailures} consecutive failures${g.lastError ? ` (${g.lastError.slice(0, 100)})` : ''}`,
      `${ok(r.checks.geodata.ok)} Geodata — ${r.checks.geodata.polygons.toLocaleString('en-US')} polygons`,
      `Memory ${r.memoryMb} MB · uptime ${formatDuration(r.uptimeSeconds * 1000)}`,
    ].join('\n'));
  },
};

export const helpCommand: Command = {
  data: new SlashCommandBuilder().setName('help').setDescription('Show all commands').setContexts(0),
  async execute(i, ctx) {
    const embed = new EmbedBuilder()
      .setTitle('GeoFS MRP Bot — commands')
      .setColor(0x7289da)
      .setDescription('Alerts fire when an aircraft whose callsign contains a configured identifier is inside a monitored country (land or 12 NM territorial waters). One global **10-minute** cooldown per aircraft.')
      .addFields(
        { name: '🔧 Admin (Administrator permission, or authorised user/role)', value: ['`/identifier add|remove`', '`/country add|remove`', '`/settings channel|role`', '`/ignore callsign duration`', '`/unignore callsign`'].join('\n') },
        { name: '👁 Everyone', value: ['`/identifier list` · `/country list`', '`/aircraft list` · `/aircraft info`', '`/ignored` · `/settings view`', '`/status` · `/health` · `/help`'].join('\n') },
        { name: 'Notes', value: `• Aircraft are identified by GeoFS **multiplayer ID**; a reconnect gets a new ID and is a new aircraft.\n• Durations: \`10m\`, \`30m\`, \`1h\`, \`6h\`, \`1d\`, \`1h30m\` (1 minute – 30 days).\n• Matching is a case-insensitive substring: \`Charlie[USAF]\`, \`delta[usaf]\`, \`[RAF]Charlie\`.\n• Currently tracking ${ctx.tracker.activeCount} online aircraft.` },
      );
    await reply(i, { embeds: [embed] });
  },
};
