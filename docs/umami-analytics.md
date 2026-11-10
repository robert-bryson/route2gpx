# Umami analytics

The browser loads Umami Cloud on `route2gpx.rsmb.tv` only. It uses the shared portfolio property and the tag `route2gpx`. Filter by Hostname before you review reports.

| Event | Trigger | Data |
| --- | --- | --- |
| `file-import-finished` | A file has been processed or cancelled | Outcome, detected format |
| `route-calculation-finished` | A validated route request settles | Outcome, travel mode |
| `export-generated` | The app hands a GPX, KML, GeoJSON, TCX, CSV, or ZIP file to the browser | Format, route-count bucket |

Import and route outcomes are `success`, `error`, or `cancelled`. Each file in a batch has a separate import outcome. Unsupported inputs use format `unsupported`.
A cancelled export dialog does not create an export event. ZIP fallback records the generated GPX files. A generated file does not prove that the visitor saved it.
The result-count buckets are `0`, `1`, `2-10`, `11-50`, and `51+`.

The send hook accepts only known event names, fields, and values. It does not send API keys, addresses, coordinates, filenames, route names, or file contents. The page title is generic. Queries, hashes, identities, and external referrer paths are removed. Unknown paths become `/other`.
Do Not Track, Global Privacy Control, and the `umami.disabled` local-storage setting prevent the tracker from loading and sending. Web Vitals collection is enabled. Umami error capture and session replay are disabled for this application.
Pending custom events are limited to eight. Analytics must not block route work. Query exclusion also prevents native UTM attribution.

After deployment, check Realtime for the hostname and tag. Create a goal for `export-generated`. Create an import-to-export funnel with `file-import-finished` filtered to `outcome=success`, followed by `export-generated`. Use a 60-minute step window. Check Performance by device.
Verify that the deployed CSP permits `https://cloud.umami.is` for scripts and `https://gateway.umami.is` for connections. Local tests use a tracker substitute and do not prove Cloud delivery.

To exclude a browser, run `localStorage.setItem('umami.disabled', '1')` in its console on this origin. Remove the key to resume collection.
