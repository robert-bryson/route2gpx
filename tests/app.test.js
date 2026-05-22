/**
 * Tests for pure utility functions in app.js.
 *
 * Strategy: Vitest runs with jsdom environment. We mock Leaflet and build
 * the minimal DOM structure that app.js expects at load time, then import
 * app.js as an ES module. app.js exposes a compatibility surface on globalThis
 * while the source migration continues.
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
const mapEventHandlers = {};
const popupInstances = [];

// ---- Setup before loading app.js ----
beforeAll(async () => {
  // Mock localStorage
  const store = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: vi.fn((k) => store[k] ?? null),
      setItem: vi.fn((k, v) => { store[k] = String(v); }),
      removeItem: vi.fn((k) => { delete store[k]; }),
      clear: vi.fn(),
    },
    configurable: true,
  });

  // Mock navigator.geolocation
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: { getCurrentPosition: vi.fn() },
    configurable: true,
  });

  // Mock Leaflet
  const mockPolyline = {
    addTo: vi.fn().mockReturnThis(),
    bindPopup: vi.fn().mockReturnThis(),
    bindTooltip: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    getBounds: vi.fn(() => [[0, 0], [1, 1]]),
    getCenter: vi.fn(() => [0.5, 0.5]),
    setStyle: vi.fn(),
    openPopup: vi.fn(),
  };

  const mockMarker = {
    addTo: vi.fn().mockReturnThis(),
    bindTooltip: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    _icon: null,
  };

  globalThis.__mapEventHandlers = mapEventHandlers;
  globalThis.__popupInstances = popupInstances;
  globalThis.L = {
    map: vi.fn(() => {
      const mapMock = {
        fitBounds: vi.fn(),
        closePopup: vi.fn(),
        removeLayer: vi.fn(),
        on: vi.fn((eventName, handler) => {
          mapEventHandlers[eventName] = handler;
          return mapMock;
        }),
      };
      return mapMock;
    }),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    polyline: vi.fn(() => ({ ...mockPolyline })),
    marker: vi.fn(() => ({ ...mockMarker })),
    divIcon: vi.fn(() => ({})),
    popup: vi.fn(() => {
      const popupMock = {
        content: '',
        latlng: null,
        setContent: vi.fn((content) => {
          popupMock.content = typeof content === 'function' ? content : content;
          return popupMock;
        }),
        setLatLng: vi.fn((latlng) => {
          popupMock.latlng = latlng;
          return popupMock;
        }),
        openOn: vi.fn(() => popupMock),
      };
      popupInstances.push(popupMock);
      return popupMock;
    }),
    DomEvent: { stopPropagation: vi.fn(), preventDefault: vi.fn() },
  };

  // Build minimal DOM with all the element IDs app.js expects
  const ids = [
    'app',
    'map', 'origin', 'destination', 'routesList', 'addStopBtn', 'reverseRouteBtn',
    'colorSwatch', 'unitKm', 'unitMi', 'getRouteBtn', 'downloadAllBtn', 'clearAllBtn',
    'apiKeyMapBtn', 'clickModeBtn', 'locateMeBtn', 'closeModalBtn', 'saveApiKeyBtn',
    'colorOptions', 'routeColor', 'colorDropdown', 'stopsContainer', 'apiKeyStatus', 'rememberApiKey',
    'mapModeIndicator', 'clickModeTarget', 'cancelClickModeBtn', 'originMapPickBtn', 'destinationMapPickBtn',
    'pickWaypointMapBtn',
    'apiKeyModal', 'apiKeyInput', 'apiKeyStorageHint', 'status', 'travelMode',
    'filenameModal', 'filenameInput', 'filenamePreview', 'cancelFilenameBtn', 'confirmFilenameBtn',
    'importDropZone', 'importFileInput',
    'fogDropZone', 'fogFileInput', 'fogBadge', 'fogRemoveBtn', 'fogVisibilityToggle',
  ];

  ids.forEach(id => {
    const el = document.createElement(
      ['origin', 'destination', 'apiKeyInput', 'routeColor', 'filenameInput', 'rememberApiKey', 'travelMode'].includes(id) ? 'input' :
        id === 'importFileInput' ? 'input' : 'div'
    );
    el.id = id;
    if (id === 'importFileInput') {
      el.type = 'file';
    }
    if (id === 'rememberApiKey') {
      el.type = 'checkbox';
    }
    if (id === 'travelMode') {
      el.type = 'hidden';
      el.value = 'DRIVE';
    }
    if (id === 'colorOptions') {
      el.setAttribute('role', 'radiogroup');
    }
    if (id === 'colorDropdown') {
      el.setAttribute('aria-hidden', 'true');
    }
    if (id === 'colorSwatch') {
      el.setAttribute('aria-expanded', 'false');
      el.setAttribute('aria-controls', 'colorDropdown');
    }
    document.body.appendChild(el);
  });

  const modeGroup = document.createElement('div');
  modeGroup.setAttribute('role', 'radiogroup');
  ['DRIVE', 'BICYCLE', 'WALK', 'TRANSIT'].forEach((mode, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.travelMode = mode;
    button.setAttribute('aria-checked', index === 0 ? 'true' : 'false');
    modeGroup.appendChild(button);
  });
  document.body.appendChild(modeGroup);

  document.getElementById('originMapPickBtn').dataset.mapPickTarget = 'origin';
  document.getElementById('originMapPickBtn').dataset.mapPickFlow = 'single';
  document.getElementById('destinationMapPickBtn').dataset.mapPickTarget = 'destination';
  document.getElementById('destinationMapPickBtn').dataset.mapPickFlow = 'single';
  document.getElementById('pickWaypointMapBtn').dataset.mapPickTarget = 'waypoint';
  document.getElementById('pickWaypointMapBtn').dataset.mapPickFlow = 'route';

  // Help toggle (queried by class)
  const helpBtn = document.createElement('button');
  helpBtn.classList.add('help-toggle');
  document.body.appendChild(helpBtn);

  // GPS field buttons
  ['origin', 'destination'].forEach(field => {
    const btn = document.createElement('button');
    btn.setAttribute('data-gps-field', field);
    document.body.appendChild(btn);
  });

  // Mock pako (used by fog.js)
  globalThis.pako = {
    inflate: vi.fn(() => new Uint8Array(0)),
  };

  // Mock JSZip (used by app.js and fog.js)
  globalThis.JSZip = vi.fn();
  globalThis.JSZip.loadAsync = vi.fn(() => Promise.resolve({ files: {} }));

  await import('../app.js?app-test');
});

// ============ decodePolyline ============
describe('decodePolyline', () => {
  test('decodes a known encoded polyline', () => {
    // Standard test: "_p~iF~ps|U" decodes to approx (38.5, -120.2)
    const points = globalThis.decodePolyline('_p~iF~ps|U');
    expect(points).toHaveLength(1);
    expect(points[0][0]).toBeCloseTo(38.5, 1);
    expect(points[0][1]).toBeCloseTo(-120.2, 1);
  });

  test('decodes multi-point polyline', () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" is a well-known test case
    const points = globalThis.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0][0]).toBeCloseTo(38.5, 1);
    expect(points[1][0]).toBeCloseTo(40.7, 1);
    expect(points[2][0]).toBeCloseTo(43.252, 1);
  });

  test('returns empty array for empty string', () => {
    expect(globalThis.decodePolyline('')).toEqual([]);
  });

  test('returns empty array for malformed encoded polylines', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });

    try {
      expect(globalThis.decodePolyline('a')).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith('Invalid encoded polyline:', expect.stringContaining('ended unexpectedly'));
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

// ============ formatDistance ============
describe('formatDistance', () => {
  test('formats kilometers (small)', () => {
    globalThis.distanceUnit = 'km';
    expect(globalThis.formatDistance(5000)).toBe('5.0 km');
  });

  test('formats kilometers (large >= 10)', () => {
    globalThis.distanceUnit = 'km';
    expect(globalThis.formatDistance(15000)).toBe('15 km');
  });

  test('formats miles (small)', () => {
    globalThis.setUnit('mi', false);
    expect(globalThis.formatDistance(1609.34)).toBe('1.0 mi');
  });

  test('formats miles (large >= 10)', () => {
    globalThis.setUnit('mi', false);
    // 10 miles = 16093.4 meters
    expect(globalThis.formatDistance(16093.4)).toBe('10 mi');
  });

  // Reset to default after
  test('formats zero', () => {
    globalThis.setUnit('km', false);
    expect(globalThis.formatDistance(0)).toBe('0.0 km');
  });
});

// ============ formatDuration ============
describe('formatDuration', () => {
  test('formats minutes-only duration', () => {
    expect(globalThis.formatDuration('1800s')).toBe('30m');
  });

  test('formats hours and minutes', () => {
    expect(globalThis.formatDuration('5400s')).toBe('1h 30m');
  });

  test('handles null/undefined', () => {
    expect(globalThis.formatDuration(null)).toBe('—');
    expect(globalThis.formatDuration(undefined)).toBe('—');
  });

  test('handles invalid string', () => {
    expect(globalThis.formatDuration('abc')).toBe('—');
  });

  test('handles zero seconds', () => {
    expect(globalThis.formatDuration('0s')).toBe('0m');
  });
});

// ============ escapeXml ============
describe('escapeXml', () => {
  test('escapes ampersand', () => {
    expect(globalThis.escapeXml('a & b')).toBe('a &amp; b');
  });

  test('escapes angle brackets', () => {
    expect(globalThis.escapeXml('<tag>')).toBe('&lt;tag&gt;');
  });

  test('escapes quotes', () => {
    expect(globalThis.escapeXml('"hello" \'world\'')).toBe('&quot;hello&quot; &apos;world&apos;');
  });

  test('handles combined special chars', () => {
    expect(globalThis.escapeXml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
  });

  test('passes through plain text', () => {
    expect(globalThis.escapeXml('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(globalThis.escapeXml('')).toBe('');
  });
});

// ============ sanitizeFilename ============
describe('sanitizeFilename', () => {
  test('allows safe characters', () => {
    expect(globalThis.sanitizeFilename('hello-world_123')).toBe('hello-world_123');
  });

  test('replaces special characters', () => {
    expect(globalThis.sanitizeFilename('a/b\\c:d')).toBe('a_b_c_d');
  });

  test('truncates to 50 characters', () => {
    const long = 'a'.repeat(100);
    expect(globalThis.sanitizeFilename(long)).toHaveLength(50);
  });

  test('handles empty string', () => {
    expect(globalThis.sanitizeFilename('')).toBe('');
  });

  test('handles path traversal attempt', () => {
    const result = globalThis.sanitizeFilename('../../etc/passwd');
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
  });
});

// ============ escapeHtml ============
describe('escapeHtml', () => {
  test('escapes HTML entities', () => {
    const result = globalThis.escapeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;');
  });

  test('escapes quotes for safe attribute interpolation', () => {
    expect(globalThis.escapeHtml('bad" onfocus="alert(1)')).toBe('bad&quot; onfocus=&quot;alert(1)');
    expect(globalThis.escapeHtml("bad' onclick='alert(1)")).toBe('bad&#39; onclick=&#39;alert(1)');
  });

  test('passes through plain text', () => {
    expect(globalThis.escapeHtml('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(globalThis.escapeHtml('')).toBe('');
  });
});

// ============ truncate ============
describe('truncate', () => {
  test('returns short string unchanged', () => {
    expect(globalThis.truncate('hello', 10)).toBe('hello');
  });

  test('truncates long string with ellipsis', () => {
    expect(globalThis.truncate('hello world', 5)).toBe('hello...');
  });

  test('handles exact length', () => {
    expect(globalThis.truncate('hello', 5)).toBe('hello');
  });

  test('handles nullish values', () => {
    expect(globalThis.truncate(null, 5)).toBe('');
    expect(globalThis.truncate(undefined, 5)).toBe('');
  });
});

// ============ formatFileSize ============
describe('formatFileSize', () => {
  test('formats bytes', () => {
    expect(globalThis.formatFileSize(500)).toBe('500 B');
  });

  test('formats kilobytes', () => {
    expect(globalThis.formatFileSize(2048)).toBe('2.0 KB');
  });

  test('formats megabytes', () => {
    expect(globalThis.formatFileSize(1048576)).toBe('1.0 MB');
  });

  test('formats zero', () => {
    expect(globalThis.formatFileSize(0)).toBe('0 B');
  });
});

describe('formatDistance invalid values', () => {
  test('returns an unavailable marker for invalid distances', () => {
    expect(globalThis.formatDistance(Number.NaN)).toBe('—');
    expect(globalThis.formatDistance(-1)).toBe('—');
  });
});

// ============ parseLocation ============
describe('parseLocation', () => {
  test('parses lat,lng coordinates', () => {
    const result = globalThis.parseLocation('40.7128, -74.0060');
    expect(result.location.latLng.latitude).toBeCloseTo(40.7128);
    expect(result.location.latLng.longitude).toBeCloseTo(-74.006);
  });

  test('parses coordinates without space', () => {
    const result = globalThis.parseLocation('51.5074,-0.1278');
    expect(result.location.latLng.latitude).toBeCloseTo(51.5074);
    expect(result.location.latLng.longitude).toBeCloseTo(-0.1278);
  });

  test('returns address for non-coordinate input', () => {
    const result = globalThis.parseLocation('New York, NY');
    expect(result.address).toBe('New York, NY');
    expect(result.location).toBeUndefined();
  });

  test('returns address for partial coordinates', () => {
    const result = globalThis.parseLocation('40.7128');
    expect(result.address).toBe('40.7128');
  });

  test('returns address for out-of-range coordinate-like input', () => {
    const result = globalThis.parseLocation('91, -181');
    expect(result.address).toBe('91, -181');
    expect(result.location).toBeUndefined();
  });
});

// ============ coordinate helpers ============
describe('coordinate helpers', () => {
  test('validates latitude and longitude ranges', () => {
    expect(globalThis.isValidLatLng({ latitude: 90, longitude: 180 })).toBe(true);
    expect(globalThis.isValidLatLng({ latitude: 90.1, longitude: 0 })).toBe(false);
    expect(globalThis.isValidLatLng({ latitude: 0, longitude: -180.1 })).toBe(false);
  });

  test('detects coordinate-shaped strings', () => {
    expect(globalThis.looksLikeCoordinatePair('40.7, -74.0')).toBe(true);
    expect(globalThis.looksLikeCoordinatePair('New York, NY')).toBe(false);
  });
});

// ============ waypoint management ============
describe('waypoint management', () => {
  test('reorders waypoint values without losing input contents', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    document.getElementById('stopsContainer').innerHTML = '';

    globalThis.addStop('First stop');
    globalThis.addStop('Second stop');
    globalThis.addStop('Third stop');

    let rows = document.querySelectorAll('.stop-row');
    globalThis.moveStop(rows[1].querySelector('[data-action="move-stop-up"]'), -1);
    expect(globalThis.getStops()).toEqual(['Second stop', 'First stop', 'Third stop']);

    rows = document.querySelectorAll('.stop-row');
    globalThis.moveStop(rows[1].querySelector('[data-action="move-stop-down"]'), 1);
    expect(globalThis.getStops()).toEqual(['Second stop', 'Third stop', 'First stop']);
    expect(document.querySelector('.stop-row [data-action="move-stop-up"]').disabled).toBe(true);
    expect(document.querySelectorAll('.stop-row [data-action="move-stop-down"]')[2].disabled).toBe(true);
  });

  test('moves origin after the next route point', () => {
    document.getElementById('origin').value = 'Origin';
    document.getElementById('destination').value = 'Destination';
    document.getElementById('stopsContainer').innerHTML = '';

    globalThis.addStop('First waypoint');
    globalThis.addStop('Second waypoint');
    globalThis.moveEndpoint('origin', 1);

    expect(document.getElementById('origin').value).toBe('First waypoint');
    expect(globalThis.getStops()).toEqual(['Origin', 'Second waypoint']);
    expect(document.getElementById('destination').value).toBe('Destination');
  });

  test('moves destination before the previous route point', () => {
    document.getElementById('origin').value = 'Origin';
    document.getElementById('destination').value = 'Destination';
    document.getElementById('stopsContainer').innerHTML = '';

    globalThis.addStop('First waypoint');
    globalThis.addStop('Second waypoint');
    globalThis.moveEndpoint('destination', -1);

    expect(document.getElementById('origin').value).toBe('Origin');
    expect(globalThis.getStops()).toEqual(['First waypoint', 'Destination']);
    expect(document.getElementById('destination').value).toBe('Second waypoint');
  });

  test('moves endpoints against each other when there are no waypoints', () => {
    document.getElementById('origin').value = 'Origin';
    document.getElementById('destination').value = 'Destination';
    document.getElementById('stopsContainer').innerHTML = '';

    globalThis.moveEndpoint('origin', 1);

    expect(document.getElementById('origin').value).toBe('Destination');
    expect(globalThis.getStops()).toEqual([]);
    expect(document.getElementById('destination').value).toBe('Origin');
  });
});

// ============ map click picker ============
describe('map click picker', () => {
  test('prompts before setting origin on a plain map click', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    globalThis.exitClickMode();

    globalThis.__mapEventHandlers.click({ latlng: { lat: 40.1234567, lng: -73.9876543 } });

    const popup = globalThis.__popupInstances.at(-1);
    expect(popup.content).toContain('Use this spot as origin?');
    expect(document.getElementById('origin').value).toBe('');

    globalThis.confirmMapClickPrompt();

    expect(document.getElementById('origin').value).toBe('40.123457, -73.987654');
    expect(document.getElementById('destination').value).toBe('');
  });

  test('prompts before setting destination when origin already exists', () => {
    document.getElementById('origin').value = '39.000000, -105.000000';
    document.getElementById('destination').value = '';
    globalThis.exitClickMode();

    globalThis.__mapEventHandlers.click({ latlng: { lat: 41, lng: -75 } });

    const popup = globalThis.__popupInstances.at(-1);
    expect(popup.content).toContain('Use this spot as destination?');
    expect(document.getElementById('destination').value).toBe('');

    globalThis.confirmMapClickPrompt();

    expect(document.getElementById('origin').value).toBe('39.000000, -105.000000');
    expect(document.getElementById('destination').value).toBe('41.000000, -75.000000');
  });

  test('does not prompt on plain map clicks once origin and destination are set', () => {
    document.getElementById('origin').value = '39.000000, -105.000000';
    document.getElementById('destination').value = '41.000000, -75.000000';
    globalThis.exitClickMode();
    const popupCount = globalThis.__popupInstances.length;

    globalThis.__mapEventHandlers.click({ latlng: { lat: 42, lng: -76 } });

    expect(globalThis.__popupInstances).toHaveLength(popupCount);
  });

  test('closes an open route popup without prompting for origin or destination', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    globalThis.exitClickMode();
    const popupCount = globalThis.__popupInstances.length;
    const routePopup = { route2gpxPopupType: 'route' };
    const closePopup = globalThis.L.map.mock.results[0].value.closePopup;
    closePopup.mockClear();

    globalThis.__mapEventHandlers.popupopen({ popup: routePopup });
    globalThis.__mapEventHandlers.preclick({ latlng: { lat: 39, lng: -105 } });
    globalThis.__mapEventHandlers.click({ latlng: { lat: 39, lng: -105 } });

    expect(closePopup).toHaveBeenCalledWith(routePopup);
    expect(globalThis.__popupInstances).toHaveLength(popupCount);
    expect(document.getElementById('origin').value).toBe('');
    expect(document.getElementById('destination').value).toBe('');
  });

  test('sets origin and exits for single-target picking', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';

    globalThis.enterClickMode('origin', 'single');
    globalThis.__mapEventHandlers.click({ latlng: { lat: 40.1234567, lng: -73.9876543 } });

    expect(document.getElementById('origin').value).toBe('40.123457, -73.987654');
    expect(document.getElementById('mapModeIndicator').hidden).toBe(true);
    expect(document.getElementById('clickModeBtn').getAttribute('aria-pressed')).toBe('false');
  });

  test('guided picking advances from origin to destination to waypoint', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    document.getElementById('stopsContainer').innerHTML = '';

    globalThis.enterClickMode('origin', 'route');
    globalThis.__mapEventHandlers.click({ latlng: { lat: 40, lng: -74 } });

    expect(document.getElementById('origin').value).toBe('40.000000, -74.000000');
  expect(document.getElementById('mapModeIndicator').hidden).toBe(false);
    expect(document.getElementById('clickModeTarget').textContent).toContain('destination');

    globalThis.__mapEventHandlers.click({ latlng: { lat: 41, lng: -75 } });

    expect(document.getElementById('destination').value).toBe('41.000000, -75.000000');
    expect(document.getElementById('clickModeTarget').textContent).toContain('waypoint');
    globalThis.exitClickMode();
  });
});

// ============ geolocation ==========
describe('geolocation', () => {
  test('ignores stale geolocation callbacks after a newer request starts', () => {
    const getCurrentPosition = globalThis.navigator.geolocation.getCurrentPosition;
    const callbacks = [];
    getCurrentPosition.mockReset();
    getCurrentPosition.mockImplementation((onSuccess) => {
      callbacks.push(onSuccess);
    });

    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';

    globalThis.useMyLocation('origin');
    globalThis.useMyLocation('destination');

    callbacks[0]({ coords: { latitude: 10, longitude: 20 } });
    expect(document.getElementById('origin').value).toBe('');
    expect(document.getElementById('destination').value).toBe('');

    callbacks[1]({ coords: { latitude: 30, longitude: 40 } });
    expect(document.getElementById('origin').value).toBe('');
    expect(document.getElementById('destination').value).toBe('30.000000, 40.000000');
  });

  test('rejects malformed geolocation coordinates', () => {
    expect(globalThis.getValidatedPositionLatLng({ coords: { latitude: 91, longitude: 0 } })).toBeNull();
    expect(globalThis.getValidatedPositionLatLng({ coords: { latitude: 45, longitude: -120 } })).toEqual({ latitude: 45, longitude: -120 });
  });
});

// ============ route creation form state ============
describe('route creation form state', () => {
  test('keeps origin, destination, and waypoint values after creating a route', async () => {
    const originalFetch = globalThis.fetch;
    document.getElementById('origin').value = 'Origin City';
    document.getElementById('destination').value = 'Destination City';
    document.getElementById('stopsContainer').innerHTML = '';
    globalThis.addStop('Scenic Stop');
    document.getElementById('travelMode').value = 'DRIVE';
    document.getElementById('routeColor').value = '#ff4757';
    localStorage.setItem('route2gpx_apiKey', 'test-key');

    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('computeRoutes')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            routes: [{
              polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
              distanceMeters: 1234,
              duration: '600s',
            }],
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'OK', results: [] }),
      });
    });

    try {
      await globalThis.getRoute();
      expect(document.getElementById('origin').value).toBe('Origin City');
      expect(document.getElementById('destination').value).toBe('Destination City');
      expect(globalThis.getStops()).toEqual(['Scenic Stop']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects API routes with invalid geometry before rendering', async () => {
    const originalFetch = globalThis.fetch;
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    document.getElementById('origin').value = 'Origin City';
    document.getElementById('destination').value = 'Destination City';
    document.getElementById('stopsContainer').innerHTML = '';
    document.getElementById('travelMode').value = 'DRIVE';
    document.getElementById('routeColor').value = '#ff4757';
    sessionStorage.removeItem('route2gpx_apiKey_session');
    localStorage.setItem('route2gpx_apiKey', 'test-key');

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        routes: [{
          polyline: { encodedPolyline: 'a' },
          distanceMeters: 1234,
          duration: '600s',
        }],
      }),
    }));

    try {
      await globalThis.getRoute();
      expect(document.getElementById('status').textContent).toContain('Route geometry was missing or invalid');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      consoleWarn.mockRestore();
    }
  });
});

// ============ route label helpers ============
describe('route label helpers', () => {
  test('extracts formatted addresses from Geocoding API results', () => {
    const data = {
      status: 'OK',
      results: [{ formatted_address: 'Telluride, CO 81435, USA' }],
    };
    expect(globalThis.getReverseGeocodeDisplayName(data)).toBe('Telluride, CO 81435, USA');
  });

  test('extracts display names from Places-shaped results', () => {
    const data = {
      places: [{ displayName: { text: 'Black Canyon of the Gunnison National Park' } }],
    };
    expect(globalThis.getReverseGeocodeDisplayName(data)).toBe('Black Canyon of the Gunnison National Park');
  });

  test('builds route names from resolved endpoint labels', () => {
    expect(globalThis.buildRouteName('Montrose, CO', 'Telluride, CO')).toBe('Montrose, CO → Telluride, CO');
  });

  test('resolves coordinate endpoint labels with reverse geocoding', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        status: 'OK',
        results: [{ formatted_address: 'Ridgway, CO 81432, USA' }],
      }),
    }));

    try {
      await expect(globalThis.resolveRouteEndpointLabel('38.1520, -107.7610', 'test-key')).resolves.toBe('Ridgway, CO 81432, USA');
      expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('maps.googleapis.com/maps/api/geocode/json'), expect.any(Object));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps coordinate endpoint labels when reverse geocoding is denied', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'REQUEST_DENIED', results: [] }),
    }));

    try {
      await expect(globalThis.resolveRouteEndpointLabel('38.1520, -107.7610', 'test-key')).resolves.toBe('38.1520, -107.7610');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ============ assertFileSize ============
describe('assertFileSize', () => {
  test('allows files at the configured limit', () => {
    expect(() => globalThis.assertFileSize({ name: 'route.gpx', size: 1024 }, 1024, 'route.gpx')).not.toThrow();
  });

  test('rejects files above the configured limit', () => {
    expect(() => globalThis.assertFileSize({ name: 'huge.gpx', size: 2048 }, 1024, 'huge.gpx')).toThrow('too large');
  });
});

// ============ storage handling ============
describe('storage handling', () => {
  test('shows a visible error when localStorage quota is exceeded', () => {
    const originalSetItem = globalThis.localStorage.setItem.getMockImplementation();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
    globalThis.localStorage.setItem.mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError');
    });

    try {
      globalThis.saveToStorage();
      expect(consoleError).toHaveBeenCalledWith('Failed to save to storage:', 'Storage is full');
      expect(document.getElementById('status').textContent).toContain('browser storage is full');
      expect(document.getElementById('status').className).toContain('error');
    } finally {
      globalThis.localStorage.setItem.mockImplementation(originalSetItem);
      consoleError.mockRestore();
      globalThis.saveToStorage();
    }
  });

  test('skips invalid restored routes instead of poisoning later storage restores', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    globalThis.routes = [];

    try {
      expect(globalThis.restoreRoute({ name: 'Bad route', coordinates: [[95, 0], [40, -74]] })).toBe(false);
      expect(globalThis.routes).toHaveLength(0);
      expect(consoleWarn).toHaveBeenCalledWith('Skipping saved route with invalid coordinates');
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test('restores valid routes with safe palette classes and no inline route styles', () => {
    globalThis.routes = [];

    const restored = globalThis.restoreRoute({
      id: 123,
      name: 'Quoted "Route"',
      origin: 'A',
      destination: 'B',
      travelMode: 'DRIVE',
      color: '#ff4757',
      coordinates: [[40, -74], [41, -75]],
      distance: 1000,
      duration: '600s',
    });

    expect(restored).toBe(true);
    expect(globalThis.routes).toHaveLength(1);
    const routeItem = document.querySelector('.route-item');
    expect(routeItem.classList.contains('route-color-0')).toBe(true);
    expect(routeItem.hasAttribute('style')).toBe(false);
    expect(routeItem.querySelector('.route-number').hasAttribute('style')).toBe(false);
    expect(routeItem.getAttribute('aria-label')).toContain('Quoted "Route"');

    globalThis.routes = [];
    document.getElementById('routesList').innerHTML = '';
  });
});

// ============ API key storage ==========
describe('API key storage', () => {
  test('defaults new keys to tab-only storage', () => {
    localStorage.removeItem('route2gpx_apiKey');
    sessionStorage.removeItem('route2gpx_apiKey_session');

    globalThis.openApiKeyModal();

    expect(document.getElementById('rememberApiKey').checked).toBe(false);
    expect(document.getElementById('apiKeyStorageHint').textContent).toContain('tab');
    globalThis.closeApiKeyModal();
  });

  test('saves unchecked API keys in session storage only', () => {
    localStorage.removeItem('route2gpx_apiKey');
    sessionStorage.removeItem('route2gpx_apiKey_session');
    document.getElementById('apiKeyInput').value = 'session-key';
    document.getElementById('rememberApiKey').checked = false;

    globalThis.saveApiKey();

    expect(sessionStorage.getItem('route2gpx_apiKey_session')).toBe('session-key');
    expect(localStorage.getItem('route2gpx_apiKey')).toBeNull();
    expect(globalThis.getApiKey()).toBe('session-key');
  });

  test('falls back to session storage when persistent storage fails', () => {
    const originalSetItem = globalThis.localStorage.setItem.getMockImplementation();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    localStorage.removeItem('route2gpx_apiKey');
    sessionStorage.removeItem('route2gpx_apiKey_session');
    document.getElementById('apiKeyInput').value = 'fallback-key';
    document.getElementById('rememberApiKey').checked = true;
    globalThis.localStorage.setItem.mockImplementation((key, value) => {
      if (key === 'route2gpx_apiKey') throw new DOMException('Blocked', 'SecurityError');
      return originalSetItem(key, value);
    });

    try {
      globalThis.saveApiKey();
      expect(sessionStorage.getItem('route2gpx_apiKey_session')).toBe('fallback-key');
      expect(document.getElementById('rememberApiKey').checked).toBe(false);
      expect(document.getElementById('status').textContent).toContain('this tab');
      expect(consoleWarn).toHaveBeenCalledWith(
        'Persistent API key storage unavailable; falling back to session storage:',
        'Blocked'
      );
    } finally {
      globalThis.localStorage.setItem.mockImplementation(originalSetItem);
      consoleWarn.mockRestore();
    }
  });
});

// ============ elevation data ==========
describe('elevation data', () => {
  test('does not extend elevation arrays when the API returns extra results', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        status: 'OK',
        results: [{ elevation: 123 }, { elevation: 'bad' }, { elevation: 999 }],
      }),
    }));

    try {
      const elevations = await globalThis.fetchElevations([[1, 2], [3, 4]]);
      expect(elevations).toEqual([123, null]);
      expect(elevations).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ============ travel mode toggle ============
describe('travel mode toggle', () => {
  test('selectTravelMode updates hidden value and selected button', () => {
    globalThis.selectTravelMode('WALK');

    expect(document.getElementById('travelMode').value).toBe('WALK');
    expect(document.querySelector('[data-travel-mode="WALK"]').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-travel-mode="DRIVE"]').getAttribute('aria-checked')).toBe('false');
  });

  test('clicking a mode button changes the selected mode', () => {
    document.querySelector('[data-travel-mode="BICYCLE"]').click();

    expect(document.getElementById('travelMode').value).toBe('BICYCLE');
    expect(document.querySelector('[data-travel-mode="BICYCLE"]').tabIndex).toBe(0);
    expect(document.querySelector('[data-travel-mode="WALK"]').tabIndex).toBe(-1);
  });
});

// ============ sanitizeColor ============
describe('sanitizeColor', () => {
  test('accepts valid hex color', () => {
    expect(globalThis.sanitizeColor('#ff4757', 0)).toBe('#ff4757');
  });

  test('accepts 3-digit hex', () => {
    expect(globalThis.sanitizeColor('#f00', 0)).toBe('#f00');
  });

  test('rejects malformed hex lengths', () => {
    expect(globalThis.sanitizeColor('#12345', 0)).not.toBe('#12345');
    expect(globalThis.sanitizeColor('#1234567', 0)).not.toBe('#1234567');
  });

  test('rejects invalid color and returns fallback', () => {
    const result = globalThis.sanitizeColor('not-a-color', 0);
    expect(result).toMatch(/^#[0-9a-fA-F]+$/);
  });

  test('rejects empty string', () => {
    const result = globalThis.sanitizeColor('', 0);
    expect(result).toMatch(/^#[0-9a-fA-F]+$/);
  });

  test('rejects non-string input', () => {
    const result = globalThis.sanitizeColor(null, 0);
    expect(result).toMatch(/^#[0-9a-fA-F]+$/);
  });

  test('cycles fallback index through palette', () => {
    const a = globalThis.sanitizeColor(null, 0);
    const b = globalThis.sanitizeColor(null, 1);
    // Different fallback indices should give different colors
    expect(a).not.toBe(b);
  });
});

// ============ color palette ============
describe('color palette', () => {
  test('renders preset colors as a radio palette', () => {
    const options = document.querySelectorAll('.color-option');

    expect(options).toHaveLength(10);
    expect(document.getElementById('colorOptions').getAttribute('role')).toBe('radiogroup');
    expect(document.getElementById('colorSwatch').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('.color-option[role="radio"]')).toHaveLength(10);
    expect(document.querySelectorAll('.color-option[aria-checked="true"]')).toHaveLength(1);
  });

  test('selectColor updates hidden value and checked state', () => {
    globalThis.selectColor(2);

    expect(document.getElementById('routeColor').value).toBe('#1e90ff');
    expect(document.getElementById('colorSwatch').classList.contains('route-color-2')).toBe(true);
    expect(document.querySelector('[data-color-index="2"]').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-color-index="2"]').tabIndex).toBe(0);
    expect(document.querySelector('[data-color-index="0"]').getAttribute('aria-checked')).toBe('false');
  });

  test('swatch opens the compact palette and selecting a color closes it', () => {
    document.getElementById('colorSwatch').click();

    expect(document.getElementById('colorDropdown').classList.contains('visible')).toBe(true);
    expect(document.getElementById('colorSwatch').getAttribute('aria-expanded')).toBe('true');

    document.querySelector('[data-color-index="3"]').click();

    expect(document.getElementById('routeColor').value).toBe('#ffa502');
    expect(document.getElementById('colorDropdown').classList.contains('visible')).toBe(false);
    expect(document.getElementById('colorSwatch').getAttribute('aria-expanded')).toBe('false');
  });

  test('arrow keys move selection through color swatches', () => {
    globalThis.selectColor(0);
    const firstColor = document.querySelector('[data-color-index="0"]');

    firstColor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(document.getElementById('routeColor').value).toBe('#2ed573');
    expect(document.querySelector('[data-color-index="1"]').getAttribute('aria-checked')).toBe('true');
  });
});

// ============ getModeIconName ============
describe('getModeIconName', () => {
  test('returns car icon for DRIVE', () => {
    expect(globalThis.getModeIconName('DRIVE')).toBe('car-front');
  });

  test('returns bus icon for TRANSIT', () => {
    expect(globalThis.getModeIconName('TRANSIT')).toBe('bus-front');
  });

  test('returns bicycle icon for BICYCLE', () => {
    expect(globalThis.getModeIconName('BICYCLE')).toBe('bike');
  });

  test('returns walk icon for WALK', () => {
    expect(globalThis.getModeIconName('WALK')).toBe('footprints');
  });

  test('returns pin icon for unknown mode', () => {
    expect(globalThis.getModeIconName('UNKNOWN')).toBe('map-pin');
  });

  test('renders accessible decorative SVG markup', () => {
    expect(globalThis.getModeIconSvg('DRIVE')).toContain('<svg');
    expect(globalThis.getModeIconSvg('DRIVE')).toContain('aria-hidden="true"');
    expect(globalThis.getModeIconSvg('DRIVE')).toContain('focusable="false"');
  });
});

// ============ resetColorPool ============
describe('resetColorPool', () => {
  test('is callable without error', () => {
    // resetColorPool mutates internal let variables not on globalThis,
    // but we can verify it runs without throwing
    expect(() => globalThis.resetColorPool()).not.toThrow();
  });

  test('selectRandomColor advances the color', () => {
    // selectRandomColor calls resetColorPool internally and picks a new color
    expect(() => globalThis.selectRandomColor()).not.toThrow();
  });
});

// ============ generateGPX ============
describe('generateGPX', () => {
  test('generates valid GPX structure', () => {
    const route = {
      name: 'Test Route',
      origin: 'Origin City',
      destination: 'Dest City',
      travelMode: 'DRIVE',
      stops: [],
      coordinates: [[40.7128, -74.006], [34.0522, -118.2437]],
      distance: 3944000,
      duration: '140400s',
      color: '#ff4757',
      id: 1,
    };

    const gpx = globalThis.generateGPX(route);

    expect(gpx).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('<metadata>');
    expect(gpx).toContain('<name>Test Route</name>');
    expect(gpx).toContain('<trk>');
    expect(gpx).toContain('<trkseg>');
    expect(gpx).toContain('<trkpt');
    expect(gpx).toContain('</gpx>');
  });

  test('includes waypoints for origin and destination', () => {
    const route = {
      name: 'WPT Test',
      origin: 'Start Place',
      destination: 'End Place',
      travelMode: 'WALK',
      stops: [],
      coordinates: [[40.0, -74.0], [41.0, -75.0]],
      distance: 1000,
      duration: '600s',
      color: '#2ed573',
      id: 2,
    };

    const gpx = globalThis.generateGPX(route);
    expect(gpx).toContain('<wpt');
    expect(gpx).toContain('Start: Start Place');
    expect(gpx).toContain('End: End Place');
  });

  test('includes exact coordinate stop waypoints', () => {
    const route = {
      name: 'Stops Test',
      origin: 'A',
      destination: 'C',
      travelMode: 'DRIVE',
      stops: ['40.5, -74.5'],
      coordinates: [[40.0, -74.0], [40.5, -74.5], [41.0, -75.0]],
      distance: 2000,
      duration: '1200s',
      color: '#1e90ff',
      id: 3,
    };

    const gpx = globalThis.generateGPX(route);
    expect(gpx).toContain('<wpt lat="40.500000" lon="-74.500000">');
    expect(gpx).toContain('Stop 1: 40.5, -74.5');
  });

  test('does not invent waypoint coordinates for address stops', () => {
    const route = {
      name: 'Address Stops Test',
      origin: 'A',
      destination: 'C',
      travelMode: 'DRIVE',
      stops: ['Coffee & Pie'],
      coordinates: [[40.0, -74.0], [40.5, -74.5], [41.0, -75.0]],
      distance: 2000,
      duration: '1200s',
      color: '#1e90ff',
      id: 3,
    };

    const gpx = globalThis.generateGPX(route);
    expect((gpx.match(/<wpt /g) || [])).toHaveLength(2);
    expect(gpx).toContain('Stops: Coffee &amp; Pie');
    expect(gpx).not.toContain('<name>Stop 1: Coffee');
  });

  test('handles routes without a stops array', () => {
    const route = {
      name: 'Legacy Route',
      origin: 'A',
      destination: 'B',
      travelMode: 'DRIVE',
      coordinates: [[40.0, -74.0], [41.0, -75.0]],
      distance: 1000,
      duration: '600s',
      color: '#ff4757',
      id: 30,
    };

    expect(() => globalThis.generateGPX(route)).not.toThrow();
  });

  test('escapes XML in route names', () => {
    const route = {
      name: 'Route <A> & "B"',
      origin: '<Origin>',
      destination: 'Dest & More',
      travelMode: 'BICYCLE',
      stops: [],
      coordinates: [[0, 0], [1, 1]],
      distance: 100,
      duration: '60s',
      color: '#ffa502',
      id: 4,
    };

    const gpx = globalThis.generateGPX(route);
    expect(gpx).not.toContain('<A>');
    expect(gpx).toContain('&lt;A&gt;');
    expect(gpx).toContain('&amp;');
  });

  test('computes correct bounds', () => {
    const route = {
      name: 'Bounds Test',
      origin: 'A',
      destination: 'B',
      travelMode: 'DRIVE',
      stops: [],
      coordinates: [[10.0, 20.0], [30.0, 40.0]],
      distance: 1000,
      duration: '600s',
      color: '#a55eea',
      id: 5,
    };

    const gpx = globalThis.generateGPX(route);
    expect(gpx).toContain('minlat="10.000000"');
    expect(gpx).toContain('maxlat="30.000000"');
    expect(gpx).toContain('minlon="20.000000"');
    expect(gpx).toContain('maxlon="40.000000"');
  });

  test('uses elevation data when available', () => {
    const route = {
      name: 'Elevation Test',
      origin: 'A',
      destination: 'B',
      travelMode: 'WALK',
      stops: [],
      coordinates: [[40.0, -74.0], [41.0, -75.0]],
      elevations: [150.5, 200.3],
      distance: 1000,
      duration: '600s',
      color: '#2ed573',
      id: 6,
    };

    const gpx = globalThis.generateGPX(route);
    expect(gpx).toContain('<ele>150.5</ele>');
    expect(gpx).toContain('<ele>200.3</ele>');
    expect(gpx).not.toContain('<ele>0</ele>');
  });

  test('falls back to 0 elevation when data is null', () => {
    const route = {
      name: 'No Elevation',
      origin: 'A',
      destination: 'B',
      travelMode: 'DRIVE',
      stops: [],
      coordinates: [[40.0, -74.0], [41.0, -75.0]],
      elevations: null,
      distance: 1000,
      duration: '600s',
      color: '#ff4757',
      id: 7,
    };

    const gpx = globalThis.generateGPX(route);
    expect(gpx).toContain('<ele>0</ele>');
  });
});

// ============ getModeIconName (extended) ============
describe('getModeIconName extended', () => {
  test('returns folder icon for IMPORTED', () => {
    expect(globalThis.getModeIconName('IMPORTED')).toBe('folder-up');
  });
});

// ============ haversineDistance ============
describe('haversineDistance', () => {
  test('computes zero for same point', () => {
    const d = globalThis.haversineDistance([40.0, -74.0], [40.0, -74.0]);
    expect(d).toBe(0);
  });

  test('computes approximately correct distance', () => {
    // NYC to LA approx 3,944 km
    const d = globalThis.haversineDistance([40.7128, -74.006], [34.0522, -118.2437]);
    expect(d).toBeGreaterThan(3900000);
    expect(d).toBeLessThan(4000000);
  });

  test('is symmetric', () => {
    const d1 = globalThis.haversineDistance([40.7128, -74.006], [51.5074, -0.1278]);
    const d2 = globalThis.haversineDistance([51.5074, -0.1278], [40.7128, -74.006]);
    expect(d1).toBeCloseTo(d2, 0);
  });
});

// ============ filename modal accessibility ============
describe('filename modal accessibility', () => {
  test('uses shared modal state for focus trap and inert app content', () => {
    const returnFocusButton = document.createElement('button');
    document.body.appendChild(returnFocusButton);
    returnFocusButton.focus();

    globalThis.openFilenameModal(1, '<gpx></gpx>', 'route.gpx');

    const modal = document.getElementById('filenameModal');
    const input = document.getElementById('filenameInput');
    const app = document.getElementById('app');
    expect(modal.classList.contains('visible')).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(app.getAttribute('aria-hidden')).toBe('true');

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escapeEvent);

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(modal.classList.contains('visible')).toBe(false);
    expect(app.hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(returnFocusButton);

    returnFocusButton.remove();
  });
});
