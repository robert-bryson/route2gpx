/** Coordinator behavior through module actions and DOM events. */

import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import * as pako from 'pako';
import { generateGPX, escapeXml, sanitizeFilename } from '../gpx.js';
import { haversineDistance, MAX_TRACK_POINTS } from '../track-data.js';
import { escapeHtml, formatDuration } from '../route-list.js';
import { getModeIconName, getModeIconSvg } from '../icons.js';
let appModule;
let mapInstance;
const mapEventHandlers = {};
const popupInstances = [];
let initialBasemapCall;

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
    getBounds: vi.fn(() => ({ getCenter: () => [0.5, 0.5] })),
    getCenter: vi.fn(() => [0.5, 0.5]),
    setStyle: vi.fn(),
    openPopup: vi.fn(),
    closePopup: vi.fn(),
    closeTooltip: vi.fn(),
    off: vi.fn(),
    unbindPopup: vi.fn(),
    unbindTooltip: vi.fn(),
    setTooltipContent: vi.fn(),
  };

  const mockMarker = {
    addTo: vi.fn().mockReturnThis(),
    bindTooltip: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    _icon: null,
    options: {},
    getElement: vi.fn(() => null),
    setLatLng: vi.fn(),
    setIcon: vi.fn(),
    closePopup: vi.fn(),
    closeTooltip: vi.fn(),
    off: vi.fn(),
    unbindTooltip: vi.fn(),
    unbindPopup: vi.fn(),
    setTooltipContent: vi.fn(),
  };

  globalThis.L = {
    map: vi.fn(() => {
      const mapMock = {
        fitBounds: vi.fn(),
        closePopup: vi.fn(),
        removeLayer: vi.fn(),
        on: vi.fn((eventName, handler) => {
          mapEventHandlers[eventName] = handler;
          mapInstance = mapMock;
      return mapMock;
        }),
      };
      mapInstance = mapMock;
      return mapMock;
    }),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    polyline: vi.fn(() => ({ ...mockPolyline })),
    marker: vi.fn(() => ({ ...mockMarker })),
    featureGroup: vi.fn(() => ({ getBounds: vi.fn(() => [[0, 0], [1, 1]]) })),
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
    'map', 'origin', 'destination', 'originPlaceName', 'destinationPlaceName', 'routesList', 'addStopBtn', 'reverseRouteBtn',
    'colorSwatch', 'unitKm', 'unitMi', 'getRouteBtn', 'downloadAllBtn', 'clearAllBtn',
    'apiKeyMapBtn', 'clickModeBtn', 'locateMeBtn', 'closeModalBtn', 'saveApiKeyBtn',
    'colorOptions', 'routeColor', 'colorDropdown', 'stopsContainer', 'apiKeyStatus', 'rememberApiKey',
    'mapModeIndicator', 'clickModeTarget', 'cancelClickModeBtn', 'originMapPickBtn', 'destinationMapPickBtn',
    'pickWaypointMapBtn', 'undoNotice', 'undoMessage', 'undoDeleteBtn', 'cancelImportBtn',
    'importSummary', 'importSummaryTitle', 'importSummaryItems', 'batchExportSummary', 'batchExportItems',
    'renameModal', 'renameInput', 'cancelRenameBtn', 'confirmRenameBtn', 'exportDataHint', 'synthesizeTimes',
    'apiKeyModal', 'apiKeyInput', 'apiKeyStorageHint', 'status', 'travelMode',
    'filenameModal', 'filenameInput', 'filenamePreview', 'cancelFilenameBtn', 'confirmFilenameBtn',
    'importDropZone', 'importFileInput',
    'fogDropZone', 'fogFileInput', 'fogBadge', 'fogRemoveBtn', 'fogVisibilityToggle',
  ];

  ids.forEach(id => {
    const el = document.createElement(
      ['origin', 'destination', 'apiKeyInput', 'routeColor', 'filenameInput', 'rememberApiKey', 'travelMode', 'renameInput', 'synthesizeTimes'].includes(id) ? 'input' :
        id === 'importFileInput' ? 'input' : 'div'
    );
    el.id = id;
    if (id === 'importFileInput') {
      el.type = 'file';
    }
    if (id === 'rememberApiKey' || id === 'synthesizeTimes') {
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

  appModule = await import('../app.js');
  initialBasemapCall = globalThis.L.tileLayer.mock.calls[0];
});

describe('basemap initialization', () => {
  test('keeps app actions, parser functions, and mutable state off the global object', () => {
    for (const name of ['getRoute', 'routes', 'distanceUnit', 'parseFIT', 'parseTCX', 'parseGeoJSON', 'setupFogOfWorld', 'showStatus', 'ICON_PATHS', 'MODE_ICON_NAMES', 'iconSvg', 'getModeIconName', 'getModeIconSvg', 'renderIconPlaceholders']) {
      expect(Object.hasOwn(globalThis, name)).toBe(false);
    }
  });
  test('loads the unbundled source without a build-time CARTO key', () => {
    expect(initialBasemapCall).toEqual([
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      expect.objectContaining({ maxZoom: 19, subdomains: 'abcd' }),
    ]);
  });
});

// ============ decodePolyline ============
describe('decodePolyline', () => {
  test('decodes a known encoded polyline', () => {
    // Standard test: "_p~iF~ps|U" decodes to approx (38.5, -120.2)
    const points = appModule.decodePolyline('_p~iF~ps|U');
    expect(points).toHaveLength(1);
    expect(points[0][0]).toBeCloseTo(38.5, 1);
    expect(points[0][1]).toBeCloseTo(-120.2, 1);
  });

  test('decodes multi-point polyline', () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" is a well-known test case
    const points = appModule.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0][0]).toBeCloseTo(38.5, 1);
    expect(points[1][0]).toBeCloseTo(40.7, 1);
    expect(points[2][0]).toBeCloseTo(43.252, 1);
  });

  test('returns empty array for empty string', () => {
    expect(appModule.decodePolyline('')).toEqual([]);
  });

  test('returns empty array for malformed encoded polylines', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });

    try {
      expect(appModule.decodePolyline('a')).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith('Invalid encoded polyline:', expect.stringContaining('ended unexpectedly'));
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test.each(['\u007f?', '???\u007f?', '_mljP???', '???_qvoa@', '______C?', '}~~~~~B???', '~~~~~~B???'])('rejects invalid characters, coordinates, and overflowing values: %j', encoded => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(appModule.decodePolyline(encoded)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('accepts both coordinate range boundaries', () => {
    expect(appModule.decodePolyline('_cidP_gsia@~fsia@~ngtcA')).toEqual([[90, 180], [-90, -180]]);
  });

  test('rejects an API route above the shared point limit', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(appModule.decodePolyline('??'.repeat(MAX_TRACK_POINTS + 1))).toEqual([]);
      expect(warning).toHaveBeenCalledWith('Invalid encoded polyline:', expect.stringContaining('too many track points'));
    } finally { warning.mockRestore(); }
  });
});

