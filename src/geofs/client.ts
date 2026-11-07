import { parseMapResponse } from './parse.js';
import type { MapSnapshot } from './types.js';

export interface GeoFsSource {
  fetchSnapshot(): Promise<MapSnapshot>;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export class GeoFsHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GeoFsHttpError';
  }
}

/**
 * Reads the same read-only endpoint the GeoFS in-game player map uses: `POST <mps>/map`.
 * The client's own request body is `{id, gid}` (own multiplayer id / license id); both are null for a passive observer.
 * It never joins the session and never sends a GeoFS account/session id.
 */
export class GeoFsMapClient implements GeoFsSource {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly userAgent = 'GeoFS-MRP-Bot/1.0 (passive map reader)',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchSnapshot(): Promise<MapSnapshot> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.userAgent },
        body: JSON.stringify({ id: null, gid: null }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new GeoFsHttpError(`GeoFS request failed: ${(e as Error).message}`);
    }
    if (!res.ok) throw new GeoFsHttpError(`GeoFS responded HTTP ${res.status}`, res.status);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BODY_BYTES) throw new GeoFsHttpError(`GeoFS response too large (${len} bytes)`);
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new GeoFsHttpError(`GeoFS returned invalid JSON: ${(e as Error).message}`, res.status);
    }
    return parseMapResponse(json, new Date());
  }
}
