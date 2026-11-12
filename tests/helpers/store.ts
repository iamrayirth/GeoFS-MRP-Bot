import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { JsonStore, type JsonStoreOptions } from '../../src/store/json-store.js';

const log = pino({ level: 'silent' });

export interface TestStore {
  store: JsonStore;
  dir: string;
  /** Close and re-read state.json from disk: a real process restart as far as persistence is concerned. */
  reopen(): Promise<JsonStore>;
  /** Close and delete the directory. */
  cleanup(): Promise<void>;
}

export async function createTestStore(opts: JsonStoreOptions = {}, dir?: string): Promise<TestStore> {
  const d = dir ?? (await mkdtemp(join(tmpdir(), 'geofs-bot-test-')));
  const o: JsonStoreOptions = { lock: false, flushDelayMs: 20, ...opts };
  const t: TestStore = {
    store: await JsonStore.open(d, log, o),
    dir: d,
    async reopen() { await t.store.close(); t.store = await JsonStore.open(d, log, o); return t.store; },
    async cleanup() { await t.store.close().catch(() => undefined); await rm(d, { recursive: true, force: true }); },
  };
  return t;
}
