// Track data stays independent of map layers and browser storage.
export const MAX_TRACK_POINTS = 1_000_000;

export function numericValue(value) {
    if (typeof value === 'string') {
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
        value = Number(value);
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeCoordinate(value) {
    if (!Array.isArray(value) || value.length < 2) return null;
    const lat = numericValue(value[0]);
    const lng = numericValue(value[1]);
    return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
}

export function normalizeTime(value) {
    if (typeof value !== 'string') return null;
    value = value.trim();
    const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))?$/.exec(value);
    if (!fields) return null;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone, , offsetHourText, offsetMinuteText] = fields;
    const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
        hour > 24 || minute > 59 || second > 59 || (hour === 24 && (minute || second || Number(fraction)))) return null;
    if (offsetHourText && (Number(offsetHourText) > 14 || Number(offsetMinuteText) > 59 ||
        (Number(offsetHourText) === 14 && Number(offsetMinuteText) !== 0))) return null;
    // An absent zone is a wall time. Never assign the importing device's zone.
    if (!zone) return value;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return null;
    const normalized = new Date(milliseconds).toISOString();
    return fraction?.length > 4 ? normalized.replace(/\.\d{3}Z$/, `${fraction}Z`) : normalized;
}

export function normalizeTrack(data) {
    const input = Array.isArray(data?.coordinates) ? data.coordinates : [];
    if (input.length > MAX_TRACK_POINTS) throw new Error(`Track exceeds the ${MAX_TRACK_POINTS.toLocaleString()} point limit.`);
    const starts = new Set([0, ...(Array.isArray(data?.segmentStarts) ? data.segmentStarts : [])]);
    const coordinates = [], elevations = [], times = [], segmentStarts = [];
    let newSegment = true;
    input.forEach((value, index) => {
        if (starts.has(index)) newSegment = true;
        const coordinate = normalizeCoordinate(value);
        if (!coordinate) {
            newSegment = true;
            return;
        }
        if (newSegment) segmentStarts.push(coordinates.length);
        newSegment = false;
        coordinates.push(coordinate);
        elevations.push(numericValue(data.elevations?.[index]));
        times.push(normalizeTime(data.times?.[index]));
    });
    return { coordinates, elevations, times, segmentStarts, diagnostics: { skippedPoints: input.length - coordinates.length } };
}

export function trackSegments(track) {
    const starts = Array.isArray(track.segmentStarts) && track.segmentStarts.length ? track.segmentStarts : [0];
    return starts.map((start, index) => track.coordinates.slice(start, starts[index + 1] ?? track.coordinates.length));
}

export function mapGeometry(track) {
    return track.segmentStarts?.length > 1 ? trackSegments(track) : track.coordinates;
}

export function trackFromSegments(segments, name = null, budget = { points: 0 }) {
    const coordinates = [], elevations = [], times = [], segmentStarts = [];
    for (const points of segments) {
        segmentStarts.push(coordinates.length);
        for (const point of points) {
            if (++budget.points > MAX_TRACK_POINTS) throw new Error('File contains too many track points.');
            coordinates.push(point.coordinate);
            elevations.push(point.elevation ?? null);
            times.push(point.time ?? null);
        }
    }
    return { ...normalizeTrack({ coordinates, elevations, times, segmentStarts }), name };
}

export function summarizeTracks(tracks, emptyMessage, { unsupportedGeometries = 0 } = {}) {
    const diagnostics = {
        skippedPoints: tracks.reduce((count, track) => count + (track.diagnostics?.skippedPoints || 0), 0),
        skippedTracks: tracks.filter(track => track.coordinates.length < 2).length,
        unsupportedGeometries,
    };
    tracks = tracks.filter(track => track.coordinates.length > 0);
    if (!tracks.length) throw new Error(emptyMessage);
    const coordinates = [], elevations = [], times = [], segmentStarts = [];
    for (const track of tracks) {
        if (coordinates.length + track.coordinates.length > MAX_TRACK_POINTS) throw new Error('File contains too many track points.');
        for (const start of track.segmentStarts) segmentStarts.push(start + coordinates.length);
        for (let i = 0; i < track.coordinates.length; i++) {
            coordinates.push(track.coordinates[i]);
            elevations.push(track.elevations[i]);
            times.push(track.times[i]);
        }
    }
    if (coordinates.length > MAX_TRACK_POINTS) throw new Error('File contains too many track points.');
    return { coordinates, elevations, times, segmentStarts, name: tracks[0].name, tracks, diagnostics };
}

export function haversineDistance([lat1, lon1], [lat2, lon2]) {
    const rad = value => value * Math.PI / 180;
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function trackDistance(track) {
    const starts = new Set(track.segmentStarts || [0]);
    let distance = 0;
    for (let i = 1; i < track.coordinates.length; i++) {
        if (!starts.has(i)) distance += haversineDistance(track.coordinates[i - 1], track.coordinates[i]);
    }
    return distance;
}
