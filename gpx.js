import { normalizeTrack, numericValue, haversineDistance } from './track-data.js';

export function escapeXml(text) {
    return String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

export function sanitizeFilename(value) {
    return String(value ?? '').replace(/[^a-zA-Z0-9_\-\s]/g, '_').substring(0, 50);
}

export function uniqueGpxFilenames(routes) {
    const used = new Set();
    return routes.map(route => {
        const base = `${sanitizeFilename(route.travelMode?.toLowerCase())}_${sanitizeFilename(route.name)}`;
        let filename = `${base}.gpx`, suffix = 2;
        while (used.has(filename.toLowerCase())) filename = `${base}_${suffix++}.gpx`;
        used.add(filename.toLowerCase());
        return filename;
    });
}

export function generateGPX(route, { timePolicy = 'preserve', startTime = new Date() } = {}) {
    const track = normalizeTrack(route);
    const coords = track.coordinates;
    if (coords.length < 2) throw new Error('A track needs at least two valid points.');
    const starts = new Set(track.segmentStarts);
    const stops = (Array.isArray(route.stops) ? route.stops : []).filter(stop => typeof stop === 'string' && stop.trim());
    const now = new Date(startTime);
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid export start time.');
    let minlat = Infinity, maxlat = -Infinity, minlon = Infinity, maxlon = -Infinity;
    for (let i = 0; i < coords.length; i++) {
        minlat = Math.min(minlat, coords[i][0]); maxlat = Math.max(maxlat, coords[i][0]);
        minlon = Math.min(minlon, coords[i][1]); maxlon = Math.max(maxlon, coords[i][1]);
    }
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="route2gpx-web" xmlns="http://www.topografix.com/GPX/1/1">', '  <metadata>',
        `    <name>${escapeXml(route.name)}</name>`,
        `    <desc>Route from ${escapeXml(route.origin)} to ${escapeXml(route.destination)} via ${escapeXml((route.travelMode || 'IMPORTED').toLowerCase())}${stops.length ? `. Stops: ${stops.map(escapeXml).join(', ')}` : ''}${timePolicy === 'synthesize' ? '. Point times are synthesized.' : ''}</desc>`,
        `    <time>${now.toISOString()}</time>`,
        `    <bounds minlat="${minlat.toFixed(6)}" minlon="${minlon.toFixed(6)}" maxlat="${maxlat.toFixed(6)}" maxlon="${maxlon.toFixed(6)}"/>`, '  </metadata>'];
    const waypoint = (coordinate, name) => lines.push(`  <wpt lat="${coordinate[0].toFixed(6)}" lon="${coordinate[1].toFixed(6)}"><name>${escapeXml(name)}</name></wpt>`);
    waypoint(coords[0], `Start: ${route.origin}`);
    stops.forEach((stop, index) => {
        const match = stop.trim().match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
        if (match && Math.abs(Number(match[1])) <= 90 && Math.abs(Number(match[2])) <= 180) waypoint([Number(match[1]), Number(match[2])], `Stop ${index + 1}: ${stop}`);
    });
    waypoint(coords[coords.length - 1], `End: ${route.destination}`);
    lines.push('  <trk>', `    <name>${escapeXml(route.name)}</name>`, `    <type>${escapeXml(route.travelMode)}</type>`);
    const distances = new Float64Array(coords.length);
    if (timePolicy === 'synthesize') {
        for (let i = 1; i < coords.length; i++) distances[i] = distances[i - 1] + (starts.has(i) ? 0 : haversineDistance(coords[i - 1], coords[i]));
    }
    const totalDistance = distances[coords.length - 1];
    const seconds = Math.max(0, numericValue(String(route.duration || '').replace(/s$/, '')) ?? (coords.length - 1) * 60);
    coords.forEach(([lat, lng], index) => {
        if (starts.has(index)) {
            if (index) lines.push('    </trkseg>');
            lines.push('    <trkseg>');
        }
        lines.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`);
        if (track.elevations[index] !== null) lines.push(`        <ele>${track.elevations[index]}</ele>`);
        let time = timePolicy === 'preserve' ? track.times[index] : null;
        if (timePolicy === 'synthesize') time = new Date(now.getTime() + seconds * 1000 * (totalDistance ? distances[index] / totalDistance : index / (coords.length - 1))).toISOString();
        if (time) lines.push(`        <time>${time}</time>`);
        lines.push('      </trkpt>');
    });
    lines.push('    </trkseg>', '  </trk>', '</gpx>');
    return lines.join('\n');
}
