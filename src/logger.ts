import pino, { type Logger } from 'pino';

export function createLogger(opts: { level?: string; pretty?: boolean } = {}): Logger {
  return pino({
    level: opts.level ?? 'info',
    base: { app: 'geofs-mrp-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: ['token', '*.token', 'DISCORD_TOKEN', 'databaseUrl'], censor: '[redacted]' },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
      : {}),
  });
}

export type Log = Logger;
