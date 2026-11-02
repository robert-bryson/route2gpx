import { numericValue, trackFromSegments, summarizeTracks } from './track-data.js';

const elements = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const childText = (node, name) => Array.from(node.children).find(child => child.localName === name)?.textContent?.trim() || null;
const text = (node, name) => elements(node, name)[0]?.textContent ?? null;

// Parse one point at a time so the shared file budget stops extraction early.
function* mapPoints(values, parsePoint) {
    for (const value of values) yield parsePoint(value);
}

function xmlDocument(source, format) {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (elements(doc, 'parsererror').length) throw new Error(`Invalid ${format} file`);
    return doc;
}

function gpxPoint(point) {
    return { coordinate: [numericValue(point.getAttribute('lat')), numericValue(point.getAttribute('lon'))], elevation: numericValue(text(point, 'ele')), time: text(point, 'time') };
}

export function parseGPX(source) {
    const doc = xmlDocument(source, 'GPX');
    const budget = { points: 0 };
    const fallbackName = elements(doc, 'metadata').map(node => childText(node, 'name')).find(Boolean) || null;
    const tracks = elements(doc, 'trk').map(track => trackFromSegments(
        elements(track, 'trkseg').map(segment => mapPoints(elements(segment, 'trkpt'), gpxPoint)), childText(track, 'name') || fallbackName, budget
    ));
    for (const route of elements(doc, 'rte')) tracks.push(trackFromSegments([mapPoints(elements(route, 'rtept'), gpxPoint)], childText(route, 'name') || fallbackName, budget));
    return summarizeTracks(tracks, 'No valid track or route points found in GPX file');
}

export function parseKML(source) {
    const doc = xmlDocument(source, 'KML');
    const budget = { points: 0 };
    const placemarks = elements(doc, 'Placemark');
    const containers = placemarks.length ? placemarks : [doc.documentElement];
    const tracks = containers.map(container => {
        const segments = elements(container, 'LineString').map(line => mapPoints((text(line, 'coordinates') || '').trim().split(/\s+/), value => {
            const [lng, lat, elevation] = value.split(',');
            return { coordinate: [numericValue(lat), numericValue(lng)], elevation: numericValue(elevation) };
        }));
        // Google Earth extensions use space-delimited lon/lat/alt coordinates.
        for (const track of elements(container, 'Track')) {
            const times = elements(track, 'when');
            let index = 0;
            segments.push(mapPoints(elements(track, 'coord'), point => {
                const [lng, lat, elevation] = point.textContent.trim().split(/\s+/);
                return { coordinate: [numericValue(lat), numericValue(lng)], elevation: numericValue(elevation), time: times[index++]?.textContent };
            }));
        }
        return trackFromSegments(segments, childText(container, 'name'), budget);
    });
    return summarizeTracks(tracks, 'No valid line tracks found in KML file (points and polygons are not route tracks)', {
        unsupportedGeometries: elements(doc, 'Point').length + elements(doc, 'Polygon').length,
    });
}

export function parseTCX(source) {
    const doc = xmlDocument(source, 'TCX');
    const budget = { points: 0 };
    const activities = [...elements(doc, 'Activity'), ...elements(doc, 'Course')];
    const tracks = (activities.length ? activities : [doc.documentElement]).map(activity => {
        const segments = elements(activity, 'Track').map(segment => mapPoints(elements(segment, 'Trackpoint'), point => ({
            coordinate: [numericValue(text(point, 'LatitudeDegrees')), numericValue(text(point, 'LongitudeDegrees'))],
            elevation: numericValue(text(point, 'AltitudeMeters')), time: text(point, 'Time')
        })));
        return trackFromSegments(segments, childText(activity, 'Notes') || childText(activity, 'Name') || childText(activity, 'Id'), budget);
    });
    return summarizeTracks(tracks, 'No valid trackpoints found in TCX file');
}

export function parseGeoJSON(source) {
    const input = JSON.parse(source);
    const budget = { points: 0 };
    const tracks = [];
    let unsupportedGeometries = 0;
    function geometry(value, name, depth = 0) {
        if (depth > 64) throw new Error('GeoJSON nesting is too deep.');
        if (!value || typeof value !== 'object') return;
        if (value.type === 'FeatureCollection') {
            if (!Array.isArray(value.features)) throw new Error('Invalid GeoJSON features.');
            value.features.forEach(feature => geometry(feature, name, depth + 1));
        } else if (value.type === 'Feature') {
            geometry(value.geometry, typeof value.properties?.name === 'string' ? value.properties.name : name, depth + 1);
        } else if (value.type === 'GeometryCollection') {
            if (!Array.isArray(value.geometries)) throw new Error('Invalid GeoJSON geometries.');
            value.geometries.forEach(item => geometry(item, name, depth + 1));
        } else if (value.type === 'LineString' || value.type === 'MultiLineString') {
            const lines = value.type === 'LineString' ? [value.coordinates] : value.coordinates;
            if (!Array.isArray(lines)) throw new Error('Invalid GeoJSON line coordinates.');
            tracks.push(trackFromSegments(lines.filter(Array.isArray).map(line => mapPoints(line, point => ({
                coordinate: Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number' ? [point[1], point[0]] : null,
                elevation: typeof point?.[2] === 'number' ? point[2] : null
            }))), name, budget));
        } else unsupportedGeometries++;
    }
    geometry(input, typeof input?.name === 'string' ? input.name : null);
    return summarizeTracks(tracks, 'No valid coordinates in GeoJSON line tracks (points and polygons are not route tracks)', { unsupportedGeometries });
}
