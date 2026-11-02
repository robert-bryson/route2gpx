import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseGPX, parseKML, parseTCX } from '../gps-import.js';

afterEach(() => vi.unstubAllGlobals());

describe('XML imports without a document tree', () => {
    test.each([
        [parseGPX, '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trkseg></trk></gpx>'],
        [parseKML, '<kml><Placemark><LineString><coordinates>2,1 4,3</coordinates></LineString></Placemark></kml>'],
        [parseTCX, '<TrainingCenterDatabase><Courses><Course><Track><Trackpoint><Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position></Trackpoint><Trackpoint><Position><LatitudeDegrees>3</LatitudeDegrees><LongitudeDegrees>4</LongitudeDegrees></Position></Trackpoint></Track></Course></Courses></TrainingCenterDatabase>'],
    ])('extracts tracks while DOMParser is unavailable', (parse, source) => {
        vi.stubGlobal('DOMParser', undefined);
        expect(parse(source).coordinates).toEqual([[1, 2], [3, 4]]);
    });
});

const gpxPoints = '<trkpt lat="1" lon="2"><ele>0</ele><time>2020-01-01T00:00:00Z</time></trkpt><trkpt lat="3" lon="4"/>';

test('preserves namespaces, entities, CDATA, routes, and metadata declared after a track', () => {
    const source = `<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" xmlns="http://www.topografix.com/GPX/1/1"><g:trk><g:trkseg>${gpxPoints}</g:trkseg></g:trk><g:rte><g:name><![CDATA[River & Trail]]></g:name><g:rtept lat="5" lon="6"/><g:rtept lat="7" lon="8"/></g:rte><g:metadata><g:name>Park &amp; Lake</g:name></g:metadata></g:gpx>`;
    const result = parseGPX(new TextEncoder().encode(source));
    expect(result.tracks.map(track => track.name)).toEqual(['Park & Lake', 'River & Trail']);
    expect(result.segmentStarts).toEqual([0, 2]);
    expect(result.elevations).toEqual([0, null, null, null]);
    expect(result.times[0]).toBe('2020-01-01T00:00:00.000Z');
});

test('decodes split UTF-8 and XML tokens at chunk boundaries', () => {
    const prefix = '<gpx><metadata><desc>';
    const padding = ' '.repeat(65536 - prefix.length - 1);
    const source = `${prefix}${padding}😀</desc><name>Résumé 😀</name></metadata><trk><trkseg>${gpxPoints}</trkseg></trk></gpx>`;
    expect(parseGPX(new TextEncoder().encode(source).buffer).name).toBe('Résumé 😀');
    expect(parseGPX(source).coordinates).toEqual([[1, 2], [3, 4]]);
});

test('keeps gx time pairing when times follow coordinates and skips invalid points', () => {
    const source = '<kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark><gx:Track><gx:coord>2 1 0</gx:coord><gx:coord>invalid</gx:coord><gx:coord>4 3 5</gx:coord><when>2020-01-01T00:00:00Z</when><when>2020-01-01T00:00:01Z</when><when>2020-01-01T00:00:02Z</when></gx:Track></Placemark></kml>';
    const result = parseKML(source);
    expect(result.coordinates).toEqual([[1, 2], [3, 4]]);
    expect(result.segmentStarts).toEqual([0, 1]);
    expect(result.times).toEqual(['2020-01-01T00:00:00.000Z', '2020-01-01T00:00:02.000Z']);
});

test.each([
    '<gpx><trk></gpx>', '<gpx><trk name="a" name="b"/></gpx>',
    `<gpx><trk><name>&unknown;</name><trkseg>${gpxPoints}</trkseg></trk></gpx>`,
])('rejects malformed XML without returning partial tracks', source => {
    expect(() => parseGPX(source)).toThrow('Invalid GPX');
});

test('rejects document types and deeply nested XML', () => {
    expect(() => parseGPX('<!DOCTYPE gpx [<!ENTITY custom "value">]><gpx/>')).toThrow('document types');
    expect(() => parseGPX('<gpx>' + '<extension>'.repeat(65) + '</extension>'.repeat(65) + '</gpx>')).toThrow('nesting');
});

