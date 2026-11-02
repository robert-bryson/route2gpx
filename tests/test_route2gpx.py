"""Tests for route2gpx utility and CLI behavior."""

from datetime import UTC, datetime
from unittest import mock
from xml.etree import ElementTree

import pytest
import requests

import route2gpx

# ============ sanitize_filename tests ============


class TestSanitizeFilename:
    def test_basic(self):
        assert route2gpx.sanitize_filename("hello world") == "hello world"

    def test_special_characters(self):
        assert route2gpx.sanitize_filename("a/b\\c:d") == "a_b_c_d"

    def test_path_traversal(self):
        result = route2gpx.sanitize_filename("../../etc/passwd")
        assert "/" not in result
        assert "\\" not in result

    def test_coordinates(self):
        result = route2gpx.sanitize_filename("40.7128, -74.0060")
        assert result == "40_7128_ -74_0060"

    def test_unicode(self):
        result = route2gpx.sanitize_filename("café résumé")
        # Non-ASCII chars replaced
        assert all(c.isalnum() or c in "_- " for c in result)

    def test_empty_string(self):
        assert route2gpx.sanitize_filename("") == ""

    def test_preserves_safe_chars(self):
        assert route2gpx.sanitize_filename("hello-world_123") == "hello-world_123"


# ============ escape_xml tests ============


class TestEscapeXml:
    def test_ampersand(self):
        assert route2gpx.escape_xml("a & b") == "a &amp; b"

    def test_less_than(self):
        assert route2gpx.escape_xml("a < b") == "a &lt; b"

    def test_greater_than(self):
        assert route2gpx.escape_xml("a > b") == "a &gt; b"

    def test_double_quote(self):
        assert route2gpx.escape_xml('a "b" c') == "a &quot;b&quot; c"

    def test_single_quote(self):
        assert route2gpx.escape_xml("a 'b' c") == "a &apos;b&apos; c"

    def test_combined(self):
        assert route2gpx.escape_xml('<a & "b">') == "&lt;a &amp; &quot;b&quot;&gt;"

    def test_empty(self):
        assert route2gpx.escape_xml("") == ""

    def test_no_special_chars(self):
        assert route2gpx.escape_xml("hello world") == "hello world"


# ============ API request helpers ============


class TestRouteApiHelpers:
    def test_build_payload(self):
        assert route2gpx.build_payload("A", "B", "BICYCLE") == {
            "origin": {"address": "A"},
            "destination": {"address": "B"},
            "travelMode": "BICYCLE",
            "polylineQuality": "HIGH_QUALITY",
        }

    def test_fetch_route_data_uses_timeout_and_headers(self):
        response = mock.Mock(status_code=200)
        response.json.return_value = {"routes": []}

        with mock.patch("route2gpx.requests.post", return_value=response) as post:
            result = route2gpx.fetch_route_data("A", "B", "DRIVE", "test-key")

        assert result == {"routes": []}
        post.assert_called_once()
        kwargs = post.call_args.kwargs
        assert kwargs["timeout"] == route2gpx.REQUEST_TIMEOUT_SECONDS
        assert kwargs["headers"]["X-Goog-Api-Key"] == "test-key"
        assert kwargs["json"]["travelMode"] == "DRIVE"

    def test_fetch_route_data_rejects_api_error(self):
        response = mock.Mock(status_code=403, text="forbidden")

        with mock.patch("route2gpx.requests.post", return_value=response):
            with pytest.raises(route2gpx.Route2GpxError, match="forbidden"):
                route2gpx.fetch_route_data("A", "B", "DRIVE", "bad-key")

    def test_fetch_route_data_wraps_network_errors(self):
        with mock.patch(
            "route2gpx.requests.post", side_effect=requests.Timeout("too slow")
        ):
            with pytest.raises(route2gpx.Route2GpxError, match="too slow"):
                route2gpx.fetch_route_data("A", "B", "DRIVE", "test-key")

    def test_fetch_route_data_rejects_invalid_json(self):
        response = mock.Mock(status_code=200, text="not json")
        response.json.side_effect = ValueError("invalid json")

        with mock.patch("route2gpx.requests.post", return_value=response):
            with pytest.raises(route2gpx.Route2GpxError, match="not valid JSON"):
                route2gpx.fetch_route_data("A", "B", "DRIVE", "test-key")

    def test_extract_encoded_polyline(self):
        data = {"routes": [{"polyline": {"encodedPolyline": "abc"}}]}
        assert route2gpx.extract_encoded_polyline(data) == "abc"

    def test_extract_encoded_polyline_rejects_invalid_response(self):
        with pytest.raises(route2gpx.Route2GpxError, match="No route found"):
            route2gpx.extract_encoded_polyline({"routes": []})


# ============ GPX output structure ============


