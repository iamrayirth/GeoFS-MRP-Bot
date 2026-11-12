import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Log } from '../logger.js';
import { InstanceLock, type LockOptions } from './lock.js';

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid ISO timestamp');
const nullableIso = iso.nullable();

/**
 * Persisted application state (everything the bot must not forget across restarts). Timestamps are ISO-8601 UTC strings.
 * `version` allows future migrations.
 */
export const stateSchema = z.object({
  version: z.literal(1),
  settings: z.record(z.string(), z.string()).default({}),
  identifiers: z.array(z.object({ value: z.string(), normalized: z.string(), createdBy: z.string().nullable(), createdAt: iso })).default([]),
  countries: z.array(z.object({ iso3: z.string(), name: z.string(), createdBy: z.string().nullable(), createdAt: iso })).default([]),
  /** The global 10-minute cooldown, one row per GeoFS multiplayer id. */
  cooldowns: z.record(z.string(), z.object({
    callsign: z.string(), lastAlertAt: iso, lastCountryIso3: z.string().nullable(), alertCount: z.number().int().min(1), updatedAt: iso,
  })).default({}),
  /** Temporary ignores, keyed by multiplayer id. */
  ignores: z.record(z.string(), z.object({ callsign: z.string(), expiresAt: iso, createdBy: z.string().nullable(), createdAt: iso })).default({}),
  /** History of aircraft that matched an identifier. */
  tracking: z.record(z.string(), z.object({
    callsign: z.string(), accountId: z.number().nullable(), aircraftTypeId: z.number().nullable(), matchedIdentifiers: z.array(z.string()),
    lat: z.number().nullable(), lon: z.number().nullable(), altitudeM: z.number().nullable(), speedKts: z.number().nullable(), headingDeg: z.number().nullable(),
    countryIso3: z.string().nullable(), firstSeenAt: iso, lastSeenAt: iso, active: z.boolean(), lastAlertAt: nullableIso,
  })).default({}),
});
export type StateFile = z.infer<typeof stateSchema>;

export const emptyState = (): StateFile => stateSchema.parse({ version: 1 });

export interface JsonStoreOptions {
  /** Debounce for non-durable writes (tracking history). Durable writes (claims, config, ignores) flush immediately. */
  flushDelayMs?: number;
  /** Set false in tests that open the same directory twice on purpose. */
  lock?: boolean | LockOptions;
}

export class StateCorruptError extends Error {
  constructor(message: string) { super(message); this.name = 'StateCorruptError'; }
}

/**
 * A small crash-safe JSON document store.
 *
 *  - All reads/mutations happen on one in-memory object inside synchronous sections, so a "claim" (check + set) is atomic
 *    within the process; the single-instance lock extends that guarantee across processes.
 *  - Writes are serialised, go to `state.json.tmp`, are fsync'd, then atomically renamed over `state.json`. The previous
 *    good file is kept as `state.json.bak`. A crash can therefore never leave a half-written state.json.
 *  - A corrupt state.json is NEVER silently replaced by an empty state (that would forget cooldowns and re-alert):
 *    the backup is used if valid, otherwise start-up fails with an explanation and every file is left untouched.
 */
export class JsonStore {
  state: StateFile = emptyState();
  private readonly file: string;
  private readonly tmp: string;
  private readonly bak: string;
  private dirty = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private lock: InstanceLock | null = null;
  private closed = false;
  private flushDelayMs: number;
  private consecutiveWriteFailures = 0;
  lastWriteAt: Date | null = null;
  lastWriteError: string | null = null;

  private constructor(readonly dir: string, private readonly log: Log, opts: JsonStoreOptions) {
    this.file = join(dir, 'state.json');
    this.tmp = `${this.file}.tmp`;
    this.bak = `${this.file}.bak`;
    this.flushDelayMs = opts.flushDelayMs ?? 2000;
  }

