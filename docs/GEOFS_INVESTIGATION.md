# GeoFS multiplayer data — investigation findings

Everything below was observed against the live service on **2026-11-07** (probe: `npm run probe:geofs`), by reading the
GeoFS client source (`https://www.geo-fs.com/js/geofs.js`) and calling the endpoints. Nothing here is assumed.
GeoFS publishes **no official API documentation**; the endpoint used is the one GeoFS's own web client uses, so it can
change without notice (see *Risks*).

## 1. Architecture

* The web client sets `geofs.multiplayerHost = 'https://mps.geo-fs.com'` (inline in `geofs.php`). There is a single global
  host — the client has no server selection — so `/map` represents the whole multiplayer population, not one session.
  (Completeness cannot be *proven* from outside; in every sample `userCount` equalled the length of `users[]`.)
* Two relevant endpoints, both `POST`, JSON body (verified in `geofs.js`):

| Endpoint | Purpose | Used? |
|---|---|---|
| `POST /update?l=…` | The flight loop. Body carries the sender's own `acid` (account id), `sid` (session id), position, etc.; response = nearby users. Requires being a logged-in participant. `POST /update {}` → HTTP 500. | **No** — would require a GeoFS login and would publish a fake aircraft into the sim. |
| `POST /map[?gid=…]` | Read-only global player list used by the in-game map and player list. Body `{id, gid}` (own id / licence id). **Works with `{"id":null,"gid":null}`**: no login, no session. | **Yes.** |

* The in-game map polls `/map` every `geofs.MPSMapUpdatePeriod = 10000` ms; the bot uses the same 10 s default
  (`POLL_INTERVAL_MS`, minimum 5 s). Response time ≈ 0.8–1.1 s, ≈ 160 KB per poll.
* No rate limits are documented or were encountered (≈ 10 requests in testing). The poll rate mirrors the official client.

## 2. Response format (`POST /map`)

```jsonc
{ "userCount": 825,
  "users": [
    { "id": "0276628518364",          // multiplayer id: 13-digit string, STABLE across polls while connected
      "acid": 2145266,                // GeoFS account id; null for guests
      "ac": 25,                       // aircraft type id (number)
      "cs": "HawaiianAirlines104",    // callsign (free text, chosen by the user)
      "st": { "gr": 0, "as": 526, "lv": "2" },       // gear flag, indicated airspeed (kts), livery
      "co": [6.37, -166.03, 12192.12, -101.99, -1.37, 0.02], // [lat, lon, altitude m, heading°, pitch, roll]
      "ve": [ … ],                    // velocity vector, units undocumented  -> NOT used
      "ti": 1794068280299.3896 }      // server timestamp, epoch ms
  ] }
```

Field semantics were confirmed from the client source (`multiplayer.sendUpdate`: `co = [lat, lon, alt, htr…]`,
`st.as = geofs.animation.values.kias`) and by plausibility: a Boeing 777 at `co[2]=12192.12` is exactly FL400.

* **Speed** is *indicated* airspeed in knots (`st.as`), not ground speed. The alert embed says so.
* **Altitude** is metres; Flight Level is computed as `round(ft/100)` from geometric altitude (not pressure-corrected).
* **Heading** can be negative (`-101.99`); normalised to 0–360 (258°).
* **Aircraft names**: the id → name table is embedded in the `geofs.php` HTML
  (`geofs.aircraftList['4'] = {name: 'Boeing 737-700', …}`), 190 entries. The bot refreshes it every 6 h and ships a
  snapshot (`data/aircraft-types.json`) as fallback. Community names are **truncated by GeoFS itself** (e.g.
  `Airbus A330-300 (by Jeffa &`). Unmapped ids are shown as `Unknown (aircraft ID 2525)`.

## 3. Real-data quirks (all handled; each has a test)

Observed in 3 polls (816, 812, 816 valid users):

| Quirk | Observed | Handling |
|---|---|---|
| `null` entries inside `users[]` | 4–6 per poll | dropped (counted) |
| Guest placeholder users `cs:"Foo"`, `co` all zeros | ~3 per poll with exact `[0,0,…]`; ~70 % of users are guests (`acid:null`) | all-zero position rejected |
| Garbage values | `st.as` = 600000000; altitude 90,916,034 m; ~17 users with `as` > 1500 | reported as **Unknown**, never displayed |
| `ac` as string / empty / null | 5 strings, 1 null per poll | parsed or Unknown |
| Unmapped aircraft ids | 2525, 5009, 3557, 6154, 5808 | `Unknown (aircraft ID n)` |
| **Duplicate callsigns across ids** | `spydir` used by 6 different multiplayer ids; ~42 users have an empty callsign | identity is the **multiplayer id** only |
| Callsign changes under the same id | 1 of 755 persisting ids | callsign refreshed, matching recomputed |
| **Stale records** | server-timestamp age: p50 1.5 s, p99 ≈ 8.7 s, **max 37,500 s (10 h)** | records older than `STALE_AFTER_MS` (120 s) are ignored |
| Missing `ti` | 5 of ~800 | accepted (present in the live map), freshness unknown |

Across two polls 20 s apart: 755 of 816 ids persisted, 680 changed position, 61 disappeared/61 appeared.
A reconnect produces a **new id** (consistent with the spec's "new aircraft" rule).

## 4. Risks and limits

* **Unofficial endpoint** — GeoFS may change `/map`, add auth or rate limits. The collector validates shape strictly
  (`GeoFsHttpError`), backs off exponentially (10 s → 60 s cap, jittered) and `/health` reports `degraded`. The data
  source sits behind the `GeoFsSource` interface so another adapter can replace it.
* Callsigns are user-chosen: anyone can type `[USAF]`. Identification is by substring, as specified, not authentication.
* `/update` and any authenticated GeoFS API were deliberately **not** used.
* **Osprey V2 (`https://api.gms-admin.net/api/v2`)** is used as **optional identity enrichment**, with the endpoints and fields taken from
  the reference bot `cynkcrl-ux/GeoFS-MRP-Track-` (see README → *Osprey identity enrichment*). From the development sandbox the host was
  allow-listed but the egress gateway could not connect to it (HTTP 502, re-tried on a later day with the same result), so **no live
  response was ever observed**: the client is tested against mocked responses derived from the reference's contract. It is not a position
  source (positions come from GeoFS `/map`), and nothing in the alert path depends on it. `GEOFS_API` (`https://mps.geo-fs.com/map`) and
  `OSPREY_BASE` are both configurable.