class TestGPXOutput:
    def test_replaces_forbidden_xml_characters_in_names(self):
        content = route2gpx.generate_gpx("A\x00\x01B\ud800😀", "End", [(1, 1), (2, 2)])
        root = ElementTree.fromstring(content)
        name = root.find("{*}trk/{*}name")
        assert name.text == "Route: A��B�😀 to End"

    def test_gpx_contains_required_elements(self):
        content = route2gpx.generate_gpx(
            "Origin",
            "Destination",
            [(38.5, -120.2), (40.7, -120.95)],
            start_time=datetime(2026, 5, 22, 12, 0, tzinfo=UTC),
        )
        assert content.startswith('<?xml version="1.0"')
        assert "<gpx" in content
        assert 'xmlns="http://www.topografix.com/GPX/1/1"' in content
        assert "<trk>" in content
        assert "<trkseg>" in content
        assert "<trkpt" in content
        assert "</gpx>" in content
        assert "2026-05-22T12:00:00Z" in content
        assert "2026-05-22T12:01:00Z" in content

    def test_gpx_route_name_is_escaped(self):
        content = route2gpx.generate_gpx("<Origin>", "A & B", [(1, 2)])
        assert "Route: &lt;Origin&gt; to A &amp; B" in content

    def test_output_filename_uses_sanitized_values(self):
        filename = route2gpx.build_output_filename("A/B", "C:D", "DRIVE")
        assert filename == "drive-route_A_B-C_D.gpx"

    def test_generate_gpx_rejects_empty_coordinates(self):
        with pytest.raises(route2gpx.Route2GpxError, match="No coordinates"):
            route2gpx.generate_gpx("A", "B", [])


# ============ CLI behavior ============


class TestCli:
    def test_main_writes_gpx_file(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("GOOGLE_ROUTES_API_KEY", "test-key")
        response = mock.Mock(status_code=200, text="")
        response.json.return_value = {
            "routes": [{"polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC"}}]
        }

        with mock.patch("route2gpx.requests.post", return_value=response) as post:
            exit_code = route2gpx.main(["Origin", "Destination", "DRIVE"])

        assert exit_code == 0
        output_file = tmp_path / "drive-route_Origin-Destination.gpx"
        assert output_file.exists()
        assert "38.500000" in output_file.read_text(encoding="utf-8")
        assert "created successfully" in capsys.readouterr().out
        post.assert_called_once()

    def test_main_returns_error_without_api_key(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("GOOGLE_ROUTES_API_KEY", raising=False)

        with (
            mock.patch("route2gpx.load_dotenv"),
            mock.patch("route2gpx.requests.post") as post,
        ):
            exit_code = route2gpx.main(["Origin", "Destination", "DRIVE"])

        assert exit_code == 1
        assert "GOOGLE_ROUTES_API_KEY" in capsys.readouterr().err
        post.assert_not_called()


class TestOutputIntegrity:
    @pytest.mark.parametrize("encoded", ["", None, 0])
    def test_rejects_empty_or_nonstring_route_geometry(self, encoded):
        with pytest.raises(route2gpx.Route2GpxError, match="invalid response"):
            route2gpx.extract_encoded_polyline(
                {"routes": [{"polyline": {"encodedPolyline": encoded}}]}
            )

    def test_explicit_naive_start_time_uses_utc(self):
        content = route2gpx.generate_gpx(
            "A", "B", [(1, 1), (2, 2)], start_time=datetime(2026, 11, 2, 10, 30)
        )
        assert "2026-11-02T10:30:00Z" in content

    def test_rejects_single_point_route_before_writing(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GOOGLE_ROUTES_API_KEY", "test-key")
        with mock.patch(
            "route2gpx.fetch_route_data",
            return_value={"routes": [{"polyline": {"encodedPolyline": "_p~iF~ps|U"}}]},
        ):
            with pytest.raises(route2gpx.Route2GpxError, match="at least two"):
                route2gpx.convert_route("A", "B", "DRIVE", output_dir=tmp_path)
        assert not list(tmp_path.iterdir())

    def test_cli_reports_output_filesystem_error(self, tmp_path, capsys):
        target = tmp_path / "missing-directory" / "output.gpx"
        with (
            mock.patch("route2gpx.load_dotenv"),
            mock.patch("route2gpx.get_api_key", return_value="test-key"),
            mock.patch(
                "route2gpx.fetch_route_data",
                return_value={
                    "routes": [{"polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC"}}]
                },
            ),
        ):
            result = route2gpx.main(["A", "B", "DRIVE", "--output", str(target)])
        assert result == 1
        assert "Could not write GPX file" in capsys.readouterr().err
        assert not target.exists()

    def test_omits_unknown_elevation_and_unrequested_timestamps(self):
        content = route2gpx.generate_gpx("A", "B", [(1, 1), (2, 2)])
        assert "<ele>" not in content
        assert "<time>" not in content

    def test_rejects_invalid_coordinates(self):
        with pytest.raises(route2gpx.Route2GpxError, match="invalid coordinates"):
            route2gpx.generate_gpx("A", "B", [(95, 0), (1, 1)])

    def test_wraps_malformed_polyline(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_ROUTES_API_KEY", "test-key")
        with mock.patch(
            "route2gpx.fetch_route_data",
            return_value={"routes": [{"polyline": {"encodedPolyline": "_"}}]},
        ):
            with pytest.raises(route2gpx.Route2GpxError, match="malformed"):
                route2gpx.convert_route("A", "B", "DRIVE")

    def test_requires_force_to_overwrite(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GOOGLE_ROUTES_API_KEY", "test-key")
        target = tmp_path / "custom.gpx"
        target.write_text("original")
        with mock.patch(
            "route2gpx.fetch_route_data",
            return_value={
                "routes": [{"polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC"}}]
            },
        ):
            with pytest.raises(route2gpx.Route2GpxError, match="already exists"):
                route2gpx.convert_route("A", "B", "DRIVE", output_file=target)
            assert target.read_text() == "original"
            route2gpx.convert_route("A", "B", "DRIVE", output_file=target, force=True)
            assert "<gpx" in target.read_text()