  static async open(dir: string, log: Log, opts: JsonStoreOptions = {}): Promise<JsonStore> {
    await mkdir(dir, { recursive: true });
    const store = new JsonStore(dir, log, opts);
    if (opts.lock !== false) {
      store.lock = new InstanceLock(dir, log, typeof opts.lock === 'object' ? opts.lock : {});
      await store.lock.acquire();
    }
    try {
      store.state = await store.load();
    } catch (e) {
      await store.lock?.release();
      throw e;
    }
    return store;
  }

  private async parseFile(path: string): Promise<{ kind: 'ok'; state: StateFile } | { kind: 'missing' } | { kind: 'corrupt'; error: StateCorruptError }> {
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw e; // permissions etc.: surface, do not guess
    }
    try { return { kind: 'ok', state: stateSchema.parse(JSON.parse(text)) }; }
    catch (e) { return { kind: 'corrupt', error: new StateCorruptError(`${path}: ${(e as Error).message.slice(0, 300)}`) }; }
  }

  /**
   * Decision table (never "forget" silently):
   *   state.json valid                       -> use it
   *   state.json corrupt, .bak valid         -> use .bak (damaged file kept as state.json.corrupt-<ts>)
   *   state.json missing, .bak valid         -> use .bak
   *   any state file exists but none is valid -> REFUSE to start, leaving every file untouched
   *   no state files at all                  -> fresh install
   */
  private async load(): Promise<StateFile> {
    const main = await this.parseFile(this.file);
    if (main.kind === 'ok') return main.state;
    const bak = await this.parseFile(this.bak);

    if (bak.kind === 'ok') {
      if (main.kind === 'corrupt') {
        const quarantine = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await rename(this.file, quarantine).catch(() => undefined);
        this.log.error({ err: main.error.message, quarantine }, 'state.json was corrupt; restored from state.json.bak (the most recent changes may be lost)');
      } else {
        this.log.error('state.json is missing but state.json.bak is valid; restoring from the backup');
      }
      return bak.state;
    }
    if (main.kind === 'corrupt' || bak.kind === 'corrupt') {
      const why = [main, bak].flatMap((x) => (x.kind === 'corrupt' ? [x.error.message] : [])).join('\n');
      throw new StateCorruptError(
        `Refusing to start: no usable state file in ${this.dir}.\n${why}\n` +
        'Starting empty would forget cooldowns, identifiers and settings (and re-alert). The files were left untouched: repair them (plain JSON) ' +
        'and restore as state.json, or delete state.json and state.json.bak to start fresh.',
      );
    }
    this.log.info({ dir: this.dir }, 'no existing state; starting fresh');
    return emptyState();
  }

  /** Test seam: replaced in tests to simulate disk failures. */
  protected async writeAtomic(data: string): Promise<void> {
    const fh = await open(this.tmp, 'w');
    try { await fh.writeFile(data, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await copyFile(this.file, this.bak).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    await rename(this.tmp, this.file);
    try { const d = await open(this.dir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch { /* directory fsync is best effort */ }
  }

  /**
   * Persist pending changes. `durable` callers await the disk write (and receive its error); others are coalesced and
   * written after `flushDelayMs`.
   */
  async commit(durable: boolean): Promise<void> {
    this.dirty = true;
    if (durable) return this.flush();
    if (!this.timer && !this.closed) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, this.flushDelayMs);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const run = this.chain.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await this.writeAtomic(JSON.stringify(this.state) + '\n');
        this.lastWriteAt = new Date();
        this.lastWriteError = null;
        this.consecutiveWriteFailures = 0;
      } catch (e) {
        this.dirty = true;
        this.consecutiveWriteFailures++;
        this.lastWriteError = (e as Error).message;
        this.log.error({ err: this.lastWriteError, failures: this.consecutiveWriteFailures }, 'failed to write state.json');
        if (!this.timer && !this.closed) { this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, 5000); this.timer.unref(); }
        throw e;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Health: is the state directory writable and are writes succeeding? */
  async ping(): Promise<boolean> {
    if (this.consecutiveWriteFailures >= 3) return false;
    try { await access(this.dir, constants.W_OK); return true; } catch { return false; }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { await this.flush(); } catch { /* already logged */ }
    await this.lock?.release();
    await rm(this.tmp, { force: true }).catch(() => undefined);
  }
}
