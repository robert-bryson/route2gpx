# Follow-up review: November 2, 2026

## Scope and assessment

The baseline is `f63be97904aa2ce0c1499478daa59f9b706d8420`. The review covers commits `25009f9` and `9a8e9d4`, plus the pending Amplify correction.

The source comparisons are `git diff f63be97...HEAD` and `git diff HEAD`. The first comparison covers committed application changes. The second covers the fixes from this session.

The review checked the browser app, import modules, storage, GPX output, Python CLI, tests, build, CI, and documentation. The README and architecture guide define the expected behavior. Standards and behavior received separate reviews.

The previous suite passed while imports could exceed their memory budget and exports could change recorded times. That is a material gap in the earlier safety claims. Extracted modules made the defects easier to isolate, but extraction alone did not establish correctness.

## Standards

Two findings required changes:

1. **P1: Fog imports bypassed the memory budget.** `FowTile.create` counted inflated tile bytes but omitted retained bitmap copies. One 58-byte compressed tile could produce a 33,283-byte source buffer and 8,388,608 bytes of bitmap copies. Many such tiles in one archive could allocate gigabytes before the recorded budget reached 512 MB. This violated the architecture requirement to bound expanded data. The fix charges each copy before allocation. A typed limit error now stops the import instead of passing through the corrupt-tile skip handler.
2. **P2: Node metadata overstated supported versions.** `package.json` accepted Node 22.13 and 24.0. Locked jsdom dependencies require 22.22.2 or 24.15.0 within those release lines. The package and lockfile now declare the same minimums. CI checks those versions and Node 26.12.0.

The review found no further reproducible network, worker-cleanup, or storage-commit defect. The storage cache does depend on immutable geometry arrays. The architecture guide now states this contract. Current app callers replace changed arrays.

Standards result: two findings. The memory-budget failure had the highest severity on this axis.

## Spec

Three findings contradicted documented behavior:

1. **P2: A stale location result could replace a newer endpoint.** The architecture requires stale background results to leave newer state unchanged. The request counter changed only when another geolocation request started. Typed edits, map picks, reuse, and endpoint moves did not consistently invalidate it. The fix observes input edits and checks the captured endpoint value. All programmatic endpoint edits now dispatch the same input event. Tests include edits and reorders that return to the original value before the callback arrives. Accepted locations also update the saved draft.
2. **P2: Timestamp conversion changed source information.** The README promises to preserve recorded times. `Date.parse` changed February 31 to March 2. It also assigned the importing device's timezone to unzoned times. The fix validates calendar fields and timezone offsets first. Zoned values convert to UTC. Unzoned values retain their wall time. Fractional digits beyond milliseconds remain intact. Invalid timestamps are omitted.
3. **P2: The file point limit counted survivors.** The README sets a one-million-point limit per file. Several tracks could each remain below that limit while their combined raw records exceeded it. Discarded coordinates did not count at aggregation. XML and GeoJSON parsers now share one raw point budget across tracks. Lazy point extraction checks that budget before it appends each record. The regression uses two individually legal GeoJSON tracks whose combined raw records exceed the limit.

Spec result: three findings. The timestamp and stale-state failures directly changed user data on this axis.

## Additional fixes

### GPX text could produce invalid XML

Both export implementations escaped markup characters but retained code points forbidden by XML 1.0. A name with a null character, a control character, or an unpaired surrogate could produce an unreadable GPX file. The Python writer could also raise an encoding exception.

