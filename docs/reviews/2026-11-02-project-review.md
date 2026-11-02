# Project review — November 2, 2026

This is a historical report. Source line numbers and baseline measurements below refer to the earlier implementation. Read the [current review](2026-11-02-architecture-hardening.md) for current fixes and verification. Use [README.md](../../README.md) for current instructions.

Reviewed commit `25009f9` across the browser app, Python CLI, tests, build, CI, and Terraform. The best improvements are preserving imported data accurately, making failures recoverable, and improving the planner on small screens. The existing static architecture and small bundle are useful foundations.

**Implementation follow-up:** The working-tree review used commit `25009f9` as its fixed point. The implementation addresses the data/export, persistence-feedback, duplicate-submission, viewport, focus, provider-error, and request-validation defects below. It adds bounded worker imports, shared elevation scheduling, versioned geometry storage, locally served runtime assets, browser CI, and shared deployment headers. See [current usage](../../README.md), [module responsibilities](../architecture.md), and [remaining work](../../TODO.md). Provider agreement fit and retention by data source remain open decisions.

## Follow-up findings and fixes

The standards and specification reviews found further defects in the pending implementation. These were behavioral defects; the review did not identify a separate breach of documented coding rules. The main design concern was duplicated layer management in the coordinator.

| Priority | Finding | Implemented change and regression |
| --- | --- | --- |
| P1 | A failed metadata-index write could overwrite previously committed geometry. Reload then combined new elevations with old provenance. | Write changed geometry under a new key. Commit the index before deleting old geometry. Failure tests verify geometry and provenance together. |
| P1 | Compressed FIT records could reject valid files when the local definition included timestamp field 253. | Exclude the timestamp payload from compressed record size and offsets. Test both reused definitions and separate definitions across timestamp rollover. |
| P2 | Route data still contained Leaflet objects, handlers, and duplicated lifecycle code. | Extract `route-map.js`. Keep layers in an ID lookup. Test visibility, segment preservation, removal, undo, popup placement, label escaping, and bounded icon updates. |
| P2 | Optional label results did not update endpoint tooltips. Endpoint controls lacked useful names. | Update visible and accessible map labels with route data. Render labels as text. Test delayed labels with real Leaflet. |
| P2 | Preview markers could cover completed route endpoints, including after a delayed input callback. | Suppress previews for completed planner points until the point inputs change. Browser tests hover the actual route endpoint. |
| P2 | Disabling enrichment left a new route marked “adding elevation.” | Let enrichment own the loading transition. Verify the disabled state in the complete routing journey. |
| P2 | Pausing elevation discarded completed batches. Queued cancellation waited for another route's response. | Return and persist partial results on cancellation. Cancel queued callers promptly. Test spacing, pause/retry, and restoration after reload. |
| P2 | Failed provider requests could attribute recorded elevations to SRTM. | Track added provider samples. Preserve recorded data and mixed provenance. |
| P2 | The first metadata update after reload rewrote unchanged geometry. | Compare restored geometry values before writing. Reuse references for later saves. Test a rename after reload with copied arrays. |
| P2 | Successful imports concealed invalid points, short tracks, and unsupported geometry. | Carry diagnostic counts from parsers into the persistent import summary. Test partial GPX and mixed GeoJSON content. |
| P2 | ZIP export omitted the single-route coverage disclosure. | Show a persistent per-route ZIP data summary. Use a stable data snapshot while generating the archive. |

Verification: 189 JavaScript unit tests passed, compared with 175 at the start of this implementation pass. The 14 browser tests cover imports, downloads, failed storage, cancellation, focus, small viewports, delayed labels, and elevation restoration. Python has 38 passing tests and 99% statement coverage, compared with 32 tests and 95% at the start of this pass. Black, isort, JavaScript lint, build, Terraform formatting, and Terraform validation passed. The Terraform lock gained the verified local-platform checksum; its provider version did not change. The npm audit reported zero vulnerabilities in the updated lockfile. Python ran on 3.15 locally; CI specifies 3.13. Browser checks use installed Chrome and synthetic provider responses. No authenticated provider request or deployment was performed.

