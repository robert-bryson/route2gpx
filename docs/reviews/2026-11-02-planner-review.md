# Project and planner review: November 2, 2026

## Scope and assessment

The fixed commit is `78f9f36`. The primary comparison is `git diff 78f9f36 --`. The incoming tree contained nine modified files. Those changes added planner clearing, persistent planner pins, and place names. This review retains those features.

The user confirmed full-project scope. The review also examined imports, compression, workers, track normalization, GPX export, storage, network requests, elevation, dialogs, route lists, the Python CLI, build scripts, CI, and Terraform. The README and architecture guide supply the behavior requirements. No separate originating issue was supplied. Standards and behavior received independent reviews.

The incoming changes were not ready to commit. Place-name requests had two lifecycles. One bypassed cancellation and deduplication. Other entry points sent typed coordinates to Google despite the unchecked option. The passing tests did not cover these cases.

The existing parser, storage, and export modules have useful boundaries and substantial tests. This review found no additional confirmed defect in those modules. That finding does not establish that every input or device is supported.

## Standards

### S1 — P2: Place-name requests bypassed deduplication

**Location:** `app.js`, former `resolveRouteEndpointLabel`; now `lookupPlaceName`.

The route-label path checked the planner cache, then sent an independent request on a miss. It did not register the request or cache its result. Equivalent origin and destination coordinates could cause two requests. A map pick could start another request for the same point. This violated the architecture rule to cache and deduplicate by coordinates.

All coordinate sources now use one lookup path. Canonical coordinates identify cached names and pending promises. Each pending lookup owns its abort controller. The coordinator applies successful names to current planner fields and matching saved routes. Names have the same 500-character limit during lookup and restoration.

Tests cover equivalent coordinate strings across endpoints and waypoints. The shared point generates one request. Tests also cover overlapping picked points and late route names. The duplicated lifecycle was a possible Duplicated Code smell; the request count was a verified defect.

### S2 — P2: Calculated geometry bypassed coordinate validation

**Location:** `app.js`, `decodePolyline` and `getRoute`.

The decoder accepted characters above the encoded format's range. It also returned coordinates outside valid latitude and longitude ranges. For example, `_mljP???` returned two points at latitude 91. `getRoute` checked only the point count before creating layers and saving the route. A large response also bypassed the shared point limit.

The decoder now rejects invalid characters, overflowing encoded values, out-of-range coordinates, and more than one million points. A final review also found signed-shift wraparound in zigzag decoding. For example, `}~~~~~B???` produced two points near latitude -0.00001 from an enormous positive delta. The decoder now uses an unsigned right shift before coordinate validation. A failure rejects the complete calculated route. No partial route is installed.

Unit tests cover invalid characters, malformed values, both delta signs, coordinate limits, and an excessive point count. Browser tests supply latitude-91 and signed-wraparound responses. They verify that no route, line, or saved record is created.

### S3 — P3: Ignore rules missed local credential files

**Location:** `.gitignore`.

The file ignored `.env` and the default Terraform variable filename. It did not ignore `.env.local`, `.env.production`, or branch-specific Terraform variable files. It also contained extensive rules for frameworks absent from this project.

The rules now cover environment variants and Terraform variable files. Example environment files and the Terraform lockfile remain eligible for source control. Generated CLI output is ignored at the repository root. Track fixtures can now be added under `tests/`. Unused framework sections were removed.

Manual `git check-ignore` checks verified these cases. This is a source-control hygiene improvement. No credential rotation or secret-history audit was performed.

Standards result: three findings. Invalid calculated geometry and duplicate requests were the highest-priority defects. All three findings are addressed.

## Spec

### B1 — P2: The typed-coordinate option was bypassed

**Requirement:** The README describes an additional option for names on typed coordinates.

The Save key listener and Edit / reuse path called the geocoder for every coordinate field. Neither checked the typed-coordinate option. A user could enter coordinates, leave the option off, and send both locations to Google by saving a key.

Both unconditional entry points were removed. Map and GPS picks request names when a key is available. Typed coordinates require the option and **Get Route**. The option now also covers coordinate waypoints. Saved names remain available during reuse without another request.

Unit and browser tests verify zero Geocoding requests during key save and route reuse with the option off. The README now explains how to request names for points picked before a key was configured.

### B2 — P2: Reset did not invalidate every lookup

**Requirement:** The architecture guide requires reset to invalidate pending results.

Typed-coordinate lookups ran outside the planner's controller map. After **Clear planner**, their completion handler could repopulate the name cache. Reentering the same coordinate displayed and saved the cleared name.

Reset now aborts every lookup through the shared lifecycle. Completion checks the identity of its pending entry. An old response cannot replace a new lookup for the same coordinates. Tests deliver old responses after reset, including through a fetch stub that ignores abort. The new draft remains free of old names. Completed saved routes remain available.

