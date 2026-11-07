import type { AutocompleteInteraction, ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { BotContext } from '../context.js';

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
  autocomplete?(i: AutocompleteInteraction, ctx: BotContext): Promise<void>;
}
