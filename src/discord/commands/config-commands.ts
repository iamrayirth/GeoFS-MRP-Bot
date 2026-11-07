import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type GuildBasedChannel } from 'discord.js';
import { countryLabel } from '../../alerts/embed.js';
import { validateIdentifier, normalizeIdentifier } from '../../tracking/identifiers.js';
import { escapeDiscord } from '../../util/format.js';
import { reply, requireAdmin, respondChoices } from '../reply.js';
import type { Command } from './types.js';

// ---- /identifier ---------------------------------------------------------------------------------------------------
export const identifierCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('identifier')
    .setDescription('Manage callsign identifiers (case-insensitive substring match, e.g. [USAF])')
    .setContexts(0)
    .addSubcommand((s) => s.setName('add').setDescription('Add a callsign identifier').addStringOption((o) => o.setName('value').setDescription('Text to look for anywhere in callsigns, e.g. [USAF]').setRequired(true).setMaxLength(32)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a callsign identifier').addStringOption((o) => o.setName('value').setDescription('Identifier to remove').setRequired(true).setAutocomplete(true).setMaxLength(32)))
    .addSubcommand((s) => s.setName('list').setDescription('List configured identifiers')),

  async execute(i, ctx) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const ids = ctx.runtime.identifiers;
      return reply(i, ids.length ? `**Configured identifiers (${ids.length})**\n${ids.map((x) => `• \`${x.value}\``).join('\n')}` : 'No identifiers configured. Add one with `/identifier add`.');
    }
    if (!(await requireAdmin(i, ctx))) return;
    const raw = i.options.getString('value', true);
    if (sub === 'add') {
      const v = validateIdentifier(raw);
      if (!v.ok) return reply(i, `❌ ${v.error}`);
      const added = await ctx.runtime.addIdentifier(v.value, v.normalized, i.user.id);
      ctx.log.info({ event: 'identifier_added', value: v.value, by: i.user.id, added }, 'identifier add');
      return reply(i, added ? `✅ Added identifier \`${v.value}\`.` : `ℹ️ \`${v.value}\` is already configured.`);
    }
    const removed = await ctx.runtime.removeIdentifier(normalizeIdentifier(raw));
    ctx.log.info({ event: 'identifier_removed', value: raw, by: i.user.id, removed }, 'identifier remove');
    return reply(i, removed ? `✅ Removed \`${raw.trim()}\`. Aircraft that only matched it are no longer monitored (effective immediately).` : `❌ \`${raw.trim()}\` is not a configured identifier.`);
  },

  async autocomplete(i, ctx) {
    const q = normalizeIdentifier(String(i.options.getFocused()));
    await respondChoices(i, ctx.runtime.identifiers.filter((x) => x.normalized.includes(q)).map((x) => ({ name: x.value, value: x.value })));
  },
};

