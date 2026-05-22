# TODO

## Completed

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

## Planned Features

- [ ] Alternative routing engine, likely OSRM, as a free fallback to Google Routes API.
- [ ] Route drag-to-edit after computation.
- [ ] Address autocomplete/geocoding suggestions.
- [ ] URL-based route sharing with encoded route parameters in the hash.
- [ ] Store exact resolved coordinates for address/place-name waypoints if they need separate GPX waypoint export.
- [ ] Optional Fog of World data editing/export, if the proprietary format can be handled safely.

## Technical Debt

- [ ] Split the large browser bundle source into smaller modules with explicit exports.
- [ ] Add browser-level smoke tests for CDN assets, map startup, imports, and downloads.
- [ ] Move inline styles to a build-managed stylesheet so the CSP can drop `style-src 'unsafe-inline'`.
