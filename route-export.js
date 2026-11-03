import { escapeXml, generateGPX, sanitizeFilename } from './gpx.js';
import { exportDistances, normalizeExportTrack, prepareExportTrack } from './export-data.js';

export const EXPORT_FORMATS = Object.freeze({
    gpx: { label: 'GPX', description: 'GPS devices & outdoor apps', mimeType: 'application/gpx+xml', serialize: generateGPX, supportsGeneratedTimes: true,
        hint: 'Best for GPS devices and outdoor apps. Keeps recorded times and known elevations.' },
    kml: { label: 'KML', description: 'Google Earth & map sharing', mimeType: 'application/vnd.google-earth.kml+xml', serialize: generateKML,
        hint: 'For Google Earth and map sharing. Keeps known elevations; point timestamps are not included.' },
    geojson: { label: 'GeoJSON', description: 'GIS & web maps', mimeType: 'application/geo+json', serialize: generateGeoJSON,
        hint: 'For GIS and web maps. Recorded times use coordTimes properties; support varies by app.' },
    tcx: { label: 'TCX', description: 'Garmin & fitness courses', mimeType: 'application/vnd.garmin.tcx+xml', serialize: generateTCX, supportsGeneratedTimes: true, requiresCompleteTimes: true,
        hint: 'For fitness courses. Every point needs a time. Course names use 15 characters; the full name stays in Notes.' },
    csv: { label: 'CSV', description: 'Spreadsheets & data analysis', mimeType: 'text/csv;charset=utf-8', serialize: generateCSV,
        hint: 'One row per point: segment, point number, latitude, longitude, elevation in meters, and time. Missing values stay empty.' },
});

export function exportFilename(value, format = 'gpx') {
    if (!Object.hasOwn(EXPORT_FORMATS, format)) throw new Error('Unsupported export format.');
    let base = String(value ?? '').trim();
    const dot = base.lastIndexOf('.');
    if (dot !== -1 && Object.hasOwn(EXPORT_FORMATS, base.slice(dot + 1).toLowerCase())) base = base.slice(0, dot);
    return `${sanitizeFilename(base) || 'route'}.${format}`;
}

export function generateRouteExport(route, format = 'gpx', options) {
    if (!Object.hasOwn(EXPORT_FORMATS, format)) throw new Error('Unsupported export format.');
    return EXPORT_FORMATS[format].serialize(route, options);
}

function lineSegments(track) {
    return track.segmentStarts.map((start, index) => {
        const end = track.segmentStarts[index + 1] ?? track.coordinates.length;
        return {
            coordinates: track.coordinates.slice(start, end).map(([lat, lng], offset) => {
                const elevation = track.elevations[start + offset];
                return elevation === null ? [lng, lat] : [lng, lat, elevation];
            }),
            times: track.times.slice(start, end),
        };
    });
}

function generateKML(route) {
    const geometries = lineSegments(normalizeExportTrack(route)).map(segment => {
        const tag = segment.coordinates.length === 1 ? 'Point' : 'LineString';
        // Ground partial-height paths instead of letting a viewer invent zero-height vertices.
        const altitudeMode = segment.coordinates.every(point => point.length === 3) ? 'absolute' : 'clampToGround';
        return `<${tag}><altitudeMode>${altitudeMode}</altitudeMode><coordinates>${segment.coordinates.map(point => point.join(',')).join(' ')}</coordinates></${tag}>`;
    });
    return ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>',
        `<name>${escapeXml(route.name)}</name>`,
        geometries.length === 1 ? geometries[0] : `<MultiGeometry>${geometries.join('')}</MultiGeometry>`,
        '</Placemark></Document></kml>'].join('\n');
}

function generateGeoJSON(route) {
    const track = normalizeExportTrack(route);
    const segments = lineSegments(track);
    const hasTimes = track.times.some(Boolean);
    const feature = (geometry, times) => ({
        type: 'Feature',
        properties: { name: route.name ?? '', ...(hasTimes ? { coordTimes: times } : {}) },
        geometry,
    });
    // Isolated points cannot form a valid GeoJSON LineString. Retain them as Points.
    if (segments.some(segment => segment.coordinates.length === 1)) {
        return JSON.stringify({ type: 'FeatureCollection', features: segments.map(segment => feature(
            { type: segment.coordinates.length === 1 ? 'Point' : 'LineString', coordinates: segment.coordinates.length === 1 ? segment.coordinates[0] : segment.coordinates },
            segment.times,
        )) });
    }
    return JSON.stringify(feature({
        type: segments.length === 1 ? 'LineString' : 'MultiLineString',
        coordinates: segments.length === 1 ? segments[0].coordinates : segments.map(segment => segment.coordinates),
    }, segments.length === 1 ? segments[0].times : segments.map(segment => segment.times)));
}

function generateCSV(route) {
    const track = normalizeExportTrack(route);
    const rows = ['segment,point,latitude,longitude,elevation_m,time'];
    let segment = 0;
    track.coordinates.forEach(([latitude, longitude], index) => {
        if (track.segmentStarts[segment + 1] === index) segment++;
        // Only finite numbers and validated times enter cells. Free-text route names cannot inject formulas.
        rows.push([segment + 1, index + 1, latitude, longitude, track.elevations[index], track.times[index]].join(','));
    });
    return rows.join('\r\n') + '\r\n';
}

function generateTCX(route, options) {
    const track = prepareExportTrack(route, options);
    if (track.times.some(time => time === null)) throw new Error('TCX needs a timestamp for every point. Select Generate new timestamps, or use GPX.');
    const distances = track.distances || exportDistances(track);
    const fullName = String(route.name ?? '').trim() || 'Route';
    const shortName = Array.from(fullName.replace(/\s+/g, ' ')).slice(0, 15).join('');
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
        '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">',
        '<Courses><Course>', `<Name>${escapeXml(shortName)}</Name>`];
    let segment = 0;
    track.coordinates.forEach(([latitude, longitude], index) => {
        if (track.segmentStarts[segment] === index) {
            if (index) lines.push('</Track>');
            lines.push('<Track>'); segment++;
        }
        // TCX excludes +180. The equivalent -180 longitude preserves the meridian.
        lines.push('<Trackpoint>', `<Time>${track.times[index]}</Time>`,
            `<Position><LatitudeDegrees>${latitude}</LatitudeDegrees><LongitudeDegrees>${longitude === 180 ? -180 : longitude}</LongitudeDegrees></Position>`);
        if (track.elevations[index] !== null) lines.push(`<AltitudeMeters>${track.elevations[index]}</AltitudeMeters>`);
        lines.push(`<DistanceMeters>${distances[index]}</DistanceMeters>`, '</Trackpoint>');
    });
    lines.push('</Track>', `<Notes>${escapeXml(fullName)}${options?.timePolicy === 'synthesize' ? '\nPoint times are generated estimates.' : ''}</Notes>`,
        '</Course></Courses></TrainingCenterDatabase>');
    return lines.join('\n');
}
