# `route2gpx`

Sometimes you gotta fudge a track..

Convert routes from Google Routes API into GPX files for GPS devices, bike computers, and mapping software.

## 🌐 Web App

**[Try it online →](https://route2gpx.rsmb.tv/)** — No installation required!

A browser app that keeps route planning state locally. Route requests go directly from your browser to Google Routes API, while deployed elevation lookups use the configured same-origin Amplify rewrite to Open-Topo-Data.

### Web Features

- 🗺️ Interactive map with click-to-add waypoints
- 🚗🚴🚶🚌 Support for Drive, Bicycle, Walk, and Transit modes
- 📥 Download individual routes or all at once as GPX files
- 📂 Import GPX, KML, FIT, TCX, GeoJSON, and gzipped GPS files
- 🎨 Auto-cycling color palette for multiple routes
- 💾 Routes persist in browser localStorage
- 📱 Mobile-friendly responsive design
- ♿ Full keyboard navigation and screen reader support
- 🔒 No app server stores your routes or API key
- 🌫️ Fog of World data visualization — upload your FoW `.zip` export to see explored areas on the map

### Getting Started (Web)

1. Visit the web app
2. Enter your [Google Routes API key](https://developers.google.com/maps/documentation/routes/get-api-key)
3. Enter origin and destination (addresses, places, or coordinates)
4. Press Enter or click "Get Route"
5. Download your GPX file

For safer browser use, create a dedicated Google API key for this app, restrict it to your website referrer, and restrict API access to the Routes API. The web app can remember the key in this browser or keep it for the current tab only. Imported GPS files are processed locally and capped by file and decompressed-size limits to protect the browser from very large uploads.

### Development (Web)

```bash
npm ci
npm test
npm run build
```

---

## 🐍 Python CLI

A simple command-line tool for scripting or batch processing.

### Features

- Retrieves routes using Google's modern Routes API
- Supports Drive, Transit, Bicycle, and Walk modes
- Exports routes to GPX format with timestamps and placeholder elevation values

### Installation

**Requirements:**

- Python 3.13+
- Poetry
- [Google Routes API key](https://console.cloud.google.com/apis/library/routes.googleapis.com)

```bash
git clone https://github.com/robert-bryson/route2gpx.git
cd route2gpx
poetry install
```

Create a `.env` file with your API key:

```env
GOOGLE_ROUTES_API_KEY=your_api_key_here
```

### Usage

```bash
poetry run python route2gpx.py "Start Location" "End Location" MODE
```

`MODE` can be `DRIVE`, `TRANSIT`, `BICYCLE`, or `WALK`.

**Example:**

```bash
poetry run python route2gpx.py "Seattle, WA" "Portland, OR" DRIVE
```

Outputs: `drive-route_Seattle_WA-Portland_OR.gpx`

### Development (Python)

```bash
poetry run pytest
poetry run black --check .
poetry run isort --check .
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
