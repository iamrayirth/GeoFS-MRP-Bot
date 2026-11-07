import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { registerCommands } from './register.js';

const cfg = loadConfig();
const log = createLogger({ level: cfg.LOG_LEVEL, pretty: cfg.LOG_PRETTY });
if (!cfg.DISCORD_CLIENT_ID) { log.error('DISCORD_CLIENT_ID is required to deploy commands'); process.exit(1); }
await registerCommands({ token: cfg.DISCORD_TOKEN, clientId: cfg.DISCORD_CLIENT_ID, guildId: cfg.DISCORD_GUILD_ID, log });
