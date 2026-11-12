import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync, rmSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Log } from '../logger.js';

interface LockInfo { pid: number; host: string; token: string; heartbeatAt: string; }

export interface LockOptions {
  /** A lock whose heartbeat is older than this is considered abandoned (crashed process). */
  staleMs?: number;
  heartbeatMs?: number;
  /** How long to wait for a live-looking lock to go stale before giving up. */
  waitMs?: number;
}

/**
 * Advisory single-instance lock for the state directory. A JSON file cannot arbitrate between two writers the way a
 * database does, so two bot processes on one STATE_DIR would silently overwrite each other (and could double-alert).
 * The lock file carries a heartbeat; a crashed process's lock goes stale after `staleMs` and is taken over.
 */
export class InstanceLock {
  private readonly token = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;
  /** Runs on every exit path (process.exit, uncaught exception, signals handled by the app) so a restart is never delayed by our own stale lock. SIGKILL cannot run it; staleness covers that. */
  private readonly onExit = () => {
    try {
      const cur = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LockInfo>;
      if (cur.token === this.token) rmSync(this.path, { force: true });
    } catch { /* already gone */ }
  };
  private readonly staleMs: number;
  private readonly heartbeatMs: number;
  private readonly waitMs: number;

  constructor(dir: string, private readonly log: Log, opts: LockOptions = {}) {
    this.path = join(dir, 'state.lock');
    this.staleMs = opts.staleMs ?? 30_000;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.waitMs = opts.waitMs ?? 45_000;
  }

  private async read(): Promise<LockInfo | null> {
    try {
      const j = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LockInfo>;
      if (typeof j.token === 'string' && typeof j.heartbeatAt === 'string') return j as LockInfo;
      return null;
    } catch { return null; }
  }

  private async write(): Promise<void> {
    const info: LockInfo = { pid: process.pid, host: hostname(), token: this.token, heartbeatAt: new Date().toISOString() };
    await writeFile(this.path, JSON.stringify(info), 'utf8');
  }

  async acquire(): Promise<void> {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const cur = await this.read();
      const age = cur ? Date.now() - Date.parse(cur.heartbeatAt) : Infinity;
      if (!cur || !(age < this.staleMs) || cur.token === this.token) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `STATE_DIR is in use by another bot instance (pid ${cur.pid} on ${cur.host}, heartbeat ${Math.round(age / 1000)}s ago). ` +
          'Run only ONE instance per state directory. If that instance is gone, wait ~30 s or delete state.lock.',
        );
      }
      this.log.warn({ pid: cur.pid, host: cur.host, ageSeconds: Math.round(age / 1000) }, 'state lock held by a recent heartbeat; waiting for it to go stale');
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(50, this.staleMs / 4))));
    }
    await this.write();
    this.timer = setInterval(() => { void this.write().catch((e) => this.log.warn({ err: (e as Error).message }, 'state lock heartbeat failed')); }, this.heartbeatMs);
    this.timer.unref();
    process.on('exit', this.onExit);
  }

  async release(): Promise<void> {
    process.off('exit', this.onExit);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const cur = await this.read();
    if (cur?.token === this.token) await rm(this.path, { force: true });
  }
}
