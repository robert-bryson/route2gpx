# `route2gpx`
Sometimes you gotta fudge a track..

A simple Python CLI tool that retrieves routes from Google Routes API (Compute Routes) and converts them into GPX files suitable for GPS devices or mapping software.

### Features

- Retrieves routes using Google's modern Routes API.
- Supports driving and transit (including train routes).
- Exports routes to GPX format with dummy timestamps and elevation data.

## Installation

**Requirements:**
- Python
- Poetry
- Google Cloud project with [Routes API enabled](https://console.cloud.google.com/apis/library/routes.googleapis.com)

### Setup

Clone this repository:

```bash
git clone https://github.com/robert-bryson/route2gpx.git
cd route2gpx
```

Install required Python packages:

```bash
poetry install
```

Create a `.env` file in the project root with your Google API key:

`GOOGLE_ROUTES_API_KEY=your_google_api_key_here`

## Usage

Run the script from your terminal:

```bash
poetry run python route2gpx.py "Start Location" "End Location" MODE
```

Replace "Start Location" and "End Location" with places, addresses, or latitude/longitude coordinates.

`MODE` can be either `DRIVE` or `TRANSIT`.

### Example

```bash
python route2gpx.py "Seattle, WA" "Portland, OR" DRIVE
```

This will generate a GPX file named something like:

`drive-route_Seattle_ WA-Portland_ OR.gpx`

## License

This project is licensed under the MIT License. See the LICENSE file for details.

