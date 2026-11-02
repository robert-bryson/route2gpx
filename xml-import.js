import { SaxesParser } from 'saxes';
import { MAX_TRACK_POINTS, normalizeCoordinate, normalizeTime, numericValue, summarizeTracks } from './track-data.js';

const CHUNK_SIZE = 64 * 1024;
const MAX_FIELD_LENGTH = 64 * 1024;
const MAX_TRACKS = 10000;
const GX_NAMESPACE = 'http://www.google.com/kml/ext/2.2';
const ROOT_NAMES = { gpx: 'gpx', kml: 'kml', tcx: 'TrainingCenterDatabase' };
// A matching local name alone does not make an extension part of a track.
const ELEMENT_PARENTS = {
    gpx: {
        metadata: ['gpx'], trk: ['gpx'], rte: ['gpx'], trkseg: ['trk'],
        trkpt: ['trkseg'], rtept: ['rte'], name: ['metadata', 'trk', 'rte'],
        ele: ['trkpt', 'rtept'], time: ['trkpt', 'rtept'],
    },
    tcx: {
        Activities: ['TrainingCenterDatabase'], Courses: ['TrainingCenterDatabase'],
        Activity: ['Activities', 'TrainingCenterDatabase'], Course: ['Courses', 'TrainingCenterDatabase'],
        Lap: ['Activity'], Track: ['Lap', 'Activity', 'Course', 'TrainingCenterDatabase'],
        Trackpoint: ['Track'], Position: ['Trackpoint'], LatitudeDegrees: ['Position'], LongitudeDegrees: ['Position'],
        AltitudeMeters: ['Trackpoint'], Time: ['Trackpoint'],
        Notes: ['Activity', 'Course', 'TrainingCenterDatabase'], Name: ['Activity', 'Course', 'TrainingCenterDatabase'],
        Id: ['Activity', 'Course', 'TrainingCenterDatabase'],
    },
    kml: {
        Document: ['kml', 'Document', 'Folder'], Folder: ['kml', 'Document', 'Folder'],
        Placemark: ['kml', 'Document', 'Folder'], MultiGeometry: ['Placemark', 'MultiGeometry', 'kml'],
        LineString: ['Placemark', 'MultiGeometry', 'kml'], coordinates: ['LineString'],
        Point: ['Placemark', 'MultiGeometry', 'kml'], Polygon: ['Placemark', 'MultiGeometry', 'kml'],
        MultiTrack: ['Placemark', 'MultiGeometry', 'kml'], Track: ['Placemark', 'MultiGeometry', 'MultiTrack', 'kml'],
        coord: ['Track'], when: ['Track'], name: ['Placemark', 'Document', 'Folder', 'kml'],
    },
};

// Normalize as records arrive. There is no raw point array or XML document tree.
function trackBuilder() {
    const track = { coordinates: [], elevations: [], times: [], segmentStarts: [], diagnostics: { skippedPoints: 0 }, name: null };
    let newSegment = true;
    return {
        track,
        fields: {},
        startSegment() { newSegment = true; },
        append(point) {
            const coordinate = normalizeCoordinate(point.coordinate);
            if (!coordinate) {
                track.diagnostics.skippedPoints++;
                newSegment = true;
                return null;
            }
            const index = track.coordinates.length;
            if (newSegment) track.segmentStarts.push(index);
            newSegment = false;
            track.coordinates.push(coordinate);
            track.elevations.push(numericValue(point.elevation));
            track.times.push(normalizeTime(point.time));
            return index;
        },
    };
}

