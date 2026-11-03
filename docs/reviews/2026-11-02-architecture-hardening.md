# Architecture hardening: November 2, 2026

Historical report. Its measurements apply to that review's working tree. See the [current review](2026-11-02-planner-review.md) for later fixes and test results.

The commit baseline is `f4c77eb`. The review includes the pending refactor and checks the rest of the project for related defects. README.md and the architecture guide define expected behavior. Standards and behavior received separate reviews.

The refactor improves module boundaries and test coverage. Its green test suite did not establish correct XML field selection, dialog focus recovery, or API-key cleanup. New regressions exposed these failures before the fixes below. The original memory claims also exceeded what the parser implements.

## Standards

1. **P2: The XML streaming claim was incorrect.** `xml-import.js` feeds chunks to saxes, but saxes buffers a complete text token before delivery. KML tuples are counted after the coordinate text arrives. A large list is read before the point limit stops extraction. The architecture guide incorrectly claimed that tuples were counted as they arrived. The README and guide now state the actual limits. A parser with supported text streaming and token limits remains in TODO.md. This is a documented memory limitation; it is not a complete memory-safety fix. The [saxes documentation](https://github.com/lddubeau/saxes#notable-differences-from-sax) confirms that event-size limits are unavailable. No private parser state was added to simulate that interface.
2. **P2: Pointer movement within a route row cleared its highlight.** Capture-phase `mouseenter` and `mouseleave` handlers processed events from every descendant. Moving from a title to a button could turn off the map highlight while the pointer remained in the row. The handlers now process the row's own boundary events. A regression covers child-to-child movement, child-to-row movement, and departure to another row.
3. **P2: A failed worker transfer leaked resources.** A synchronous `Worker.postMessage` exception rejected the promise through its executor. It did not release the worker, abort listener, or 60-second timer. The transfer now has an explicit failure cleanup path. A `DataCloneError` regression checks all three resources.
4. **P3: Parser dispatch was duplicated.** Worker and fallback paths each selected a parser and decoded GeoJSON bytes. `parseImportBuffer` now owns both operations. A `Map` also rejects inherited object property names such as `toString` and `__proto__`. This was a maintainability judgment, not a documented coding-rule violation.

Standards result: four findings. The incorrect import-memory claim had the highest operational impact. Code defects are fixed; token buffering remains an explicit parser limitation.

## Spec

1. **P2: XML extensions could change point data.** The parsers used local tag names without sufficient namespace and parent checks. TCX fields inside an extension replaced latitude, longitude, elevation, and time. A foreign GPX `trk` element could also reject an otherwise usable file as a nested track. The parser now checks the document root, namespace, supported parent, and recognized ancestry. Unknown extension subtrees cannot supply track fields. Tests cover GPX, TCX, KML, namespace aliases, and an unrelated root. This selects supported fields; it does not perform full schema validation.
2. **P2: Popup downloads lost keyboard focus.** The coordinator closes a Leaflet popup after its Download button opens the filename dialog. The dialog recorded route context only for list rows. After dismissal, focus remained inside the hidden dialog. It now records route context from either invoking control. It restores the current route action or the planner fallback. Unit tests cover detached controls. A real Leaflet browser journey covers Cancel and Escape.
3. **P2: API-key cleanup reported false success.** `removeStorageItem` swallowed removal errors. Switching storage could leave an old persistent key behind or leave an old session key taking precedence. The Remove action also reported success after failed deletion. Cleanup now returns its result. Failures keep the dialog open, show an inline alert, and give browser-data cleanup instructions. Tests cover failed deletion and both storage transitions. Both stores are attempted during removal, even if the first attempt fails.
4. **P3: The CLI filename example was wrong.** Filename conversion preserves spaces. The README now shows the actual output for the Seattle-to-Portland example. Filename behavior remains consistent with the existing Python tests.

Spec result: four findings. XML field replacement and incorrect API-key cleanup directly affected user data and credentials. All four defects are fixed.

## Coordinator and module interfaces

`app.js` fell from 2,829 to 2,228 lines. Route-list rendering and dialog state now have separate module interfaces.

- `createRouteList` owns row and popup presentation, delegated row events, focus recovery, and hover scrolling. Its interface is `render`, `highlight`, and `popup`. Action callbacks keep route mutation and map changes in the coordinator.
- `createAppDialogs` owns pending rename and download state, keyboard handling, inert content, focus restoration, API-key storage, and dialog event listeners. It receives route lookup and action callbacks. Confirmation reads the current route. `destroy` releases listeners and dismisses the active dialog.
- The coordinator retains planner state, geolocation, route requests, import batches, elevation coordination, and downloads. Further extraction needs a concrete behavior boundary. A 2,228-line coordinator still has substantial maintenance cost.

Application-owned `Object.assign(globalThis, ...)` surfaces were removed from `app.js`, `parsers.js`, `icons.js`, and `fog.js`. The mutable global route and distance-unit accessors were removed. Tests import the responsible module and use module actions or DOM events. The format-detection tests no longer initialize the whole application. Fog setup requires an explicit context. Self-hosted Leaflet, JSZip, and Pako retain their vendor globals.

## Renderer and coordination checks

New behavioral tests cover row focus after reorder, deletion, and disappearing actions; popup escaping; row activation; hover scrolling; elevation action labels; dialog focus traps and restoration; rename and download confirmation; mixed imports; cancellation; undo; reuse; ZIP output; and ZIP failure fallback.

Fog checks exercise low-zoom tile aggregation, block rendering, sub-block rendering, missing tiles, pixel offsets, renderer errors, archive loading, visibility, replacement, removal, and import controls.

One new test exposed a defect: at low zoom, an empty bitmap block cleared an output pixel even though it contained no visited bits. The renderer now checks that the block contains a visited bit before clearing that pixel. The regression failed before this fix.

## XML memory use

The previous point budget applied only after `DOMParser` had allocated the document tree. The replacement uses saxes to parse GPX, KML, and TCX without a DOM. It decodes byte input in 64 KiB chunks and normalizes point records into track arrays. Names, segment breaks, elevations, recorded times, and skipped-point diagnostics remain aligned. Complete text tokens can still be buffered before extraction.

Large XML files and gzip XML files now finish parsing inside the cancellable import worker. They no longer return expanded XML bytes for a second main-thread parse. The fallback uses the same parsers when workers are unavailable.

The file-wide raw point budget remains one million, including invalid coordinates. Extra XML limits cover nesting, scalar fields, empty track containers, and gx time lists. Document types and custom entities are rejected. KML time pairing supports times before or after coordinates. Malformed XML rejects the file without installing partial tracks.

Tests check imports without a DOM, UTF-8 and XML chunk boundaries, namespaces, CDATA, entities, metadata fallback, malformed input, and shared budgets. A small test budget proves that the parser stops before processing a later malformed XML tail. It does not prove early rejection inside a single buffered coordinate token. The browser regression imports small GPX, large KML, and compressed TCX with `window.DOMParser` disabled.

### Desktop measurement

Run:

```bash
node scripts/benchmark-xml.cjs 50000
node scripts/benchmark-xml.cjs 100000
```

The script bundles the old parser from `f4c77eb` and the current parser, then runs them in separate Node processes. Both samples include the same jsdom startup cost. Each generated GPX point has coordinates, elevation, and a recorded time. The script checks output point and time counts. Peak memory is process RSS, not a JavaScript heap measurement.

| Points | DOM peak RSS | Incremental peak RSS | DOM parse time | Incremental parse time |
| --- | --- | --- | --- | --- |
| 50,000 | 444 MiB | 182 MiB | 620 ms | 110 ms |
| 100,000 | 702 MiB | 201 MiB | 1,862 ms | 213 ms |

These single-run measurements used Node 26.12.0 on macOS. At 100,000 points, peak RSS fell about 71%. They do not establish mobile-device limits, worker cloning costs, map-layer memory use, or browser storage capacity. This GPX fixture also does not measure KML token buffering. Source bytes, SAX token buffers, and retained track arrays still consume memory. File-size and point limits remain necessary.

## Verification

The first column below is the incoming working tree, measured before this review. The final column includes the new regression fixes. This separates the pending refactor's gains from this review's gains.

| Measure | Review start | Final |
| --- | --- | --- |
| Unit tests | 302 | 317 |
| Browser tests | 17 | 18 |
| Overall line coverage | 83.32% | 83.50% |
| Overall statement coverage | 80.01% | 80.29% |
| Overall branch coverage | 71.31% | 71.82% |
| Overall function coverage | 83.99% | 84.12% |
| Coordinator line coverage | 75.56% | 75.52% |
| Fog line coverage | 98.85% | 98.85% |

The route-list module has 100% line coverage; dialogs have 95.30%; XML parsing has 100%. The file set includes all 20 root JavaScript files, including build and preview entry files. Child-process and browser execution do not contribute to these unit coverage values. Extracted files have not been excluded. The coordinator's small percentage decrease follows removal of the shared parser dispatch. Global minimums are now 80% statements, 71% branches, 84% functions, and 83% lines. Per-module minimums also protect the extracted interfaces.

Validation includes `npm run check`, `npm run test:coverage`, and browser tests against the fresh build with installed Chrome. Build fixtures discover root JavaScript inputs so a new module is not silently omitted. The runtime dependency and lockfile explicitly include saxes, and the build packages the XML dependency notices.

All 39 Python tests pass with 99% statement coverage. Black and isort pass. Terraform formatting and validation pass. The installed provider needed to run outside the sandbox. `npm audit` reports zero advisories across production and development dependencies. JavaScript checks used Node 26.12.0; Python checks used the existing Python 3.15 environment. The Node 22/24 matrix and Python 3.13 CI environment were not run locally.

README instructions now match the key controls, CLI filename behavior, and parser limits. TODO.md lists unfinished work only. Earlier reports are marked as historical and link to this review. The documentation uses short instructions and explicit limits; it is not a claim of formal ASD-STE100 conformance.

No deployment or authenticated provider call is part of this change. Production headers, provider permissions, screen readers, physical devices, and constrained-device performance remain in [TODO.md](../../TODO.md).
