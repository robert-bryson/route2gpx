#!/usr/bin/env python3
"""
Google Routes API to GPX Converter
This script retrieves a route using the Google Routes API and exports it as a GPX file.
"""

import argparse
import os
import sys
from datetime import datetime, timedelta, UTC

import polyline
import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

API_KEY = os.getenv("GOOGLE_ROUTES_API_KEY")
if API_KEY is None:
    raise ValueError("Google API key not found in .env file.")

# Command-line arguments
parser = argparse.ArgumentParser(description="Compute route and export as GPX.")
parser.add_argument("origin", help="Start location (address or lat,lng).")
parser.add_argument("destination", help="End location (address or lat,lng).")
parser.add_argument("mode", choices=["DRIVE", "TRANSIT"], help="Travel mode.")
args = parser.parse_args()

# Google Routes API endpoint
ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"

headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": API_KEY,
    "X-Goog-FieldMask": "routes.polyline",
}

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

# Generate GPX content
start_time = datetime.now(UTC)

gpx_lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="route2gpx">',
    f"  <trk><name>Route: {args.origin} to {args.destination}</name>",
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

import re


# Helper function to sanitize filenames
def sanitize_filename(s):
    return re.sub(r"[^a-zA-Z0-9_\-\s]", "_", s)


# Sanitize input args for filename
safe_origin = sanitize_filename(args.origin)
safe_destination = sanitize_filename(args.destination)
safe_mode = sanitize_filename(args.mode.lower())

# Create safe output file name
output_file = f"{safe_mode}-route_{safe_origin}-{safe_destination}.gpx"


# Write GPX to file
output_file = f"{args.mode}-route_{args.origin}-{args.destination}.gpx"
with open(output_file, "w") as file:
    file.write(gpx_content)

print(f"GPX file '{output_file}' created successfully.")
