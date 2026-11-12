import type { Log } from '../logger.js';

/**
 * Osprey V2 identity API client.
 *
 * SOURCE OF THE CONTRACT: the three endpoints, query parameters and response fields below are taken from the reference
 * implementation `cynkcrl-ux/GeoFS-MRP-Track-` (mrp-track-bot.js). The host (https://api.gms-admin.net/api/v2) could NOT
 * be reached from the development sandbox (gateway 502), so this client is tested against mocked responses built from
 * that contract, not against the live service. Parsing is therefore deliberately defensive and never invents values.
 *
 *   GET {base}/users/?acid=<account id>                      -> user object
 *   GET {base}/users/search?exact_callsign=<callsign>        -> { results: [user, ...] }
 *   GET {base}/users/search?pattern=/<regex>/i&page=N&per_page=100 -> { results: [user, ...], count }
 *
 * user = { accountID, currentCallsign?, Online, pastCallsigns: string[], events?: [{ event: { type, timestamp } }] }
 *        event.type "login" / "account_created" are the ones the reference reads.
 */
export interface OspreyIdentity {
  accountId: string | null;
  /** currentCallsign (present on search results). */
  callsign: string | null;
  /** Osprey's own Online flag; null when the field is absent/unexpected. */
  online: boolean | null;
  pastCallsigns: string[];
  /** Most recent `login` event, if the response included events. */
  lastLoginAt: Date | null;
  createdAt: Date | null;
}

export type OspreyLookup =
  | { status: 'ok'; identity: OspreyIdentity; via: 'acid' | 'callsign' }
  | { status: 'not_found' }
  | { status: 'unavailable'; error: string };

export class OspreyError extends Error {
  constructor(message: string, readonly httpStatus?: number) { super(message); this.name = 'OspreyError'; }
}

export interface OspreyOptions {
  base: string;
  timeoutMs?: number;
  /** Positive-result cache. */
  ttlMs?: number;
  /** "No such user" cache (shorter, so new accounts show up soon). */
  negativeTtlMs?: number;
  /** After this many consecutive failures stop calling Osprey for `breakerMs`. */
  breakerThreshold?: number;
  breakerMs?: number;
  rosterTtlMs?: number;
  maxRosterPages?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

const asDate = (v: unknown): Date | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? new Date(t) : null;
};

/** Parse one Osprey user object. Returns null if it carries no usable identity at all. */
export function parseOspreyUser(raw: unknown): OspreyIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const accountId = u.accountID !== undefined && u.accountID !== null && String(u.accountID) !== '' ? String(u.accountID) : null;
  const callsign = typeof u.currentCallsign === 'string' && u.currentCallsign.trim() ? u.currentCallsign.trim() : null;
  if (!accountId && !callsign) return null;
  const past = Array.isArray(u.pastCallsigns) ? u.pastCallsigns.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()) : [];
  const events = Array.isArray(u.events) ? u.events : [];
  let lastLogin: Date | null = null;
  let created: Date | null = null;
  for (const e of events) {
    const ev = (e as { event?: { type?: unknown; timestamp?: unknown } } | null)?.event;
    const ts = asDate(ev?.timestamp);
    if (!ts) continue;
    if (ev?.type === 'login' && (!lastLogin || ts > lastLogin)) lastLogin = ts;
    if (ev?.type === 'account_created' && (!created || ts < created)) created = ts;
  }
  return {
    accountId, callsign,
    online: u.Online === true ? true : u.Online === false ? false : null,
    pastCallsigns: [...new Set(past)],
    lastLoginAt: lastLogin, createdAt: created,
  };
}

/** Escape a literal for use inside the server-side regex. */
export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Case-insensitive alternation of literal identifiers, the same shape the reference builds (`\[TAG\]|...`). */
export function identifierPattern(identifiers: string[]): string {
  return identifiers.map(escapeRegex).join('|');
}

interface CacheEntry<T> { at: number; value: T; }

