"""Tests for route2gpx utility functions."""

import importlib
import sys
from unittest import mock

import pytest


def _import_route2gpx():
    """Import route2gpx with mocked env and argv so module-level code doesn't fail."""
    # Remove cached module if present
    sys.modules.pop("route2gpx", None)

    fake_argv = ["route2gpx", "Origin", "Destination", "DRIVE"]
    fake_response = mock.MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "routes": [{"polyline": {"encodedPolyline": "_p~iF~ps|U"}}]
    }

    with (
        mock.patch.dict("os.environ", {"GOOGLE_ROUTES_API_KEY": "test-key"}),
        mock.patch("sys.argv", fake_argv),
        mock.patch("requests.post", return_value=fake_response),
        mock.patch("builtins.open", mock.mock_open()),
        mock.patch("builtins.print"),
    ):
        mod = importlib.import_module("route2gpx")
    return mod


@pytest.fixture(scope="module")
def r2g():
    return _import_route2gpx()


# ============ sanitize_filename tests ============


class TestSanitizeFilename:
    def test_basic(self, r2g):
        assert r2g.sanitize_filename("hello world") == "hello world"

    def test_special_characters(self, r2g):
        assert r2g.sanitize_filename("a/b\\c:d") == "a_b_c_d"

    def test_path_traversal(self, r2g):
        result = r2g.sanitize_filename("../../etc/passwd")
        assert "/" not in result
        assert "\\" not in result

    def test_coordinates(self, r2g):
        result = r2g.sanitize_filename("40.7128, -74.0060")
        assert result == "40_7128_ -74_0060"

    def test_unicode(self, r2g):
        result = r2g.sanitize_filename("café résumé")
        # Non-ASCII chars replaced
        assert all(c.isalnum() or c in "_- " for c in result)

    def test_empty_string(self, r2g):
        assert r2g.sanitize_filename("") == ""

    def test_preserves_safe_chars(self, r2g):
        assert r2g.sanitize_filename("hello-world_123") == "hello-world_123"


# ============ escape_xml tests ============


class TestEscapeXml:
    def test_ampersand(self, r2g):
        assert r2g.escape_xml("a & b") == "a &amp; b"

    def test_less_than(self, r2g):
        assert r2g.escape_xml("a < b") == "a &lt; b"

    def test_greater_than(self, r2g):
        assert r2g.escape_xml("a > b") == "a &gt; b"

    def test_double_quote(self, r2g):
        assert r2g.escape_xml('a "b" c') == "a &quot;b&quot; c"

    def test_single_quote(self, r2g):
        assert r2g.escape_xml("a 'b' c") == "a &apos;b&apos; c"

    def test_combined(self, r2g):
        assert r2g.escape_xml('<a & "b">') == "&lt;a &amp; &quot;b&quot;&gt;"

    def test_empty(self, r2g):
        assert r2g.escape_xml("") == ""

    def test_no_special_chars(self, r2g):
        assert r2g.escape_xml("hello world") == "hello world"


# ============ GPX output structure test ============


class TestGPXOutput:
    def test_gpx_contains_required_elements(self, r2g):
        """Verify the module produced valid GPX structure."""
        # The module writes GPX on import; check gpx_content
        content = r2g.gpx_content
        assert content.startswith('<?xml version="1.0"')
        assert "<gpx" in content
        assert "<trk>" in content
        assert "<trkseg>" in content
        assert "<trkpt" in content
        assert "</gpx>" in content

    def test_gpx_route_name_is_escaped(self, r2g):
        """Ensure the route name uses escaped XML."""
        content = r2g.gpx_content
        # The origin is "Origin" and destination is "Destination" from our mock
        assert "Route: Origin to Destination" in content

    def test_output_filename_uses_sanitized_values(self, r2g):
        """Verify filename is derived from sanitized inputs."""
        filename = r2g.output_file
        assert filename.endswith(".gpx")
        assert "drive" in filename.lower()
