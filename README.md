# GeoFS MRP Bot

A Discord bot that watches **live GeoFS multiplayer** aircraft and posts an alert (with a role ping) when an aircraft whose
callsign contains a configured identifier (e.g. `[USAF]`) is inside a configured country — **land or 12 NM territorial
waters** — with one global, fixed 10-minute per-aircraft cooldown.

* Data: GeoFS's own read-only player-list endpoint (`POST https://mps.geo-fs.com/map`) — [findings](docs/GEOFS_INVESTIGATION.md)
* Identity: optional Osprey V2 enrichment (endpoints from the reference bot) — [below](#osprey-identity-enrichment)
* Geography: Natural Earth land + Marine Regions (VLIZ) 12 NM territorial seas — [details & measured accuracy](docs/GEODATA.md)
* Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
* Stack: Node 22 · TypeScript · discord.js 14 · JSON file store · Turf · Zod · Pino · Vitest · Docker

## What is verified, and what is not

**Verified in development (with evidence in the docs and tests)**

| | |
|---|---|
| Live GeoFS `/map` collector | Called the real service; schema, quirks and freshness measured; production client/parser exercised against it (`npm run probe:geofs`) |
| Aircraft names | Table scraped from the live GeoFS page (190 types); unmapped ids shown as *Unknown (aircraft ID n)* |
| Country + territorial-water detection | Real dataset; 12 NM width measured (median 12.03 NM); known cities, the antimeridian, disputes, EEZ-is-not-territorial-sea, holes, borders all tested |
| Cooldown / ignore / identifiers | Unit + integration tests incl. the exact 12:00/12:03/12:08/12:10/12:20 timeline, restarts, reconnect-with-new-id, failed delivery rollback |
| JSON state store | Atomic cooldown claims (50 concurrent ⇒ exactly one wins), crash-safe writes, **refuses to start rather than silently reset** on a corrupt `state.json`, backup recovery, single-instance lock (incl. a real child-process crash test) |
| End to end on **live** data | `npm run dry-run`: real feed → tracker → geo → cooldown claims in `state.json` → real embed builder. alerts on poll 1, none on polls 2–3 (cooldown), unresolved ocean aircraft skipped |
| Build/runtime | `tsc` build; runtime stage simulated with production-only dependencies |
| Test suite | 240+ tests (`npm test`, ~5 s, no external services) |

**NOT verified — could not be tested from the development sandbox**

* **Live Discord.** The sandbox blocks `discord.com` and there was no bot token, so the gateway connection, slash-command
  registration, real permission checks, the visual rendering of the embed and the actual role ping were **never exercised
  against Discord**. They are covered by tests using faked interaction/guild objects and an embed-limits test, and the
  start-up path was run up to the Discord login. Expect to do a first-run check (steps below).
* **Docker image build / `docker compose up`** (no Docker daemon in the sandbox). `docker compose config` validates; the
  Dockerfile follows the standard multi-stage pattern but has not been built.
* Behaviour under GeoFS rate limiting (none documented/observed) and over multi-day uptime.
* **Osprey V2 against the live API.** `https://api.gms-admin.net/api/v2` was unreachable from the sandbox (the egress gateway could not connect), so the integration is implemented from the endpoints/fields used by the reference bot `cynkcrl-ux/GeoFS-MRP-Track-` and tested **only against mocked responses**. Whether Osprey's `accountID` equals the GeoFS `acid` is an assumption (callsign lookup is the fallback). It is optional and can never block an alert.

## Quick start (Docker Compose — recommended)

### 1. Create the Discord application
1. <https://discord.com/developers/applications> → **New Application** → **Bot** → **Reset Token** (copy it once).
   No privileged intents are required.
2. Copy the **Application ID** (`DISCORD_CLIENT_ID`) and your server's ID (`DISCORD_GUILD_ID`; enable Developer Mode → right-click the server → Copy Server ID).
3. Invite the bot (replace `CLIENT_ID`) — scopes `bot` + `applications.commands`; permissions *View Channel, Send Messages, Embed Links*:
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=19456`
4. Make the role you want pinged **mentionable** (or give the bot *Mention Everyone*), otherwise the ping does not notify.

### 2. Configure and start
```bash
git clone <this repo> && cd GeoFS-MRP-Bot
cp .env.example .env
# edit .env: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
docker compose up -d --build
docker compose logs -f bot
```
State is kept in `state.json` on the `botstate` Docker volume (survives restarts and rebuilds). Slash commands are registered automatically on start (guild-scoped ⇒ instant).

### 3. First-run check (do this once — it is the part that could not be tested here)
In Discord, as an Administrator:
```
/settings channel channel:#alerts
/settings role    role:@MRP-Alerts
/identifier add   value:[USAF]
/country add      country:India          (autocomplete: names, ISO codes and aliases such as "UK", "USA")
/status           /health                (everything should be green; GeoFS "last poll" a few seconds ago)
/aircraft list scope:All active aircraft  (live GeoFS aircraft should appear)
```
To prove delivery end-to-end without waiting for a real match, add an identifier that currently exists in GeoFS
(find one with `/aircraft list`, e.g. a bracket tag some online pilot uses) and a country that aircraft is over; you should get
one alert with a role ping, then silence for 10 minutes, then a repeat alert while it is still there.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | **required**, secret |
| `DISCORD_CLIENT_ID` | derived from token | needed by `npm run deploy-commands` |
| `DISCORD_GUILD_ID` | — | restricts the bot to one server (recommended) |
| `STATE_DIR` | `./state` | directory for `state.json` (`/app/state` in Docker, on a volume) |
| `REGISTER_COMMANDS` | `true` | register slash commands at start |
| `AUTHORIZED_USER_IDS`, `ADMIN_ROLE_IDS` | — | extra users/roles allowed to run admin commands (Administrators always are) |
| `GEOFS_API` | `https://mps.geo-fs.com/map` | data source |
| `OSPREY_BASE` | `https://api.gms-admin.net/api/v2` | Osprey V2 identity API |
| `OSPREY_ENABLED` | `true` | `false` disables Osprey (alerts, `/ident`, `/roster` degrade gracefully) |
| `GEOFS_AIRCRAFT_LIST_URL` | `https://www.geo-fs.com/geofs.php` | aircraft id → name table |
| `POLL_INTERVAL_MS` | `10000` | min 5000 (GeoFS's own client uses 10 s) |
| `STALE_AFTER_MS` | `120000` | ignore server records older than this |
| `HEALTH_PORT` | `8080` | `0` disables the HTTP health endpoint |
| `LOG_LEVEL`, `LOG_PRETTY` | `info`, `false` | JSON logs; pretty only in dev |

The 10-minute cooldown is **not** configurable (`src/config.ts: ALERT_COOLDOWN_MS`). No secret, token or ID is hard-coded.

## Commands

Admin = Discord **Administrator** permission, or a user/role listed in `AUTHORIZED_USER_IDS` / `ADMIN_ROLE_IDS`.
All replies are ephemeral. Commands work only in servers (and only in `DISCORD_GUILD_ID` if set).

| Command | Who | |
|---|---|---|
| `/identifier add value:` · `remove value:` · `list` | admin · admin · all | case-insensitive **substring** match anywhere in the callsign; removal is effective immediately |
| `/country add country:` · `remove country:` · `list` | admin · admin · all | per sovereign country (names, ISO-2/3, aliases); territories are refused with a pointer to their sovereign |
| `/aircraft list [filter] [scope]` · `info aircraft:` | all | active aircraft; `info` shows id, identifiers, type, country/area, position, FL/KTS/heading, first/last seen, last alert, cooldown left, ignore status |
| `/ignore callsign: duration:` | admin | by **multiplayer id** (autocomplete picks the exact aircraft); `10m 30m 1h 6h 1d 1h30m…`, 1 min – 30 days |
| `/unignore callsign:` · `/ignored` | admin · all | `/ignored` shows callsign, id and expiry |
| `/settings view` · `channel channel:` · `role role:` | all · admin · admin | alerts need both set; channel permissions are checked |
| `/ident pilot:` | all | identity card: live GeoFS data + Osprey (account ID, aliases, last login, account created) |
| `/roster` | all | Osprey accounts whose callsign matches a configured identifier, flagged if visible in GeoFS now |
| `/status` · `/health` · `/help` | all | |

> Discord does not allow a slash command to be both runnable and have sub-commands, so the requested bare `/settings`
> is `/settings view`.

## Alert behaviour

* Posts only to the configured channel, with `<@&role>` on **every** alert (repeats included); nothing else can be mentioned.
* Embed: callsign, multiplayer id, country (flag; territory in brackets; disputed claimants), area (land / territorial waters …),
  aircraft name, clickable Google Maps position, speed in **KTS** (indicated airspeed), altitude as **FL** (+ feet), heading in **°**,
  matched identifiers, UTC detection time, and — when Osprey answers — an **Osprey identity** block (account ID, known aliases, last login). Missing/implausible values are **Unknown**.
* Title is *ENTERED* when the aircraft was not in monitored territory on the previous observation, otherwise *REMAINS IN*.
* **Cooldown (global, fixed 10 min per multiplayer id, shared by all countries, persisted):**
  `12:00 India ALERT · 12:03 Pakistan – · 12:08 Nepal – · 12:10 still Nepal ALERT · 12:20 ALERT`. After expiry an aircraft outside
  monitored countries is silent and alerts immediately on entering one.
* A reconnect with a **new multiplayer id is a new aircraft** (new cooldown, not ignored).
* Aircraft that vanish are marked inactive and not processed; their cooldown/ignore rows are kept.

## Osprey identity enrichment

Optional. Uses the **same Osprey V2 endpoints as the reference bot** `cynkcrl-ux/GeoFS-MRP-Track-` (base `OSPREY_BASE`,
default `https://api.gms-admin.net/api/v2`):

| Endpoint | Used for |
|---|---|
| `GET /users/?acid=<account id>` | alert enrichment and `/ident` (the GeoFS `acid` from the live feed) |
| `GET /users/search?exact_callsign=<callsign>` | fallback when the account id is unknown to Osprey, and `/ident` for offline pilots |
| `GET /users/search?pattern=/<regex>/i&page=N&per_page=100` | `/roster` (regex built from your configured identifiers, escaped) |

Fields read (as in the reference): `accountID`, `currentCallsign`, `Online`, `pastCallsigns[]`, `events[].event.{type,timestamp}`
(`login`, `account_created`). Nothing else is assumed or invented; absent fields are simply not shown.

Behaviour: lookups are **cached** (10 min; 2 min for "not found"), concurrent identical lookups are merged, HTTP 429 honours
`Retry-After` (default 8 s, as the reference) and retries **once** (the reference loops forever), and after 3 consecutive failures
Osprey is left alone for 60 s. Alerts look Osprey up **before** claiming the cooldown, with a 2 s cap — if Osprey is slow, down or
wrong, the alert is sent without the block (`Lookup unavailable`). `/health` reports Osprey as informational only.

Differences from the reference: it queries `?acid=` with the GeoFS *multiplayer id* (a different number); this bot sends the GeoFS
`acid` (account id). It also stores Osprey-only "online" pilots without positions; this bot does not (no position ⇒ no territory ⇒ no alert).
**Unverified:** the live API could not be reached from the development sandbox (see "What is verified").

## Operations

* **Logs:** structured JSON (Pino) on stdout; key events `alert_sent`, `command`, `unauthorized_command`, `aobox_mismatch`.
  `docker compose logs -f bot`.
* **Health:** `GET :8080/healthz` → 200 `ok|degraded`, **503** `unhealthy` (DB or Discord down). GeoFS outages are *degraded*
  (restarting would not help). Docker `HEALTHCHECK` uses it; `/health` shows the same in Discord.
* **Restart strategy:** `restart: unless-stopped`; fatal errors exit non-zero so the supervisor restarts; SIGTERM shuts down cleanly.
  State (config, cooldowns, ignores) is restored from `state.json`, so restarts never cause duplicate alerts.
  Use plain Docker/systemd instead? Run `node dist/index.js` under any supervisor with `Restart=always`.
* **Backups:** `docker compose cp bot:/app/state/state.json ./state-backup.json` (plain JSON; the bot also keeps `state.json.bak`, the previous good copy). Restore by stopping the bot and putting the file back.
* **Update:** `git pull && docker compose up -d --build` .
* **Refresh data:** `npm run build:geodata` (boundaries), `npm run update:aircraft` (aircraft table; also refreshed live every 6 h).
* **Scale:** exactly **one** instance per `STATE_DIR` — a lock file (`state.lock`, heartbeat) refuses a second one. A JSON file cannot arbitrate between writers or hosts; if you ever need several replicas, that is the point to move to a database.
* **Without Docker:** Node ≥ 22: `npm ci && npm run build && STATE_DIR=./state npm start` (under systemd/pm2 with `Restart=always`).
* **Corrupt state file:** the bot restores `state.json.bak` automatically; if neither file is usable it **refuses to start** (and leaves the files untouched) instead of silently forgetting cooldowns — repair the JSON or delete both files to start fresh.

## Development

```bash
npm ci
npm run typecheck
npm test            # ~5 s; no database or network needed (uses temporary state directories)
npm run probe:geofs         # inspect the live GeoFS feed through the production parser
npm run dry-run -- "[" 3    # live end-to-end run, Discord replaced by console (throw-away state dir)
```
Behind an HTTP proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1`.

Project layout: `src/{geofs,osprey,tracking,geo,alerts,store,discord}`, `data/` (bundled datasets),
`tests/{unit,integration}`, `scripts/`, `docs/`.

## Limitations and assumptions

* GeoFS has no documented public API; the endpoint is what the web client uses and may change. Callsigns are self-chosen and spoofable.
* Territorial waters are the VLIZ v12 12 NM polygons (baseline-based), simplified to 200 m; ~1 % of coastal aircraft (reclaimed land, some bays) can be *Unknown*. Not a legal determination. Details: [docs/GEODATA.md](docs/GEODATA.md).
* Monitoring is per sovereign state; disputed areas alert if **any** claimant is monitored and name the others.
* FL uses geometric altitude (no pressure correction); speed is indicated airspeed (GeoFS does not expose ground speed in `/map`).
* State is a single JSON file written whole on each change (fine for this data size: tens of KB to ~1 MB); one instance only (see Operations).
* Autocomplete shows at most 25 aircraft; `/aircraft list` shows 20 rows.
* Node 22 is what was tested (Node 24 should work; not run).
* Data attributions: Natural Earth (public domain); Flanders Marine Institute (VLIZ) Maritime Boundaries v12 (CC-BY 4.0).
