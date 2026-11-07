import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import { buildAlertMessage } from '../alerts/embed.js';
import { PermanentNotifyError, type AlertPayload, type Notifier } from '../alerts/types.js';
import type { Log } from '../logger.js';

const PERMANENT_CODES = new Set<number>([
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.CannotSendMessagesToThisUser,
  RESTJSONErrorCodes.InvalidFormBodyOrContentType,
]);

/** Sends alerts ONLY to the configured channel id. Serialised so bursts cannot interleave; retries transient failures. */
export class DiscordNotifier implements Notifier {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly log: Log,
    private readonly opts: { guildId?: string; attempts?: number; baseDelayMs?: number } = {},
  ) {}

  send(payload: AlertPayload): Promise<void> {
    const run = this.chain.then(() => this.deliver(payload));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async deliver(p: AlertPayload): Promise<void> {
    const attempts = this.opts.attempts ?? 3;
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const channel = await this.client.channels.fetch(p.channelId);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new PermanentNotifyError(`channel ${p.channelId} is not a guild text channel`);
        if (this.opts.guildId && 'guildId' in channel && channel.guildId !== this.opts.guildId) {
          throw new PermanentNotifyError(`channel ${p.channelId} is not in the configured guild`);
        }
        if (!('send' in channel)) throw new PermanentNotifyError('channel cannot receive messages');
        await channel.send(buildAlertMessage(p));
        return;
      } catch (e) {
        lastErr = e;
        if (e instanceof PermanentNotifyError) throw e;
        if (e instanceof DiscordAPIError && PERMANENT_CODES.has(Number(e.code))) {
          throw new PermanentNotifyError(`Discord rejected the alert (${e.code}): ${e.message}`);
        }
        const retryAfter = e instanceof DiscordAPIError && e.status === 429 ? 2000 : 0;
        this.log.warn({ attempt: i, attempts, err: (e as Error).message }, 'discord send failed');
        if (i < attempts) await new Promise((r) => setTimeout(r, Math.max(retryAfter, (this.opts.baseDelayMs ?? 1000) * 2 ** (i - 1))));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('discord send failed');
  }
}
