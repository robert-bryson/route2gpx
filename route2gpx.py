#!/usr/bin/env python3
"""
Google Routes API to GPX Converter
This script retrieves a route using the Google Routes API and exports it as a GPX file.
"""

import argparse
import os
import re
import sys
from datetime import UTC, datetime, timedelta

import polyline
import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

API_KEY = os.getenv("GOOGLE_ROUTES_API_KEY")
if API_KEY is None:
    raise ValueError("Google API key not found in .env file.")


# Helper function to sanitize filenames
def sanitize_filename(s):
    return re.sub(r"[^a-zA-Z0-9_\-\s]", "_", s)


def escape_xml(text):
    """Escape special characters for XML output."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


# Command-line arguments
parser = argparse.ArgumentParser(description="Compute route and export as GPX.")
parser.add_argument("origin", help="Start location (address or lat,lng).")
parser.add_argument("destination", help="End location (address or lat,lng).")
parser.add_argument(
    "mode", choices=["DRIVE", "TRANSIT", "BICYCLE", "WALK"], help="Travel mode."
)
args = parser.parse_args()

# Google Routes API endpoint
ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"

headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": API_KEY,
    "X-Goog-FieldMask": "routes.polyline",
}

# docs at https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes#request-body
payload = {
    "origin": {"address": args.origin},
    "destination": {"address": args.destination},
    "travelMode": args.mode,
    # "routeModifiers": {
    #     "avoidHighways": True
    # },
    # "routingPreference": "TRAFFIC_AWARE",
    "polylineQuality": "HIGH_QUALITY",
}

# Request route from Google Routes API
response = requests.post(ENDPOINT, json=payload, headers=headers)

if response.status_code != 200:
    print(f"API request failed: {response.text}")
    sys.exit(1)

data = response.json()

try:
    encoded_polyline = data["routes"][0]["polyline"]["encodedPolyline"]
except (KeyError, IndexError):
    print("No route found or invalid response.")
    sys.exit(1)

# Decode polyline into coordinates (lat, lng)
coordinates = polyline.decode(encoded_polyline)

# Sanitize input args for filename
safe_origin = sanitize_filename(args.origin)
safe_destination = sanitize_filename(args.destination)
safe_mode = sanitize_filename(args.mode.lower())

# Generate GPX content
start_time = datetime.now(UTC)

gpx_lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="route2gpx">',
    f"  <trk><name>Route: {escape_xml(args.origin)} to {escape_xml(args.destination)}</name>",
    "    <trkseg>",
]

# Populate GPX points with dummy elevation and timestamps
for idx, (lat, lon) in enumerate(coordinates):
    point_time = (start_time + timedelta(seconds=idx * 60)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    elevation = 0  # dummy elevation; can be modified
    gpx_lines.extend(
        [
            f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">',
            f"        <ele>{elevation}</ele>",
            f"        <time>{point_time}</time>",
            "      </trkpt>",
        ]
    )

gpx_lines.extend(["    </trkseg>", "  </trk>", "</gpx>"])

gpx_content = "\n".join(gpx_lines)

# Use sanitized filename
output_file = f"{safe_mode}-route_{safe_origin}-{safe_destination}.gpx"

# Write GPX to file
with open(output_file, "w") as file:
    file.write(gpx_content)

print(f"GPX file '{output_file}' created successfully.")
