# Browser architecture

`app.js` coordinates user actions and state changes. Keep parsing, network work, storage, and map layers behind their module interfaces. Do not add new provider abstractions until a second provider is selected.

| Module | Responsibility |
| --- | --- |
| `track-data.js` | Validate aligned coordinates, elevations, and times. Preserve segment breaks and calculate distance within segments. |
| `gps-import.js`, `parsers.js` | Parse XML, GeoJSON, and FIT into tracks. Report skipped content. |
| `compression.js`, `import-client.js`, `import-worker.js` | Bound expanded data and move supported large imports to a cancellable worker. |
| `gpx.js` | Export validated tracks with explicit timestamp policy and unique archive names. |
| `google-routes.js`, `network.js` | Validate requests, preserve useful errors, enforce timeouts, and support cancellation. |
| `elevation.js` | Share request spacing, sample by distance, retain partial results, and interpolate within segments. |
| `route-storage.js` | Read legacy records and commit geometry and metadata consistently. |
| `route-map.js` | Own route layers by ID, marker labels, visibility, styling, hover, popup placement, and cleanup. |
| `fog.js` | Parse and render the separate Fog of World overlay. Receive app services through setup. |

## Track rules

A track has `coordinates` as latitude/longitude pairs. Its optional `elevations` and `times` arrays use the same indices. Missing values are `null`; zero is valid. `segmentStarts` contains the first point index of each segment, starting with zero. Never calculate distance or interpolate across a segment break.

Normalization removes invalid points and their associated fields together. It starts a new segment after a removed point. Imports report skipped points, tracks with fewer than two points, and unsupported geometry. The import summary must retain those warnings after the success message changes.

Route data must not contain Leaflet layers, DOM nodes, or map event handlers. `createRouteMap` keeps these objects in its own ID lookup. It supplies tooltip text as DOM text, mounts only visible routes, and removes handlers and popup bindings when a route is deleted. Label changes must call `updateLabels`. Collection changes must call `updateStyles` once after the batch. Hover changes line style without rebuilding endpoint icons.

Keep original coordinates for GPX output. A future renderer or map simplification must not replace export geometry. Canvas is still an experiment that needs representative measurements.

## Storage commits

The `route2gpx_routes` key contains either a legacy route array or a version 2 metadata index. Version 2 entries reference geometry keys. The reader accepts the original `route2gpx_geometry_<id>` keys and revision keys with a numeric suffix.

For each save:

1. Reuse the committed geometry key when its values are unchanged. Array identity provides a fast path; value comparison handles arrays copied during restoration.
2. Write changed geometry under an unused key.
3. Commit the metadata index after all required geometry writes succeed.
4. Delete replaced geometry only after the index commits.

If a write fails, remove new uncommitted keys. Keep the previous index and referenced geometry. This prevents a failed elevation save from pairing new heights with old source metadata. A legacy array remains readable until migration succeeds. If migration cannot fit a second geometry copy, retain the legacy format if its update fits.

The app displays persistent unsaved state independently of transient task messages. Browser storage has finite capacity; exports are the recovery path. This storage format does not provide cross-tab conflict resolution or asynchronous IndexedDB capacity.

## Background work

One elevation client owns the page queue. Cancelling queued work releases its caller without starting a cancelled request. Cancelling active enrichment returns completed batches. The coordinator installs and saves those values if the route still exists. Removed routes cannot receive stale results.

Preserve existing elevations. Add SRTM provenance only when provider or cached samples were added. Retain the mixed-source flag when recorded and provider elevations are combined. A failed lookup must not relabel recorded data as SRTM.

Route geometry appears before optional labels resolve. Late labels update the list, tooltips, and accessible endpoint names only while the same route remains present. Preview markers stay suppressed for completed planner points until the inputs change, including when a previously scheduled input update runs after route completion.

## Verification boundaries

Run `npm run check` and browser tests against a fresh build. Browser tests use real Leaflet, intercepted provider responses, and generated files. Unit tests cover segment preservation, compressed FIT timestamps, failed storage commits, elevation cancellation, map-layer cleanup, label escaping, and icon update counts.

The automated suite does not establish deployed provider permissions, production response headers, physical-keyboard behavior, screen-reader conformance, or field performance. Track those checks in `TODO.md`.
