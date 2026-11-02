import { trackFromSegments, summarizeTracks } from './track-data.js';
import { parseFIT } from './parsers.js';
import { parseXmlTracks } from './xml-import.js';

// GeoJSON coordinates are already materialized by JSON.parse.
function* mapPoints(values, parsePoint) {
    for (const value of values) yield parsePoint(value);
}

export const parseGPX = source => parseXmlTracks(source, 'gpx');
export const parseKML = source => parseXmlTracks(source, 'kml');
export const parseTCX = source => parseXmlTracks(source, 'tcx');
const IMPORT_PARSERS = new Map([
    ['fit', parseFIT], ['geojson', parseGeoJSON], ['gpx', parseGPX], ['kml', parseKML], ['tcx', parseTCX],
]);

/** Use the same byte decoding and parser selection in workers and the fallback. */
export function parseImportBuffer(buffer, format) {
    const parser = IMPORT_PARSERS.get(format);
    if (!parser) throw new Error('Unsupported file type');
    return parser(format === 'geojson' ? new TextDecoder().decode(buffer) : buffer);
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

export function detectImportFormat(filename) {
    const name = filename.toLowerCase();
    if (/\.(geojson|json)\.gz$/.test(name)) return { format: 'geojson', gzipped: true };
    if (name.endsWith('.fit.gz')) return { format: 'fit', gzipped: true };
    if (name.endsWith('.tcx.gz')) return { format: 'tcx', gzipped: true };
    if (name.endsWith('.gpx.gz')) return { format: 'gpx', gzipped: true };
    if (name.endsWith('.kml.gz')) return { format: 'kml', gzipped: true };
    if (name.endsWith('.fit')) return { format: 'fit', gzipped: false };
    if (name.endsWith('.tcx')) return { format: 'tcx', gzipped: false };
    if (name.endsWith('.gpx')) return { format: 'gpx', gzipped: false };
    if (name.endsWith('.kml')) return { format: 'kml', gzipped: false };
    if (name.endsWith('.geojson') || name.endsWith('.json')) return { format: 'geojson', gzipped: false };
    return null;
}