The coordinator and legacy compatibility globals still need further extraction. Canvas, IndexedDB, physical mobile keyboards, screen readers, and production headers require the separate measurements or checks listed in `TODO.md`. The sections below retain the original review evidence; their source line numbers refer to the original commit.

The original review combined source inspection, primary-source research, Chrome reproductions against the generated `dist/` build, synthetic performance measurements, and public deployment-header checks. That review did not change application code. Priorities below mean: **P0: resolve a product/architecture decision before expanding the integration; P1: fix user-visible data loss or broken flows; P2: improve reliability, usability, and maintenance; P3: validate or consider later.** Effort is relative, not a delivery estimate.

## Evidence and limits

| Check | Result |
| --- | --- |
| `npm test` | 152 tests passed across four files. |
| `npm run build` | Passed; application JS 68,390 bytes / 22,290 gzip bytes; CSS 22,757 / 5,326; HTML 18,715 / 4,886. These exclude CDN libraries and map tiles. Gzip figures are local compression measurements, not confirmed transfer sizes. |
| Normal Python test invocation | 27 passed, one failed: the missing-key test loads the repository `.env` despite deleting the environment variable. Network calls in that test remained mocked. |
| Python with `PYTHON_DOTENV_DISABLED=1` | All 28 tests passed, with 99% statement coverage of `route2gpx.py`. Interpreter was Python 3.15; CI specifies 3.13. |
| Black and isort | Passed. |
| `terraform fmt -check infra` | Passed. Provider initialization, Terraform validation, and deployment were not performed. |
| `npm audit` | Five affected development packages: three high and two moderate. `npm audit --omit=dev` reported zero. This does not scan the separately loaded CDN scripts. |
| Chrome | Real Leaflet and CDN script startup succeeded; desktop 1440×1000, mobile 390×844 and 320×568, landscape 667×375, tablet 768×1024 inspected. No uncaught page exceptions in the synthetic journeys. |
| Production | Public HEAD and GET returned 200. Both lacked a CSP response header, although HTML contains a CSP meta policy and Terraform declares a response header. Other configured security headers were present. |

Chrome used an isolated browser context, synthetic files and keys, intercepted Google responses, and mocked elevation requests for request-behavior checks. No authenticated Google requests or real elevation lookups were needed. Local builds intentionally had no CARTO key, so their tile watermark is an expected local-preview limitation, not evidence of a deployed basemap defect. Browser measurements are desktop lab observations, not field Core Web Vitals or a screen-reader conformance assessment.

The original session used temporary browser artifacts. Those paths are not part of the repository. The sections below record the durable reproduction steps and expected behavior.

## Decisions and fixes with the highest return

| Priority | Opportunity | Evidence | Effort |
| --- | --- | --- | --- |
| P0 | Establish routing-provider fit for the map, persistence, and export model | Current published provider terms plus source | Decision, then potentially large |
| P1 | Preserve missing elevations and coordinate/elevation pairing | Reproduced | Small–medium |
| P1 | Preserve tracks, segments, and multiple imported geometries | Reproduced for GPX/KML; source for GeoJSON/TCX | Medium–large |
| P1 | Make ZIP filenames unique | Reproduced: two routes became one archive entry | Small |
| P1 | Keep storage failure visible after successful parsing | Reproduced | Small |
| P1 | Prevent duplicate submissions and define cancellation | Reproduced | Small–medium |
| P1 | Fit dialogs and map controls into short viewports | Measured and visually inspected | Small–medium |
| P2 | Preserve useful API errors and validate mode/stop constraints | Reproduced errors; documented request contract | Small |
| P2 | Share the elevation queue, expose partial results, and cap work | Reproduced concurrency; source and provider limits | Medium |
| P2 | Bound decompression before allocating its entire result | Source | Medium |
| P2 | Preserve keyboard focus through list updates | Reproduced | Small–medium |
| P2 | Test complete browser journeys and isolate Python environment loading | Passing unit suite missed the reproduced failures | Medium |
| P2 | Extract data, export, and request modules from the coordinator | Source and test setup | Medium, incremental |

