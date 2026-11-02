# Remaining work

Completed fixes and verification are recorded in the [project review](docs/reviews/2026-11-02-project-review.md). See the [architecture guide](docs/architecture.md) before changing module boundaries.

## Before deployment

- [ ] Confirm routing-provider agreement fit for the CARTO map, route storage, and GPX export. Define retention by data source.
- [ ] Verify authenticated Routes and Geocoding calls and key restrictions on the deployed HTTPS origin.
- [ ] Check deployed CSP and cache headers after deployment. Local build tests do not verify hosting configuration.

## Maintenance and verification

- [ ] Extract route-list and modal coordination from `app.js`. Route layers now belong to `route-map.js`.
- [ ] Remove compatibility globals after converting the remaining legacy unit-test harnesses to module interfaces.
- [ ] Add JSDoc domain types and a practical static type check to extracted modules.
- [ ] Measure storage limits and import latency on representative devices before selecting IndexedDB or a different map renderer.
- [ ] Test geolocation success, denial, and stale callbacks through the browser permission interface.
- [ ] Test VoiceOver or NVDA through import, reorder, hide, download, and delete. Check single-pointer map panning alternatives.
- [ ] Test physical mobile keyboards, compact controls, the color palette, and sidebar sizing. Add screenshot coverage where stable.

## Later features

- [ ] Compare routing providers compatible with the selected map, storage, and export model. Include hosting cost, mode coverage, and representative routes.
- [ ] Add route drag editing after the provider decision.
- [ ] Add address autocomplete.
- [ ] Design URL sharing with explicit payload-size and privacy limits.
- [ ] Store resolved waypoint coordinates if address waypoints need separate GPX waypoint export.
- [ ] Evaluate Fog of World editing and export against the format's validation requirements.