// ============ formatDistance ============
describe('formatDistance', () => {
  test('formats kilometers (small)', () => {
    appModule.setUnit('km', false);
    expect(appModule.formatDistance(5000)).toBe('5.0 km');
  });

  test('formats kilometers (large >= 10)', () => {
    appModule.setUnit('km', false);
    expect(appModule.formatDistance(15000)).toBe('15 km');
  });

  test('formats miles (small)', () => {
    appModule.setUnit('mi', false);
    expect(appModule.formatDistance(1609.34)).toBe('1.0 mi');
  });

  test('formats miles (large >= 10)', () => {
    appModule.setUnit('mi', false);
    // 10 miles = 16093.4 meters
    expect(appModule.formatDistance(16093.4)).toBe('10 mi');
  });

  // Reset to default after
  test('formats zero', () => {
    appModule.setUnit('km', false);
    expect(appModule.formatDistance(0)).toBe('0.0 km');
  });
});

// ============ formatDuration ============
describe('formatDuration', () => {
  test('formats minutes-only duration', () => {
    expect(formatDuration('1800s')).toBe('30m');
  });

  test('formats hours and minutes', () => {
    expect(formatDuration('5400s')).toBe('1h 30m');
  });

  test('handles null/undefined', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });

  test('handles invalid string', () => {
    expect(formatDuration('abc')).toBe('—');
  });

  test('handles zero seconds', () => {
    expect(formatDuration('0s')).toBe('0m');
  });
});