### B3 — P2: Planner pin buttons lacked keyboard activation

**Requirement:** The README promises keyboard operation of planner controls. Planner pins must focus their fields.

Leaflet gave the pins a button role and a tab stop. The application registered only a click action. Enter and Space did not focus the field. A browser regression exposed this after focus retention was fixed.

Pins now handle both keys. The handler prevents the default action and stops propagation before focusing the field. Unit and browser tests exercise both keys.

### B4 — P2: A late name destroyed the focused pin

**Requirement:** The README and architecture guide require focus preservation.

Each preview update removed and recreated all planner markers. A delayed place name could remove the DOM node that held keyboard focus. Rebuilding also repeated marker allocation and event registration.

Planner markers now belong to their input nodes. Position, icon, tooltip, and accessible name update in place. Removal releases the handlers and tooltip. A browser test verifies that the original pin remains connected and focused after its name arrives. A unit test checks coordinate and color updates without another marker allocation.

### B5 — P3: Empty waypoint rows changed pin numbers

**Requirement:** Numbered planner pins must identify their corresponding fields.

The preview loop counted only nonempty fields. With an empty first waypoint, the second row's pin was labeled Waypoint 1. Pin numbers now use the input row position. Unit and browser tests cover an empty preceding row and renumbering after removal.

### B6 — P3: Waypoint deletion lost focus

**Requirement:** Planner controls must remain usable from the keyboard.

Removing a focused waypoint row sent focus to the document body. Removal now focuses the next waypoint, the previous waypoint, or the destination when no waypoint remains. Unit and browser tests cover the next-row and destination paths.

### B7 — P3: Color selection did not update planner pins

**Requirement:** The selected planner color must apply to the planner preview.

`selectColor` updated the palette and hidden field but did not update existing pins. Their color changed only after another preview event. Selection now refreshes the pins immediately and preserves pin focus. The pin-update unit test covers this path.

Spec result: seven findings. Unrequested location disclosure, stale reset results, and broken keyboard behavior were the highest-priority defects. All seven findings are fixed.

## Tests and coverage

The incoming JavaScript suite passed before changes. New regressions first failed against the incoming implementation. The browser suite exposed the missing keyboard action during verification.

| Measure | Incoming tree | Final tree |
| --- | --- | --- |
| JavaScript unit tests | 321 | 338 |
| Browser test cases | 25 | 32 |
| Statement coverage | 81.75% | 82.25% |
| Branch coverage | 73.09% | 73.65% |
| Function coverage | 85.18% | 86.16% |
| Line coverage | 85.12% | 85.53% |
| Coordinator line coverage | 79.33% | 80.24% |

The initial browser count is the number of existing cases. The complete browser suite was run after implementation. Coverage includes all root JavaScript files. No module was excluded to improve the result. Build and preview checks run in child processes; their execution does not contribute to unit coverage.

Global coverage minimums increased to 82% statements, 73% branches, 86% functions, and 85% lines. Coordinator minimums increased to 75%, 62%, 78%, and 80%, respectively. Other module minimums remain in place.

Verification completed:

- JavaScript lint, all 338 unit tests with coverage, and the production build pass.
- All 32 browser tests pass against the current build with Chromium.
- Late-name tests preserve explicit route renames and do not restore deleted routes.
- All 39 Python tests pass with 99% statement coverage. Black and isort pass.
- Terraform formatting and validation pass. Validation used the installed provider outside the sandbox.
- `npm audit` reports zero advisories for the installed production and development dependencies.
- `git diff --check` passes. Ignore-rule checks retain example files and track fixtures.

JavaScript checks used Node 26.12.0. Python checks used the existing Python 3.15 environment. The other CI release lines were not run locally. Browser execution required a localhost server outside the sandbox. These checks did not deploy the app or change infrastructure.

## Documentation and remaining limits

README instructions now describe reset, keyboard pin actions, lookup triggers, coordinate preservation, and data destinations. The architecture guide records lookup ownership, marker cleanup, geometry validation, and coverage minimums. Earlier reports are marked as historical and link here. TODO.md contains unfinished work only. The prose uses short instructions and explicit terms. Formal ASD-STE100 conformance was not assessed.

The coordinator is still 2,352 lines. It owns many asynchronous interactions and has no static domain-type check. That remains a maintenance cost. Further extraction should give a module ownership of state and lifecycle, with tests at its interface. Moving functions into another file without that ownership would not resolve the coupling.

XML token buffering, total import memory, browser storage capacity, provider agreement fit, deployed key restrictions, production response headers, screen readers, and physical devices remain open checks in [TODO.md](../../TODO.md). This review does not establish those properties.
