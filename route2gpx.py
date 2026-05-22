#!/usr/bin/env python3
"""Convert a Google Routes API route to a GPX file."""

import argparse
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import polyline
import requests
from dotenv import load_dotenv

ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELD_MASK = "routes.polyline"
REQUEST_TIMEOUT_SECONDS = 30
VALID_MODES = ("DRIVE", "TRANSIT", "BICYCLE", "WALK")


class Route2GpxError(Exception):
    """Raised when route conversion cannot continue."""


def sanitize_filename(value):
    return re.sub(r"[^a-zA-Z0-9_\-\s]", "_", value)


def escape_xml(text):
    """Escape special characters for XML output."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def build_headers(api_key):
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": FIELD_MASK,
    }


def build_payload(origin, destination, mode):
    return {
        "origin": {"address": origin},
        "destination": {"address": destination},
        "travelMode": mode,
        "polylineQuality": "HIGH_QUALITY",
    }


def get_api_key():
    api_key = os.getenv("GOOGLE_ROUTES_API_KEY")
    if not api_key:
        raise Route2GpxError("Google API key not found. Set GOOGLE_ROUTES_API_KEY.")
    return api_key


def fetch_route_data(origin, destination, mode, api_key):
    try:
        response = requests.post(
            ENDPOINT,
            json=build_payload(origin, destination, mode),
            headers=build_headers(api_key),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        raise Route2GpxError(f"API request failed: {error}") from error

    if response.status_code != 200:
        raise Route2GpxError(f"API request failed: {response.text}")

    try:
        return response.json()
    except ValueError as error:
        raise Route2GpxError("API response was not valid JSON.") from error


def extract_encoded_polyline(data):
    try:
        return data["routes"][0]["polyline"]["encodedPolyline"]
    except (KeyError, IndexError, TypeError) as error:
        raise Route2GpxError("No route found or invalid response.") from error


def generate_gpx(origin, destination, coordinates, start_time=None):
    if not coordinates:
        raise Route2GpxError("No coordinates found in route polyline.")

    start_time = start_time or datetime.now(UTC)
    gpx_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="route2gpx" xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <trk><name>Route: {escape_xml(origin)} to {escape_xml(destination)}</name>",
        "    <trkseg>",
    ]

    for idx, (lat, lon) in enumerate(coordinates):
        point_time = (start_time + timedelta(seconds=idx * 60)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        gpx_lines.extend(
            [
                f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">',
                "        <ele>0</ele>",
                f"        <time>{point_time}</time>",
                "      </trkpt>",
            ]
        )

    gpx_lines.extend(["    </trkseg>", "  </trk>", "</gpx>"])
    return "\n".join(gpx_lines)


def build_output_filename(origin, destination, mode):
    safe_origin = sanitize_filename(origin)
    safe_destination = sanitize_filename(destination)
    safe_mode = sanitize_filename(mode.lower())
    return f"{safe_mode}-route_{safe_origin}-{safe_destination}.gpx"


def convert_route(origin, destination, mode, output_dir=Path(".")):
    api_key = get_api_key()
    data = fetch_route_data(origin, destination, mode, api_key)
    encoded_polyline = extract_encoded_polyline(data)
    coordinates = polyline.decode(encoded_polyline)
    gpx_content = generate_gpx(origin, destination, coordinates)
    output_file = Path(output_dir) / build_output_filename(origin, destination, mode)
    output_file.write_text(gpx_content, encoding="utf-8")
    return output_file


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Compute route and export as GPX.")
    parser.add_argument("origin", help="Start location (address or lat,lng).")
    parser.add_argument("destination", help="End location (address or lat,lng).")
    parser.add_argument("mode", choices=VALID_MODES, help="Travel mode.")
    return parser.parse_args(argv)


def main(argv=None):
    load_dotenv()
    args = parse_args(argv)

    try:
        output_file = convert_route(args.origin, args.destination, args.mode)
    except Route2GpxError as error:
        print(error, file=sys.stderr)
        return 1

    print(f"GPX file '{output_file}' created successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
