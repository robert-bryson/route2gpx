import { expect, test } from 'vitest';
import { EXPORT_FORMATS, exportFilename, generateRouteExport } from '../route-export.js';
import { parseGeoJSON, parseKML, parseTCX } from '../gps-import.js';

const route = {
    name: 'Coast & hills <trail>',
    coordinates: [[47, -122], [47.001, -122.001], [40, -74], [40.001, -74.001]],
    elevations: [0, null, 100, null],
    times: ['2020-01-01T00:00:00Z', null, '2020-01-01T00:01:00Z', null],
    segmentStarts: [0, 2],
};

test('KML keeps gaps, coordinates, zero and missing heights, and escapes XML names', () => {
    const source = generateRouteExport(route, 'kml');
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('name').textContent).toBe(route.name);
    expect(doc.querySelectorAll('MultiGeometry > LineString')).toHaveLength(2);
    expect(doc.querySelector('coordinates').textContent).toBe('-122,47,0 -122.001,47.001');
    const imported = parseKML(source);
    expect(imported.coordinates).toEqual(route.coordinates);
    expect(imported.segmentStarts).toEqual([0, 2]);
    expect(imported.elevations).toEqual(route.elevations);
    expect(imported.times).toEqual([null, null, null, null]);
});

test('GeoJSON round-trips separate segments, optional heights, and aligned recorded times', () => {
    const source = generateRouteExport(route, 'geojson');
    const json = JSON.parse(source);
    expect(json.geometry.type).toBe('MultiLineString');
    expect(json.geometry.coordinates[0]).toEqual([[-122, 47, 0], [-122.001, 47.001]]);
    expect(json.properties.coordTimes).toEqual([
        ['2020-01-01T00:00:00.000Z', null], ['2020-01-01T00:01:00.000Z', null],
    ]);
    const imported = parseGeoJSON(source);
    expect(imported.coordinates).toEqual(route.coordinates);
    expect(imported.elevations).toEqual(route.elevations);
    expect(imported.segmentStarts).toEqual([0, 2]);
    expect(imported.times).toEqual(json.properties.coordTimes.flat());
});

test('single-segment exports use a LineString and omit absent timestamps and heights', () => {
    const track = { coordinates: route.coordinates.slice(0, 2) };
    const json = JSON.parse(generateRouteExport(track, 'geojson'));
    expect(json.geometry).toEqual({ type: 'LineString', coordinates: [[-122, 47], [-122.001, 47.001]] });
    expect(json.properties).toEqual({ name: '' });
    expect(parseGeoJSON(generateRouteExport({ ...track, times: route.times.slice(0, 2) }, 'geojson')).times).toEqual(['2020-01-01T00:00:00.000Z', null]);
    const xml = generateRouteExport(track, 'kml');
    expect(xml).not.toContain('MultiGeometry');
    expect(xml).toContain('<altitudeMode>clampToGround</altitudeMode>');
});

test('isolated points remain Points instead of invalid one-point lines or connected gaps', () => {
    const split = { ...route, segmentStarts: [0, 1] };
    const json = JSON.parse(generateRouteExport(split, 'geojson'));
    expect(json.type).toBe('FeatureCollection');
    expect(json.features.map(feature => feature.geometry.type)).toEqual(['Point', 'LineString']);
    expect(json.features[0].geometry.coordinates).toEqual([-122, 47, 0]);
    expect(json.features[1].geometry.coordinates).toHaveLength(3);
    const xml = new DOMParser().parseFromString(generateRouteExport(split, 'kml'), 'application/xml');
    expect(xml.querySelectorAll('MultiGeometry > Point')).toHaveLength(1);
    expect(xml.querySelectorAll('MultiGeometry > LineString')).toHaveLength(1);
});

test('invalid GeoJSON coordinates cannot shift recorded times to a neighboring point', () => {
    const imported = parseGeoJSON(JSON.stringify({
        type: 'Feature',
        properties: { coordTimes: ['2020-01-01T00:00:00Z', '2020-01-01T00:00:01Z', 'invalid'] },
        geometry: { type: 'LineString', coordinates: [[2, 1], [999, 999], [4, 3]] },
    }));
    expect(imported.coordinates).toEqual([[1, 2], [3, 4]]);
    expect(imported.segmentStarts).toEqual([0, 1]);
    expect(imported.times).toEqual(['2020-01-01T00:00:00.000Z', null]);
});

test('default GPX export retains timestamp synthesis as an explicit option', () => {
    const xml = generateRouteExport({ ...route, duration: '60s' }, 'gpx', { timePolicy: 'synthesize', startTime: '2020-01-01T00:00:00Z' });
    expect(new DOMParser().parseFromString(xml, 'application/xml').querySelectorAll('trkpt > time')).toHaveLength(4);
    expect(generateRouteExport(route)).toContain('<gpx version="1.1"');
});

test.each(['kml', 'geojson'])('%s rejects a track without two valid coordinates', format => {
    expect(() => generateRouteExport({ coordinates: [[1, 2], [999, 999]] }, format)).toThrow('two valid points');
});

