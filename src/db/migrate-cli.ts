import 'dotenv/config';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createDb, waitForDb } from './client.js';

const cfg = loadConfig({ ...process.env, DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? 'x'.repeat(24) });
const log = createLogger({ level: cfg.LOG_LEVEL, pretty: cfg.LOG_PRETTY });
const h = createDb(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL, log });
try {
  await waitForDb(h, log);
  await h.migrate();
  log.info('migrations applied');
} finally {
  await h.close();
}