Both implementations now replace forbidden code points with `�` before escaping markup. Valid Unicode characters remain intact. Tests parse the resulting XML and check its text content. The rules come from the [XML 1.0 character definition](https://www.w3.org/TR/xml/#charsets).

### Missing geolocation values became zero

The location validator used `Number`. It accepted null, blank strings, booleans, and arrays as zero coordinates. It now uses the existing strict numeric validator. Tests check absent values and out-of-range coordinates.

### Node 26 could not start in Amplify

The deployment log showed a missing `libatomic.so.1` before `npm ci` could start. Node's Linux binaries require this runtime from Node 25 onward. The build now installs `libatomic` with DNF before any Node command. It prints the Node version before dependency installation.

Keep the Amazon Linux 2023 image and the Node 26.12.0 override. See [Node's runtime requirements](https://github.com/nodejs/node/blob/v26.12.0/BUILDING.md#official-binary-platforms-and-toolchains) and [AWS's AL2023 privilege guidance](https://docs.aws.amazon.com/amplify/latest/userguide/troubleshooting-AL2023.html).

The SSM warning is a separate configuration issue. This build reads `CARTO_API_KEY` from Amplify environment variables. It does not parse the JSON in `process.env.secrets`.

## Tests and coverage

The original JavaScript suite had 189 passing unit tests and 14 browser tests. The Python suite had 38 passing tests. New regressions failed against the defective implementations before the fixes were applied.

The coverage configuration includes every root JavaScript source file. It does not exclude untested modules to improve the result. The report does not collect child-process or browser execution. Build and preview files therefore remain at zero in this report even when integration checks execute them.

The new worker tests cover message transfer, results, startup failure, parser failure, timeout, cancellation, bounded decompression, and XML handoff. Browser tests check accepted geolocation, permission denial, draft restoration, and delayed results after edits. Unit tests also check calendar boundaries, fractional seconds, KML timestamp alignment, bitmap allocation, and shared file budgets.

CI runs coverage on Node 22.22.2, 24.15.0, and 26.12.0. Minimums are 58% statements, 52% branches, 64% functions, and 61% lines. These levels prevent loss of the measured improvement. They are an initial floor, not a sufficient long-term target.

Dependabot updates Vitest and its coverage packages together. Their versions must remain compatible.

## Remaining weaknesses

- **The coordinator is still too large.** `app.js` owns planner state, modal state, geolocation, route-list updates, imports, and downloads. Extract route-list and modal coordination through small, tested interfaces. Avoid a broad rewrite.
- **The compatibility globals weaken module boundaries.** Legacy tests depend on a mutable global surface. Convert those tests to explicit module interfaces before removing the globals.
- **Coverage remains incomplete.** The coordinator, Fog renderer, and preview error paths need more behavioral tests. A passing suite does not prove untested paths are safe.
- **The Fog budget is a byte-allocation limit.** It does not measure all object overhead or guarantee a fixed total heap size. Measure representative imports on constrained devices.
- **XML parsing still builds a DOM.** Shared point budgets stop point extraction, but the XML parser constructs the document first. File-size limits remain necessary. Measure peak memory before raising them.
- **Browser checks use synthetic location callbacks.** They verify app behavior. They do not establish the behavior of an actual browser permission prompt or a physical location sensor.
- **Production checks remain open.** Verify the Amplify build, response headers, API restrictions, accessibility, and device performance after deployment. Keep those tasks in [TODO.md](../../TODO.md).

## Documentation changes

The README now separates local checks, Amplify settings, and API-key setup. Instructions use direct verbs and shorter sentences. The architecture guide states the timestamp, point-budget, endpoint-edit, and immutable-storage contracts. The original review is marked historical and no longer directs readers to temporary session files.

These edits follow the practical principles in [ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf): short sentences, direct instructions, and consistent terms. This was a clarity pass, not a certified vocabulary audit.

## Verification record

| Measure | Before | After |
| --- | --- | --- |
| JavaScript unit tests | 189 | 237 |
| Browser tests | 14 | 16 |
| Python tests | 38 | 39 |
| JavaScript line coverage | 60.05% | 63.55% |
| JavaScript branch coverage | 51.66% | 54.36% |
| JavaScript statement coverage | 56.64% | 60.19% |
| JavaScript function coverage | 62.50% | 66.94% |

The coverage file set remains unchanged: 17 root JavaScript source files. Worker-client coverage is now 100% for lines and branches. The worker entry has 100% line coverage and 90% branch coverage.

The following checks passed:

- JavaScript lint, unit tests, and production build through `npm run check`.
- Unit coverage and the configured minimums through `npm run test:coverage`.
- All 16 browser tests against a fresh build and installed Chrome.
- All 31 track tests in a separate UTC process. The main suite used the local Los Angeles timezone.
- All 39 Python tests. Pytest-cov reports 99% with branch measurement enabled.
- Black and isort for the complete Python source set.
- A clean dependency install with lifecycle scripts disabled, followed by `npm audit`: zero vulnerabilities.
- Terraform formatting and validation. Validation required the local provider process to run outside the sandbox.
- YAML parsing for Amplify, CI, and Dependabot. Amplify shell commands also passed Bash syntax checks.
- Local documentation links and Git whitespace checks.

Local checks used Node 26.12.0 and Python 3.15 on macOS. The configured Node 22/24 CI jobs and Python 3.13 job were not run locally. Browser checks used synthetic provider responses and geolocation callbacks.

No deployment or authenticated provider request was performed. The local Docker daemon was unavailable, so the AL2023 package-install command still requires verification in Amplify. These limits remain explicit in [TODO.md](../../TODO.md).
