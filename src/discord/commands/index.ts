import { aircraftCommand, ignoreCommand, ignoredCommand, unignoreCommand } from './aircraft-commands.js';
import { countryCommand, identifierCommand, settingsCommand } from './config-commands.js';
import { identCommand, rosterCommand } from './osprey-commands.js';
import { healthCommand, helpCommand, statusCommand } from './system-commands.js';
import type { Command } from './types.js';

export const commands: Command[] = [
  identifierCommand, countryCommand, aircraftCommand, ignoreCommand, unignoreCommand, ignoredCommand,
  settingsCommand, identCommand, rosterCommand, statusCommand, healthCommand, helpCommand,
];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
export const commandJson = () => commands.map((c) => c.data.toJSON());