// ---- /country ------------------------------------------------------------------------------------------------------
export const countryCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('country')
    .setDescription('Manage monitored countries (land + territorial waters)')
    .setContexts(0)
    .addSubcommand((s) => s.setName('add').setDescription('Monitor a country').addStringOption((o) => o.setName('country').setDescription('Country name, ISO code or common alias').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Stop monitoring a country').addStringOption((o) => o.setName('country').setDescription('Monitored country').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List monitored countries')),

  async execute(i, ctx) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const list = ctx.runtime.countries.map((c) => ctx.directory.get(c.iso3) ?? { iso3: c.iso3, iso2: null, name: c.name });
      return reply(i, list.length ? `**Monitored countries (${list.length})** — land and 12 NM territorial waters\n${list.map((c) => `• ${countryLabel(c)}`).join('\n')}` : 'No countries monitored. Add one with `/country add`.');
    }
    if (!(await requireAdmin(i, ctx))) return;
    const q = i.options.getString('country', true);
    const r = ctx.directory.lookup(q);
    if (r.kind === 'territory') {
      return reply(i, `❌ **${escapeDiscord(r.territory)}** is a territory of ${r.sovereigns.map((s) => `**${s.name}**`).join(' / ')}. Monitoring is configured per sovereign country; add ${r.sovereigns.map((s) => `\`${s.name}\``).join(' or ')} instead (its territories and waters are included, and shown in alerts).`);
    }
    if (r.kind === 'ambiguous') return reply(i, `❓ "${escapeDiscord(q)}" is ambiguous. Did you mean: ${r.candidates.map((c) => `**${c.name}**`).join(', ')}?`);
    if (r.kind === 'none') return reply(i, `❌ No country matches "${escapeDiscord(q)}". Start typing and pick from the suggestions.`);
    const c = r.country;
    if (sub === 'add') {
      const added = await ctx.runtime.addCountry(c.iso3, c.name, i.user.id);
      ctx.log.info({ event: 'country_added', iso3: c.iso3, by: i.user.id, added }, 'country add');
      return reply(i, added ? `✅ Now monitoring ${countryLabel(c)} (land, internal/archipelagic waters and 12 NM territorial waters).` : `ℹ️ ${countryLabel(c)} is already monitored.`);
    }
    const removed = await ctx.runtime.removeCountry(c.iso3);
    ctx.log.info({ event: 'country_removed', iso3: c.iso3, by: i.user.id, removed }, 'country remove');
    return reply(i, removed ? `✅ Stopped monitoring ${countryLabel(c)}.` : `❌ ${countryLabel(c)} was not being monitored.`);
  },

  async autocomplete(i, ctx) {
    const focused = String(i.options.getFocused());
    if (i.options.getSubcommand() === 'remove') {
      const q = focused.toLowerCase();
      return respondChoices(i, ctx.runtime.countries.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ name: c.name, value: c.name })));
    }
    const monitored = new Set(ctx.runtime.countries.map((c) => c.iso3));
    await respondChoices(i, ctx.directory.suggest(focused, 60).filter((c) => !monitored.has(c.iso3)).map((c) => ({ name: c.name, value: c.name })));
  },
};

// ---- /settings -----------------------------------------------------------------------------------------------------
export const settingsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Notification settings')
    .setContexts(0)
    .addSubcommand((s) => s.setName('view').setDescription('Show current notification settings'))
    .addSubcommand((s) => s.setName('channel').setDescription('Set the channel that receives alerts').addChannelOption((o) => o.setName('channel').setDescription('Text channel for alerts').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand((s) => s.setName('role').setDescription('Set the role pinged on every alert').addRoleOption((o) => o.setName('role').setDescription('Role to ping').setRequired(true))),

  async execute(i, ctx) {
    const sub = i.options.getSubcommand();
    if (sub === 'view') {
      const { channelId, roleId } = ctx.runtime;
      const lines = [
        '**Notification settings**',
        `Channel: ${channelId ? `<#${channelId}>` : '⚠ not set — use `/settings channel`'}`,
        `Role pinged on every alert: ${roleId ? `<@&${roleId}>` : '⚠ not set — use `/settings role`'}`,
        `Alerts active: ${ctx.runtime.isNotificationConfigured ? '✅ yes' : '❌ no (both channel and role are required)'}`,
        `Cooldown: 10 minutes per aircraft (fixed, global)`,
      ];
      return reply(i, lines.join('\n'));
    }
    if (!(await requireAdmin(i, ctx))) return;
    if (!i.inGuild() || !i.guild) return reply(i, '❌ Use this command in a server.');

    if (sub === 'channel') {
      const ch = i.options.getChannel('channel', true) as GuildBasedChannel;
      if (ch.guildId !== i.guildId) return reply(i, '❌ The channel must be in this server.');
      const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
      const perms = 'permissionsFor' in ch ? ch.permissionsFor(me) : null;
      const need = [['ViewChannel', PermissionFlagsBits.ViewChannel], ['SendMessages', PermissionFlagsBits.SendMessages], ['EmbedLinks', PermissionFlagsBits.EmbedLinks]] as const;
      const missing = need.filter(([, f]) => !perms?.has(f)).map(([n]) => n);
      if (missing.length) return reply(i, `❌ I can't post there. Missing permission(s) in <#${ch.id}>: **${missing.join(', ')}**.`);
      await ctx.runtime.setChannel(ch.id);
      ctx.log.info({ event: 'channel_set', channelId: ch.id, by: i.user.id }, 'notification channel set');
      return reply(i, `✅ Alerts will be posted in <#${ch.id}>.${ctx.runtime.roleId ? '' : '\n⚠ No role set yet — alerts stay off until you run `/settings role`.'}`);
    }

    const role = i.options.getRole('role', true);
    if (role.id === i.guildId) return reply(i, '❌ Pinging @everyone is not allowed. Pick a dedicated role.');
    const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
    const full = i.guild.roles.cache.get(role.id) ?? (await i.guild.roles.fetch(role.id));
    const canPing = !!full?.mentionable || me.permissions.has(PermissionFlagsBits.MentionEveryone);
    await ctx.runtime.setRole(role.id);
    ctx.log.info({ event: 'role_set', roleId: role.id, by: i.user.id }, 'notification role set');
    const warn = canPing ? '' : '\n⚠ This role is not mentionable and I lack **Mention Everyone**, so the ping will not notify anyone. Make the role mentionable or grant me that permission.';
    return reply(i, `✅ <@&${role.id}> will be pinged on every alert.${ctx.runtime.channelId ? '' : '\n⚠ No channel set yet — alerts stay off until you run `/settings channel`.'}${warn}`);
  },
};
