# TODO

Keep this list biased toward work that is still useful. Completed items are retained as release notes for recent AI-assisted cleanup; stale maybes belong in issues, not here.

## Current Priorities

- [ ] Add browser-level smoke tests for CDN assets, map startup, imports, downloads, and the generated `dist/` bundle.
- [ ] Move inline styles to a build-managed stylesheet so the CSP can drop `style-src 'unsafe-inline'`.
- [ ] Split the large browser bundle source into smaller modules with explicit exports.

## Planned Features

- [ ] Alternative routing engine, likely OSRM, as a free fallback to Google Routes API.
- [ ] Route drag-to-edit after computation.
- [ ] Address autocomplete/geocoding suggestions.
- [ ] URL-based route sharing with encoded route parameters in the hash.
- [ ] Store exact resolved coordinates for address/place-name waypoints if they need separate GPX waypoint export.
- [ ] Optional Fog of World data editing/export, if the proprietary format can be handled safely.

## Hardening / Quality

- [ ] Add integration coverage for Google Routes API error bodies, rate limits, and network timeouts.
- [ ] Add browser permission smoke coverage for geolocation success, denial, and stale callback handling.
- [ ] Add visual/screenshot coverage for compact map controls, color palette, and mobile sidebar sizing.
- [ ] Validate restored localStorage route payloads before creating Leaflet layers, so one corrupt saved route cannot block later saved routes.

## Completed

- [x] API key storage defaults to current-tab session storage and falls back safely when persistent storage is blocked.
- [x] Malformed route polylines are rejected before bogus map layers or GPX files are created.
- [x] Elevation enrichment ignores malformed or extra API results instead of extending route elevation arrays.
- [x] Stale geolocation callbacks cannot overwrite a newer location request.
- [x] Plain map clicks prompt before filling empty origin/destination fields.
- [x] Compact icon controls for travel mode, color selection, imports, Fog of World, API key, guided picking, and geolocation.
- [x] Older routes are visually de-emphasized on the map while keeping the newest route prominent.
- [x] Map UI supports click-to-set origin/destination.
- [x] Map UI supports intermediary route waypoints.
- [x] Filename confirmation modal before GPX download.
- [x] Elevation lookup via Open-Topo-Data.
- [x] GPX/KML/FIT/TCX/GeoJSON import and map overlay.
- [x] Batch ZIP export for multiple routes.
- [x] Fog of World ZIP import and map overlay.
- [x] Waypoint rows can be reordered before route calculation.
- [x] GPX export avoids fake coordinates for address/place-name waypoints.
- [x] Python CLI can be imported without making network requests or writing files.
- [x] Import size checks cover compressed and decompressed GPS/Fog of World data.
- [x] Browser storage save failures show a user-visible warning.
- [x] Amplify elevation rewrite and local-development behavior are documented.