/** Parse strings or UTF-8 bytes in chunks, retaining only track data and open tags. */
export function parseXmlTracks(source, format) {
    const parser = new SaxesParser({ xmlns: true });
    const frames = [];
    const tracks = [];
    const fallback = trackBuilder();
    let current = fallback;
    let point = null;
    let gx = null;
    let fallbackName = null;
    let pointCount = 0;
    let timeCount = 0;
    let trackCount = 0;
    let unsupportedGeometries = 0;
    let documentNamespace;

    const consumePoint = () => {
        if (++pointCount > MAX_TRACK_POINTS) throw new Error('File contains too many track points.');
    };
    const startTrack = () => {
        if (++trackCount > MAX_TRACKS) throw new Error('XML file contains too many tracks.');
        current = trackBuilder();
    };
    const isContainer = name => format === 'gpx' ? name === 'trk' || name === 'rte'
        : format === 'kml' ? name === 'Placemark' : name === 'Activity' || name === 'Course';

    parser.on('error', error => { throw new Error(`Invalid ${format.toUpperCase()} file: ${error.message}`); });
    parser.on('doctype', () => { throw new Error('XML document types and custom entities are not supported.'); });
    parser.on('opentag', tag => {
        if (frames.length >= 64) throw new Error('XML nesting is too deep.');
        const name = tag.local;
        const parentFrame = frames.at(-1);
        const parent = parentFrame?.name;
        if (!parentFrame) {
            if (name !== ROOT_NAMES[format]) throw new Error(`Invalid ${format.toUpperCase()} root element.`);
            documentNamespace = tag.uri;
        }
        const isGx = format === 'kml' && ['Track', 'MultiTrack', 'coord'].includes(name);
        const namespaceMatches = isGx ? tag.uri === GX_NAMESPACE : tag.uri === documentNamespace;
        const recognized = !parentFrame || Boolean(parentFrame.recognized && namespaceMatches && ELEMENT_PARENTS[format][name]?.includes(parent));
        const frame = { name, text: '', capture: false, recognized };
        frames.push(frame);
        if (!recognized) return;
        if (isContainer(name)) {
            if (current !== fallback) throw new Error(`Invalid ${format.toUpperCase()} file: nested tracks.`);
            startTrack();
            frame.container = true;
        }

        if (format === 'gpx') {
            if (name === 'trkseg' && parent === 'trk') current.startSegment();
            if (current !== fallback && ((name === 'trkpt' && parent === 'trkseg') || (name === 'rtept' && parent === 'rte'))) {
                consumePoint();
                point = { coordinate: [tag.attributes.lat?.value, tag.attributes.lon?.value] };
                frame.point = true;
            }
            if (point && ['ele', 'time'].includes(name) && ['trkpt', 'rtept'].includes(parent)) frame.capture = true;
            if (name === 'name' && ['trk', 'rte', 'metadata'].includes(parent)) frame.capture = true;
        } else if (format === 'tcx') {
            if (name === 'Track') current.startSegment();
            if (name === 'Trackpoint' && parent === 'Track') {
                consumePoint();
                point = { coordinate: [null, null] };
                frame.point = true;
            }
            if (point && ['LatitudeDegrees', 'LongitudeDegrees', 'AltitudeMeters', 'Time'].includes(name)) frame.capture = true;
            if (['Notes', 'Name', 'Id'].includes(name) && (isContainer(parent) || frames.length === 2)) frame.capture = true;
        } else {
            if (name === 'Point' || name === 'Polygon') unsupportedGeometries++;
            if (name === 'LineString') current.startSegment();
            if (name === 'Track') {
                current.startSegment();
                gx = { times: [], indices: [] };
            }
            if ((name === 'coordinates' && parent === 'LineString') ||
                (gx && ['coord', 'when'].includes(name)) || (name === 'name' && (parent === 'Placemark' || frames.length === 2))) frame.capture = true;
        }
    });

    const captureText = value => {
        const frame = frames.at(-1);
        if (!frame?.capture) return;
        frame.text += value;
        // Coordinate lists are scanned without splitting them into a second array.
        if (frame.name !== 'coordinates' && frame.text.length > MAX_FIELD_LENGTH) throw new Error('XML field is too long.');
    };
    parser.on('text', captureText);
    parser.on('cdata', captureText);
    parser.on('closetag', () => {
        const frame = frames.pop();
        const { name } = frame;
        if (!frame.recognized) return;
        const parent = frames.at(-1)?.name;
        const value = frame.text.trim();
        if (frame.capture) {
            if (format === 'gpx') {
                if (name === 'name') {
                    if (parent === 'metadata') fallbackName ||= value || null;
                    else current.track.name ||= value || null;
                } else if (name === 'ele') point.elevation = value;
                else if (name === 'time') point.time = value;
            } else if (format === 'tcx') {
                if (name === 'LatitudeDegrees') point.coordinate[0] = value;
                else if (name === 'LongitudeDegrees') point.coordinate[1] = value;
                else if (name === 'AltitudeMeters') point.elevation = value;
                else if (name === 'Time') point.time = value;
                else current.fields[name] ||= value;
            } else if (name === 'name') current.track.name ||= value || null;
            else if (name === 'coordinates') {
                for (const [tuple] of value.matchAll(/\S+/g)) {
                    consumePoint();
                    const [lng, lat, elevation] = tuple.split(',');
                    current.append({ coordinate: [lat, lng], elevation });
                }
            } else if (name === 'when') {
                if (++timeCount > MAX_TRACK_POINTS) throw new Error('File contains too many track times.');
                gx.times.push(normalizeTime(value));
            } else if (name === 'coord') {
                consumePoint();
                const [lng, lat, elevation] = value.split(/\s+/);
                gx.indices.push(current.append({ coordinate: [lat, lng], elevation }));
            }
        }
        if (frame.point) { current.append(point); point = null; }
        if (format === 'kml' && name === 'Track' && gx) {
            // gx:Track permits times before or after coordinates. Invalid points
            // still occupy an index in that pairing.
            gx.indices.forEach((index, rawIndex) => {
                if (index !== null) current.track.times[index] = gx.times[rawIndex] ?? null;
            });
            gx = null;
        }
        if (frame.container) {
            if (format === 'tcx') current.track.name = current.fields.Notes || current.fields.Name || current.fields.Id || null;
            tracks.push(current.track);
            current = fallback;
        }
    });

    if (typeof source === 'string') {
        for (let offset = 0; offset < source.length; offset += CHUNK_SIZE) parser.write(source.slice(offset, offset + CHUNK_SIZE));
    } else {
        const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
        const decoder = new TextDecoder();
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) parser.write(decoder.decode(bytes.subarray(offset, offset + CHUNK_SIZE), { stream: true }));
        parser.write(decoder.decode());
    }
    parser.close();
    if (!trackCount) {
        fallback.track.name ||= fallback.fields.Notes || fallback.fields.Name || fallback.fields.Id || null;
        tracks.push(fallback.track);
    }
    if (format === 'gpx') for (const track of tracks) track.name ||= fallbackName;
    const emptyMessage = {
        gpx: 'No valid track or route points found in GPX file',
        kml: 'No valid line tracks found in KML file (points and polygons are not route tracks)',
        tcx: 'No valid trackpoints found in TCX file',
    }[format];
    return summarizeTracks(tracks, emptyMessage, { unsupportedGeometries });
}
