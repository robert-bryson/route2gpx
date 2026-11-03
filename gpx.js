import { prepareExportTrack } from './export-data.js';

export function escapeXml(text) {
    return String(text ?? '')
        // eslint-disable-next-line no-control-regex -- Replace code points forbidden by XML 1.0.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, '\uFFFD')
        .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
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
    const track = prepareExportTrack(route, { timePolicy, startTime });
    const coords = track.coordinates;
    const starts = new Set(track.segmentStarts);
    const stops = (Array.isArray(route.stops) ? route.stops : []).filter(stop => typeof stop === 'string' && stop.trim());
    const now = track.exportTime;
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
    coords.forEach(([lat, lng], index) => {
        if (starts.has(index)) {
            if (index) lines.push('    </trkseg>');
            lines.push('    <trkseg>');
        }
        lines.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`);
        if (track.elevations[index] !== null) lines.push(`        <ele>${track.elevations[index]}</ele>`);
        const time = track.times[index];
        if (time) lines.push(`        <time>${time}</time>`);
        lines.push('      </trkpt>');
    });
    lines.push('    </trkseg>', '  </trk>', '</gpx>');
    return lines.join('\n');
}
