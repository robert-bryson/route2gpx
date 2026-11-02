import { requestJson } from './network.js';
import { haversineDistance } from './track-data.js';

export function abortableDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled.', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, milliseconds);
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
    });
}

export function elevationSamples(coordinates, segmentStarts = [0], maxSamples = 1000) {
    if (coordinates.length <= maxSamples) return coordinates.map((_, index) => index);
    const starts = new Set(segmentStarts);
    const distances = new Float64Array(coordinates.length);
    const indices = new Set([0, coordinates.length - 1]);
    for (let i = 1; i < coordinates.length; i++) {
        distances[i] = distances[i - 1] + (starts.has(i) ? 0 : haversineDistance(coordinates[i - 1], coordinates[i]));
        if (starts.has(i)) { indices.add(i); indices.add(i - 1); }
    }
    if (indices.size > maxSamples) throw new Error('Too many separate segments for the elevation sampling budget.');
    const remaining = maxSamples - indices.size;
    const total = distances[coordinates.length - 1];
    let cursor = 0;
    for (let i = 1; i <= remaining; i++) {
        const target = total * i / (remaining + 1);
        while (cursor < distances.length - 1 && distances[cursor] < target) cursor++;
        indices.add(total ? cursor : Math.floor((coordinates.length - 1) * i / (remaining + 1)));
    }
    return [...indices].sort((a, b) => a - b);
}

// One client owns request spacing across all routes in this page.
export function createElevationClient({ request = requestJson, intervalMs = 1100, maxSamples = 1000 } = {}) {
    let queue = Promise.resolve(), lastStarted = -Infinity;
    const cache = new Map();
    const schedule = (operation, signal) => {
        const result = queue.then(async () => {
            if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
            const wait = Math.max(0, intervalMs - (Date.now() - lastStarted));
            if (wait) await abortableDelay(wait, signal);
            lastStarted = Date.now();
            return operation();
        });
        queue = result.catch(() => {});
        if (!signal) return result;
        // The queue must remain serial, but a cancelled caller need not wait
        // for another route's request to finish before it can save its progress.
        return new Promise((resolve, reject) => {
            const cancel = () => reject(new DOMException('Cancelled.', 'AbortError'));
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
            result.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
        });
    };
    return {
        async fetch(coordinates, { signal, segmentStarts = [0], existing = [], interpolateExisting = false, onProgress = () => {} } = {}) {
            const samples = elevationSamples(coordinates, segmentStarts, maxSamples);
            const elevations = coordinates.map((_, index) => Number.isFinite(existing[index]) ? existing[index] : null);
            const key = index => coordinates[index].map(value => value.toFixed(6)).join(',');
            let addedSamples = 0, cancelled = signal?.aborted === true;
            const missing = samples.filter(index => {
                if (elevations[index] !== null) return false;
                if (cache.has(key(index))) { elevations[index] = cache.get(key(index)); addedSamples++; return false; }
                return true;
            });
            const batches = Math.ceil(missing.length / 100);
            for (let offset = 0; offset < missing.length; offset += 100) {
                const batch = missing.slice(offset, offset + 100);
                try {
                    const data = await schedule(() => request(`/api/elevation/v1/srtm90m?locations=${encodeURIComponent(batch.map(key).join('|'))}`, { signal, timeoutMs: 20000 }), signal);
                    if (data.status === 'OK' && Array.isArray(data.results)) {
                        batch.forEach((index, i) => {
                            const value = data.results[i]?.elevation;
                            if (Number.isFinite(value)) { elevations[index] = value; cache.set(key(index), value); addedSamples++; }
                        });
                    }
                } catch (error) {
                    if (signal?.aborted || error.name === 'AbortError') { cancelled = true; break; }
                    // Keep missing batches unknown; a later retry can fill them.
                }
                onProgress({ completed: Math.min(batches, Math.floor(offset / 100) + 1), total: batches });
            }
            cancelled ||= signal?.aborted === true;
            const starts = new Set(segmentStarts);
            if (!cancelled && coordinates.length > samples.length && (addedSamples || interpolateExisting)) {
                for (let s = 1; s < samples.length; s++) {
                    const from = samples[s - 1], to = samples[s];
                    if (elevations[from] === null || elevations[to] === null) continue;
                    let distance = 0, crossesSegment = false;
                    const lengths = [0];
                    for (let i = from + 1; i <= to; i++) {
                        if (starts.has(i)) { crossesSegment = true; break; }
                        distance += haversineDistance(coordinates[i - 1], coordinates[i]); lengths.push(distance);
                    }
                    if (crossesSegment) continue;
                    for (let i = from + 1; i < to; i++) if (elevations[i] === null) elevations[i] = elevations[from] + (elevations[to] - elevations[from]) * (distance ? lengths[i - from] / distance : (i - from) / (to - from));
                }
            }
            const count = elevations.filter(value => value !== null).length;
            return { elevations, status: cancelled ? 'cancelled' : count === coordinates.length ? 'ready' : count ? 'partial' : 'unavailable', sampled: samples.length < coordinates.length, sampleCount: samples.length, addedSamples };
        }
    };
}
