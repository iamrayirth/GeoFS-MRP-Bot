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
                                  │ alerts/            │──────────────────►│ PostgreSQL │  settings, identifiers,
                                  │ alert-manager      │◄──────────────────│ (drizzle)  │  countries, cooldowns,
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
| `src/db/` | Drizzle schema, SQL migrations, repositories (driver-agnostic: `pg` in prod, PGlite in tests) |
| `src/discord/` | slash commands, permission checks, interaction handler, notifier (retry/rate-limit), command registration |
| `src/health.ts`, `src/monitor.ts`, `src/index.ts` | health endpoint, poll→track→alert wiring, bootstrap/shutdown |

## Stack and why

* **Node 22 + TypeScript (strict), discord.js 14** — requested; one process, async I/O, the CPU work (≈ 90 ms/poll for ~820 aircraft) never blocks the gateway for long.
* **PostgreSQL + Drizzle ORM** — requested. Drizzle needs no engine binary download (Prisma's does), generates plain SQL migrations (`drizzle/`), and the same schema runs on real Postgres and on **PGlite** (Postgres in WASM), which lets the test suite use genuine Postgres semantics without a server.
* **Turf.js** point-in-polygon on a custom grid index; **mapshaper** (build-time only) to simplify the boundary data.
* **Zod** (config), **Pino** (structured JSON logs), **Vitest**, **Docker/Compose**.

## Key design decisions

1. **Identity = multiplayer id.** Callsigns collide in real data (`spydir` ×6, ~42 empty). Cooldown, ignore and tracking all key on the id; a reconnect gets a new id and is therefore a new aircraft.
2. **Cooldown is level-triggered and atomic.** Whenever an aircraft with a matching callsign is inside *any* monitored country and `now − lastAlertAt ≥ 10 min` it alerts. This yields exactly the specified 12:00/12:03/12:08/12:10/12:20 behaviour. The claim is one conditional `INSERT … ON CONFLICT DO UPDATE … WHERE last_alert_at <= now−10m` before sending, so restarts, overlapping cycles or a second process can never double-alert (tested with 50 concurrent connections on real PostgreSQL). If Discord delivery fails the claim is **rolled back** (and retried after a 30 s holdoff) so an alert is not silently lost.
3. **Fixed 10-minute cooldown** is a constant (`ALERT_COOLDOWN_MS`), not configuration.
4. **Config changes are immediate.** Commands write to the DB, then update the in-memory mirror, then reply; the poller reads the mirror every cycle.
5. **Fail safe.** Unresolvable country, unknown channel/role, DB outage during a cycle ⇒ no alert (and no cooldown consumed); nothing is posted anywhere except the configured channel; only the configured role can be mentioned (`allowedMentions`).
6. **No fabricated values.** Implausible telemetry and unmapped aircraft show as `Unknown`.
7. **Single instance.** In-memory caches are per process; the database claim makes accidental duplicates harmless, but run one replica.
