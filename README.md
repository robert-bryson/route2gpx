# `route2gpx`

Sometimes you gotta fudge a track..

Convert routes from Google Routes API into GPX files for GPS devices, bike computers, and mapping software.

## 🌐 Web App

**[Try it online →](https://robert-bryson.github.io/route2gpx/)** — No installation required!

A fully client-side web app that runs entirely in your browser. Your API key and routes never touch a server.

### Web Features

- 🗺️ Interactive map with click-to-add waypoints
- 🚗🚴🚶🚌 Support for Drive, Bicycle, Walk, and Transit modes
- 📥 Download individual routes or all at once as GPX files
- 🎨 Auto-cycling color palette for multiple routes
- 💾 Routes persist in browser localStorage
- 📱 Mobile-friendly responsive design
- ♿ Full keyboard navigation and screen reader support
- 🔒 100% private — runs entirely in your browser

### Getting Started (Web)

1. Visit the web app
2. Enter your [Google Routes API key](https://developers.google.com/maps/documentation/routes/get-api-key)
3. Enter origin and destination (addresses, places, or coordinates)
4. Press Enter or click "Get Route"
5. Download your GPX file

---

## 🐍 Python CLI

A simple command-line tool for scripting or batch processing.

### Features

- Retrieves routes using Google's modern Routes API
- Supports driving and transit modes
- Exports routes to GPX format with timestamps and elevation data

### Installation

**Requirements:**

- Python 3.x
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

`MODE` can be `DRIVE` or `TRANSIT`.

**Example:**

```bash
poetry run python route2gpx.py "Seattle, WA" "Portland, OR" DRIVE
```

Outputs: `drive-route_Seattle_WA-Portland_OR.gpx`

---

## License

MIT License — see [LICENSE](LICENSE) for details.
