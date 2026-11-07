import { randomUUID } from 'node:crypto';
import { MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type Client, type Interaction } from 'discord.js';
import { commandMap } from './commands/index.js';
import type { BotContext } from './context.js';

/** Guild-only, optionally single-guild. Returns a refusal message or null when the interaction may proceed. */
function refusal(i: Interaction, ctx: BotContext): string | null {
  if (!i.inGuild()) return 'This bot only works inside a server.';
  if (ctx.cfg.DISCORD_GUILD_ID && i.guildId !== ctx.cfg.DISCORD_GUILD_ID) return 'This bot is not configured for this server.';
  return null;
}

async function handleCommand(i: ChatInputCommandInteraction, ctx: BotContext) {
  const cmd = commandMap.get(i.commandName);
  if (!cmd) { await i.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral }); return; }
  const no = refusal(i, ctx);
  if (no) { await i.reply({ content: no, flags: MessageFlags.Ephemeral }); return; }
  // Defer first: DB work can exceed Discord's 3 s acknowledgement window.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const t0 = Date.now();
  try {
    await cmd.execute(i, ctx);
    ctx.log.info({ event: 'command', command: i.commandName, sub: i.options.getSubcommand(false), user: i.user.id, ms: Date.now() - t0 }, 'command handled');
  } catch (err) {
    const ref = randomUUID().slice(0, 8);
    ctx.log.error({ err: (err as Error).message, stack: (err as Error).stack, command: i.commandName, ref }, 'command failed');
    await i.editReply({ content: `⚠ Something went wrong (ref \`${ref}\`). Please try again; if it persists, check the bot logs.`, allowedMentions: { parse: [] } }).catch(() => undefined);
  }
}

async function handleAutocomplete(i: AutocompleteInteraction, ctx: BotContext) {
  const cmd = commandMap.get(i.commandName);
  if (!cmd?.autocomplete || refusal(i, ctx)) { await i.respond([]).catch(() => undefined); return; }
  try { await cmd.autocomplete(i, ctx); }
  catch (err) { ctx.log.warn({ err: (err as Error).message, command: i.commandName }, 'autocomplete failed'); await i.respond([]).catch(() => undefined); }
}

export function attachInteractionHandler(client: Client, ctx: BotContext) {
  client.on('interactionCreate', (i) => {
    if (i.isChatInputCommand()) void handleCommand(i, ctx);
    else if (i.isAutocomplete()) void handleAutocomplete(i, ctx);
  });
}
