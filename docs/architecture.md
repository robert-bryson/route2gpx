# Browser architecture

`app.js` coordinates user actions and state changes. Keep parsing, network requests, storage, and map layers behind their module interfaces. Add a provider abstraction only after you select a second provider.

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

A track has `coordinates` as latitude/longitude pairs. The optional `elevations` and `times` arrays use the same indices. Use `null` for a missing value. Zero is valid. `segmentStarts` contains the first point index of each segment. It starts with zero. Never calculate distance or interpolate across a segment break.

Normalization removes invalid points and their associated fields together. It starts a new segment after a removed point. Imports report invalid points, short tracks, and unsupported geometry. The import summary retains those warnings after the success message changes.

Each XML or GeoJSON parser owns one raw point budget for the complete file. Pass this budget through every `trackFromSegments` call. Invalid points consume the same budget as valid points. Lazy point iterators stop extraction when the budget is exhausted.

Validate the calendar date and time fields before converting a timestamp. Convert zoned times to UTC. Preserve digits beyond milliseconds. Preserve an unzoned wall time without assigning the device timezone. Omit invalid timestamps. Replace code points forbidden by XML 1.0 before writing export text.

Keep Leaflet layers, DOM nodes, and map event handlers out of route data. `createRouteMap` stores these objects by route ID. It supplies tooltip text as DOM text. It mounts only visible routes. When you delete a route, it removes the handlers and popup bindings.

After a label change, call `updateLabels`. After a collection change, call `updateStyles` once for the complete batch. Hover changes the line style without rebuilding endpoint icons.

Keep original coordinates for GPX output. A future renderer or map simplification must not replace export geometry. Canvas is still an experiment that needs representative measurements.

## Storage commits

The `route2gpx_routes` key contains either a legacy route array or a version 2 metadata index. Version 2 entries reference geometry keys. The reader accepts the original `route2gpx_geometry_<id>` keys and revision keys with a numeric suffix.

For each save:

1. Reuse the committed geometry key when its values are unchanged. Array identity provides a fast path; value comparison handles arrays copied during restoration.
2. Write changed geometry under an unused key.
3. Commit the metadata index after all required geometry writes succeed.
4. Delete replaced geometry only after the index commits.

Treat saved geometry arrays as immutable. Replace an array when its data changes. The storage cache uses array identity for its fast path. An in-place edit breaks this contract.

If a write fails, remove new uncommitted keys. Keep the previous index and referenced geometry. This prevents a failed elevation save from pairing new heights with old source metadata. A legacy array remains readable until migration succeeds. If migration cannot fit a second geometry copy, retain the legacy format if its update fits.

The app displays persistent unsaved state independently of transient task messages. Browser storage has finite capacity; exports are the recovery path. This storage format does not provide cross-tab conflict resolution or asynchronous IndexedDB capacity.

## Background work

One elevation client owns the page queue. Cancelling queued work releases its caller without starting a cancelled request. Cancelling active enrichment returns completed batches. The coordinator installs and saves those values if the route still exists. Removed routes cannot receive stale results.

Preserve existing elevations. Add SRTM provenance only when provider or cached samples were added. Retain the mixed-source flag when recorded and provider elevations are combined. A failed lookup must not relabel recorded data as SRTM.

Draw route geometry before optional labels resolve. Apply late labels only while the same route remains present. Update the list, tooltips, and accessible endpoint names together.

Use `setEndpointValue` for programmatic endpoint edits. It dispatches the same input event as a user edit. This updates validation and the saved draft. It also invalidates a pending geolocation result. Reordering twice must not restore permission for an old callback to overwrite the planner.

Keep preview markers suppressed for completed planner points until the inputs change. This also applies to delayed input callbacks.

## Fog memory budget

Fog of World input has two decompression stages: ZIP entries and compressed tiles. The tile budget counts decoded bytes and each retained bitmap copy. Aliased block references still require separate copies. Read block references as little-endian values.

Check the budget before allocating each bitmap. Propagate `DecompressionLimitError` to the caller. Do not report a partial map as a successful import after a limit failure. Ordinary corrupt tiles can be skipped. The byte budget does not include all JavaScript object overhead.

## Verification boundaries

Run `npm run check` and browser tests against a fresh build. Run `npm run test:coverage` to measure unit coverage. CI checks the declared Node release lines and enforces the coverage minimums.

Browser tests use real Leaflet, intercepted provider responses, and generated files. Unit tests cover data integrity, memory limits, worker lifecycle, failed storage commits, cancellation, map cleanup, and text escaping. Coverage includes all root JavaScript files. Child-process build checks and browser tests do not contribute to the unit coverage report.

The automated suite does not establish deployed provider permissions, production response headers, physical-keyboard behavior, screen-reader conformance, or field performance. Track those checks in `TODO.md`.
