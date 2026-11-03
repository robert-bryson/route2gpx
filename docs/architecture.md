# Browser architecture

`app.js` coordinates user actions and state changes. Keep parsing, network requests, storage, and map layers behind their module interfaces. Add a provider abstraction only after you select a second provider.

| Module | Responsibility |
| --- | --- |
| `track-data.js` | Validate aligned coordinates, elevations, and times. Preserve segment breaks and calculate distance within segments. |
| `gps-import.js`, `xml-import.js`, `parsers.js` | Detect formats and parse XML, GeoJSON, and FIT into tracks. Report skipped content. |
| `compression.js`, `import-client.js`, `import-worker.js` | Bound expanded data and move supported large imports to a cancellable worker. |
| `export-data.js` | Validate export tracks. Share cumulative distance and explicit timestamp generation. Never add distance across gaps. |
| `gpx.js`, `route-export.js` | Export GPX, KML, GeoJSON, TCX, and CSV. Register each format's serializer, labels, MIME type, and time options. Create safe filenames and unique GPX archive names. |
| `google-routes.js`, `network.js` | Validate requests, preserve useful errors, enforce timeouts, and support cancellation. |
| `elevation.js` | Share request spacing, sample by distance, retain partial results, and interpolate within segments. |
| `route-storage.js` | Read legacy records and commit geometry and metadata consistently. |
| `route-map.js` | Own route layers by ID, marker labels, visibility, styling, hover, popup placement, and cleanup. |
| `route-list.js` | Own route rows, row focus recovery, delegated row interaction, hover scrolling, and popup presentation. |
| `app-dialogs.js` | Own dialog state, keyboard handling, focus recovery, API-key storage, rename input, and download confirmation. |
| `fog.js` | Parse and render the separate Fog of World overlay. Receive app services through setup. |

`createRouteList` receives formatting and action callbacks. It exposes `render`, `highlight`, and `popup`. The coordinator changes route data and map layers in response to those callbacks. Rows do not retain their own route collection.

`createAppDialogs` receives a route lookup, a rename callback, a download callback, and status reporting. It looks up current route data when an action is confirmed. It owns pending rename and download state. Dismissal restores focus to the invoking control. If a row was replaced or a map popup was closed, it finds the route's current action. If the route was deleted, it uses the planner button. `destroy` dismisses any open dialog and releases its listeners.

API-key writes and removals must report storage failures. A successful write to one store does not establish that the old key was removed from the other store. Keep the dialog open with an inline error if cleanup fails.

Application functions and mutable state are not installed on `globalThis`. Tests import the responsible module and use DOM events for user actions. Leaflet, JSZip, and Pako still use their self-hosted vendor globals. Fog requires an explicit setup context; it does not fall back to application globals.

## Track rules

A track has `coordinates` as latitude/longitude pairs. The optional `elevations` and `times` arrays use the same indices. Use `null` for a missing value. Zero is valid. `segmentStarts` contains the first point index of each segment. It starts with zero. Never calculate distance or interpolate across a segment break.

Normalization removes invalid points and their associated fields together. It starts a new segment after a removed point. Imports report invalid points, short tracks, and unsupported geometry. The import summary retains those warnings after the success message changes.

Each XML or GeoJSON parser owns one raw point budget for the complete file. Invalid points consume the same budget as valid points. GeoJSON passes this budget through every `trackFromSegments` call. XML counts GPX and TCX records on opening their point tags. KML counts tuples when the parser delivers a complete coordinate field. A point-limit failure stops further track extraction.

XML uses the saxes parser without a DOM. It accepts strings or UTF-8 bytes and feeds 64 KiB chunks. Byte input is decoded in chunks without a complete decoded-string copy. Names, elevations, times, and segment breaks retain the same track representation as other imports. KML coordinate lists are scanned without a tuple-array copy. However, saxes buffers each text token before it emits an event. A large coordinate list or scalar field can therefore be read in full before its limit is checked. Chunked input does not bound token memory. gx times remain paired with raw point indices even when an invalid point is skipped or times follow coordinates.

Recognize XML fields by namespace and parent element. A supported document root defines the base namespace. Namespace-free files remain supported. KML `Track`, `MultiTrack`, and `coord` use `http://www.google.com/kml/ext/2.2`, with any prefix. Unknown extension subtrees do not supply tracks, positions, elevations, or times. This is field selection, not full XML schema validation.

XML permits at most 10,000 track containers and 64 open elements. Captured scalar fields have a 65,536 UTF-16-code-unit limit. KML coordinate lists use the file point budget, and gx times have their own file-wide one-million-entry limit. Document types are rejected. Predefined and numeric XML entities remain supported. Malformed XML rejects the complete file rather than returning partial tracks.

These limits do not bound total heap usage. The source bytes, SAX token buffers, normalized tracks, worker result cloning, and map layers still consume memory. Keep file-size limits in place. `scripts/benchmark-xml.cjs` compares peak process RSS with the former DOM parser; constrained-device and browser heap measurements remain separate work.

Use `parseImportBuffer` for parser selection and byte decoding in both worker and main-thread paths. If a worker input transfer throws, release the worker, abort listener, and deadline before rejecting the import.

Validate the calendar date and time fields before converting a timestamp. Convert zoned times to UTC. Preserve digits beyond milliseconds. Preserve an unzoned wall time without assigning the device timezone. Omit invalid timestamps. Replace code points forbidden by XML 1.0 before writing export text.

Keep Leaflet layers, DOM nodes, and map event handlers out of route data. `createRouteMap` stores these objects by route ID. It supplies tooltip text as DOM text. It mounts only visible routes. When you delete a route, it removes the handlers and popup bindings.

