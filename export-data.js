import { haversineDistance, normalizeTrack, numericValue } from './track-data.js';

function validExportDate(date) {
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;
}

export function exportDistances(track) {
    const distances = new Float64Array(track.coordinates.length);
    let segment = 1;
    for (let index = 1; index < distances.length; index++) {
        const isBreak = track.segmentStarts[segment] === index;
        if (isBreak) segment++;
        distances[index] = distances[index - 1] + (isBreak ? 0 : haversineDistance(track.coordinates[index - 1], track.coordinates[index]));
    }
    return distances;
}

export function normalizeExportTrack(route) {
    const track = normalizeTrack(route);
    if (track.coordinates.length < 2) throw new Error('A track needs at least two valid points.');
    return track;
}

/** Prepare point data once. Time generation always replaces the complete time array. */
export function prepareExportTrack(route, { timePolicy = 'preserve', startTime = new Date() } = {}) {
    if (!['preserve', 'synthesize'].includes(timePolicy)) throw new Error('Unsupported export time policy.');
    const track = normalizeExportTrack(route);
    const exportTime = new Date(startTime);
    if (!validExportDate(exportTime)) throw new Error('Invalid export start time.');
    if (timePolicy === 'preserve') return { ...track, exportTime, distances: null };

    const distances = exportDistances(track);
    const totalDistance = distances.at(-1);
    const seconds = Math.max(0, numericValue(String(route.duration ?? '').replace(/s$/, '')) ?? (track.coordinates.length - 1) * 60);
    if (!validExportDate(new Date(exportTime.getTime() + seconds * 1000))) {
        throw new Error('Route duration is too large to generate timestamps.');
    }
    track.coordinates.forEach((_, index) => {
        track.times[index] = new Date(exportTime.getTime() + seconds * 1000 *
            (totalDistance ? distances[index] / totalDistance : index / (track.coordinates.length - 1))).toISOString();
    });
    return { ...track, exportTime, distances };
}
