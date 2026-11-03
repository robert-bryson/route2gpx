# Route export formats

The web app exports GPX, KML, GeoJSON, TCX, and CSV. Select a route's download icon to open the format popup. GPX is the default. The Python CLI exports GPX only.

## Select a format

| Format | Use | Data rules |
| --- | --- | --- |
| GPX 1.1 | GPS devices and outdoor apps | Keep segments, recorded times, known elevations, and coordinate waypoints. Omit missing values. |
| KML 2.2 | Google Earth and map viewers | Write one geometry per segment. Keep known elevations. Omit point times. |
| GeoJSON | GIS and web maps | Use longitude before latitude. Keep segments and optional heights. Store times in `properties.coordTimes`. Other apps can ignore this property. |
| TCX v2 | Garmin and fitness courses | Write a Course with separate Track elements. Every point must have a time. Keep known elevations and cumulative distance. |
| CSV | Spreadsheets and data analysis | Write one row per point. Keep segment numbers, coordinates, known elevations, and recorded times. |

GPX supports optional elevation and time fields in each track point. It is the default format for a complete track backup. [GPX 1.1 schema](https://www.topografix.com/GPX/1/1/)

KML paths have no point time field. This exporter uses plain paths for files with incomplete times. A segment with missing heights uses `clampToGround`; its known heights remain in the file. A segment with all heights uses `absolute`. [KML reference](https://developers.google.com/kml/documentation/kmlreference#linestring)

GeoJSON permits a third coordinate for height. `coordTimes` is a toGeoJSON convention, not an RFC time field. It contains one entry per point, with `null` for missing times. Multiple segments use nested arrays. The app reads this property on import. [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946.html), [toGeoJSON source](https://github.com/mapbox/togeojson/blob/master/togeojson.js)

## TCX rules

TCX exports a planned course. It does not create a recorded activity or invent calories, heart rate, laps, or turn instructions.

The Garmin schema requires a Time for each Trackpoint. If any time is missing, Download stays disabled. Select **Generate new timestamps** to create estimated times, or select another format. This option is visible without opening **Track data & options**.

The Course Name permits 1 to 15 characters. The exporter collapses whitespace and limits the name to 15 Unicode characters. Notes retains the full name. Generated times are marked as estimates in Notes. Import uses Name before Notes, so a description cannot replace a course name.

TCX excludes longitude `180`. The exporter writes the equivalent `-180` value. Separate Track elements retain gaps. Distance does not increase across a gap. [Garmin TCX v2 schema](https://www8.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd)

## Time generation

GPX and TCX can generate new point times. Generation is off each time the popup opens. It replaces all recorded times and starts at download time.

The exporter uses route duration when available. Otherwise, it estimates a total duration of one minute per point interval. It distributes that duration by distance within segments. For a route with zero distance, it uses point order. It does not assign travel distance to gaps. Excessive duration values stop the export with an error.

CSV and GeoJSON preserve recorded times. KML omits point times. An unknown time policy causes an error; it cannot silently remove recorded times.

## CSV columns

CSV uses UTF-8 text, a header row, comma separators, and CRLF line endings. [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180.html)

| Column | Meaning |
| --- | --- |
| `segment` | Segment number, starting at 1. |
| `point` | Point number across the complete route, starting at 1. |
| `latitude` | Latitude in degrees. |
| `longitude` | Longitude in degrees. |
| `elevation_m` | Known source elevation in meters. Empty if missing. Zero is valid. |
| `time` | Valid recorded time. Empty if missing. Zoned times use UTC. Times without a zone retain their wall time. |

Cells contain finite numbers or validated time strings. Free-text names and descriptions are excluded. These fields cannot add spreadsheet formulas or change row boundaries. CSV is export-only; the app does not import it.

## Shared limits

All exporters validate aligned coordinates, elevations, and times. Invalid points create segment breaks. Exports use the full route geometry.

KML and GeoJSON lines need at least two positions. The exporters retain isolated positions as Points. The app's line-only importer skips those Points. Use GPX for a full backup. [KML LineString](https://developers.google.com/kml/documentation/kmlreference#linestring), [GeoJSON LineString](https://www.rfc-editor.org/rfc/rfc7946.html#section-3.1.4)

Exports retain source height values. They do not convert the vertical datum. GeoJSON specifies WGS84 ellipsoidal height, but imported and sampled heights can use another reference. A file can therefore need height conversion for survey or GIS work. [RFC 7946 coordinate reference system](https://www.rfc-editor.org/rfc/rfc7946.html#section-4)

The popup retains its keyboard focus. Escape and Cancel return focus to the route action. The popup scrolls on short screens. Download errors appear inside the popup.

**Download All (ZIP)** exports GPX files. It does not apply the popup's single-route format choice.

## Deferred formats

- FIT needs a device-specific course model and binary encoding. Add it when a target device justifies that work. [Garmin FIT courses](https://developer.garmin.com/fit/file-types/course/)
- KMZ is a ZIP package for KML and related files. Add it when compression or bundled resources are useful. [Google KMZ documentation](https://developers.google.com/kml/documentation/kmzarchives)

Format research and schema checks were completed on 2026-11-03. These choices reflect the app's data model and expected uses. They are not market-share claims.
