/**
 * Tests for GPS file parsers (parsers.js).
 *
 * Tests FIT, TCX, and GeoJSON parsers, plus the format detection
 * and gzip decompression flow from app.js.
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
    // Load parsers.js into global scope
    const code = readFileSync(resolve(__dirname, '..', 'parsers.js'), 'utf-8');
    (0, eval)(code);
});

// ============ FIT Parser ============
describe('parseFIT', () => {
    // Helper: build a minimal valid FIT file buffer
    function buildFITFile(records) {
        // We need: header + definition message for record (mesg 20) + data messages + CRC
        const parts = [];

        // Field definitions for record message (global message 20):
        // field 0 = position_lat, sint32 (base type 5), 4 bytes
        // field 1 = position_long, sint32 (base type 5), 4 bytes
        // field 2 = altitude, uint16 (base type 4), 2 bytes
        const defMsg = new Uint8Array([
            0x40,       // record header: definition, local type 0
            0x00,       // reserved
            0x00,       // architecture: little-endian
            20, 0,      // global message number: 20 (record)
            3,          // num fields
            0, 4, 5,    // field 0 (position_lat): 4 bytes, sint32
            1, 4, 5,    // field 1 (position_long): 4 bytes, sint32
            2, 2, 4,    // field 2 (altitude): 2 bytes, uint16
        ]);
        parts.push(defMsg);

        // Data messages
        for (const rec of records) {
            const buf = new ArrayBuffer(1 + 4 + 4 + 2); // header + lat + lng + alt
            const view = new DataView(buf);
            view.setUint8(0, 0x00); // data message, local type 0
            view.setInt32(1, rec.lat, true);
            view.setInt32(5, rec.lng, true);
            view.setUint16(9, rec.alt, true);
            parts.push(new Uint8Array(buf));
        }

        // Calculate data size
        let dataSize = 0;
        for (const p of parts) dataSize += p.byteLength;

        // Build header (14 bytes)
        const header = new ArrayBuffer(14);
        const hView = new DataView(header);
        hView.setUint8(0, 14);           // header size
        hView.setUint8(1, 0x20);         // protocol version 2.0
        hView.setUint16(2, 2134, true);  // profile version
        hView.setUint32(4, dataSize, true); // data size
        // ".FIT" magic
        hView.setUint8(8, 0x2E);  // '.'
        hView.setUint8(9, 0x46);  // 'F'
        hView.setUint8(10, 0x49); // 'I'
        hView.setUint8(11, 0x54); // 'T'
        hView.setUint16(12, 0, true); // CRC (unused)

        // Combine header + data + file CRC
        const totalSize = 14 + dataSize + 2;
        const result = new Uint8Array(totalSize);
        result.set(new Uint8Array(header), 0);
        let offset = 14;
        for (const p of parts) {
            result.set(p, offset);
            offset += p.byteLength;
        }
        // File CRC (2 bytes, zeroed - not validated by our parser)

        return result.buffer;
    }

    function degToSemicircles(deg) {
        return Math.round(deg / (180 / Math.pow(2, 31)));
    }

    test('parses valid FIT with GPS points', () => {
        const lat = degToSemicircles(40.7128);
        const lng = degToSemicircles(-74.006);
        const alt = (100 + 500) * 5; // altitude 100m: (value/5 - 500) = 100

        const buffer = buildFITFile([{ lat, lng, alt }]);
        const result = globalThis.parseFIT(buffer);

        expect(result.coordinates).toHaveLength(1);
        expect(result.coordinates[0][0]).toBeCloseTo(40.7128, 3);
        expect(result.coordinates[0][1]).toBeCloseTo(-74.006, 3);
        expect(result.elevations[0]).toBeCloseTo(100, 0);
    });

    test('parses multiple GPS points', () => {
        const points = [
            { lat: degToSemicircles(40.7128), lng: degToSemicircles(-74.006), alt: 3000 },
            { lat: degToSemicircles(40.7130), lng: degToSemicircles(-74.005), alt: 3050 },
            { lat: degToSemicircles(40.7135), lng: degToSemicircles(-74.004), alt: 3100 },
        ];
        const buffer = buildFITFile(points);
        const result = globalThis.parseFIT(buffer);

        expect(result.coordinates).toHaveLength(3);
        expect(result.coordinates[0][0]).toBeCloseTo(40.7128, 3);
        expect(result.coordinates[2][0]).toBeCloseTo(40.7135, 3);
    });

    test('skips invalid sentinel coordinates', () => {
        const points = [
            { lat: degToSemicircles(40.7128), lng: degToSemicircles(-74.006), alt: 3000 },
            { lat: 0x7FFFFFFF, lng: 0x7FFFFFFF, alt: 0xFFFF }, // invalid
        ];
        const buffer = buildFITFile(points);
        const result = globalThis.parseFIT(buffer);

        expect(result.coordinates).toHaveLength(1);
    });

    test('throws on invalid FIT magic', () => {
        const buffer = new ArrayBuffer(16);
        const view = new DataView(buffer);
        view.setUint8(0, 14);
        // wrong magic
        view.setUint8(8, 0x58); // 'X'
        view.setUint8(9, 0x58);
        view.setUint8(10, 0x58);
        view.setUint8(11, 0x58);

        expect(() => globalThis.parseFIT(buffer)).toThrow('Not a valid FIT file');
    });

    test('throws when no GPS data found', () => {
        // FIT with definition but no data records
        const buffer = buildFITFile([]);
        expect(() => globalThis.parseFIT(buffer)).toThrow('No GPS data found');
    });
});

// ============ TCX Parser ============
describe('parseTCX', () => {
    test('parses valid TCX with trackpoints', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <TrainingCenterDatabase>
        <Activities>
          <Activity Sport="Running">
            <Id>2021-08-13T10:00:00Z</Id>
            <Lap>
              <Track>
                <Trackpoint>
                  <Time>2021-08-13T10:00:00Z</Time>
                  <Position>
                    <LatitudeDegrees>40.7128</LatitudeDegrees>
                    <LongitudeDegrees>-74.006</LongitudeDegrees>
                  </Position>
                  <AltitudeMeters>10.5</AltitudeMeters>
                </Trackpoint>
                <Trackpoint>
                  <Time>2021-08-13T10:00:05Z</Time>
                  <Position>
                    <LatitudeDegrees>40.7130</LatitudeDegrees>
                    <LongitudeDegrees>-74.005</LongitudeDegrees>
                  </Position>
                  <AltitudeMeters>11.0</AltitudeMeters>
                </Trackpoint>
              </Track>
            </Lap>
          </Activity>
        </Activities>
      </TrainingCenterDatabase>`;

        const result = globalThis.parseTCX(xml);

        expect(result.coordinates).toHaveLength(2);
        expect(result.coordinates[0][0]).toBeCloseTo(40.7128, 4);
        expect(result.coordinates[0][1]).toBeCloseTo(-74.006, 4);
        expect(result.elevations[0]).toBeCloseTo(10.5, 1);
        expect(result.elevations[1]).toBeCloseTo(11.0, 1);
        expect(result.name).toBe('2021-08-13T10:00:00Z');
    });

    test('extracts name from Notes element', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <TrainingCenterDatabase>
        <Activities>
          <Activity Sport="Running">
            <Notes>Morning Run</Notes>
            <Id>2021-08-13</Id>
            <Lap><Track>
              <Trackpoint><Position>
                <LatitudeDegrees>40.7</LatitudeDegrees>
                <LongitudeDegrees>-74.0</LongitudeDegrees>
              </Position></Trackpoint>
            </Track></Lap>
          </Activity>
        </Activities>
      </TrainingCenterDatabase>`;

        const result = globalThis.parseTCX(xml);
        expect(result.name).toBe('Morning Run');
    });

    test('skips trackpoints without position', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <TrainingCenterDatabase>
        <Activities><Activity><Lap><Track>
          <Trackpoint>
            <Time>2021-08-13T10:00:00Z</Time>
            <HeartRateBpm><Value>120</Value></HeartRateBpm>
          </Trackpoint>
          <Trackpoint>
            <Position>
              <LatitudeDegrees>40.7</LatitudeDegrees>
              <LongitudeDegrees>-74.0</LongitudeDegrees>
            </Position>
          </Trackpoint>
        </Track></Lap></Activity></Activities>
      </TrainingCenterDatabase>`;

        const result = globalThis.parseTCX(xml);
        expect(result.coordinates).toHaveLength(1);
    });

    test('throws on empty TCX', () => {
        const xml = `<?xml version="1.0"?><TrainingCenterDatabase></TrainingCenterDatabase>`;
        expect(() => globalThis.parseTCX(xml)).toThrow('No valid trackpoints');
    });

    test('throws on invalid XML', () => {
        expect(() => globalThis.parseTCX('not xml at all <<<<')).toThrow('Invalid TCX');
    });
});

// ============ GeoJSON Parser ============
describe('parseGeoJSON', () => {
    test('parses LineString', () => {
        const json = JSON.stringify({
            type: 'Feature',
            properties: { name: 'Test Trail' },
            geometry: {
                type: 'LineString',
                coordinates: [[-74.006, 40.7128, 10], [-74.005, 40.7130, 11]]
            }
        });

        const result = globalThis.parseGeoJSON(json);

        expect(result.coordinates).toHaveLength(2);
        expect(result.coordinates[0]).toEqual([40.7128, -74.006]); // [lat, lng]
        expect(result.coordinates[1]).toEqual([40.7130, -74.005]);
        expect(result.elevations[0]).toBe(10);
        expect(result.elevations[1]).toBe(11);
        expect(result.name).toBe('Test Trail');
    });

    test('parses FeatureCollection', () => {
        const json = JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { name: 'Route 1' },
                    geometry: {
                        type: 'LineString',
                        coordinates: [[-74.0, 40.7], [-74.1, 40.8]]
                    }
                }
            ]
        });

        const result = globalThis.parseGeoJSON(json);
        expect(result.coordinates).toHaveLength(2);
        expect(result.name).toBe('Route 1');
    });

    test('parses Point geometry', () => {
        const json = JSON.stringify({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [-74.006, 40.7128] }
        });

        const result = globalThis.parseGeoJSON(json);
        expect(result.coordinates).toHaveLength(1);
        expect(result.coordinates[0]).toEqual([40.7128, -74.006]);
    });

    test('parses bare geometry object', () => {
        const json = JSON.stringify({
            type: 'LineString',
            coordinates: [[-74.0, 40.7], [-74.1, 40.8]]
        });

        const result = globalThis.parseGeoJSON(json);
        expect(result.coordinates).toHaveLength(2);
    });

    test('handles missing elevation', () => {
        const json = JSON.stringify({
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: [[-74.0, 40.7], [-74.1, 40.8]]
            }
        });

        const result = globalThis.parseGeoJSON(json);
        expect(result.elevations).toEqual([null, null]);
    });

    test('throws on empty coordinates', () => {
        const json = JSON.stringify({
            type: 'FeatureCollection',
            features: []
        });
        expect(() => globalThis.parseGeoJSON(json)).toThrow('No valid coordinates');
    });

    test('throws on invalid JSON', () => {
        expect(() => globalThis.parseGeoJSON('not json')).toThrow();
    });
});

// ============ Format Detection (from app.js) ============
describe('detectImportFormat', () => {
    // Load app.js minimally to get detectImportFormat
    beforeAll(() => {
        // Mock all the DOM and Leaflet dependencies
        const store = {};
        Object.defineProperty(globalThis, 'localStorage', {
            value: {
                getItem: vi.fn((k) => store[k] ?? null),
                setItem: vi.fn((k, v) => { store[k] = String(v); }),
                removeItem: vi.fn((k) => { delete store[k]; }),
                clear: vi.fn(() => {
                    Object.keys(store).forEach((key) => delete store[key]);
                }),
            },
            configurable: true,
        });

        if (!globalThis.L) {
            const noop = vi.fn().mockReturnThis();
            globalThis.L = {
                map: vi.fn(() => ({ fitBounds: noop, closePopup: noop, removeLayer: noop, on: noop, hasLayer: vi.fn() })),
                tileLayer: vi.fn(() => ({ addTo: noop })),
                polyline: vi.fn(() => ({
                    addTo: noop, bindPopup: noop, bindTooltip: noop, on: noop,
                    getBounds: vi.fn(() => [[0, 0], [1, 1]]), setStyle: noop,
                })),
                marker: vi.fn(() => ({ addTo: noop, bindTooltip: noop, on: noop, _icon: null })),
                divIcon: vi.fn(() => ({})),
                popup: vi.fn(() => ({ setContent: vi.fn().mockReturnThis() })),
                DomEvent: { stopPropagation: vi.fn(), preventDefault: vi.fn() },
                GridLayer: { extend: vi.fn(() => vi.fn()) },
                latLngBounds: vi.fn(),
            };
        }

        if (!globalThis.pako) {
            globalThis.pako = { inflate: vi.fn(() => new Uint8Array(0)) };
        }

        if (!globalThis.JSZip) {
            globalThis.JSZip = vi.fn();
            globalThis.JSZip.loadAsync = vi.fn(() => Promise.resolve({ files: {} }));
        }

        // Build DOM elements that app.js needs
        const ids = [
            'map', 'origin', 'destination', 'routesList', 'addStopBtn', 'reverseRouteBtn',
            'colorSwatch', 'unitKm', 'unitMi', 'getRouteBtn', 'downloadAllBtn', 'clearAllBtn',
            'apiKeyMapBtn', 'clickModeBtn', 'locateMeBtn', 'closeModalBtn', 'saveApiKeyBtn',
            'colorOptions', 'routeColor', 'colorDropdown', 'stopsContainer',
            'apiKeyModal', 'apiKeyInput', 'status', 'travelMode',
            'filenameModal', 'filenameInput', 'filenamePreview', 'cancelFilenameBtn', 'confirmFilenameBtn',
            'importDropZone', 'importFileInput',
            'fogDropZone', 'fogFileInput', 'fogBadge', 'fogRemoveBtn', 'fogVisibilityToggle',
            'helpContent', 'mapModeIndicator', 'clickModeTarget',
        ];

        for (const id of ids) {
            if (document.getElementById(id)) continue;
            const tag = ['origin', 'destination', 'apiKeyInput', 'routeColor', 'filenameInput', 'importFileInput', 'fogFileInput']
                .includes(id) ? 'input' : id === 'travelMode' ? 'select' : 'div';
            const el = document.createElement(tag);
            el.id = id;
            if (tag === 'input' && (id === 'importFileInput' || id === 'fogFileInput')) el.type = 'file';
            if (tag === 'select') {
                const opt = document.createElement('option');
                opt.value = 'DRIVE';
                el.appendChild(opt);
            }
            document.body.appendChild(el);
        }

        if (!document.querySelector('.help-toggle')) {
            const helpBtn = document.createElement('button');
            helpBtn.classList.add('help-toggle');
            document.body.appendChild(helpBtn);
        }

        if (!document.querySelector('[data-gps-field]')) {
            ['origin', 'destination'].forEach(field => {
                const btn = document.createElement('button');
                btn.setAttribute('data-gps-field', field);
                document.body.appendChild(btn);
            });
        }

        // Load fog.js and app.js if not already loaded
        if (!globalThis.detectImportFormat) {
            const fogCode = readFileSync(resolve(__dirname, '..', 'fog.js'), 'utf-8');
            (0, eval)(fogCode);
            const appCode = readFileSync(resolve(__dirname, '..', 'app.js'), 'utf-8');
            (0, eval)(appCode);
        }
    });

    test('detects .fit files', () => {
        const result = globalThis.detectImportFormat('activity.fit');
        expect(result).toEqual({ format: 'fit', gzipped: false });
    });

    test('detects .fit.gz files', () => {
        const result = globalThis.detectImportFormat('5922865120.fit.gz');
        expect(result).toEqual({ format: 'fit', gzipped: true });
    });

    test('detects .tcx files', () => {
        const result = globalThis.detectImportFormat('run.tcx');
        expect(result).toEqual({ format: 'tcx', gzipped: false });
    });

    test('detects .tcx.gz files', () => {
        const result = globalThis.detectImportFormat('3503559100.tcx.gz');
        expect(result).toEqual({ format: 'tcx', gzipped: true });
    });

    test('detects .gpx files', () => {
        const result = globalThis.detectImportFormat('route.gpx');
        expect(result).toEqual({ format: 'gpx', gzipped: false });
    });

    test('detects .gpx.gz files', () => {
        const result = globalThis.detectImportFormat('route.gpx.gz');
        expect(result).toEqual({ format: 'gpx', gzipped: true });
    });

    test('detects .kml files', () => {
        const result = globalThis.detectImportFormat('map.kml');
        expect(result).toEqual({ format: 'kml', gzipped: false });
    });

    test('detects .geojson files', () => {
        const result = globalThis.detectImportFormat('track.geojson');
        expect(result).toEqual({ format: 'geojson', gzipped: false });
    });

    test('detects .json files', () => {
        const result = globalThis.detectImportFormat('data.json');
        expect(result).toEqual({ format: 'geojson', gzipped: false });
    });

    test('returns null for unsupported formats', () => {
        expect(globalThis.detectImportFormat('photo.jpg')).toBeNull();
        expect(globalThis.detectImportFormat('document.pdf')).toBeNull();
        expect(globalThis.detectImportFormat('data.csv')).toBeNull();
    });

    test('case insensitive detection', () => {
        expect(globalThis.detectImportFormat('Activity.FIT')).toEqual({ format: 'fit', gzipped: false });
        expect(globalThis.detectImportFormat('Route.GPX.GZ')).toEqual({ format: 'gpx', gzipped: true });
        expect(globalThis.detectImportFormat('Track.TCX')).toEqual({ format: 'tcx', gzipped: false });
    });
});
