# TODO

Keep this list biased toward work that is still useful. Completed items are retained as release notes for recent AI-assisted cleanup; stale maybes belong in issues, not here.

## Current Priorities

- [ ] Add browser-level smoke tests for CDN assets, map startup, imports, downloads, and the generated `dist/` bundle.
- [ ] Continue splitting the `app.js` coordinator into route state, storage, API, map rendering, import, export, and modal modules.

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

## Completed

- [x] Removed inline `style` attributes and palette-driven dynamic style attributes so the CSP no longer needs `style-src 'unsafe-inline'`.
- [x] Restored localStorage route payloads are validated before Leaflet layers are created, so corrupt saved routes are skipped individually.
- [x] Import parsers reject out-of-range coordinates and malformed elevation values before routes reach the map or GPX export.
- [x] Route-list and waypoint HTML escaping now handles quoted attribute values safely.
- [x] Browser source now builds through ES module imports/exports instead of manual JavaScript concatenation.
- [x] Main CSS moved from inline HTML into a build-managed hashed stylesheet.
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
