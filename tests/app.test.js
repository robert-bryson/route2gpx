/**
 * Tests for pure utility functions in app.js.
 *
 * Strategy: Vitest runs with jsdom environment. We mock Leaflet and build
 * the minimal DOM structure that app.js expects at load time, then load
 * app.js via indirect eval so all function declarations land on globalThis.
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Setup before loading app.js ----
beforeAll(() => {
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

  globalThis.L = {
    map: vi.fn(() => ({
      fitBounds: vi.fn(),
      closePopup: vi.fn(),
      removeLayer: vi.fn(),
      on: vi.fn(),
    })),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    polyline: vi.fn(() => ({ ...mockPolyline })),
    marker: vi.fn(() => ({ ...mockMarker })),
    divIcon: vi.fn(() => ({})),
    popup: vi.fn(() => ({ setContent: vi.fn().mockReturnThis() })),
    DomEvent: { stopPropagation: vi.fn(), preventDefault: vi.fn() },
  };

  // Build minimal DOM with all the element IDs app.js expects
  const ids = [
    'map', 'origin', 'destination', 'routesList', 'addStopBtn', 'reverseRouteBtn',
    'colorSwatch', 'unitKm', 'unitMi', 'getRouteBtn', 'downloadAllBtn', 'clearAllBtn',
    'apiKeyMapBtn', 'clickModeBtn', 'locateMeBtn', 'closeModalBtn', 'saveApiKeyBtn',
    'colorOptions', 'routeColor', 'colorDropdown', 'stopsContainer', 'apiKeyStatus',
    'apiKeyModal', 'apiKeyInput', 'status', 'travelMode',
    'filenameModal', 'filenameInput', 'filenamePreview', 'cancelFilenameBtn', 'confirmFilenameBtn',
    'importDropZone', 'importFileInput',
    'fogDropZone', 'fogFileInput', 'fogBadge', 'fogRemoveBtn',
  ];

  ids.forEach(id => {
    const el = document.createElement(
      ['origin', 'destination', 'apiKeyInput', 'routeColor', 'filenameInput'].includes(id) ? 'input' :
        id === 'importFileInput' ? 'input' : 'div'
    );
    el.id = id;
    if (id === 'importFileInput') {
      el.type = 'file';
    }
    if (id === 'travelMode') {
      const select = document.createElement('select');
      select.id = id;
      const opt = document.createElement('option');
      opt.value = 'DRIVE';
      select.appendChild(opt);
      document.body.appendChild(select);
      return;
    }
    document.body.appendChild(el);
  });

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

  // Load fog.js into global scope (must be before app.js since app.js calls setupFogOfWorld)
  const fogCode = readFileSync(resolve(__dirname, '..', 'fog.js'), 'utf-8');
  (0, eval)(fogCode);

  // Load app.js into global scope via indirect eval
  const code = readFileSync(resolve(__dirname, '..', 'app.js'), 'utf-8');
  (0, eval)(code);
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
});

// ============ sanitizeColor ============
describe('sanitizeColor', () => {
  test('accepts valid hex color', () => {
    expect(globalThis.sanitizeColor('#ff4757', 0)).toBe('#ff4757');
  });

  test('accepts 3-digit hex', () => {
    expect(globalThis.sanitizeColor('#f00', 0)).toBe('#f00');
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

// ============ getModeEmoji ============
describe('getModeEmoji', () => {
  test('returns car emoji for DRIVE', () => {
    expect(globalThis.getModeEmoji('DRIVE')).toBe('🚗');
  });

  test('returns bus emoji for TRANSIT', () => {
    expect(globalThis.getModeEmoji('TRANSIT')).toBe('🚌');
  });

  test('returns bicycle emoji for BICYCLE', () => {
    expect(globalThis.getModeEmoji('BICYCLE')).toBe('🚴');
  });

  test('returns walk emoji for WALK', () => {
    expect(globalThis.getModeEmoji('WALK')).toBe('🚶');
  });

  test('returns pin for unknown mode', () => {
    expect(globalThis.getModeEmoji('UNKNOWN')).toBe('📍');
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

  test('includes stop waypoints', () => {
    const route = {
      name: 'Stops Test',
      origin: 'A',
      destination: 'C',
      travelMode: 'DRIVE',
      stops: ['B'],
      coordinates: [[40.0, -74.0], [40.5, -74.5], [41.0, -75.0]],
      distance: 2000,
      duration: '1200s',
      color: '#1e90ff',
      id: 3,
    };

    const gpx = globalThis.generateGPX(route);
    expect(gpx).toContain('Stop 1: B');
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

// ============ getModeEmoji (extended) ============
describe('getModeEmoji extended', () => {
  test('returns folder emoji for IMPORTED', () => {
    expect(globalThis.getModeEmoji('IMPORTED')).toBe('📂');
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