// ============ escapeXml ============
describe('escapeXml', () => {
  test('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  test('escapes angle brackets', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
  });

  test('escapes quotes', () => {
    expect(escapeXml('"hello" \'world\'')).toBe('&quot;hello&quot; &apos;world&apos;');
  });

  test('handles combined special chars', () => {
    expect(escapeXml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
  });

  test('passes through plain text', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// ============ sanitizeFilename ============
describe('sanitizeFilename', () => {
  test('allows safe characters', () => {
    expect(sanitizeFilename('hello-world_123')).toBe('hello-world_123');
  });

  test('replaces special characters', () => {
    expect(sanitizeFilename('a/b\\c:d')).toBe('a_b_c_d');
  });

  test('truncates to 50 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeFilename(long)).toHaveLength(50);
  });

  test('handles empty string', () => {
    expect(sanitizeFilename('')).toBe('');
  });

  test('handles path traversal attempt', () => {
    const result = sanitizeFilename('../../etc/passwd');
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
  });
});

// ============ escapeHtml ============
describe('escapeHtml', () => {
  test('escapes HTML entities', () => {
    const result = escapeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;');
  });

  test('escapes quotes for safe attribute interpolation', () => {
    expect(escapeHtml('bad" onfocus="alert(1)')).toBe('bad&quot; onfocus=&quot;alert(1)');
    expect(escapeHtml("bad' onclick='alert(1)")).toBe('bad&#39; onclick=&#39;alert(1)');
  });

  test('passes through plain text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

// ============ truncate ============
describe('truncate', () => {
  test('returns short string unchanged', () => {
    expect(appModule.truncate('hello', 10)).toBe('hello');
  });

  test('truncates long string with ellipsis', () => {
    expect(appModule.truncate('hello world', 5)).toBe('hello...');
  });

  test('handles exact length', () => {
    expect(appModule.truncate('hello', 5)).toBe('hello');
  });

  test('handles nullish values', () => {
    expect(appModule.truncate(null, 5)).toBe('');
    expect(appModule.truncate(undefined, 5)).toBe('');
  });
});

// ============ formatFileSize ============
describe('formatFileSize', () => {
  test('formats bytes', () => {
    expect(appModule.formatFileSize(500)).toBe('500 B');
  });

  test('formats kilobytes', () => {
    expect(appModule.formatFileSize(2048)).toBe('2.0 KB');
  });

  test('formats megabytes', () => {
    expect(appModule.formatFileSize(1048576)).toBe('1.0 MB');
  });

  test('formats zero', () => {
    expect(appModule.formatFileSize(0)).toBe('0 B');
  });
});

describe('formatDistance invalid values', () => {
  test('returns an unavailable marker for invalid distances', () => {
    expect(appModule.formatDistance(Number.NaN)).toBe('—');
    expect(appModule.formatDistance(-1)).toBe('—');
  });
});

// ============ parseLocation ============
describe('parseLocation', () => {
  test('parses lat,lng coordinates', () => {
    const result = appModule.parseLocation('40.7128, -74.0060');
    expect(result.location.latLng.latitude).toBeCloseTo(40.7128);
    expect(result.location.latLng.longitude).toBeCloseTo(-74.006);
  });

  test('parses coordinates without space', () => {
    const result = appModule.parseLocation('51.5074,-0.1278');
    expect(result.location.latLng.latitude).toBeCloseTo(51.5074);
    expect(result.location.latLng.longitude).toBeCloseTo(-0.1278);
  });

  test('returns address for non-coordinate input', () => {
    const result = appModule.parseLocation('New York, NY');
    expect(result.address).toBe('New York, NY');
    expect(result.location).toBeUndefined();
  });

  test('returns address for partial coordinates', () => {
    const result = appModule.parseLocation('40.7128');
    expect(result.address).toBe('40.7128');
  });

  test('returns address for out-of-range coordinate-like input', () => {
    const result = appModule.parseLocation('91, -181');
    expect(result.address).toBe('91, -181');
    expect(result.location).toBeUndefined();
  });
});

// ============ coordinate helpers ============
describe('coordinate helpers', () => {
  test('validates latitude and longitude ranges', () => {
    expect(appModule.isValidLatLng({ latitude: 90, longitude: 180 })).toBe(true);
    expect(appModule.isValidLatLng({ latitude: 90.1, longitude: 0 })).toBe(false);
    expect(appModule.isValidLatLng({ latitude: 0, longitude: -180.1 })).toBe(false);
  });

  test('detects coordinate-shaped strings', () => {
    expect(appModule.looksLikeCoordinatePair('40.7, -74.0')).toBe(true);
    expect(appModule.looksLikeCoordinatePair('New York, NY')).toBe(false);
  });
});

// ============ waypoint management ============
describe('waypoint management', () => {
  test('reorders waypoint values without losing input contents', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    document.getElementById('stopsContainer').innerHTML = '';

    appModule.addStop('First stop');
    appModule.addStop('Second stop');
    appModule.addStop('Third stop');

    let rows = document.querySelectorAll('.stop-row');
    appModule.moveStop(rows[1].querySelector('[data-action="move-stop-up"]'), -1);
    expect(appModule.getStops()).toEqual(['Second stop', 'First stop', 'Third stop']);

    rows = document.querySelectorAll('.stop-row');
    appModule.moveStop(rows[1].querySelector('[data-action="move-stop-down"]'), 1);
    expect(appModule.getStops()).toEqual(['Second stop', 'Third stop', 'First stop']);
    expect(document.querySelector('.stop-row [data-action="move-stop-up"]').disabled).toBe(true);
    expect(document.querySelectorAll('.stop-row [data-action="move-stop-down"]')[2].disabled).toBe(true);
  });

  test('moves origin after the next route point', () => {
    document.getElementById('origin').value = 'Origin';
    document.getElementById('destination').value = 'Destination';
    document.getElementById('stopsContainer').innerHTML = '';

    appModule.addStop('First waypoint');
    appModule.addStop('Second waypoint');
    appModule.moveEndpoint('origin', 1);

    expect(document.getElementById('origin').value).toBe('First waypoint');
    expect(appModule.getStops()).toEqual(['Origin', 'Second waypoint']);
    expect(document.getElementById('destination').value).toBe('Destination');
  });

  test('moves destination before the previous route point', () => {
    document.getElementById('origin').value = 'Origin';
    document.getElementById('destination').value = 'Destination';
    document.getElementById('stopsContainer').innerHTML = '';

    appModule.addStop('First waypoint');
    appModule.addStop('Second waypoint');
    appModule.moveEndpoint('destination', -1);

    expect(document.getElementById('origin').value).toBe('Origin');
    expect(appModule.getStops()).toEqual(['First waypoint', 'Destination']);
    expect(document.getElementById('destination').value).toBe('Second waypoint');
  });

  test('moves endpoints against each other when there are no waypoints', () => {
    document.getElementById('origin').value = 'Origin';
    document.getElementById('destination').value = 'Destination';
    document.getElementById('stopsContainer').innerHTML = '';

    appModule.moveEndpoint('origin', 1);

    expect(document.getElementById('origin').value).toBe('Destination');
    expect(appModule.getStops()).toEqual([]);
    expect(document.getElementById('destination').value).toBe('Origin');
  });
});

// ============ map click picker ============
describe('map click picker', () => {
  test('prompts before setting origin on a plain map click', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    appModule.exitClickMode();

    mapEventHandlers.click({ latlng: { lat: 40.1234567, lng: -73.9876543 } });

    const popup = popupInstances.at(-1);
    expect(popup.content).toContain('Use this spot as origin?');
    expect(document.getElementById('origin').value).toBe('');

    appModule.confirmMapClickPrompt();

    expect(document.getElementById('origin').value).toBe('40.123457, -73.987654');
    expect(document.getElementById('destination').value).toBe('');
  });

  test('prompts before setting destination when origin already exists', () => {
    document.getElementById('origin').value = '39.000000, -105.000000';
    document.getElementById('destination').value = '';
    appModule.exitClickMode();

    mapEventHandlers.click({ latlng: { lat: 41, lng: -75 } });

    const popup = popupInstances.at(-1);
    expect(popup.content).toContain('Use this spot as destination?');
    expect(document.getElementById('destination').value).toBe('');

    appModule.confirmMapClickPrompt();

    expect(document.getElementById('origin').value).toBe('39.000000, -105.000000');
    expect(document.getElementById('destination').value).toBe('41.000000, -75.000000');
  });

  test('does not prompt on plain map clicks once origin and destination are set', () => {
    document.getElementById('origin').value = '39.000000, -105.000000';
    document.getElementById('destination').value = '41.000000, -75.000000';
    appModule.exitClickMode();
    const popupCount = popupInstances.length;

    mapEventHandlers.click({ latlng: { lat: 42, lng: -76 } });

    expect(popupInstances).toHaveLength(popupCount);
  });

  test('closes an open route popup without prompting for origin or destination', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    appModule.exitClickMode();
    const popupCount = popupInstances.length;
    const routePopup = { route2gpxPopupType: 'route' };
    const closePopup = mapInstance.closePopup;
    closePopup.mockClear();

    mapEventHandlers.popupopen({ popup: routePopup });
    mapEventHandlers.preclick({ latlng: { lat: 39, lng: -105 } });
    mapEventHandlers.click({ latlng: { lat: 39, lng: -105 } });

    expect(closePopup).toHaveBeenCalledWith(routePopup);
    expect(popupInstances).toHaveLength(popupCount);
    expect(document.getElementById('origin').value).toBe('');
    expect(document.getElementById('destination').value).toBe('');
  });

  test('sets origin and exits for single-target picking', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';

    appModule.enterClickMode('origin', 'single');
    mapEventHandlers.click({ latlng: { lat: 40.1234567, lng: -73.9876543 } });

    expect(document.getElementById('origin').value).toBe('40.123457, -73.987654');
    expect(document.getElementById('mapModeIndicator').hidden).toBe(true);
    expect(document.getElementById('clickModeBtn').getAttribute('aria-pressed')).toBe('false');
  });

  test('guided picking advances from origin to destination to waypoint', () => {
    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';
    document.getElementById('stopsContainer').innerHTML = '';

    appModule.enterClickMode('origin', 'route');
    mapEventHandlers.click({ latlng: { lat: 40, lng: -74 } });

    expect(document.getElementById('origin').value).toBe('40.000000, -74.000000');
  expect(document.getElementById('mapModeIndicator').hidden).toBe(false);
    expect(document.getElementById('clickModeTarget').textContent).toContain('destination');

    mapEventHandlers.click({ latlng: { lat: 41, lng: -75 } });

    expect(document.getElementById('destination').value).toBe('41.000000, -75.000000');
    expect(document.getElementById('clickModeTarget').textContent).toContain('waypoint');
    appModule.exitClickMode();
  });
});

// ============ geolocation ==========
describe('geolocation', () => {
  test.each(['typed', 'reordered', 'reordered and reverted', 'edited and reverted'])('keeps an endpoint that was %s while geolocation was pending', (change) => {
    const input = document.getElementById('origin');
    const getCurrentPosition = navigator.geolocation.getCurrentPosition;
    getCurrentPosition.mockReset();
    let deliver;
    getCurrentPosition.mockImplementation(success => { deliver = success; });
    input.value = 'Original origin';
    document.getElementById('destination').value = 'Original destination';
    document.getElementById('stopsContainer').replaceChildren();
    appModule.useMyLocation('origin');
    if (change.startsWith('reordered')) {
      appModule.moveEndpoint('origin', 1);
      if (change.endsWith('reverted')) appModule.moveEndpoint('origin', 1);
    } else {
      input.value = 'New origin';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (change === 'edited and reverted') {
        input.value = 'Original origin';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    const expected = input.value;
    deliver({ coords: { latitude: 10, longitude: 20 } });
    expect(input.value).toBe(expected);
  });

  test.each([null, undefined, '', ' ', false, []])('rejects absent or coerced geolocation coordinates: %j', value => {
    expect(appModule.getValidatedPositionLatLng({ coords: { latitude: value, longitude: value } })).toBeNull();
  });

  test('ignores stale geolocation callbacks after a newer request starts', () => {
    const getCurrentPosition = globalThis.navigator.geolocation.getCurrentPosition;
    const callbacks = [];
    getCurrentPosition.mockReset();
    getCurrentPosition.mockImplementation((onSuccess) => {
      callbacks.push(onSuccess);
    });

    document.getElementById('origin').value = '';
    document.getElementById('destination').value = '';

    appModule.useMyLocation('origin');
    appModule.useMyLocation('destination');

    callbacks[0]({ coords: { latitude: 10, longitude: 20 } });
    expect(document.getElementById('origin').value).toBe('');
    expect(document.getElementById('destination').value).toBe('');

    callbacks[1]({ coords: { latitude: 30, longitude: 40 } });
    expect(document.getElementById('origin').value).toBe('');
    expect(document.getElementById('destination').value).toBe('30.000000, 40.000000');
  });

  test('rejects malformed geolocation coordinates', () => {
    expect(appModule.getValidatedPositionLatLng({ coords: { latitude: 91, longitude: 0 } })).toBeNull();
    expect(appModule.getValidatedPositionLatLng({ coords: { latitude: 45, longitude: -120 } })).toEqual({ latitude: 45, longitude: -120 });
  });
});

// ============ route creation form state ============
describe('route creation form state', () => {
  test('keeps origin, destination, and waypoint values after creating a route', async () => {
    const originalFetch = globalThis.fetch;
    document.getElementById('origin').value = 'Origin City';
    document.getElementById('destination').value = 'Destination City';
    document.getElementById('stopsContainer').innerHTML = '';
    appModule.addStop('Scenic Stop');
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
      await appModule.getRoute();
      expect(document.getElementById('origin').value).toBe('Origin City');
      expect(document.getElementById('destination').value).toBe('Destination City');
      expect(appModule.getStops()).toEqual(['Scenic Stop']);
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
      await appModule.getRoute();
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
    expect(appModule.getReverseGeocodeDisplayName(data)).toBe('Telluride, CO 81435, USA');
  });

  test('extracts display names from Places-shaped results', () => {
    const data = {
      places: [{ displayName: { text: 'Black Canyon of the Gunnison National Park' } }],
    };
    expect(appModule.getReverseGeocodeDisplayName(data)).toBe('Black Canyon of the Gunnison National Park');
  });

  test('builds route names from resolved endpoint labels', () => {
    expect(appModule.buildRouteName('Montrose, CO', 'Telluride, CO')).toBe('Montrose, CO → Telluride, CO');
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
      await expect(appModule.lookupPlaceName('38.1520, -107.7610', 'test-key')).resolves.toBe('Ridgway, CO 81432, USA');
      expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('maps.googleapis.com/maps/api/geocode/json'), expect.any(Object));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns no replacement label when reverse geocoding is denied', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'REQUEST_DENIED', results: [] }),
    }));

    try {
      await expect(appModule.lookupPlaceName('38.1530, -107.7620', 'test-key')).resolves.toBe('');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('planner points and place names', () => {
  function action(name, field) {
    const button = document.createElement('button');
    button.dataset.action = name;
    if (field) button.dataset.field = field;
    document.body.appendChild(button);
    button.click();
    button.remove();
  }

  function pick(target, lat, lng) {
    appModule.enterClickMode(target);
    mapEventHandlers.click({ latlng: { lat, lng } });
  }

  const response = name => ({ ok: true, json: async () => ({ status: 'OK', results: [{ formatted_address: name }] }) });

  beforeEach(() => {
    action('clear-planner');
    sessionStorage.setItem('route2gpx_apiKey_session', 'test-key');
    const elevation = document.createElement('input');
    elevation.id = 'fetchElevation';
    elevation.type = 'checkbox';
    document.body.appendChild(elevation);
  });

  afterEach(() => {
    action('clear-planner');
    document.getElementById('fetchElevation').remove();
    sessionStorage.removeItem('route2gpx_apiKey_session');
    vi.restoreAllMocks();
  });

  test('deduplicates picked locations and saves late names with a reusable route', async () => {
    const labels = document.createElement('input');
    labels.type = 'checkbox';
    labels.id = 'labelCoordinates';
    labels.checked = true;
    document.body.appendChild(labels);
    const pending = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).includes('computeRoutes')) return Promise.resolve({ ok: true, json: async () => ({ routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }] }) });
      if (String(url).includes('/geocode/')) return new Promise(resolve => pending.push(resolve));
      return Promise.resolve({ ok: true, json: async () => ({ status: 'OK', results: [] }) });
    });
    pick('origin', 11, 22);
    pick('destination', 11, 22);
    pick('waypoint', 33, 44);
    expect(fetch).toHaveBeenCalledTimes(2);
    await appModule.getRoute();
    const row = document.querySelector('.route-item:last-child');
    const edit = row.dataset.routeId;
    pending[0](response('Shared trailhead'));
    pending[1](response('Scenic waypoint'));
    await vi.waitFor(() => expect(document.querySelector(`.route-item[data-route-id="${edit}"] .route-item-title`).textContent).toBe('Shared trailhead → Shared trailhead'));
    expect(document.getElementById('origin').value).toBe('11.000000, 22.000000');
    expect(document.querySelector('.stop-location .location-name').textContent).toBe('Scenic waypoint');
    action('clear-endpoint', 'origin');
    expect(document.getElementById('origin').value).toBe('');
    expect(document.getElementById('originPlaceName').hidden).toBe(true);
    expect(document.getElementById('destination').value).toBe('11.000000, 22.000000');
    action('clear-planner');
    expect(appModule.getStops()).toEqual([]);
    expect(JSON.parse(localStorage.getItem('route2gpx_draft')).placeNames).toEqual({});
    document.querySelector(`[data-action="edit-route"][data-route-id="${edit}"]`).click();
    expect(document.getElementById('originPlaceName').textContent).toBe('Shared trailhead');
    expect(document.querySelector('.stop-location .location-name').textContent).toBe('Scenic waypoint');
    document.getElementById('reverseRouteBtn').click();
    expect(JSON.parse(localStorage.getItem('route2gpx_draft')).placeNames).toEqual({ '11,22': 'Shared trailhead', '33,44': 'Scenic waypoint' });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/geocode/'))).toHaveLength(2);
    labels.remove();
  });

  test('ignores a cleared lookup even if it resolves after a new lookup for the same coordinates', async () => {
    let deliverOld, oldRead = false;
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise(resolve => { deliverOld = resolve; }))
      .mockResolvedValue(response('New trailhead'));
    pick('origin', 11, 22);
    action('clear-planner');
    pick('origin', 11, 22);
    await vi.waitFor(() => expect(document.getElementById('originPlaceName').textContent).toBe('New trailhead'));
    deliverOld({ ok: true, json: async () => { oldRead = true; return { status: 'OK', results: [{ formatted_address: 'Old trailhead' }] }; } });
    await vi.waitFor(() => expect(oldRead).toBe(true));
    expect(document.getElementById('originPlaceName').textContent).toBe('New trailhead');
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/geocode/'))).toHaveLength(2);
  });

  test('retains GPS coordinates when place lookup is denied and clears their label on editing', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ status: 'REQUEST_DENIED', results: [] }) });
    navigator.geolocation.getCurrentPosition.mockImplementationOnce(success => success({ coords: { latitude: 11, longitude: 22 } }));
    appModule.useMyLocation('origin');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const input = document.getElementById('origin');
    expect(input.value).toBe('11.000000, 22.000000');
    expect(document.getElementById('originPlaceName').hidden).toBe(true);
    input.value = 'New address';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  test('does not geocode typed coordinates on key save or route reuse when their option is off', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => Promise.resolve(
      String(url).includes('computeRoutes')
        ? { ok: true, json: async () => ({ routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] }) }
        : response('Unrequested place')
    ));
    document.getElementById('origin').value = '11, 22';
    document.getElementById('destination').value = '33, 44';
    await appModule.getRoute();
    document.getElementById('apiKeyInput').value = 'replacement-key';
    document.getElementById('rememberApiKey').checked = false;
    document.getElementById('saveApiKeyBtn').click();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/geocode/'))).toHaveLength(0);
    document.querySelector('.route-item:last-child [data-action="edit-route"]').click();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/geocode/'))).toHaveLength(0);
  });

  test('deduplicates typed-coordinate lookups across endpoints and waypoints', async () => {
    const labels = document.createElement('input');
    labels.id = 'labelCoordinates';
    labels.type = 'checkbox';
    labels.checked = true;
    document.body.appendChild(labels);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => Promise.resolve(
      String(url).includes('computeRoutes')
        ? { ok: true, json: async () => ({ routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] }) }
        : response('One shared place')
    ));
    try {
      document.getElementById('origin').value = '11, 22';
      document.getElementById('destination').value = '11.0, 22.0';
      appModule.addStop('11.000, 22.000');
      await appModule.getRoute();
      await vi.waitFor(() => expect(document.querySelector('.route-item:last-child .route-item-title').textContent).toBe('One shared place → One shared place'));
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/geocode/'))).toHaveLength(1);
      expect(document.querySelector('.stop-location .location-name').textContent).toBe('One shared place');
    } finally { labels.remove(); }
  });

  test('cancels typed-coordinate lookups on reset and ignores their late responses', async () => {
    const labels = document.createElement('input');
    labels.id = 'labelCoordinates';
    labels.type = 'checkbox';
    labels.checked = true;
    document.body.appendChild(labels);
    const pending = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (String(url).includes('computeRoutes')) return Promise.resolve({ ok: true, json: async () => ({ routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] }) });
      return new Promise(resolve => pending.push({ resolve, signal: options.signal }));
    });
    try {
      document.getElementById('origin').value = '11, 22';
      document.getElementById('destination').value = '33, 44';
      await appModule.getRoute();
      expect(pending).toHaveLength(2);
      action('clear-planner');
      const aborted = pending.every(request => request.signal.aborted);
      const reads = pending.map(request => {
        const json = vi.fn(async () => ({ status: 'OK', results: [{ formatted_address: 'Cleared name' }] }));
        request.resolve({ ok: true, json });
        return json;
      });
      await vi.waitFor(() => expect(reads.every(read => read.mock.calls.length === 1)).toBe(true));
      document.getElementById('origin').value = '11, 22';
      document.getElementById('origin').dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('route2gpx_draft')).origin).toBe('11, 22'));
      expect(document.getElementById('originPlaceName').hidden).toBe(true);
      expect(JSON.parse(localStorage.getItem('route2gpx_draft')).placeNames).toEqual({});
      expect(aborted).toBe(true);
    } finally { labels.remove(); }
  });

  test.each(['rename', 'delete'])('respects a route %s while a place lookup is pending', async change => {
    let deliver;
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).includes('computeRoutes')) return Promise.resolve({ ok: true, json: async () => ({ routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] }) });
      return new Promise(resolve => { deliver = resolve; });
    });
    pick('origin', 11, 22);
    document.getElementById('destination').value = 'Destination';
    await appModule.getRoute();
    const row = document.querySelector('.route-item:last-child');
    const id = row.dataset.routeId;
    if (change === 'rename') {
      row.querySelector('[data-action="rename-route"]').click();
      document.getElementById('renameInput').value = 'My route';
      document.getElementById('confirmRenameBtn').click();
    } else {
      row.querySelector('[data-action="remove-route"]').click();
    }
    deliver(response('Late place'));
    await vi.waitFor(() => expect(document.getElementById('originPlaceName').textContent).toBe('Late place'));
    const saved = JSON.parse(localStorage.getItem('route2gpx_routes')).routes.find(route => String(route.id) === id);
    if (change === 'rename') {
      expect(saved.name).toBe('My route');
      expect(saved.origin).toBe('Late place');
      expect(document.querySelector(`.route-item[data-route-id="${id}"] .route-item-title`).textContent).toBe('My route');
    } else {
      expect(saved).toBeUndefined();
      expect(document.querySelector(`.route-item[data-route-id="${id}"]`)).toBeNull();
    }
  });

  test('numbers planner pins by their input row when earlier waypoints are empty', () => {
    appModule.addStop('');
    appModule.addStop('11, 22');
    expect(globalThis.L.marker.mock.lastCall[1].title).toBe('Waypoint 2: 11, 22');
  });

  test('updates an existing planner pin and supports Enter and Space without losing focus', async () => {
    const element = document.createElement('button');
    document.body.appendChild(element);
    const createMarker = globalThis.L.marker.getMockImplementation();
    let marker;
    globalThis.L.marker.mockImplementationOnce((point, options) => {
      marker = { ...createMarker(point, options), options, getElement: () => element };
      return marker;
    });
    try {
      appModule.addStop('11, 22');
      const input = document.querySelector('.stop-input');
      const keydown = marker.on.mock.calls.filter(([event]) => event === 'keydown').at(-1)[1];
      element.focus();
      keydown({ originalEvent: { key: 'ArrowRight' } });
      expect(document.activeElement === element).toBe(true);
      for (const key of ['Enter', ' ']) {
        element.focus();
        const event = { key };
        keydown({ originalEvent: event });
        expect(document.activeElement === input).toBe(true);
        expect(globalThis.L.DomEvent.preventDefault).toHaveBeenCalledWith(event);
        expect(globalThis.L.DomEvent.stopPropagation).toHaveBeenCalledWith(event);
      }
      element.focus();
      const nextColor = (appModule.getPaletteColorIndex(document.getElementById('routeColor').value) + 1) % 10;
      appModule.selectColor(nextColor);
      expect(document.activeElement === element).toBe(true);
      const allocations = globalThis.L.marker.mock.calls.length;
      input.value = '33, 44';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(element.title).toBe('Waypoint 1: 33, 44'));
      expect(marker.setLatLng).toHaveBeenCalledWith([33, 44]);
      expect(marker.setIcon).toHaveBeenCalled();
      expect(marker.setTooltipContent.mock.lastCall[0].textContent).toBe('Waypoint 1: 33, 44');
      expect(globalThis.L.marker.mock.calls.length).toBe(allocations);
      expect(document.activeElement === element).toBe(true);
    } finally { element.remove(); }
  });

  test('moves focus to the next waypoint or destination when a waypoint is removed', () => {
    appModule.addStop('First');
    appModule.addStop('Second');
    const remove = document.querySelector('.stop-row [data-action="remove-stop"]');
    remove.focus();
    remove.click();
    expect(document.activeElement).toBe(document.querySelector('.stop-input'));
    document.querySelector('.stop-row [data-action="remove-stop"]').click();
    expect(document.activeElement).toBe(document.getElementById('destination'));
  });
});

