import { REST, Routes } from 'discord.js';
import type { Log } from '../logger.js';
import { commandJson } from './commands/index.js';

/** Idempotent bulk-overwrite of the application's slash commands (guild-scoped when a guild id is given: instant). */
export async function registerCommands(opts: { token: string; clientId: string; guildId?: string; log: Log }): Promise<number> {
  const rest = new REST({ version: '10' }).setToken(opts.token);
  const body = commandJson();
  const route = opts.guildId ? Routes.applicationGuildCommands(opts.clientId, opts.guildId) : Routes.applicationCommands(opts.clientId);
  await rest.put(route, { body });
  opts.log.info({ count: body.length, scope: opts.guildId ? `guild:${opts.guildId}` : 'global' }, 'slash commands registered');
  return body.length;
}