### Provider fit comes before a routing fallback

The app displays Google Routes geometry on a CARTO/OpenStreetMap Leaflet map (`app.js:127`, `135`, `1634`) and persists it without expiry (`app.js:170`). The current standard **non-EEA** terms restrict Routes content on non-Google maps and limit coordinate caching to 30 days. Confirm the applicable agreement and billing region, and separately establish GPX-export permissions. This is an architecture constraint; attribution alone does not resolve it. User-imported tracks need their own retention policy. [Google service-specific terms, §19](https://cloud.google.com/maps-platform/terms/maps-service-terms)

Choose deliberately between a Google path aligned with its applicable terms and a provider compatible with the intended map, storage, and export behavior. Add geometry provenance and creation/expiry metadata so these decisions can be implemented per source.

The TODO's OSRM fallback deserves a capability and operating-cost comparison before implementation. OSRM ships car, bicycle, and foot profiles; the profile is involved in data preparation. Valhalla documents driving, cycling, walking, and transit combinations. Those capabilities alone do not establish a hosted endpoint's terms, transit-data coverage, capacity, or availability. Compare representative routes and the intended hosting arrangement before choosing. [OSRM profiles](https://project-osrm.org/docs/v26.4.0/profiles), [Valhalla services](https://valhalla.github.io/valhalla/api/)

### Imported data can change silently

**Unknown elevations become sea level.** `normalizeElevations()` calls `Number(value)` (`app.js:432`), converting `null` and empty strings to zero. Importing a GeoJSON line with elevations `[123, missing]` produced `[123, 0]`. Restoring `[123, null]` also produced `[123, 0]`. An elevation-free GPX passes through an array of nulls and can consequently be labeled elevation-ready.

Normalize absence before numeric conversion. Validate latitude, longitude, elevation, and optional time as one point record. If a point is removed, remove its associated fields together: restoring coordinates `[[1,1], [999,999], [3,3]]` and elevations `[100,200,300]` currently yields coordinates `[[1,1],[3,3]]` and elevations `[100,200]`, assigning the discarded point's elevation to the last point (`app.js:456`, `468`). Add round-trip assertions for nulls, legitimate zero elevations, invalid middle points, and partial datasets.

**Missing GPX coordinates become valid zero coordinates.** `Number(pt.getAttribute('lat'))` and its longitude equivalent accept absent attributes as zero (`app.js:2303`). A `<trkpt/>` followed by a valid point imported as a route starting at `[0,0]`. Empty numeric text has similar coercion issues in XML parsers. Require nonempty numeric source values before range validation, while accepting explicitly provided zero.

**Segments are flattened and some geometries are discarded.** `importGPX()` selects every `trkpt` in the document (`app.js:2288`) and exports one segment. A fixture with two short segments near Seattle and New York became a 3,889,260 m route, including an artificial connection. `parseTCX()` likewise collects trackpoints globally. `parseGeoJSON()` recursively flattens coordinates without dispatching on geometry type (`parsers.js:236`); separate lines, polygon rings, and point collections can become one continuous route, while GeometryCollections are skipped. `importKML()` reads only the first `<coordinates>` element (`app.js:2330`): a two-Placemark file retained only the first line.

Represent tracks with segments, calculate distance within segments, and preserve multiple imported tracks or offer an explicit selection step. Dispatch GeoJSON by its declared geometry type and reject unsupported route geometries clearly. GPX explicitly represents discontinuities using separate track segments; GeoJSON distinguishes LineString, MultiLineString, Polygon, and GeometryCollection. [GPX schema](https://www.topografix.com/GPX/1/1/), [GeoJSON specification](https://www.rfc-editor.org/rfc/rfc7946)

**Single-point imports disappear after refresh.** `addImportedRoute()` accepts one point (`app.js:2359`), but restored routes require at least two (`app.js:457`). Chrome confirmed import success followed by restore rejection. Either support a separate point/waypoint object or reject insufficient track geometry consistently before reporting success.

### Export should preserve information and disclose synthesis

**ZIP collisions lose routes.** `downloadAllRoutes()` uses only sanitized mode and name as the archive path (`app.js:2036`). Two routes named “Same route” in WALK mode produced one `walk_Same route.gpx` entry. Auto-generated route names are truncated, making collisions plausible even for different endpoints. JSZip updates an existing entry with the same name. Allocate unique filenames across the entire export, including collisions introduced by sanitization or truncation, and verify archive entry count equals route count. [JSZip file behavior](https://stuk.github.io/jszip/documentation/api_jszip/file_data.html)

**Export always invents point times and fills absent elevation with zero** (`app.js:1939`; CLI `route2gpx.py:103`). Imported original times are not retained by the current route model. Synthesized tracks may be an intended use of this project, so expose that choice: preserve imported values when present, offer geometry-only output, and make synthesized timestamps an explicit option. Interpolate requested synthetic times by distance if appropriate, rather than by point index, since polyline vertices are unevenly spaced. Omit unknown elevation instead of asserting sea level. GPX permits both elevation and point timestamps to be absent. [GPX waypoint type](https://www.topografix.com/GPX/1/1/)

Show export state for “elevation still loading,” “partial elevation,” and “no elevation.” Currently the user can download before enrichment completes, then receive a materially different file later without a clear export choice. Keep full-resolution geometry available for device export when experimenting with map rendering.

### Successful imports can conceal failed persistence

`saveToStorage()` catches quota failures and calls `showStatus(error)`, but returns no result (`app.js:170`). `addImportedRoute()` immediately calls `showStatus(success)` (`app.js:2408`). Chrome reproduced the final message `Imported: quota (2 points, 157 km)` with the success class while the route write had failed. Route calculation has the same save-then-success sequence (`app.js:1677`).

Return a persistence result and expose saved/unsaved state independently of transient task messages. Keep a persistent recovery action such as Export unsaved routes. Test the entire import and route-add flow with quota failure; the existing test only calls `saveToStorage()` in isolation (`tests/app.test.js:777`).

### Submission state must cover every entry point

Disabling the Get Route button does not guard `getRoute()` itself (`app.js:1532`). Keyboard handlers still invoke it. Two Enter presses during a delayed mocked response produced two requests and two routes. Overlapping completions can also re-enable the button while another request remains active.

Use one in-flight state checked by click, field Enter, and global shortcuts. Define whether edits cancel an old calculation or the request uses an immutable snapshot. Expose Cancel for genuinely long operations and ignore stale completions. A regression should hold the response open, trigger every submit path, and assert the intended request count and busy state.

## UI and UX opportunities

### Repair small-screen layout before visual polish

The fixed-height shell and 52% sidebar / 48% map split (`styles.css:1676`) create separate scrolling regions while keeping key controls below the visible planner on short screens.

| Viewport | Observed layout |
| --- | --- |
| 390×844 | Origin input about 164 px wide. Main action fits just inside the initially visible planner. |
| 320×568 | Origin input only 94 px wide. Get Route is below the sidebar's initial visible area. API-key dialog spans y≈−19 to 587. |
| 667×375 | API-key dialog spans y≈−49 to 424. Map is 180 px high, but its control column is 260 px high, extending to y=465 and clipping lower controls. |

Make dialogs scroll within the available viewport, including short and keyboard-reduced heights; top content and actions must remain reachable. Adapt map controls to available height, perhaps using a compact toolbar or overflow menu. Use a resizable/collapsible planner or Planner/Map switch on mobile. Keep the primary planner action reachable during editing. Validate actual iOS/Android keyboard behavior separately; the Chrome viewport checks do not establish it.

The current endpoint row spends much of its width on three adjacent icon buttons. Move secondary actions into a clearly labeled options control or a second row, and let the location text use the available width. Render the route order as **Origin → waypoints → Destination**, matching the actual request order; waypoints currently appear below the destination. Preserve the existing accessible up/down controls for reordering.

### Make the two main entry paths obvious

The first visit immediately opens an API-key modal (`app.js:978`), although importing, inspecting, and exporting files do not require that key. Offer visible **Plan a route** and **Import GPS file** entry actions, and request the key when the user first calculates a route. Give import a text label in the empty state rather than relying on a top-right icon. Treat Fog of World as a secondary overlay capability.

Keep mode names visible where space allows, expose key configuration near route calculation, and use persistent inline guidance for setup problems. “100% Private & Secure” and the help text claiming data goes only to Google (`index.html:69`, `371`) overstate the implementation: elevation coordinates are sent through the hosting rewrite to Open Topo Data, and basemap requests go to CARTO. Describe actual data flows in plain language, consistent with the more accurate README. Explain billing setup factually instead of relying on “generous free usage.”

### Preserve useful errors and prevent unsupported requests

Every 401/403 currently deletes the saved key and replaces Google's explanation with “Invalid API key” (`app.js:1607`). A mocked 403 explaining missing billing reproduced this behavior. Preserve the key and surface a sanitized provider message with targeted guidance for billing, API enablement, restrictions, and quota. Display errors within the active key dialog when applicable: the generic status region is inside the inert background while that dialog is open.

Reject unsupported combinations before a request: Routes permits at most 25 intermediate stops, and transit permits none. Keep entered stops when switching modes, explain incompatibility, and prevent submission until resolved. Above ten intermediate stops, explain that the billing tier may change rather than hard-coding a price. A transit departure/arrival-time control is a useful subsequent feature. [Compute Routes contract](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes), [Transit routing](https://developers.google.com/maps/documentation/routes/transit-route), [Usage and billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)

Google's current browser restriction guidance is nuanced: it allows website restrictions for recent HTTPS services, while its web-service guidance identifies limitations for other endpoints. Validate the actual deployed origin and optional legacy Geocoding JSON endpoint with correctly restricted test credentials before claiming that all direct REST calls work or fail. This review did not perform authenticated compatibility checks. [Security guidance](https://developers.google.com/maps/api-security-best-practices), [Maps FAQ](https://developers.google.com/maps/faq)

### Help users revise and recover work

Add **Load into planner**, rename, and Undo deletion before investing in route drag editing. Preserve the original route request separately from display labels, so reopening a route uses its actual input rather than reverse-geocoded prose. Save planner drafts separately from completed routes and restore the saved viewport or fit restored routes. Currently restored routes return to the default US map view until selected.

For multiple-file imports, show a persistent summary of successes, skipped points, unsupported geometries, and failures. `handleImportFiles()` currently overwrites intermediate errors and can finish with a generic success count (`app.js:2202`). A structured summary makes partial outcomes reviewable.

### Continue accessibility work through complete journeys

The named dialogs, inert background, focus trap, Escape handling, travel-mode radio keyboard controls, import browse alternative, and waypoint move buttons are useful existing work. Preserve them. [W3C dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

`renderRoutesList()` replaces its entire HTML on visibility changes, unit changes, and elevation completion (`app.js:1742`). Chrome confirmed that activating Hide with Space leaves focus on `BODY`. Update the affected route row in place or restore focus by stable route/action identity; when deleting, move to the next sensible route or empty-state action. Test focus while background elevation completes as well as after explicit user actions.

Align the color popup's semantics: the trigger advertises a dialog, but its controlled element has no dialog role (`index.html:252`). Complete the distance-unit radio keyboard behavior, and verify Leaflet marker names in the accessibility tree. Audit a single-pointer alternative for map panning; W3C specifically identifies directional controls as an alternative to dragging a map. [Dragging guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)

Test VoiceOver or NVDA through create/import/reorder/hide/download/delete and dialogs before retaining the README's broad screen-reader-support claim. Live regions should announce meaningful waiting, failure, and progress states; a static role alone does not establish usable announcements. [Status-message guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)

## Performance: optimize the work users trigger

### Measured results

Three desktop runs of the synthetic GPX serialization workload were approximately 7–8 ms for 10,000 points and 59–69 ms for 100,000 points. The 100,000-point output was 13,000,602 bytes. A later end-to-end 100,000-point GeoJSON import took about 91 ms; opening its popup, including a map-fit call in the measured sequence, took about 96 ms. The point pattern was deliberately simple; complex geometry, large XML documents, slower devices, memory pressure, and cold starts were not benchmarked.

These observations justify removing avoidable large synchronous work. They do not establish a field INP failure. Work over 50 ms is considered a long task; Core Web Vitals need appropriate mobile/desktop field or controlled lab measurement. [Long tasks](https://web.dev/articles/optimize-long-tasks), [Web Vitals](https://web.dev/articles/vitals)

1. **Stop serializing a complete GPX just to open a popup.** `createRoutePopup()` generates the file and allocates a Blob to display its size (`app.js:257`). Cache size by export revision/options, show an estimate, or calculate it when exporting. Generated timestamps mean the cache also needs a deliberate time policy.
2. **Avoid rewriting every route's geometry for metadata changes.** Hide/show, distance-unit changes, and enrichment all call `saveToStorage()`, serializing the whole route collection. Keep lightweight preferences separate; persist immutable geometry per route and update only changed metadata. Evaluate IndexedDB when the real workload needs larger asynchronous storage, with versioned migrations and explicit failure handling. IndexedDB operations are asynchronous. [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
3. **Batch restoration and multi-file rendering.** Every restored route updates all map styles and rerenders the whole list (`app.js:487`), making those repeated collection operations quadratic in route count. Restore validated data/layers, then render and update styles once. Avoid recreating endpoint icons for all routes on every hover/unhover (`app.js:549`).
4. **Render route geometry before optional labels resolve.** `getRoute()` waits for both reverse-geocoding requests before adding the route (`app.js:1630`), potentially adding up to the eight-second label timeout after routing succeeds. Show coordinate labels immediately, then update labels asynchronously with stale-result protection.
5. **Profile parsers and decompression on a worker.** Suitable binary/JSON/decompression work can leave the main thread; DOM-based XML parsing needs a worker-compatible parser or a different approach. A worker cannot directly manipulate the page DOM. Add progress and cancellation, and measure before moving all work. [Workers](https://web.dev/articles/off-main-thread)
6. **Compare SVG and Canvas on representative maps.** Leaflet already performs clipping and simplification, and SVG is its default renderer. Benchmark a shared Canvas renderer and map-only smoothing for dense tracks while preserving original export coordinates and testing hit detection. Canvas is an experiment here, not a measured universal improvement. [Leaflet 1.9.4 reference](https://leafletjs.com/reference-1.9.4.html#map-prefercanvas)

### Elevation needs a shared budget and explicit partial state

Each `fetchElevations()` loop spaces its own requests by 1.1 seconds, but separate routes start independent loops (`app.js:2076`). Two concurrent one-point jobs started requests in the same measured millisecond. The public service documents 100 locations per request, one request per second, and 1,000 per day. A page-wide queue would fix cross-route spacing within one page; aggregate traffic through Amplify needs a separate capacity decision. The public documentation does not establish how the quota identity is counted. [Open Topo Data](https://www.opentopodata.org/#public-api)

A hypothetical 10,000-point route requires 100 batches and at least 108.9 seconds of programmed waiting, plus network time. A 100,000-point route consumes 1,000 batches. Use a distance-based sampling budget appropriate to the selected elevation dataset and export needs, retain provenance for interpolated values, cache repeated queries, and cancel work for deleted routes.

The chosen SRTM dataset covers roughly 60°S–60°N and can return no data. Show partial coverage and offer retry of missing batches. `enrichRouteElevations()` currently considers any non-null elevation ready and refuses later enrichment if any value already exists (`app.js:2115`), concealing partial failures. A broader-coverage fallback needs documented resolution/datum behavior. [Dataset availability](https://www.opentopodata.org/), [Query API](https://www.opentopodata.org/api/)

## Code quality and maintainability

`app.js` has 2,945 lines and combines state, storage, network requests, import parsing, GPX output, map rendering, and dialog behavior. Routes mix data with Leaflet objects and hover functions. Tests create a large substitute DOM and Leaflet mock before they can exercise helpers. `fog.js` relies on implicit global functions and `map` despite being an ES module (`fog.js:391`); `exposeAppCompatGlobals()` republishes a broad mutable surface (`app.js:2805`).

Extract deep modules around the places where one implementation can hide substantial behavior behind a small interface:

| Proposed module | Small interface and responsibility |
| --- | --- |
| Track data/import | Parse and validate input into tracks containing segments and point records; return diagnostics and preserve paired fields. No Leaflet objects. |
| GPX/export | Serialize validated tracks with explicit elevation/time options; allocate unique filenames; keep output behavior testable without a map. |
| Google routing | Validate request capabilities, construct the request, classify errors, and normalize results; accept a cancellation signal. Introduce a provider adapter only when a second implementation is actually selected. |
| Elevation | Own queueing, sampling, progress, partial results, retries, and cancellation behind one enrichment operation. |
| Persistence | Own versioned records, migration, per-route writes, saved/unsaved results, and source-specific retention. |
| Map view | Own route-ID-to-layer lookup and map interactions; add/update/remove data without mutating the data model. |

Keep the coordinator focused on user actions and state transitions. Extract export and point validation first because they address reproduced defects and remove the most cumbersome test setup. Inject dependencies at seams that actually vary, such as network and storage. Retire compatibility globals as their callers move, rather than maintaining both interfaces indefinitely.

Add JSDoc types and a practical static check, or adopt TypeScript incrementally in extracted pure modules. In particular, distinguish imported tracks from computed routes and optional fields from zero-valued fields. Keep schema migrations testable. Align ESM configuration (`vitest.config.js` currently emits a CommonJS/ESM configuration warning), add JavaScript linting/formatting, and align pre-commit's Black/isort revisions with the locked development versions.

The Python CLI is compact and mostly separable already. Isolate `load_dotenv()` in tests so local credentials cannot change missing-key cases; disable dotenv for that test or mock its loader. Wrap malformed-polyline decoding and filesystem failures in useful CLI errors, since `main()` currently catches only `Route2GpxError` (`route2gpx.py:150`). Consider explicit output/overwrite options and the same export-time policy as the web app when extending CLI features.

## Import resilience and dependency management

The gzip limit is checked **after** `pako.inflate()` creates the entire output (`app.js:2241`), so it cannot cap peak expansion memory. Fog ZIP accounting limits extracted ZIP-entry bytes (`fog.js:145`), but each entry is inflated again inside `FowTile.create()` without a corresponding inner-output budget (`fog.js:67`). A small compressed input can therefore require far more memory than the advertised decompressed limit suggests. This is a source-level reliability finding; no destructive memory-exhaustion fixture was run.

Use incremental inflation with an output-byte counter and abort before retaining more than the budget; account for both compression layers and total work. Validate tile header/block references and cap point/entry counts as well as file bytes. Pako 2.1.0 supports chunk callbacks that can replace its default collect-all behavior. [Pinned Pako implementation](https://github.com/nodeca/pako/blob/2.1.0/lib/inflate.js)

All five npm audit findings concern development tools: locked Vitest/mocker 4.1.11, Vite 8.2.2, source-map-js 1.2.1, and Undici 8.10.2. The audit reported fixes available. Update to patched compatible versions and rerun checks; investigate each advisory's actual preconditions rather than equating its severity with deployed browser exposure. For example, the Vitest advisory concerns manual mock registration and the cited Undici advisory concerns EventSource parsing. [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8), [Undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-4qv8-2p9j-2685)

Leaflet, JSZip, and Pako are loaded from pinned CDN URLs with integrity hashes, which is useful protection. However, they are outside the npm dependency graph and its update checks. Consider bundling/self-hosting these pinned dependencies, keeping ZIP/inflate lazy-loaded, so deployment tests and dependency tools cover the actual runtime graph. Also clear rejected entries from `loadingScripts` and add a load timeout: a transient CDN failure is currently cached for the lifetime of the page (`app.js:215`). Surface startup/tile failures with a usable retry path.

## Build, deployment, and verification

Production GET and HEAD responses lacked the CSP response header declared in `infra/main.tf:23`. The HTML meta policy remains present; this is configuration drift to investigate, not evidence that all CSP protection is absent. Chrome also confirms that `frame-ancestors` is ignored in a meta policy. Production still sent `X-Frame-Options: DENY`. Add a deployment check for the intended headers and generate/check the duplicated CSP from one source.

`Cache-Control` on deployed HTML is `public, max-age=3600`; Terraform makes JS immutable for one year but leaves hashed CSS on the general one-hour policy. Make fingerprinted JS and CSS immutable and make HTML revalidate so it discovers new hashes promptly. Check actual deployed asset responses after changing patterns. [HTTP caching guidance](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)

The Route 53 check verifies root HTTP availability, which cannot detect broken map startup, failed imports, or unusable exports. Add a synthetic browser smoke journey with a tiny local track and a real generated download; it can run without Google credentials. Amplify's own build runs `npm ci` and `npm run build` but no tests (`amplify.yml`); confirm deployment is gated on successful required checks or add appropriate verification to that pipeline.

Add `npm run dev` or `npm run preview` so development does not require remembering to rebuild before every static preview. Keep the documented local elevation-proxy distinction clear. `build.js` uses a global whitespace regex while its comment claims to preserve whitespace-sensitive HTML; replace it with a suitable HTML minifier if those elements are added. This is a future maintenance concern, not a reproduced current page failure.

### Regression suite worth adding

Prioritize behavior tests crossing real user-facing interfaces:

- Import fixtures with absent/empty/zero coordinates, missing elevations, an invalid middle point, multiple segments/tracks, and multiple KML Placemarks; assert saved and exported data remains aligned.
- Parse generated GPX and assert segment count, point count, optional fields, and preserved timestamps according to the chosen policy.
- Export two identically named routes and sanitization-collision names; inspect the ZIP and compare entries to input route IDs.
- Complete import and route creation while storage writes fail; assert a persistent unsaved indicator survives success messages.
- Hold a route response open and submit through keyboard/click paths; verify request count, cancellation, and stale results.
- Mock 403/429/malformed JSON/timeouts; preserve keys and useful diagnostics. Validate transit with stops and the 25-stop limit before fetch.
- Run browser smoke tests against built `dist/`, actual Leaflet, CDN/SRI/CSP behavior, import controls, file downloads, modal focus, and focus after list updates.
- Cover 320×568 and 667×375, with added waypoint rows and open dialogs; test actual mobile keyboards and VoiceOver separately.
- Use a fake clock for cross-route elevation spacing, cancellation, and partial retries; keep routine CI free of real provider quota usage.
- Isolate Python environment/dotenv behavior. Current high statement coverage did not make the normal local invocation deterministic.

Keep a small separate network smoke check for third-party assets and deployed headers. Pin runtime assets in deterministic browser tests so a CDN outage does not make every unit test flaky.

## Suggested sequence

1. **Resolve provider fit while fixing independent data defects.** Decide the map/storage/export contract. Fix elevation nulls and paired validation, ZIP naming, persistence feedback, duplicate submission, and short-viewport clipping. Add the corresponding complete-flow regressions.
2. **Improve the main user journey.** Offer import before key setup; let location inputs use the available width; order stops between endpoints; add inline actionable errors, mode constraints, focus preservation, rename/reuse, and Undo.
3. **Make background work bounded and visible.** Share elevation scheduling, expose partial progress/cancellation, bound both compression layers, avoid popup-time GPX construction, and batch restoration.
4. **Extract modules as behavior is secured.** Separate validated track data, export, persistence, routing, and map layers. Add types/linting, browser CI, patched tooling, and deployment-header checks. Evaluate IndexedDB and Canvas against recorded workloads.
5. **Revisit feature expansion.** Provider-compatible autocomplete, route sharing, drag editing, elevation profiles, and offline local-file workflows can follow. Sharing needs explicit payload-size/privacy choices; offline support needs a caching decision for runtime assets and tiles. Establish those use cases before adding accounts, cloud sync, or broader infrastructure.

The first implementation slice should pair the data/export fixes with their complete-flow regressions. It is small enough to review, protects the app's main output, and creates cleaner interfaces for the later UI and performance work.
