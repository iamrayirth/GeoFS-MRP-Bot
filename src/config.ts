import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? String(def) : v),
    z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
  );
const blankToUndef = (v: unknown) => (v === '' ? undefined : v);
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const snowflakeList = csv.refine((a) => a.every((x) => /^\d{15,25}$/.test(x)), 'must be comma-separated Discord IDs');

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.preprocess(blankToUndef, z.string().regex(/^\d{15,25}$/).optional()),
  DISCORD_GUILD_ID: z.preprocess(blankToUndef, z.string().regex(/^\d{15,25}$/).optional()),
  /** Directory holding state.json (identifiers, countries, settings, cooldowns, ignores). Mount it as a volume. */
  STATE_DIR: z.string().min(1).default('./state'),
  AUTHORIZED_USER_IDS: snowflakeList,
  ADMIN_ROLE_IDS: snowflakeList,
  GEOFS_API: z.string().url().default('https://mps.geo-fs.com/map'),
  /** Osprey V2 identity API (account id, past callsigns, last login). Optional enrichment; alerts never depend on it. */
  OSPREY_BASE: z.string().url().default('https://api.gms-admin.net/api/v2'),
  OSPREY_ENABLED: bool(true),
  GEOFS_AIRCRAFT_LIST_URL: z.string().url().default('https://www.geo-fs.com/geofs.php'),
  POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(300_000).default(10_000),
  STALE_AFTER_MS: z.coerce.number().int().min(10_000).default(120_000),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: bool(false),
  REGISTER_COMMANDS: bool(true),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Fixed, deliberately NOT configurable (requirement: one global fixed cooldown). */
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
