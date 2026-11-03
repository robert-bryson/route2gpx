# Export review and validation

## Scope

Reviewed the working tree against `a81e9a8`. The scope includes the download popup, GPX/KML/GeoJSON exports, new TCX/CSV exports, shared time preparation, related import behavior, tests, and documentation. The user requests supply the behavior specification. README.md and docs/architecture.md supply the project rules.

Two independent reviews examined standards and behavior. The final review found no remaining blocker in this scope. This is a review of the changed paths and their dependencies, not a complete security audit of every project feature.

## Standards

No hard violation of a documented project rule remained. Three maintainability and wording findings were fixed. These were judgment calls, rather than lint failures.

| Finding | Risk | Final change |
| --- | --- | --- |
| Format names appeared in the registry, HTML, and filename suffix expression. | A new format could keep the previous extension or be absent from the popup. | One registry now supplies labels, descriptions, MIME types, time options, serializers, and recognized suffixes. |
| Serializer dispatch used GeoJSON as a default branch. | A future registry entry could download GeoJSON under another format's extension. | Each registry entry names its serializer. Unknown format keys cause an error. |
| The data summary said missing values were never filled. | The text contradicted the time-generation option. | The summary states the default policy and its explicit time-generation exception. |

Shared preparation in `export-data.js` validates aligned fields, calculates distance within segments, and generates times for GPX and TCX. It reuses the normalized time array. Filename editing only updates the filename preview; it does not scan the full route or erase a download error.

## Spec

Six data and interaction issues were corrected or guarded. Tests cover the affected boundaries.

| Priority | Issue and effect | Fix and evidence |
| --- | --- | --- |
| P2 | TCX import preferred Notes over Name. A course description became its display name. | Read Name first. A regression fixture supplies different Name and Notes fields and checks the imported name. |
| P2 | A visibility transition delayed the popup's focus target. Initial keyboard input could remain outside the dialog. | Animate opacity only. Browser tests check initial format focus, arrow selection, focus trapping, Escape, and focus return. |
| P2 | Updating the time choice removed and reinserted its focused checkbox. Space enabled generation but moved focus to BODY. | Move the label only when its parent changes. Unit tests reproduce both GPX and TCX paths. Browser tests check focus after generation is selected. |
| P3 | An unsupported GPX time policy silently omitted recorded times. | Reject unknown policies. A regression test checks the error instead of permitting data loss. |
| P3 | Numeric zero duration used the unknown-duration fallback. | Use a nullish default. A stationary-duration test checks that explicit zero creates no elapsed time. |
| P3 | Excessive generated dates could overflow Date or leave the four-digit year range accepted by the track model. | Validate start and end dates before generation. Tests cover invalid dates, overflow, year zero, and crossing year 9999. |

The new formats also enforce their data contracts:

- TCX writes a Course with separate Track elements. It requires a valid time for every point. Missing times disable Download until the user selects generation. Consent resets when the popup opens. Generated times replace all recorded times and are identified as estimates in Notes.
- TCX short names contain at most 15 Unicode characters. Notes retains the full name. Longitude `180` becomes the equivalent `-180`. Distances do not increase across gaps. The exporter does not invent fitness measurements or activities.
- CSV has six fixed columns. Segment and point numbers start at 1. Zero elevations remain zero; missing values stay empty. Only finite numbers and validated times enter cells. Untrusted route names cannot add formulas or rows.
- KML and GeoJSON preserve segments. Their isolated points remain valid Point geometries. GPX retains its recorded-time and waypoint behavior. GeoJSON times survive reimport through aligned `coordTimes` arrays.
- The popup body scrolls independently of its title and action buttons. Mobile checks cover 320×568 and 667×375 viewports, visible actions, and filename focus-outline space.

## Validation

The following checks passed:

- `npm run lint`
- `npm run test:coverage`: 380 tests in 18 files.
- `npm run build`
- `npm run test:browser`: 38 tests. Additional targeted popup checks cover the final focus-outline adjustment.
- Garmin TCX v2 schema validation with `xmllint --nonet`: three generated files. Fixtures cover complete recorded times, generated times with separate segments, Unicode and XML control characters, missing heights, long names, and antimeridian coordinates.
- `git diff --check`

The Garmin schema was downloaded from its [official source](https://www8.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd). The schema check was a local validation step. Unit and browser tests do not fetch external schemas.

Coverage before the TCX/CSV extension was measured on the pending three-format implementation. The table compares that measurement with the final export implementation. No existing coverage threshold was reduced.

| Metric | Before | After |
| --- | ---: | ---: |
| Statements | 82.56% | 82.93% |
| Branches | 74.58% | 75.09% |
| Functions | 86.51% | 86.89% |
| Lines | 85.82% | 86.12% |

`export-data.js` and `route-export.js` each reached 100% statement, branch, function, and line coverage. Each now has a separate gate: 95% statements, 90% branches, 100% functions, and 95% lines. These gates protect the export boundary; coverage alone does not prove correctness.

## Documentation and limits

README.md contains the short user flow. The [format guide](../export-formats.md) is the source for output policies and CSV columns. The architecture guide records module boundaries and invariants. TODO.md links this review and contains unfinished work only. Older review reports remain historical records.

The revised text uses short sentences, active verbs, explicit units, and consistent terms. It follows the requested simplified-English direction; it is not a claim of ASD-STE100 certification.

FIT and KMZ remain deferred. CSV is export-only. ZIP export still bundles GPX. KML omits point times. The line-only importer skips isolated Points in KML and GeoJSON. Exports retain source heights without a vertical datum conversion. Physical screen-reader use and actual Garmin-device imports remain outside these automated checks.

Standards: 0 hard violations; 3 judgment findings fixed. The largest maintainability risk was format dispatch falling through to another serializer. Spec: 6 data and interaction findings addressed; the highest priority was P2, including lost keyboard focus and incorrect TCX names. No review finding remains open in this scope.
