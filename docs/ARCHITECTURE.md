# Architecture

```
            ┌────────────────────────── GeoFS ───────────────────────────┐
            │  POST https://mps.geo-fs.com/map  (read-only player list)    │
            └───────────────────────────────┬──────────────────────────────┘
                                            │ every 10 s (single-flight, backoff+jitter)
                                  ┌─────────▼─────────┐
                                  │ geofs/  client +   │  validate → Observation[]   (null/garbage/placeholder
                                  │ parse + poller     │  records rejected & counted; implausible values → Unknown)
                                  └─────────┬─────────┘
                                            │ MapSnapshot
                                  ┌─────────▼─────────┐        ┌──────────────┐
                                  │ tracking/tracker   │◄───────┤ geo/engine    │ lat/lon → sovereign(s),
                                  │ Map<multiplayerId> │        │ (+countries)  │ tier, territory, "unresolved"
                                  │ identifiers match, │        └──────────────┘
                                  │ stale/inactive     │◄─── config-service (in-memory mirror of DB config)
                                  └─────────┬─────────┘
                                            │ active aircraft
                                  ┌─────────▼─────────┐   atomic claim    ┌────────────┐
                                  │ alerts/            │──────────────────►│ state.json │  settings, identifiers,
                                  │ alert-manager      │◄──────────────────│ (JSON)     │  countries, cooldowns,
                                  │ + decision (pure)  │   ignores         └────────────┘  ignores, tracking
                                  └─────────┬─────────┘
                                            │ AlertPayload
                                  ┌─────────▼─────────┐
                                  │ discord/notifier   │──► configured channel only, role ping on every alert
                                  └───────────────────┘
   discord/ commands (slash) ──► config-service / repositories        health.ts ──► /healthz, /health command
```

| Module | Responsibility |
|---|---|
| `src/geofs/` | HTTP collector (`GeoFsSource` interface), strict parsing, poller with backoff, aircraft-name table |
| `src/tracking/` | identifier matching; `AircraftTracker` (one record per **multiplayer id**; active/inactive; stale filter) |
| `src/geo/` | `GeoEngine` (point-in-polygon, tiers, disputes, gap snapping), `CountryDirectory` (names/aliases), `AoBoxes` |
| `src/alerts/` | `decision.ts` (pure cooldown/ignore rules), `AlertManager` (claim → send → rollback), embed builder |
| `src/store/` | `JsonStore` (crash-safe state.json, backup, instance lock) and the repositories on top of it |
| `src/osprey/` | Osprey V2 client (cache, retry, circuit breaker) — optional enrichment |
| `src/discord/` | slash commands, permission checks, interaction handler, notifier (retry/rate-limit), command registration |
| `src/health.ts`, `src/monitor.ts`, `src/index.ts` | health endpoint, poll→track→alert wiring, bootstrap/shutdown |

## Stack and why

* **Node 22 + TypeScript (strict), discord.js 14** — requested; one process, async I/O, the CPU work (≈ 90 ms/poll for ~820 aircraft) never blocks the gateway for long.
* **JSON file persistence** — requested instead of PostgreSQL. State is small (config, one cooldown row per alerted aircraft, ignores, history for matching aircraft), so one atomically-written `state.json` (tmp → fsync → rename, previous copy kept as `.bak`) is enough, needs no service, and is trivial to back up or edit. The price is a **single instance** (enforced with a heartbeat lock file) and whole-file rewrites; the repository interfaces are unchanged, so a database could be swapped back in.
* **Turf.js** point-in-polygon on a custom grid index; **mapshaper** (build-time only) to simplify the boundary data.
* **Zod** (config), **Pino** (structured JSON logs), **Vitest**, **Docker/Compose**.

## Key design decisions

1. **Identity = multiplayer id.** Callsigns collide in real data (`spydir` ×6, ~42 empty). Cooldown, ignore and tracking all key on the id; a reconnect gets a new id and is therefore a new aircraft.
2. **Cooldown is level-triggered and atomic.** Whenever an aircraft with a matching callsign is inside *any* monitored country and `now − lastAlertAt ≥ 10 min` it alerts. This yields exactly the specified 12:00/12:03/12:08/12:10/12:20 behaviour. The check-and-set of the claim runs in one synchronous section (so 50 concurrent claims yield exactly one winner) and is flushed to `state.json` **before** the message is sent, so a restart can never double-alert. If the disk write fails the claim is reverted; if Discord delivery fails the claim is **rolled back** (and retried after a 30 s holdoff) so an alert is not silently lost.
3. **Fixed 10-minute cooldown** is a constant (`ALERT_COOLDOWN_MS`), not configuration.
4. **Config changes are immediate.** Commands write to the DB, then update the in-memory mirror, then reply; the poller reads the mirror every cycle.
5. **Fail safe.** Unresolvable country, unknown channel/role, DB outage during a cycle ⇒ no alert (and no cooldown consumed); nothing is posted anywhere except the configured channel; only the configured role can be mentioned (`allowedMentions`).
6. **No fabricated values.** Implausible telemetry and unmapped aircraft show as `Unknown`.
7. **Single instance.** In-memory caches and the JSON file are per process; `state.lock` (heartbeat, stale after 30 s, released on every exit path) refuses a second instance on the same directory.
8. **Never silently forget.** A corrupt `state.json` is restored from `state.json.bak`; if nothing usable exists the bot refuses to start and leaves the files untouched, because starting empty would drop cooldowns and re-alert.
9. **Osprey is garnish, not a dependency.** Looked up before the claim with a 2 s cap; any failure degrades to an alert without the identity block.
