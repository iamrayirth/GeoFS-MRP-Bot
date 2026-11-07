# Geographical data

`data/geodata.json.gz` (≈ 8 MB, committed) is produced by `npm run build:geodata` (`scripts/build-geodata.ts`; downloads
≈ 250 MB into `.cache/` the first time; reproducible).

## Sources

| Layer | Source | Licence | Used for |
|---|---|---|---|
| **Land** | Natural Earth 1:10m Admin-0 Countries **v5.1.2**, full-resolution GeoJSON (`nvkelso/natural-earth-vector`) | Public domain | national territory |
| **Territorial seas (12 NM)** | Marine Regions / VLIZ *Maritime Boundaries v12* — layer `eez_12nm` (WFS `geo.vliz.be/geoserver/MarineRegions/wfs`) | CC-BY 4.0 (cite Flanders Marine Institute) | territorial waters |
| Internal waters | same, `eez_internal_waters` | CC-BY 4.0 | waters landward of baselines |
| Archipelagic waters | same, `eez_archipelagic_waters` | CC-BY 4.0 | e.g. Indonesia, Philippines, Fiji |
| Territory→sovereign table | same, `eez_land` **attributes only** | CC-BY 4.0 | linking land polygons to sovereigns |

**The EEZ is deliberately not used.** `eez_land` is "Union EEZ and country" (land + the full 200 NM EEZ); its geometry would
violate the requirement that the EEZ is not territorial water, so only its attribute table is read.
`world-atlas` (TopoJSON) was tried first and **rejected**: it is quantised to a 0.40 × 0.19 km grid, which collapses
Vatican City (it resolved as Italy). Full-resolution Natural Earth is used instead.

## How a point is resolved (`src/geo/engine.ts`)

1. Spatial grid (2°) → candidate polygons → bounding box → `@turf/boolean-point-in-polygon` (boundary counts as inside, holes respected).
2. **Precedence:** land > internal waters > archipelagic waters > 12 NM territorial sea.
3. Several sovereigns at the winning tier ⇒ `ambiguous` with **all** claimants (disputed land such as Siachen; overlapping
   12 NM zones). An alert fires if **any** claimant is monitored and the embed lists the others.
4. No polygon ⇒ **hairline-gap tolerance**: the land and sea layers come from different sources, so a point within
   **1 km** of land/internal/archipelagic waters but in no polygon is attributed to that polygon (`snapped`, shown as
   "(coastal)"). The **outer** edge of the 12 NM zone is never extended.
5. Still nothing ⇒ `unresolved` (high seas, EEZ beyond 12 NM, Antarctica, Bir Tawil). **No country is ever guessed**, and
   unresolved aircraft never alert.

Monitoring is per **sovereign state** (ISO-3166 alpha-3; Kosovo `XKX`). Territories belong to their sovereign
(Guam → United States, shown in the alert as "United States (Guam)"); `/country add Guam` is refused with an explanation.
Disputed/partially-recognised entities are listed with every claimant in `scripts/build-geodata.ts` (`MANUAL`).

## Accuracy — measured, not assumed

* **12 NM width check:** for 1,500 sampled vertices of the 12 NM polygons the distance to the nearest Natural Earth coast has
  **median 12.03–12.10 NM** (p25 ≈ 7–10 NM because inner-edge vertices lie on the baseline; p75 ≈ 13.1 NM; p95 ≈ 22 NM from
  straight-baseline coasts and bays). Walking offshore from Oregon / Byron Bay the zone ends at 13.0 / 12.4 NM. Where states
  use straight baselines (India's west coast, South Africa) an *internal-waters* band precedes the 12 NM band, as in law.
* **Simplification:** land 75 m, internal waters 750 m, archipelagic 500 m, **12 NM 200 m** (topology-preserving
  `mapshaper`, `keep-shapes`). Positional error is ≪ the 22 km width of the zone but can matter within a few hundred metres
  of a boundary.
* **Live coverage (819 aircraft):** 628 land, 76 in 12 NM, 35 internal, 3 archipelagic, 77 unresolved (open ocean);
  17 needed coastal snapping. Of 333 aircraft below 250 m only **4** were unresolved (Rio Galeão in Guanabara Bay, Hong Kong's
  reclaimed-land airport, 2 guests). Reclaimed land and bay waters absent from the VLIZ internal-waters layer are the known gap.
* Performance: loading ≈ 0.8 s / ≈ 300 MB RSS; resolving all ~820 live aircraft ≈ 90 ms.
* Legal caveat: these are cartographic datasets, not legal determinations. Natural Earth uses de-facto boundaries and VLIZ
  models baselines per its documentation; neither is authoritative for border disputes.

## Your coarse bounding boxes (`data/ao-boxes.json`)

Used for (1) country-name/alias lookup, (2) an **informational cross-check**: if the polygon result lies outside the coarse
box of its country (or of that country's territories) a `aobox_mismatch` warning is logged. They never decide a country and
never suppress an alert — rectangles overlap heavily (India's box contains most of Nepal) and cannot express territorial
waters. Five names appear twice in the input with slightly different boxes (Mauritius, Seychelles, Comoros, Maldives, Sao Tome and
Principe) and "Cabo Verde"/"Cape Verde" are one sovereign; all boxes of a sovereign are kept and a point inside **any** of them passes.

## Refreshing

`npm run build:geodata` (delete `.cache/geodata` to force re-download), then commit `data/geodata.json.gz`.
`npm run update:aircraft` refreshes `data/aircraft-types.json`.
