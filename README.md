# route2gpx

Convert planned routes and recorded GPS tracks to GPX files. Use the [web app](https://route2gpx.rsmb.tv/) or the Python command-line tool.

## Use the web app

1. Open the app. To work without a Google key, select **Import GPS file**.
2. To calculate a route, configure a Google Routes API key. Enter an origin and destination. Add intermediate waypoints if required.
3. Select Drive, Bicycle, Walk, or Transit. Select **Get Route**.
4. Select **GPX** on a route. Check the elevation and time coverage, choose a filename, then download the file.

Use **Edit / reuse** to copy a calculated route into the planner. Rename a route to change its display name. After deletion, **Undo** remains available for 15 seconds. On small screens, use **Planner** and **Map** to switch views. The app saves the planner draft separately from completed routes.

Map clicks can set endpoints after confirmation. The guided picker sets endpoints and waypoints in sequence. Intermediate stops appear between the origin and destination. Transit does not accept intermediate stops. Other modes accept up to 25.

Keyboard controls support mode and unit selection, waypoint reordering, route actions, and named dialogs. Automated tests check focus preservation. Screen-reader and mobile-keyboard testing on physical devices is still required.

## Import and export rules

The app accepts GPX, KML, FIT, TCX, GeoJSON, and their gzip-compressed forms. Fog of World ZIP files are separate map overlays.

- Tracks must contain at least two valid points. Invalid coordinates are skipped with their elevation and time fields. A skipped point creates a segment break.
- Separate GPX tracks and segments, KML Placemarks, TCX tracks, and GeoJSON line geometries keep their breaks. Points and polygons are not route tracks.
- Import results retain warnings for invalid points, short tracks, unsupported geometry, and failed files. Cancelling an import retains completed tracks.
- Each file can contain up to one million points. Limits are 100 files and 250 MB per batch, 50 MB per file, and 120 MB after gzip expansion. Decompression checks the output size while it runs. Large FIT/GeoJSON files and gzip files use a cancellable worker when available.
- GPX exports preserve segment breaks, recorded times, and known elevations. Missing values are omitted. Full route coordinates remain available for export.
- The download dialog offers optional timestamp synthesis from route duration and distance. ZIP exports preserve recorded times and allocate unique filenames. The ZIP data summary lists elevation and time coverage for each exported route.
- Coordinate waypoints can be exported as GPX waypoints. Address and place-name waypoints remain in the description.

Elevation lookup is optional. One queue spaces requests across routes. It samples at most 1,000 points per route and interpolates between successful samples within each segment. Partial results can be retried or paused. Pause retains completed batches, including after reload. Recorded elevations are retained; routes that combine recorded and SRTM values keep that source information.

## Data and API keys

Imports run locally. Completed routes use browser localStorage. An unsaved-data notice remains visible if storage fails. Export routes before clearing browser data.

Route requests go directly to Google Routes API. Optional coordinate labels go to Google Geocoding API. Map tiles come from CARTO. Deployed elevation requests pass through the same-origin Amplify rewrite to Open Topo Data. The app does not upload routes or API keys to an application database.

Create a dedicated Google API key and configure the restrictions for your deployed website and required APIs. Enable Geocoding only if you use coordinate labels. Keys use current-tab session storage by default. You can choose persistent browser storage. If that write fails, the app attempts tab storage. Verify authenticated requests and restrictions on the deployed HTTPS origin.

Before deployment, confirm that your routing agreement permits the selected map, storage period, and GPX export. The app records route source and creation time but does not enforce a retention period. See the [provider decision in the review](docs/reviews/2026-11-02-project-review.md#provider-fit-comes-before-a-routing-fallback).

## Develop the web app

Use a supported Node version: 22.13+, 24, or 26+.

```bash
npm ci
npm run check
npm run dev
```

`npm run check` runs JavaScript lint, unit tests, and the build. `npm run dev` rebuilds on source changes and serves `http://127.0.0.1:4173`. Refresh after a rebuild. Use `npm run preview` to serve an existing build.

The build follows ES module imports. It writes hashed JavaScript, CSS, and an import worker to `dist/`. Leaflet, JSZip, and Pako use versions pinned in the lockfile and are served locally with integrity hashes and licenses. Startup does not require a script CDN.

`customHttp.yml` defines the headers for Amplify, Terraform, local preview, and the HTML CSP. Production HTML revalidates. Fingerprinted assets use immutable caching. Deploy again to apply header changes, then check the actual responses. Local preview revalidates all files.

Run browser tests against the built app:

```bash
npx playwright install chromium
npm run build
npm run test:browser
```

Tests use real Leaflet, local fixtures, generated downloads, and intercepted provider responses. No Google credentials are required. To use installed Chrome, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. CI runs lint, unit tests, build checks, and browser tests. Amplify runs lint and unit tests before packaging.

The [architecture guide](docs/architecture.md) describes module boundaries, storage commits, and validation. The [review](docs/reviews/2026-11-02-project-review.md) records the original findings and follow-up fixes. [TODO.md](TODO.md) lists remaining work.

### CARTO basemap key

1. Obtain a [CARTO Basemaps API key](https://carto.com/basemaps/apikey/).
2. Set `CARTO_API_KEY` in the Amplify build environment. Check branch overrides.
3. Restrict the key to the domains that serve the app.
4. Run a new build after each key change.

The build trims the key and includes it in the browser bundle. Tile requests send its encoded value in the `key` query parameter. This key is visible to website visitors.

Amplify sets `AWS_APP_ID`. When it is present, the build stops if the CARTO key is missing or blank. Local builds can omit the key; tiles can then show a watermark. For a local key that permits your development hostname:

```bash
CARTO_API_KEY=your_basemaps_key npm run build
```

The web build reads the shell environment. It does not load `.env`.

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

Valid modes are `DRIVE`, `TRANSIT`, `BICYCLE`, and `WALK`. The default output for this example is `drive-route_Seattle_WA-Portland_OR.gpx`.

Use `--output custom.gpx` to choose a path. Existing files are preserved unless you add `--force`. Output omits invented elevation and point times by default. Add `--timestamps` to synthesize times from route duration. `--start-time 2026-11-02T10:00:00-08:00` sets an explicit synthesis start; a start without a time-zone offset uses UTC.

Run Python checks:

```bash
poetry run pytest --cov=route2gpx --cov-report=term-missing
poetry run black --check .
poetry run isort --check .
```

## License

MIT. See [LICENSE](LICENSE).
