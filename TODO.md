# Remaining work

The [export review](docs/reviews/2026-11-03-export-review.md) records the latest fixes and checks. The [planner review](docs/reviews/2026-11-02-planner-review.md) records earlier work. Read the [architecture guide](docs/architecture.md) before you change module boundaries. This list contains unfinished work only.

## Before deployment

- [ ] Confirm routing-provider agreement fit for the CARTO map, route storage, and GPX export. Define retention by data source.
- [ ] Verify authenticated Routes and Geocoding calls and key restrictions on the deployed HTTPS origin.
- [ ] Check deployed CSP and cache headers after deployment. Local build tests do not verify hosting configuration.
- [ ] Verify the Umami tag, import outcomes, and generated export events in Cloud. Follow the [analytics guide](docs/umami-analytics.md). Confirm no private values appear.
- [ ] Confirm that Amplify installs `libatomic` and completes a build with Node 26.12.0. The local Docker daemon was unavailable for the AL2023 check.

## Maintenance and verification

- [ ] Add JSDoc domain types and a practical static type check to extracted modules.
- [ ] Select an XML parser with supported token-size limits and text streaming. saxes buffers complete text tokens, including KML coordinate lists. Preserve strict XML checks and namespace handling when evaluating a replacement.
- [ ] Measure total import heap use on constrained devices. Desktop XML peak-memory measurements are recorded in the hardening report; input and point limits remain in place.
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