test('bounds non-coordinate fields and empty track collections', () => {
    expect(() => parseGPX(`<gpx><metadata><name>${'x'.repeat(65537)}</name></metadata></gpx>`)).toThrow('field is too long');
    expect(() => parseGPX('<gpx>' + '<trk/>'.repeat(10001) + '</gpx>')).toThrow('too many tracks');
});

test('ignores GPX extension elements that reuse track and point field names', () => {
    const source = '<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:x="urn:extension"><trk><trkseg>' +
        '<trkpt lat="1" lon="2"><ele>10</ele><x:ele>999</x:ele><time>2020-01-01T00:00:00Z</time><x:time>2021-01-01T00:00:00Z</x:time></trkpt>' +
        '<trkpt lat="3" lon="4"/></trkseg><extensions><x:trk><x:trkseg><x:trkpt lat="5" lon="6"/></x:trkseg></x:trk></extensions></trk></gpx>';
    const result = parseGPX(source);
    expect(result.coordinates).toEqual([[1, 2], [3, 4]]);
    expect(result.elevations).toEqual([10, null]);
    expect(result.times).toEqual(['2020-01-01T00:00:00.000Z', null]);
});

test('reads TCX positions and times only from their defined parent elements', () => {
    const source = '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:x="urn:extension"><Activities><Activity><Lap><Track>' +
        '<Trackpoint><Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position><AltitudeMeters>10</AltitudeMeters><Time>2020-01-01T00:00:00Z</Time>' +
        '<Extensions><x:LatitudeDegrees>80</x:LatitudeDegrees><x:LongitudeDegrees>90</x:LongitudeDegrees><x:AltitudeMeters>999</x:AltitudeMeters><x:Time>2021-01-01T00:00:00Z</x:Time>' +
        '<LatitudeDegrees>70</LatitudeDegrees><Time>2022-01-01T00:00:00Z</Time></Extensions></Trackpoint>' +
        '<Trackpoint><Position><LatitudeDegrees>3</LatitudeDegrees><LongitudeDegrees>4</LongitudeDegrees></Position></Trackpoint>' +
        '</Track></Lap></Activity></Activities></TrainingCenterDatabase>';
    const result = parseTCX(source);
    expect(result.coordinates).toEqual([[1, 2], [3, 4]]);
    expect(result.elevations).toEqual([10, null]);
    expect(result.times).toEqual(['2020-01-01T00:00:00.000Z', null]);
});

test('does not import route-shaped data inside unrelated XML extensions', () => {
    const extension = '<extensions><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trkseg></trk></extensions>';
    expect(() => parseGPX(`<gpx>${extension}</gpx>`)).toThrow('No valid track');
});

test('keeps KML gx tracks separate from foreign extensions and extension timestamps', () => {
    const source = '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:t="http://www.google.com/kml/ext/2.2" xmlns:x="urn:extension"><Placemark><t:Track>' +
        '<when>2020-01-01T00:00:00Z</when><when>2020-01-01T00:00:01Z</when><t:coord>2 1 0</t:coord><t:coord>4 3 5</t:coord>' +
        '<ExtendedData><when>2030-01-01T00:00:00Z</when><t:coord>80 80 999</t:coord></ExtendedData></t:Track>' +
        '<x:Track><x:coord>70 70 999</x:coord></x:Track></Placemark></kml>';
    const result = parseKML(source);
    expect(result.coordinates).toEqual([[1, 2], [3, 4]]);
    expect(result.elevations).toEqual([0, 5]);
    expect(result.times).toEqual(['2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z']);
});

test('rejects a different XML document type instead of looking for track-shaped descendants', () => {
    expect(() => parseGPX(`<other><gpx><trk><trkseg>${gpxPoints}</trkseg></trk></gpx></other>`)).toThrow('Invalid GPX root');
});
