# route2gpx

Convert planned routes and recorded GPS tracks to GPX files. Use the [web app](https://route2gpx.rsmb.tv/) or the Python command-line tool.

## Use the web app

1. Open the app. To import a recorded track, select **Import GPS file**. A Google key is not necessary for imports.
2. To calculate a route, set a Google Routes API key. Enter an origin and a destination. Add intermediate waypoints if necessary.
3. Select Drive, Bicycle, Walk, or Transit. Select **Get Route**.
4. Select **GPX** on a route. Check the elevation and time coverage. Enter a filename. Download the file.

Use **Edit / reuse** to copy a calculated route into the planner. Rename a route to change its display name. After deletion, **Undo** remains available for 15 seconds.

On small screens, use **Planner** and **Map** to change views. The app saves the planner draft separately from completed routes. A late location result cannot replace an endpoint that you edited while the request was pending.

Map clicks can set endpoints after confirmation. The guided picker sets endpoints and waypoints in sequence. Intermediate stops appear between the origin and destination. Transit does not accept intermediate stops. Other modes accept up to 25.

Use the keyboard to select a mode or unit, move waypoints, and operate route controls and dialogs. Automated tests check focus preservation. Physical-device checks remain necessary for screen readers and mobile keyboards.

## Import and export rules

The app accepts GPX, KML, FIT, TCX, GeoJSON, and their gzip-compressed forms. Fog of World ZIP files are separate map overlays.

- Tracks must contain at least two valid points. Invalid coordinates are skipped with their elevation and time fields. A skipped point creates a segment break.
- Separate GPX tracks and segments, KML Placemarks, TCX tracks, and GeoJSON line geometries keep their breaks. Points and polygons are not route tracks.
- Import results retain warnings for invalid points, short tracks, unsupported geometry, and failed files. Cancelling an import retains completed tracks.
- Each file can contain up to one million points across all tracks. Invalid points also count toward this limit.
- Import at most 100 files and 250 MB per batch. The limit is 50 MB per file and 120 MB after gzip expansion.
- Decompression checks the output size while it runs. GPS files larger than 256 KiB and all gzip files use a cancellable worker when available. XML parsing finishes inside the worker.
- GPX, KML, and TCX parse without an XML DOM. XML imports have nesting, field-length, and track-count limits. The parser can buffer a complete text field, including a KML coordinate list. These limits do not cap total memory use. Document types and custom entities are unsupported.
- XML fields must use the track document's namespace and supported parent elements. Foreign extensions cannot replace point data. KML tracks use the standard Google extension namespace.
- GPX exports preserve segment breaks, recorded times, and known elevations. Missing values are omitted. Full route coordinates remain available for export.
- Invalid calendar dates are omitted. Zoned times convert to UTC and retain fractional-second precision. Times without a zone keep their original wall time.
- Export replaces characters that XML cannot represent with the replacement character `�`. Other Unicode text remains unchanged.
- The download dialog offers optional timestamp synthesis from route duration and distance. ZIP exports preserve recorded times and allocate unique filenames. The ZIP data summary lists elevation and time coverage for each exported route.
- Coordinate waypoints can be exported as GPX waypoints. Address and place-name waypoints remain in the description.

Elevation lookup is optional. One queue spaces requests across routes. It samples at most 1,000 points per route. It interpolates between successful samples within each segment.

Pause or retry a partial lookup as necessary. Pause retains completed batches, including after reload. The app retains recorded elevations and identifies routes with mixed elevation sources.

Fog of World ZIP files have a separate 250 MB input limit. A 512 MB allocation budget covers decoded tile bytes and retained bitmap copies. A limit failure stops the import. This byte budget does not measure the total JavaScript heap.

## Data and API keys

Imports run locally. Completed routes use browser localStorage. An unsaved-data notice remains visible if storage fails. Export routes before clearing browser data.

Route requests go directly to Google Routes API. Optional coordinate labels go to Google Geocoding API. Map tiles come from CARTO. Deployed elevation requests pass through the same-origin Amplify rewrite to Open Topo Data. The app does not upload routes or API keys to an application database.

Create a dedicated Google API key. Restrict it to the deployed website and necessary APIs. Enable Geocoding only if you use coordinate labels.

By default, keys use storage for the current browser tab. You can select persistent browser storage. If that write fails, the app attempts tab storage. Verify authenticated requests and key restrictions on the deployed HTTPS origin.

Use **Remove key** to delete a key. If removal or a storage change fails, the dialog stays open and shows an error. Export your routes before you clear this website's browser data to remove a retained key.

Before deployment, confirm that your routing agreement permits the selected map, storage period, and GPX export. The app records route source and creation time but does not enforce a retention period. See the [provider decision in the review](docs/reviews/2026-11-02-project-review.md#provider-fit-comes-before-a-routing-fallback).

## Develop the web app

Use a Node version supported by the locked dependencies:

- Node 22: version 22.22.2 or later within that release line.
- Node 24: version 24.15.0 or later within that release line.
- Node 26 or later.

```bash
npm ci
npm run check
npm run dev
```

`npm run check` runs JavaScript lint, unit tests, and the build. `npm run dev` rebuilds when source files change. It serves the app at `http://127.0.0.1:4173`. Refresh after a rebuild. Use `npm run preview` to serve an existing build.

Run `npm run test:coverage` for JavaScript coverage. Open `coverage/index.html` for the report. CI enforces minimum coverage levels in `vitest.config.mjs`. The report includes all root JavaScript files. It does not collect coverage from browser tests or child processes.

Run `node scripts/benchmark-xml.cjs 100000` to compare XML parsing time and peak process memory against the DOM implementation at `f4c77eb`. Both samples run in separate processes with the same jsdom startup cost. These measurements do not establish mobile-device memory limits.

The build follows ES module imports. It writes hashed JavaScript, CSS, and an import worker to `dist/`. Leaflet, JSZip, and Pako use versions pinned in the lockfile and are served locally with integrity hashes and licenses. Startup does not require a script CDN.

`customHttp.yml` defines the headers for Amplify, Terraform, local preview, and the HTML CSP. Production HTML revalidates. Fingerprinted assets use immutable caching. Deploy again to apply header changes, then check the actual responses. Local preview revalidates all files.

Run browser tests against the built app:

```bash
npx playwright install chromium
npm run build
npm run test:browser
```

Tests use real Leaflet, local fixtures, generated downloads, and intercepted provider responses. Google credentials are not necessary. To use installed Chrome, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path.

CI checks Node 22.22.2, 24.15.0, and 26.12.0. Each job runs lint, coverage, the build, and browser tests. Amplify runs lint and unit tests before it packages the app.

The [architecture guide](docs/architecture.md) describes module boundaries, storage commits, and validation. The [hardening report](docs/reviews/2026-11-02-architecture-hardening.md) records the latest changes, memory measurements, and verification limits. The [follow-up review](docs/reviews/2026-11-02-follow-up-review.md) retains earlier findings. [TODO.md](TODO.md) lists remaining work.

### Amplify build environment

1. Select **Amazon Linux 2023** as the build image.
2. Open **Hosting → Build settings → Build image settings → Live package updates**.
3. Set the Node.js version to `26.12.0`.
4. Commit the build configuration. Push the commit. Run a new Amplify build.

Node.js 25 and later require the `libatomic` runtime on Linux. `amplify.yml` installs this package before it runs Node or npm. It then prints the Node version. See [Node's runtime requirements](https://github.com/nodejs/node/blob/v26.12.0/BUILDING.md#official-binary-platforms-and-toolchains) and [AWS's privilege guidance](https://docs.aws.amazon.com/amplify/latest/userguide/troubleshooting-AL2023.html).

### CARTO basemap key

1. Obtain a [CARTO Basemaps API key](https://carto.com/basemaps/apikey/).
2. Set `CARTO_API_KEY` under **Hosting → Environment variables** in Amplify. Check branch overrides.
3. Restrict the key to the domains that serve the app.
4. Run a new build after each key change.

The build trims the key and includes it in the browser bundle. Tile requests send its encoded value in the `key` query parameter. This key is visible to website visitors.

Amplify sets `AWS_APP_ID`. When it is present, the build stops if the CARTO key is missing or blank. Local builds can omit the key; tiles can then show a watermark. For a local key that permits your development hostname:

```bash
CARTO_API_KEY=your_basemaps_key npm run build
```

The web build reads the shell environment. It does not load `.env` or the JSON in `process.env.secrets` from Secret management.

Production elevation lookup requires the Amplify rewrite from `/api/elevation/<path>` to Open Topo Data. The local preview server returns an unavailable response for that path. Route calculation, import, and export still work locally.

## Use the Python CLI

Install Python 3.13+ and Poetry, then install project dependencies:

```bash
git clone https://github.com/robert-bryson/route2gpx.git
cd route2gpx
poetry install
```

Set `GOOGLE_ROUTES_API_KEY` in your environment or a local `.env` file:

```env
GOOGLE_ROUTES_API_KEY=your_api_key_here
```

Calculate a route:

```bash
poetry run python route2gpx.py "Seattle, WA" "Portland, OR" DRIVE
```

Specify one of these modes: `DRIVE`, `TRANSIT`, `BICYCLE`, or `WALK`. The default output for this example is `drive-route_Seattle_ WA-Portland_ OR.gpx`. Filename conversion preserves spaces.

Use `--output custom.gpx` to choose a path. Existing files are preserved unless you add `--force`. Output omits invented elevation and point times by default. Add `--timestamps` to synthesize times from route duration. `--start-time 2026-11-02T10:00:00-08:00` sets an explicit synthesis start; a start without a time-zone offset uses UTC.

Run Python checks:

```bash
poetry run pytest --cov=route2gpx --cov-report=term-missing
poetry run black --check .
poetry run isort --check .
```

## License

MIT. See [LICENSE](LICENSE).
