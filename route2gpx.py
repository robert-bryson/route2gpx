#!/usr/bin/env python3
"""Convert a Google Routes API route to a GPX file."""

import argparse
import math
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import polyline
import requests
from dotenv import load_dotenv

ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELD_MASK = "routes.polyline.encodedPolyline,routes.duration"
REQUEST_TIMEOUT_SECONDS = 30
VALID_MODES = ("DRIVE", "TRANSIT", "BICYCLE", "WALK")


class Route2GpxError(Exception):
    """Raised when route conversion cannot continue."""


def sanitize_filename(value):
    return re.sub(r"[^a-zA-Z0-9_\-\s]", "_", value)[:80]


def escape_xml(text):
    """Escape special characters for XML output."""
    text = re.sub(
        r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "\ufffd", text
    )
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
    api_key = os.getenv("GOOGLE_ROUTES_API_KEY", "").strip()
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
        encoded = data["routes"][0]["polyline"]["encodedPolyline"]
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("Empty route geometry")
        return encoded
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise Route2GpxError("No route found or invalid response.") from error


def generate_gpx(
    origin,
    destination,
    coordinates,
    start_time=None,
    *,
    synthesize_times=False,
    duration_seconds=None,
):
    if not coordinates:
        raise Route2GpxError("No coordinates found in route polyline.")

    if any(
        not math.isfinite(lat)
        or not math.isfinite(lon)
        or not -90 <= lat <= 90
        or not -180 <= lon <= 180
        for lat, lon in coordinates
    ):
        raise Route2GpxError("Route contains invalid coordinates.")

    include_times = synthesize_times or start_time is not None
    start_time = start_time or datetime.now(UTC)
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=UTC)
    start_time = start_time.astimezone(UTC)
    cumulative = [0.0]
    for (lat1, lon1), (lat2, lon2) in zip(coordinates, coordinates[1:]):
        a = (
            math.sin(math.radians(lat2 - lat1) / 2) ** 2
            + math.cos(math.radians(lat1))
            * math.cos(math.radians(lat2))
            * math.sin(math.radians(lon2 - lon1) / 2) ** 2
        )
        cumulative.append(
            cumulative[-1]
            + 6371000 * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0, 1 - a)))
        )
    seconds = (
        duration_seconds
        if duration_seconds is not None
        and math.isfinite(duration_seconds)
        and duration_seconds >= 0
        else max(len(coordinates) - 1, 0) * 60
    )
    gpx_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="route2gpx" xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <trk><name>Route: {escape_xml(origin)} to {escape_xml(destination)}</name>",
        "    <trkseg>",
    ]

    for idx, (lat, lon) in enumerate(coordinates):
        gpx_lines.append(f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">')
        if include_times:
            fraction = (
                cumulative[idx] / cumulative[-1]
                if cumulative[-1]
                else idx / max(len(coordinates) - 1, 1)
            )
            point_time = (start_time + timedelta(seconds=seconds * fraction)).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
            gpx_lines.append(f"        <time>{point_time}</time>")
        gpx_lines.append("      </trkpt>")

    gpx_lines.extend(["    </trkseg>", "  </trk>", "</gpx>"])
    return "\n".join(gpx_lines)


def build_output_filename(origin, destination, mode):
    safe_origin = sanitize_filename(origin)
    safe_destination = sanitize_filename(destination)
    safe_mode = sanitize_filename(mode.lower())
    return f"{safe_mode}-route_{safe_origin}-{safe_destination}.gpx"


def convert_route(
    origin,
    destination,
    mode,
    output_dir=Path("."),
    *,
    output_file=None,
    force=False,
    synthesize_times=False,
    start_time=None,
):
    api_key = get_api_key()
    data = fetch_route_data(origin, destination, mode, api_key)
    encoded_polyline = extract_encoded_polyline(data)
    try:
        coordinates = polyline.decode(encoded_polyline)
    except (ValueError, TypeError, IndexError) as error:
        raise Route2GpxError("Route geometry was malformed.") from error
    if len(coordinates) < 2:
        raise Route2GpxError("A route needs at least two valid points.")
    try:
        duration = float(data["routes"][0].get("duration", "").removesuffix("s"))
    except (ValueError, TypeError, AttributeError):
        duration = None
    gpx_content = generate_gpx(
        origin,
        destination,
        coordinates,
        start_time,
        synthesize_times=synthesize_times,
        duration_seconds=duration,
    )
    output_file = (
        Path(output_file)
        if output_file is not None
        else Path(output_dir) / build_output_filename(origin, destination, mode)
    )
    try:
        with output_file.open("w" if force else "x", encoding="utf-8") as target:
            target.write(gpx_content)
    except FileExistsError as error:
        raise Route2GpxError(
            f"Output already exists: {output_file}. Use --force to replace it."
        ) from error
    except OSError as error:
        raise Route2GpxError(f"Could not write GPX file: {error}") from error
    return output_file


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Compute route and export as GPX.")
    parser.add_argument("origin", help="Start location (address or lat,lng).")
    parser.add_argument("destination", help="End location (address or lat,lng).")
    parser.add_argument("mode", choices=VALID_MODES, help="Travel mode.")
    parser.add_argument("--output", type=Path, help="Output file path.")
    parser.add_argument(
        "--force", action="store_true", help="Replace an existing output."
    )
    parser.add_argument(
        "--timestamps",
        action="store_true",
        help="Synthesize point timestamps from route duration (omitted by default).",
    )
    parser.add_argument(
        "--start-time",
        type=datetime.fromisoformat,
        help="ISO start time for synthesized timestamps.",
    )
    return parser.parse_args(argv)


def main(argv=None):
    load_dotenv()
    args = parse_args(argv)

    try:
        output_file = convert_route(
            args.origin,
            args.destination,
            args.mode,
            output_file=args.output,
            force=args.force,
            synthesize_times=args.timestamps,
            start_time=args.start_time,
        )
    except Route2GpxError as error:
        print(error, file=sys.stderr)
        return 1

    print(f"GPX file '{output_file}' created successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