// ============ assertFileSize ============
describe('assertFileSize', () => {
  test('allows files at the configured limit', () => {
    expect(() => appModule.assertFileSize({ name: 'route.gpx', size: 1024 }, 1024, 'route.gpx')).not.toThrow();
  });

  test('rejects files above the configured limit', () => {
    expect(() => appModule.assertFileSize({ name: 'huge.gpx', size: 2048 }, 1024, 'huge.gpx')).toThrow('too large');
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
      appModule.saveToStorage();
      expect(consoleError).toHaveBeenCalledWith('Failed to save to storage:', 'Storage is full');
      expect(document.getElementById('status').textContent).toContain('browser storage is full');
      expect(document.getElementById('status').className).toContain('error');
    } finally {
      globalThis.localStorage.setItem.mockImplementation(originalSetItem);
      consoleError.mockRestore();
      appModule.saveToStorage();
    }
  });

  test('skips invalid restored routes instead of poisoning later storage restores', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    document.querySelectorAll('#routesList .route-item').forEach(row => appModule.removeRoute(Number(row.dataset.routeId)));

    try {
      expect(appModule.restoreRoute({ name: 'Bad route', coordinates: [[95, 0], [40, -74]] })).toBe(false);
      expect(document.querySelectorAll('#routesList .route-item')).toHaveLength(0);
      expect(consoleWarn).toHaveBeenCalledWith('Skipping saved route with invalid coordinates');
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test('restores valid routes with safe palette classes and no inline route styles', () => {
    document.querySelectorAll('#routesList .route-item').forEach(row => appModule.removeRoute(Number(row.dataset.routeId)));

    const restored = appModule.restoreRoute({
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
    expect(document.querySelectorAll('#routesList .route-item')).toHaveLength(1);
    const routeItem = document.querySelector('.route-item');
    expect(routeItem.classList.contains('route-color-0')).toBe(true);
    expect(routeItem.hasAttribute('style')).toBe(false);
    expect(routeItem.querySelector('.route-number').hasAttribute('style')).toBe(false);
    expect(routeItem.getAttribute('aria-label')).toContain('Quoted "Route"');

    document.querySelectorAll('#routesList .route-item').forEach(row => appModule.removeRoute(Number(row.dataset.routeId)));
    document.getElementById('routesList').innerHTML = '';
  });
});

// ============ API key storage ==========
describe('API key storage', () => {
  test('defaults new keys to tab-only storage', () => {
    localStorage.removeItem('route2gpx_apiKey');
    sessionStorage.removeItem('route2gpx_apiKey_session');

    appModule.openApiKeyModal();

    expect(document.getElementById('rememberApiKey').checked).toBe(false);
    expect(document.getElementById('apiKeyStorageHint').textContent).toContain('tab');
    appModule.closeApiKeyModal();
  });

  test('saves unchecked API keys in session storage only', () => {
    localStorage.removeItem('route2gpx_apiKey');
    sessionStorage.removeItem('route2gpx_apiKey_session');
    document.getElementById('apiKeyInput').value = 'session-key';
    document.getElementById('rememberApiKey').checked = false;

    appModule.saveApiKey();

    expect(sessionStorage.getItem('route2gpx_apiKey_session')).toBe('session-key');
    expect(localStorage.getItem('route2gpx_apiKey')).toBeNull();
    expect(appModule.getApiKey()).toBe('session-key');
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
      appModule.saveApiKey();
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
      const elevations = await appModule.fetchElevations([[1, 2], [3, 4]]);
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
    appModule.selectTravelMode('WALK');

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
    expect(appModule.sanitizeColor('#ff4757', 0)).toBe('#ff4757');
  });

  test('accepts 3-digit hex', () => {
    expect(appModule.sanitizeColor('#f00', 0)).toBe('#f00');
  });

  test('rejects malformed hex lengths', () => {
    expect(appModule.sanitizeColor('#12345', 0)).not.toBe('#12345');
    expect(appModule.sanitizeColor('#1234567', 0)).not.toBe('#1234567');
  });

  test('rejects invalid color and returns fallback', () => {
    const result = appModule.sanitizeColor('not-a-color', 0);
    expect(result).toMatch(/^#[0-9a-fA-F]+$/);
  });

  test('rejects empty string', () => {
    const result = appModule.sanitizeColor('', 0);
    expect(result).toMatch(/^#[0-9a-fA-F]+$/);
  });

  test('rejects non-string input', () => {
    const result = appModule.sanitizeColor(null, 0);
    expect(result).toMatch(/^#[0-9a-fA-F]+$/);
  });

  test('cycles fallback index through palette', () => {
    const a = appModule.sanitizeColor(null, 0);
    const b = appModule.sanitizeColor(null, 1);
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
    appModule.selectColor(2);

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
    appModule.selectColor(0);
    const firstColor = document.querySelector('[data-color-index="0"]');

    firstColor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(document.getElementById('routeColor').value).toBe('#2ed573');
    expect(document.querySelector('[data-color-index="1"]').getAttribute('aria-checked')).toBe('true');
  });
});

// ============ getModeIconName ============
describe('getModeIconName', () => {
  test('returns car icon for DRIVE', () => {
    expect(getModeIconName('DRIVE')).toBe('car-front');
  });

  test('returns bus icon for TRANSIT', () => {
    expect(getModeIconName('TRANSIT')).toBe('bus-front');
  });

  test('returns bicycle icon for BICYCLE', () => {
    expect(getModeIconName('BICYCLE')).toBe('bike');
  });

  test('returns walk icon for WALK', () => {
    expect(getModeIconName('WALK')).toBe('footprints');
  });

  test('returns pin icon for unknown mode', () => {
    expect(getModeIconName('UNKNOWN')).toBe('map-pin');
  });

  test('renders accessible decorative SVG markup', () => {
    expect(getModeIconSvg('DRIVE')).toContain('<svg');
    expect(getModeIconSvg('DRIVE')).toContain('aria-hidden="true"');
    expect(getModeIconSvg('DRIVE')).toContain('focusable="false"');
  });
});

// ============ resetColorPool ============
describe('resetColorPool', () => {
  test('is callable without error', () => {
    // The pool state stays private to the module,
    // but we can verify it runs without throwing
    expect(() => appModule.resetColorPool()).not.toThrow();
  });

  test('selectRandomColor advances the color', () => {
    // selectRandomColor calls resetColorPool internally and picks a new color
    expect(() => appModule.selectRandomColor()).not.toThrow();
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

    const gpx = generateGPX(route);

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

    const gpx = generateGPX(route);
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

    const gpx = generateGPX(route);
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

    const gpx = generateGPX(route);
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

    expect(() => generateGPX(route)).not.toThrow();
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

    const gpx = generateGPX(route);
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

    const gpx = generateGPX(route);
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

    const gpx = generateGPX(route);
    expect(gpx).toContain('<ele>150.5</ele>');
    expect(gpx).toContain('<ele>200.3</ele>');
    expect(gpx).not.toContain('<ele>0</ele>');
  });

  test('omits unknown elevation instead of inventing sea level', () => {
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

    const gpx = generateGPX(route);
    expect(gpx).not.toContain('<ele>');
  });
});

// ============ getModeIconName (extended) ============
describe('getModeIconName extended', () => {
  test('returns folder icon for IMPORTED', () => {
    expect(getModeIconName('IMPORTED')).toBe('folder-up');
  });
});

// ============ haversineDistance ============
describe('haversineDistance', () => {
  test('computes zero for same point', () => {
    const d = haversineDistance([40.0, -74.0], [40.0, -74.0]);
    expect(d).toBe(0);
  });

  test('computes approximately correct distance', () => {
    // NYC to LA approx 3,944 km
    const d = haversineDistance([40.7128, -74.006], [34.0522, -118.2437]);
    expect(d).toBeGreaterThan(3900000);
    expect(d).toBeLessThan(4000000);
  });

  test('is symmetric', () => {
    const d1 = haversineDistance([40.7128, -74.006], [51.5074, -0.1278]);
    const d2 = haversineDistance([51.5074, -0.1278], [40.7128, -74.006]);
    expect(d1).toBeCloseTo(d2, 0);
  });
});

// ============ filename modal accessibility ============
describe('filename modal accessibility', () => {
  test('uses shared modal state for focus trap and inert app content', () => {
    const returnFocusButton = document.createElement('button');
    document.body.appendChild(returnFocusButton);
    returnFocusButton.focus();

    appModule.openFilenameModal(1, '<gpx></gpx>', 'route.gpx');

    const modal = document.getElementById('filenameModal');
    const input = document.getElementById('filenameInput');
    const appElement = document.getElementById('app');
    expect(modal.classList.contains('visible')).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(appElement.getAttribute('aria-hidden')).toBe('true');

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escapeEvent);

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(modal.classList.contains('visible')).toBe(false);
    expect(appElement.hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(returnFocusButton);

    returnFocusButton.remove();
  });
});

describe('coordinator import and route actions', () => {
  const source = '<gpx><trk><name>Trail</name><trkseg><trkpt lat="1" lon="2"><ele>0</ele><time>2020-01-01T00:00:00Z</time></trkpt><trkpt lat="3" lon="4"/></trkseg></trk></gpx>';
  const inputFile = (name, content = source) => {
    const bytes = new TextEncoder().encode(content);
    return { name, size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer) };
  };
  const setFiles = files => {
    const input = document.getElementById('importFileInput');
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
  };
  const action = name => document.querySelector(`#routesList [data-action="${name}"]`).click();
  const saved = () => JSON.parse(localStorage.getItem('route2gpx_routes')).routes;
  let downloads;

  beforeEach(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    document.querySelectorAll('#routesList .route-item').forEach(row => appModule.removeRoute(Number(row.dataset.routeId)));
    document.getElementById('stopsContainer').replaceChildren();
    downloads = [];
    vi.stubGlobal('JSZip', JSZip);
    vi.stubGlobal('pako', pako);
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:test-download');
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloads.push(this.download); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  test('retains partial successes and diagnostics for a mixed import batch', async () => {
    const partial = source.replace('<trkpt lat="1"', '<trkpt/><trkpt lat="1"').replace('</gpx>', '<trk><trkseg><trkpt lat="5" lon="6"/></trkseg></trk></gpx>');
    setFiles([inputFile('partial.gpx', partial), inputFile('bad.txt')]);
    await vi.waitFor(() => expect(document.getElementById('importSummaryTitle').textContent).toBe('Imported 1 of 2 file(s)'));
    expect(document.getElementById('importSummaryItems').textContent).toContain('Skipped 1 invalid point(s)');
    expect(document.getElementById('importSummaryItems').textContent).toContain('Skipped 1 track(s)');
    expect(document.getElementById('importSummaryItems').textContent).toContain('Unsupported file type');
    expect(saved()).toHaveLength(1);
    expect(document.getElementById('cancelImportBtn').hidden).toBe(true);
    expect(document.querySelectorAll('#routesList .route-item')).toHaveLength(1);
  });

  test('rejects oversized batches before reading files', () => {
    const file = inputFile('trail.gpx');
    setFiles(Array(101).fill(file));
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(document.getElementById('status').textContent).toContain('at most 100 files');
  });

  test('cancels a pending file read and prevents concurrent imports', async () => {
    let finish;
    const pending = { name: 'pending.gpx', size: 100, arrayBuffer: () => new Promise(resolve => { finish = resolve; }) };
    setFiles([inputFile('first.gpx'), pending, inputFile('never.gpx')]);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    setFiles([inputFile('concurrent.gpx')]);
    expect(document.getElementById('status').textContent).toContain('already running');
    document.getElementById('cancelImportBtn').click();
    finish(new TextEncoder().encode(source).buffer);
    await vi.waitFor(() => expect(document.getElementById('importSummaryItems').textContent).toContain('Import cancelled. Completed tracks are retained.'));
    expect(saved()).toHaveLength(1);
  });

  test('parses gzip locally when no worker exists and rejects unusable tracks', async () => {
    const bytes = pako.gzip(source);
    const { added } = await appModule.handleSingleImportFile({ name: 'trail.gpx.gz', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
    expect(added[0].times[0]).toBe('2020-01-01T00:00:00.000Z');
    await expect(appModule.handleSingleImportFile(inputFile('short.gpx', '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>'))).rejects.toThrow('at least two');
  });

  test('coordinates visibility, row zoom, rename, deletion, and undo without global state', async () => {
    await appModule.handleSingleImportFile(inputFile('trail.gpx'));
    action('toggle-visibility'); expect(saved()[0].visible).toBe(false);
    document.querySelector('#routesList .route-item').click();
    expect(saved()[0].visible).toBe(true); expect(document.body.dataset.mobileView).toBe('map');
    action('rename-route'); document.getElementById('renameInput').value = 'New name';
    document.getElementById('confirmRenameBtn').click(); expect(saved()[0].name).toBe('New name');
    action('remove-route'); expect(saved()).toHaveLength(0);
    expect(document.getElementById('undoNotice').hidden).toBe(false);
    document.getElementById('undoDeleteBtn').click(); expect(saved()[0].name).toBe('New name');
    expect(document.querySelector('.route-item-title').textContent).toBe('New name');
    vi.stubGlobal('confirm', () => true); document.getElementById('clearAllBtn').click();
    expect(saved()).toHaveLength(0); document.getElementById('undoDeleteBtn').click(); expect(saved()).toHaveLength(1);
  });

  test('reuses stored planner inputs, mode, and waypoints through row actions', () => {
    appModule.restoreRoute({ id: 987, name: 'Planned', coordinates: [[1, 2], [3, 4]], request: { origin: 'Start', destination: 'End', stops: ['Middle'], travelMode: 'WALK' } });
    action('edit-route');
    expect(document.getElementById('origin').value).toBe('Start');
    expect(document.getElementById('destination').value).toBe('End');
    expect(appModule.getStops()).toEqual(['Middle']); expect(document.getElementById('travelMode').value).toBe('WALK');
    expect(JSON.parse(localStorage.getItem('route2gpx_draft')).origin).toBe('Start');
  });

  test('exports one route through its dialog and multiple routes as distinct ZIP entries', async () => {
    await appModule.handleSingleImportFile(inputFile('trail.gpx'));
    document.getElementById('downloadAllBtn').click();
    expect(document.getElementById('filenameModal').classList.contains('visible')).toBe(true);
    document.getElementById('confirmFilenameBtn').click();
    expect(downloads).toEqual(['imported_Trail.gpx']);
    await appModule.handleSingleImportFile(inputFile('second.gpx'));
    const write = vi.spyOn(JSZip.prototype, 'file');
    document.getElementById('downloadAllBtn').click();
    await vi.waitFor(() => expect(downloads).toContain('routes.zip'));
    expect(write.mock.calls.filter(call => call.length > 1).map(([name]) => name)).toEqual(['imported_Trail.gpx', 'imported_Trail_2.gpx']);
    expect(document.getElementById('batchExportItems').children).toHaveLength(2);
  });

  test('falls back to individual exports if ZIP generation fails', async () => {
    await appModule.handleSingleImportFile(inputFile('one.gpx'));
    await appModule.handleSingleImportFile(inputFile('two.gpx'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValue(new Error('ZIP failed'));
    document.getElementById('downloadAllBtn').click();
    await vi.waitFor(() => expect(downloads).toHaveLength(2));
    expect(new Set(downloads).size).toBe(2);
    expect(document.getElementById('status').textContent).toContain('downloading GPX files individually');
  });
});
