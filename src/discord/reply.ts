import { MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type InteractionEditReplyOptions } from 'discord.js';
import { isAuthorized } from './permissions.js';
import type { BotContext } from './context.js';

export const NO_MENTIONS = { parse: [] as never[] };

export async function reply(i: ChatInputCommandInteraction, content: string | InteractionEditReplyOptions) {
  const body = typeof content === 'string' ? { content } : content;
  await i.editReply({ allowedMentions: NO_MENTIONS, ...body });
}

/** Returns true if allowed; otherwise replies with a refusal and returns false. */
export async function requireAdmin(i: ChatInputCommandInteraction, ctx: BotContext): Promise<boolean> {
  if (isAuthorized(i, ctx.cfg)) return true;
  ctx.log.warn({ event: 'unauthorized_command', userId: i.user.id, command: i.commandName }, 'unauthorized command attempt');
  await reply(i, '⛔ You are not authorised to change the bot configuration. This needs the **Administrator** permission, or a user/role listed by the bot owner.');
  return false;
}

export async function respondChoices(i: AutocompleteInteraction, choices: { name: string; value: string }[]) {
  // Discord limits: 25 choices, name/value <= 100 chars
  await i.respond(choices.slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) })));
}

export const EPHEMERAL = MessageFlags.Ephemeral;