test('filenames have one matching extension and unsupported formats are rejected', () => {
    expect(exportFilename(' A/B.GPX ', 'geojson')).toBe('A_B.geojson');
    expect(exportFilename('.kml', 'kml')).toBe('route.kml');
    expect(exportFilename()).toBe('route.gpx');
    expect(exportFilename('x'.repeat(80), 'kml')).toBe(`${'x'.repeat(50)}.kml`);
    expect(EXPORT_FORMATS.geojson.mimeType).toBe('application/geo+json');
    expect(() => exportFilename('trail', 'fit')).toThrow('Unsupported export format');
    expect(() => generateRouteExport(route, '__proto__')).toThrow('Unsupported export format');
});

test.each(Object.keys(EXPORT_FORMATS).flatMap(from => ['tcx', 'csv'].map(to => [from, to])))('switches a %s filename to %s without keeping the old extension', (from, to) => {
    expect(exportFilename(`Trail.${from.toUpperCase()}`, to)).toBe(`Trail.${to}`);
});

test('CSV preserves gaps, zero heights, missing values, and validated times in fixed columns', () => {
    const source = generateRouteExport({ ...route, name: '=HYPERLINK("bad")\r\nmore' }, 'csv');
    expect(source).toBe([
        'segment,point,latitude,longitude,elevation_m,time',
        '1,1,47,-122,0,2020-01-01T00:00:00.000Z',
        '1,2,47.001,-122.001,,',
        '2,3,40,-74,100,2020-01-01T00:01:00.000Z',
        '2,4,40.001,-74.001,,', '',
    ].join('\r\n'));
    expect(source).not.toContain('HYPERLINK');
});

test('TCX requires complete point times unless generation is explicitly selected', () => {
    expect(() => generateRouteExport(route, 'tcx')).toThrow(/timestamp for every point/i);
    const source = generateRouteExport({ ...route, duration: '100s' }, 'tcx', { timePolicy: 'synthesize', startTime: '2020-01-01T00:00:00Z' });
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.namespaceURI).toBe('http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2');
    expect(doc.querySelectorAll('Courses > Course > Track')).toHaveLength(2);
    expect(doc.querySelectorAll('Trackpoint > Time')).toHaveLength(4);
    expect(doc.querySelectorAll('Trackpoint > AltitudeMeters')).toHaveLength(2);
    expect(doc.querySelector('Notes').textContent).toContain('Point times are generated');
    expect(doc.querySelector('Activity')).toBeNull();
    const imported = parseTCX(source);
    expect(imported.coordinates).toEqual(route.coordinates);
    expect(imported.segmentStarts).toEqual([0, 2]);
    expect(imported.elevations).toEqual(route.elevations);
    expect(imported.times.at(-1)).toBe('2020-01-01T00:01:40.000Z');
    const distances = [...doc.querySelectorAll('DistanceMeters')].map(node => Number(node.textContent));
    expect(distances[2]).toBe(distances[1]);
    expect(distances.at(-1)).toBeLessThan(400);
});

test('TCX preserves recorded times and handles schema name and longitude limits', () => {
    const source = generateRouteExport({
        ...route, name: '  😀 Coastal   trail with a very long name  ',
        coordinates: [[90, 180], [-90, -180]], segmentStarts: [0, 1],
        elevations: [0, null], times: ['2020-01-01T00:00:00.123456Z', '2020-01-01T00:01:00'],
    }, 'tcx');
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    expect(Array.from(doc.querySelector('Name').textContent)).toHaveLength(15);
    expect(doc.querySelector('Notes').textContent).toContain('with a very long name');
    expect([...doc.querySelectorAll('LongitudeDegrees')].map(node => node.textContent)).toEqual(['-180', '-180']);
    expect([...doc.querySelectorAll('Time')].map(node => node.textContent)).toEqual(['2020-01-01T00:00:00.123456Z', '2020-01-01T00:01:00']);
    expect(parseTCX(source).name).toBe(doc.querySelector('Name').textContent);
});

test('TCX import uses the course name instead of its descriptive notes', () => {
    const source = '<TrainingCenterDatabase><Courses><Course><Name>Actual course</Name><Track><Trackpoint><Time>2020-01-01T00:00:00Z</Time><Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position></Trackpoint><Trackpoint><Time>2020-01-01T00:01:00Z</Time><Position><LatitudeDegrees>2</LatitudeDegrees><LongitudeDegrees>3</LongitudeDegrees></Position></Trackpoint></Track><Notes>Background information, not the course name.</Notes></Course></Courses></TrainingCenterDatabase>';
    expect(parseTCX(source).name).toBe('Actual course');
});

test('invalid time policies fail instead of silently dropping recorded point times', () => {
    expect(() => generateRouteExport(route, 'gpx', { timePolicy: 'invalid' })).toThrow(/time policy/i);
});

test('TCX supplies a schema-safe default name and replaces XML control characters', () => {
    const unnamed = { ...route, name: ' ', times: Array(4).fill('2020-01-01T00:00:00Z') };
    expect(generateRouteExport(unnamed, 'tcx')).toContain('<Name>Route</Name>');
    expect(generateRouteExport({ ...unnamed, name: undefined }, 'tcx')).toContain('<Name>Route</Name>');
    const source = generateRouteExport({ ...unnamed, name: 'A\u0000 & <B>' }, 'tcx');
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('Name').textContent).toBe('A� & <B>');
});