After a label change, call `updateLabels`. After a collection change, call `updateStyles` once for the complete batch. Hover changes the line style without rebuilding endpoint icons.

Keep original coordinates for GPX output. A future renderer or map simplification must not replace export geometry. Canvas is still an experiment that needs representative measurements.

KML writes a separate geometry per segment and omits point times. GeoJSON uses LineString or MultiLineString. It adds aligned `properties.coordTimes` when recorded times exist. Import validates those times through the normal track pipeline. Both exporters retain isolated one-point segments as Points. The line-only importer skips those Points. Preserve source height values without a vertical datum conversion.

TCX writes a Course with separate Track elements. It requires a time for every point. Default export must reject incomplete times. Only an explicit user choice can generate replacement times. The UI must display that choice and explain the disabled Download action. Limit the short name to 15 Unicode characters and retain the full name in Notes. TCX import uses Name before descriptive Notes. Convert longitude `180` to its equivalent `-180` to meet the schema.

CSV has fixed numeric and time columns. Do not add untrusted text cells without a spreadsheet formula policy. CSV is export-only. The [format guide](export-formats.md) defines the columns and time rules.

Build popup choices and filename extension handling from the format registry. Dispatch through the registered serializer. Do not make an unknown format fall through to another serializer. Preserve checkbox focus when changing export options; move its label only when its parent must change. File-name editing must not normalize the complete route or clear an export error.

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

Every supported GPS format can finish parsing in the import worker. Use the worker for gzip files and files larger than 256 KiB when it is available. The worker returns parsed tracks, not XML bytes for a second main-thread parse. The main-thread fallback uses the same parsers and limits. Cancellation terminates the worker; completed files in the batch remain installed.

One elevation client owns the page queue. Cancelling queued work releases its caller without starting a cancelled request. Cancelling active enrichment returns completed batches. The coordinator installs and saves those values if the route still exists. Removed routes cannot receive stale results.

Preserve existing elevations. Add SRTM provenance only when provider or cached samples were added. Retain the mixed-source flag when recorded and provider elevations are combined. A failed lookup must not relabel recorded data as SRTM.

Draw route geometry before optional labels resolve. Apply late labels only while the same route remains present. Update the list, tooltips, and accessible endpoint names together.

Use `setEndpointValue` for programmatic endpoint edits. It dispatches the same input event as a user edit. This updates validation and the saved draft. It also invalidates a pending geolocation result. Reordering twice must not restore permission for an old callback to overwrite the planner.

Keep the planner's origin, numbered waypoints, and destination visible after route calculation. Planner pins focus their corresponding input when selected. Clearing the planner cancels its active route calculation and place lookups, removes only its points and pins, and saves the empty draft. Saved routes remain available through Edit / reuse.

### Planner points and place names

Keep exact coordinates in planner inputs and route requests. Store display names with the draft and request. Render names as text. Retain coordinates when lookup fails.

Map and GPS picks request names when a key is available. Typed coordinates require the explicit option and **Get Route**. Apply that option to coordinate waypoints as well as endpoints. Saving a key and reusing a route must not start requests for typed coordinates.

Use one lookup path for every coordinate source. It owns cached names, pending promises, and abort controllers. Use canonical coordinates to deduplicate equivalent input strings. Limit stored names to 500 characters. Route drawing must not wait for names.

On reset, abort and remove every pending lookup. Check lookup identity before applying a response. An old response must not replace a newer lookup for the same coordinates. Names must not reappear in a cleared draft. Apply results only to routes that still exist. Preserve explicit route renames.

Retain each planner marker while its input remains valid. Update its position, icon, and text in place. Release its handlers and tooltip when the input is cleared or removed. Keep pin numbers aligned with input row numbers, including empty rows. Enter and Space must focus the pin's input. Preserve pin focus during label and color changes.

Validate encoded route geometry before adding route data or map layers. Reject invalid characters, overflowing encoded values, out-of-range coordinates, and routes above the shared point limit. Reject the complete route; do not salvage part of a calculated route.

## Fog memory budget

Fog of World input has two decompression stages: ZIP entries and compressed tiles. The tile budget counts decoded bytes and each retained bitmap copy. Aliased block references still require separate copies. Read block references as little-endian values.

Check the budget before allocating each bitmap. Propagate `DecompressionLimitError` to the caller. Do not report a partial map as a successful import after a limit failure. Ordinary corrupt tiles can be skipped. The byte budget does not include all JavaScript object overhead.

## Verification boundaries

Run `npm run check` and browser tests against a fresh build. Run `npm run test:coverage` to measure unit coverage. CI checks the declared Node release lines and enforces the coverage minimums.

Browser tests use real Leaflet, intercepted provider responses, and generated files. Unit tests cover data integrity, memory limits, worker lifecycle, failed storage commits, cancellation, map cleanup, text escaping, route-list focus recovery, dialog behavior, and Fog drawing across all three zoom regimes. A low-zoom Fog block clears an output pixel only if its bitmap contains a visited bit.

Coverage includes all root JavaScript files. Global minimums are 82% statements, 73% branches, 86% functions, and 85% lines. The coordinator, dialogs, route list, Fog, and XML modules also have individual minimums. Child-process build checks and browser tests do not contribute to the unit coverage report.

The build includes notices for bundled XML dependencies under `dist/vendor/`. `licenses/saxes.txt` retains the [upstream saxes 6.0.0 notice](https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE), which is absent from that npm package. The xmlchars notice comes from its installed package.

The automated suite does not establish deployed provider permissions, production response headers, physical-keyboard behavior, screen-reader conformance, or field performance. Track those checks in `TODO.md`.