export class OspreyClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly negTtlMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerMs: number;
  private readonly rosterTtlMs: number;
  private readonly maxRosterPages: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ua: string;
  private readonly cache = new Map<string, CacheEntry<OspreyIdentity | null>>();
  private readonly inflight = new Map<string, Promise<OspreyLookup>>();
  private rosterCache: { key: string; at: number; value: { entries: OspreyIdentity[]; truncated: boolean } } | null = null;

  private consecutiveFailures = 0;
  private breakerUntil = 0;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;

  constructor(private readonly log: Log, opts: OspreyOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.negTtlMs = opts.negativeTtlMs ?? 2 * 60_000;
    this.breakerThreshold = opts.breakerThreshold ?? 3;
    this.breakerMs = opts.breakerMs ?? 60_000;
    this.rosterTtlMs = opts.rosterTtlMs ?? 60_000;
    this.maxRosterPages = opts.maxRosterPages ?? 5;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ua = opts.userAgent ?? 'GeoFS-MRP-Bot/1.0 (osprey enrichment)';
  }

  health() {
    return {
      ok: this.consecutiveFailures === 0 ? (this.lastSuccessAt ? true : null) : this.consecutiveFailures < this.breakerThreshold,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  private get breakerOpen(): boolean { return this.now() < this.breakerUntil; }

  /** GET JSON with a single bounded retry on HTTP 429 (the reference retries forever; this does not). */
  private async getJson(path: string, attempt = 1): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: 'application/json', 'user-agent': this.ua }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new OspreyError(`Osprey request failed: ${(e as Error).message}`);
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 8000; // 8 s default, as in the reference
      if (attempt >= 2) throw new OspreyError('Osprey rate limit (HTTP 429)', 429);
      this.log.warn({ waitMs }, 'osprey rate limited; retrying once');
      await this.sleep(waitMs);
      return this.getJson(path, attempt + 1);
    }
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new OspreyError(`Osprey responded HTTP ${res.status}`, res.status);
    try { return { status: res.status, body: await res.json() }; }
    catch (e) { throw new OspreyError(`Osprey returned invalid JSON: ${(e as Error).message}`, res.status); }
  }

  private recordSuccess() { this.consecutiveFailures = 0; this.lastError = null; this.lastSuccessAt = new Date(this.now()); }
  private recordFailure(e: unknown) {
    this.consecutiveFailures++;
    this.lastError = (e as Error).message;
    if (this.consecutiveFailures >= this.breakerThreshold) {
      this.breakerUntil = this.now() + this.breakerMs;
      this.log.warn({ failures: this.consecutiveFailures, pauseMs: this.breakerMs, err: this.lastError }, 'osprey unavailable; pausing lookups');
    }
  }

  private async cached(key: string, load: () => Promise<OspreyIdentity | null>): Promise<OspreyLookup & { cached?: boolean }> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < (hit.value ? this.ttlMs : this.negTtlMs)) {
      return hit.value ? { status: 'ok', identity: hit.value, via: key.startsWith('acid:') ? 'acid' : 'callsign', cached: true } : { status: 'not_found', cached: true };
    }
    if (this.breakerOpen) return { status: 'unavailable', error: this.lastError ?? 'Osprey temporarily paused after repeated failures' };
    try {
      const value = await load();
      this.recordSuccess();
      this.cache.set(key, { at: this.now(), value });
      return value ? { status: 'ok', identity: value, via: key.startsWith('acid:') ? 'acid' : 'callsign' } : { status: 'not_found' };
    } catch (e) {
      this.recordFailure(e);
      return { status: 'unavailable', error: (e as Error).message };
    }
  }

  private single(key: string, fn: () => Promise<OspreyLookup>): Promise<OspreyLookup> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** GET /users/?acid=<id> */
  byAcid(acid: string | number): Promise<OspreyLookup> {
    const id = String(acid).trim();
    if (!/^\d{1,18}$/.test(id)) return Promise.resolve({ status: 'not_found' });
    return this.single(`acid:${id}`, () => this.cached(`acid:${id}`, async () => {
      const r = await this.getJson(`/users/?acid=${encodeURIComponent(id)}`);
      return r.status === 404 ? null : parseOspreyUser(r.body);
    }));
  }

  /** GET /users/search?exact_callsign=<cs> (first result) */
  byExactCallsign(callsign: string): Promise<OspreyLookup> {
    const cs = callsign.trim();
    if (!cs) return Promise.resolve({ status: 'not_found' });
    const key = `cs:${cs.toLowerCase()}`;
    return this.single(key, () => this.cached(key, async () => {
      const r = await this.getJson(`/users/search?exact_callsign=${encodeURIComponent(cs)}`);
      const results = (r.body as { results?: unknown } | null)?.results;
      return Array.isArray(results) && results.length ? parseOspreyUser(results[0]) : null;
    }));
  }

  /**
   * Resolve one pilot. Tries the account id first (the GeoFS `acid` from the live feed) and falls back to the exact
   * callsign when the id is unknown or unknown to Osprey.
   */
  async lookup(q: { accountId?: string | number | null; callsign?: string | null }): Promise<OspreyLookup> {
    if (q.accountId !== null && q.accountId !== undefined && q.accountId !== '') {
      const r = await this.byAcid(q.accountId);
      if (r.status !== 'not_found') return r;
    }
    if (q.callsign) return this.byExactCallsign(q.callsign);
    return { status: 'not_found' };
  }

  /**
   * GET /users/search?pattern=/<regex>/i&page=N&per_page=100 — all accounts whose callsign matches any identifier.
   * Paginates like the reference, but is capped (`maxRosterPages`) and cached.
   */
  async roster(identifiers: string[]): Promise<{ status: 'ok'; entries: OspreyIdentity[]; truncated: boolean } | { status: 'unavailable'; error: string }> {
    const pattern = identifierPattern(identifiers.filter((x) => x.trim()));
    if (!pattern) return { status: 'ok', entries: [], truncated: false };
    if (this.rosterCache && this.rosterCache.key === pattern && this.now() - this.rosterCache.at < this.rosterTtlMs) return { status: 'ok', ...this.rosterCache.value };
    if (this.breakerOpen) return { status: 'unavailable', error: this.lastError ?? 'Osprey temporarily paused after repeated failures' };
    try {
      const entries: OspreyIdentity[] = [];
      let truncated = false;
      for (let page = 1; ; page++) {
        const r = await this.getJson(`/users/search?pattern=${encodeURIComponent(`/${pattern}/i`)}&page=${page}&per_page=100`);
        const body = r.body as { results?: unknown; count?: unknown } | null;
        const results = Array.isArray(body?.results) ? body!.results : [];
        for (const raw of results) { const id = parseOspreyUser(raw); if (id) entries.push(id); }
        const total = Number(body?.count);
        if (results.length < 100 || (Number.isFinite(total) && entries.length >= total)) break;
        if (page >= this.maxRosterPages) { truncated = true; break; }
      }
      this.recordSuccess();
      this.rosterCache = { key: pattern, at: this.now(), value: { entries, truncated } };
      return { status: 'ok', entries, truncated };
    } catch (e) {
      this.recordFailure(e);
      return { status: 'unavailable', error: (e as Error).message };
    }
  }
}
