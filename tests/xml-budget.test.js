import { expect, test, vi } from 'vitest';

// Exercise the real parsing path with a small file-wide limit.
vi.mock('../track-data.js', async importOriginal => ({ ...await importOriginal(), MAX_TRACK_POINTS: 3 }));
import { parseGPX, parseKML, parseTCX } from '../gps-import.js';

test.each([
    [parseGPX, '<gpx><trk><trkseg><trkpt/><trkpt/></trkseg></trk><trk><trkseg><trkpt/><trkpt/>'],
    [parseKML, '<kml><Placemark><LineString><coordinates>invalid invalid</coordinates></LineString></Placemark><Placemark><LineString><coordinates>invalid invalid</coordinates>'],
    [parseTCX, '<TrainingCenterDatabase><Activity><Track><Trackpoint/><Trackpoint/></Track></Activity><Activity><Track><Trackpoint/><Trackpoint/>'],
])('stops at the shared raw point limit before reading a malformed tail', (parse, source) => {
    expect(() => parse(source + '<broken')).toThrow('too many track points');
});

test('bounds gx times even when coordinates are absent', () => {
    const source = '<kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark><gx:Track>' + '<when>2020-01-01T00:00:00Z</when>'.repeat(4) + '</gx:Track></Placemark></kml>';
    expect(() => parseKML(source)).toThrow('too many track times');
});
