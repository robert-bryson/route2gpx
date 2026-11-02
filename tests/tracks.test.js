import { describe, test, expect } from 'vitest';
import { normalizeTrack, normalizeTime, numericValue, trackDistance, mapGeometry, MAX_TRACK_POINTS } from '../track-data.js';
import { parseGPX, parseKML, parseTCX, parseGeoJSON } from '../gps-import.js';
import { generateGPX, uniqueGpxFilenames } from '../gpx.js';

describe('track integrity through import, restore, and export', () => {
    test.each([
        '2020-02-31T00:00:00Z', '2021-02-29T00:00:00Z', '2020-04-31T00:00:00Z',
        '2020-13-01T00:00:00Z', '2020-01-01T25:00:00Z', '2020-01-01T00:00:00+14:01',
        '1900-02-29T00:00:00Z', '0000-01-01T00:00:00Z', '2020-01-01T24:00:01Z',
        '2020-01-01T00:60:00Z', '2020-01-01T00:00:60Z', '2020-01-01T00:00:00+15:00',
        '2020-01-01T00:00:00+01:60',
    ])('omits an invalid recorded time: %s', value => {
        expect(normalizeTime(value)).toBeNull();
    });

    test.each([
        ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
        ['2020-01-01T00:30:00+01:00', '2019-12-31T23:30:00.000Z'],
        ['2020-01-01T00:00:00-14:00', '2020-01-01T14:00:00.000Z'],
        ['2020-01-01T24:00:00Z', '2020-01-02T00:00:00.000Z'],
        ['2020-01-01T00:00:00.1Z', '2020-01-01T00:00:00.100Z'],
    ])('keeps a valid calendar date and offset: %s', (value, expected) => {
        expect(normalizeTime(value)).toBe(expected);
    });

    test('preserves unzoned wall times and submillisecond precision without inferring a timezone', () => {
        expect(normalizeTime('2020-01-01T00:00:00')).toBe('2020-01-01T00:00:00');
        expect(normalizeTime('2020-02-29T12:30:00.123456+02:30')).toBe('2020-02-29T10:00:00.123456Z');
        expect(normalizeTime(' 2020-02-29T12:30:00Z ')).toBe('2020-02-29T12:30:00.000Z');
        const imported = parseGPX('<gpx><trk><trkseg><trkpt lat="1" lon="1"><time>2020-02-31T00:00:00Z</time></trkpt><trkpt lat="2" lon="2"><time>2020-01-01T00:00:00</time></trkpt></trkseg></trk></gpx>');
        const output = new DOMParser().parseFromString(generateGPX(imported), 'application/xml');
        expect([...output.querySelectorAll('trkpt > time')].map(node => node.textContent)).toEqual(['2020-01-01T00:00:00']);
    });

    test('enforces the file point budget across tracks, including invalid coordinates', () => {
        const coordinates = Array(Math.floor(MAX_TRACK_POINTS / 2)).fill(null);
        coordinates.push([1, 1], [2, 2]);
        const source = JSON.stringify({ type: 'FeatureCollection', features: [0, 1].map(() => ({
            type: 'Feature', geometry: { type: 'LineString', coordinates },
        })) });
        expect(() => parseGeoJSON(source)).toThrow(/too many track points|point limit/);
    });

    test('replaces forbidden XML characters while preserving valid Unicode in exports', () => {
        const xml = generateGPX({ name: 'A\u0000\u0001B\ud800😀', coordinates: [[1, 1], [2, 2]] });
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        expect(doc.querySelector('parsererror')).toBeNull();
        expect(doc.querySelector('metadata > name').textContent).toBe('A��B�😀');
    });

    test('keeps unknown numeric fields unknown and accepts explicit zero', () => {
        for (const value of [null, undefined, '', ' ', false, true, '0x10', Infinity]) expect(numericValue(value)).toBeNull();
        expect(numericValue('0')).toBe(0);
        const result = normalizeTrack({ coordinates: [[1, 1], [999, 999], [3, 3]], elevations: [0, 200, null], times: ['2020-01-01T00:00:00Z', null, 'invalid'] });
        expect(result.coordinates).toEqual([[1, 1], [3, 3]]);
        expect(result.elevations).toEqual([0, null]);
        expect(result.segmentStarts).toEqual([0, 1]);
        expect(result.times).toEqual(['2020-01-01T00:00:00.000Z', null]);
    });

    test('never joins disconnected GPX segments and preserves recorded times', () => {
        const source = '<gpx><trk><name>Two places</name><trkseg><trkpt lat="47" lon="-122"><ele>0</ele><time>2020-01-01T00:00:00Z</time></trkpt><trkpt lat="47.001" lon="-122"/></trkseg><trkseg><trkpt lat="40" lon="-74"/><trkpt lat="40.001" lon="-74"/></trkseg></trk></gpx>';
        const imported = parseGPX(source);
        expect(imported.segmentStarts).toEqual([0, 2]);
        expect(trackDistance(imported)).toBeLessThan(250);
        expect(mapGeometry(imported)).toHaveLength(2);
        const output = new DOMParser().parseFromString(generateGPX({ ...imported, origin: 'A', destination: 'B', travelMode: 'IMPORTED' }), 'application/xml');
        expect(output.querySelectorAll('trkseg')).toHaveLength(2);
        expect(output.querySelectorAll('trkpt')).toHaveLength(4);
        expect(output.querySelectorAll('trkpt > ele')).toHaveLength(1);
        expect(output.querySelectorAll('trkpt > time')).toHaveLength(1);
        expect(output.querySelector('trkpt > time').textContent).toBe('2020-01-01T00:00:00.000Z');
    });

    test('rejects absent and empty coordinates without inventing the origin', () => {
        const data = parseGPX('<gpx><trk><trkseg><trkpt/><trkpt lat="" lon=""/><trkpt lat="0" lon="0"/><trkpt lat="1" lon="1"/></trkseg></trk></gpx>');
        expect(data.coordinates).toEqual([[0, 0], [1, 1]]);
        expect(data.elevations).toEqual([null, null]);
    });

    test('retains separate GPX tracks and KML Placemarks', () => {
        const gpx = parseGPX('<gpx><trk><name>One</name><trkseg><trkpt lat="1" lon="1"/></trkseg></trk><trk><name>Two</name><trkseg><trkpt lat="2" lon="2"/></trkseg></trk></gpx>');
        expect(gpx.tracks.map(track => track.name)).toEqual(['One', 'Two']);
        const kml = parseKML('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>One</name><LineString><coordinates>1,1 2,2</coordinates></LineString></Placemark><Placemark><name>Two</name><LineString><coordinates>3,3 4,4</coordinates></LineString></Placemark></Document></kml>');
        expect(kml.tracks.map(track => track.name)).toEqual(['One', 'Two']);
        expect(kml.segmentStarts).toEqual([0, 2]);
    });

    test('supports GeoJSON line collections without joining lines or tracing polygons', () => {
        const data = parseGeoJSON(JSON.stringify({ type: 'GeometryCollection', geometries: [{ type: 'MultiLineString', coordinates: [[[1, 1], [2, 2]], [[3, 3], [4, 4]]] }, { type: 'Polygon', coordinates: [[[10, 10], [20, 20], [10, 10]]] }] }));
        expect(data.segmentStarts).toEqual([0, 2]);
        expect(data.coordinates).toHaveLength(4);
        expect(() => parseGeoJSON(JSON.stringify({ type: 'Point', coordinates: [1, 1] }))).toThrow('not route tracks');
    });

    test('TCX preserves track breaks and skips empty positions', () => {
        const data = parseTCX('<TrainingCenterDatabase><Activities><Activity><Lap><Track><Trackpoint><Position><LatitudeDegrees/><LongitudeDegrees/></Position></Trackpoint><Trackpoint><Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position><Time>2020-01-01T00:00:00Z</Time></Trackpoint></Track><Track><Trackpoint><Position><LatitudeDegrees>3</LatitudeDegrees><LongitudeDegrees>4</LongitudeDegrees></Position></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>');
        expect(data.coordinates).toEqual([[1, 2], [3, 4]]);
        expect(data.segmentStarts).toEqual([0, 1]);
        expect(data.times[0]).toBe('2020-01-01T00:00:00.000Z');
    });

    test('aligns gx:Track times across lazy KML segments and invalid points', () => {
        const source = '<kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark><gx:MultiTrack><gx:Track><when>2020-01-01T00:00:00Z</when><when>2020-01-01T00:00:01Z</when><when>2020-01-01T00:00:02Z</when><gx:coord>1 1 0</gx:coord><gx:coord>invalid</gx:coord><gx:coord>2 2 20</gx:coord></gx:Track><gx:Track><when>2020-01-01T00:00:03Z</when><when>2020-01-01T00:00:04Z</when><gx:coord>3 3 30</gx:coord><gx:coord>4 4 40</gx:coord></gx:Track></gx:MultiTrack></Placemark></kml>';
        const result = parseKML(source);
        expect(result.coordinates).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
        expect(result.elevations).toEqual([0, 20, 30, 40]);
        expect(result.segmentStarts).toEqual([0, 1, 2]);
        expect(result.times).toEqual([0, 2, 3, 4].map(second => `2020-01-01T00:00:0${second}.000Z`));
        expect(result.diagnostics.skippedPoints).toBe(1);
    });

    test('synthesizes time only by explicit choice and distributes it by distance', () => {
        const track = { coordinates: [[0, 0], [0, 0.1], [0, 1]], travelMode: 'WALK', duration: '100s' };
        const options = { timePolicy: 'synthesize', startTime: new Date('2020-01-01T00:00:00Z') };
        const doc = new DOMParser().parseFromString(generateGPX(track, options), 'application/xml');
        expect([...doc.querySelectorAll('trkpt > time')].map(node => node.textContent)).toEqual(['2020-01-01T00:00:00.000Z', '2020-01-01T00:00:10.000Z', '2020-01-01T00:01:40.000Z']);
        expect(generateGPX(track)).not.toContain('<ele>');
        expect(generateGPX(track)).not.toMatch(/<trkpt[^>]*>\s*<time>/);
    });

    test('reserves unique ZIP paths after truncation, sanitization, and case folding', () => {
        const routes = ['A/B', 'A:B', 'a_b', 'x'.repeat(60), 'x'.repeat(70)].map(name => ({ name, travelMode: 'WALK' }));
        const files = uniqueGpxFilenames(routes);
        expect(new Set(files.map(file => file.toLowerCase())).size).toBe(routes.length);
        expect(files.slice(0, 3)).toEqual(['walk_A_B.gpx', 'walk_A_B_2.gpx', 'walk_a_b_3.gpx']);
    });

    test('reports skipped points, short tracks, and unsupported geometry', () => {
        const gpx = parseGPX('<gpx><trk><trkseg><trkpt/><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk><trk><trkseg><trkpt lat="3" lon="3"/></trkseg></trk><trk/></gpx>');
        expect(gpx.diagnostics).toEqual({ skippedPoints: 1, skippedTracks: 2, unsupportedGeometries: 0 });
        const json = parseGeoJSON(JSON.stringify({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[1, 1], [2, 2], [200, 200]] }, { type: 'Polygon', coordinates: [] }] }));
        expect(json.diagnostics).toEqual({ skippedPoints: 1, skippedTracks: 0, unsupportedGeometries: 1 });
        const kml = parseKML('<kml><Placemark><LineString><coordinates>1,1 2,2</coordinates></LineString><Point><coordinates>3,3</coordinates></Point></Placemark></kml>');
        expect(kml.diagnostics.unsupportedGeometries).toBe(1);
    });
});
