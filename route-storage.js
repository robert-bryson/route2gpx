export const ROUTES_STORAGE_KEY = 'route2gpx_routes';
const GEOMETRY_PREFIX = 'route2gpx_geometry_';

const GEOMETRY_KEY = /^route2gpx_geometry_\d+(?:_\d+)?$/;
const geometryRefs = ({ coordinates, elevations, times, segmentStarts }) => [coordinates, elevations, times, segmentStarts];

function sameValues(first, second) {
    if (first === second) return true;
    return Array.isArray(first) && Array.isArray(second) && first.length === second.length &&
        first.every((value, index) => Array.isArray(value) ? sameValues(value, second[index]) : value === second[index]);
}

// Write changed geometry under a new key before committing the index. Failed
// commits leave the previous geometry and its metadata intact.
// Legacy arrays remain readable and migrate only after the new index commits.
export function createRouteStorage() {
    const cache = new Map();
    let committedKeys = new Set();
    let revision = 0;
    return {
        load(storage, onInvalid = () => {}) {
            cache.clear();
            committedKeys = new Set();
            const value = JSON.parse(storage.getItem(ROUTES_STORAGE_KEY) || '[]');
            if (Array.isArray(value)) return value;
            if (value?.version !== 2 || !Array.isArray(value.routes)) throw new Error('Unsupported saved route format.');
            const result = [];
            for (const entry of value.routes) {
                try {
                    if (!entry || !GEOMETRY_KEY.test(entry.geometryKey)) throw new Error('Invalid geometry reference.');
                    committedKeys.add(entry.geometryKey);
                    const geometry = JSON.parse(storage.getItem(entry.geometryKey));
                    if (!geometry || !Array.isArray(geometry.coordinates)) throw new Error('Missing geometry.');
                    cache.set(entry.id, { key: entry.geometryKey, refs: geometryRefs(geometry) });
                    result.push({ ...entry, ...geometry });
                } catch { onInvalid(); }
            }
            return result;
        },
        save(storage, routes) {
            const previous = storage.getItem(ROUTES_STORAGE_KEY);
            const legacy = !previous || previous.trimStart().startsWith('[');
            const entries = [], nextKeys = new Set(), written = [], nextCache = new Map();
            try {
                for (const route of routes) {
                    const { coordinates, elevations, times, segmentStarts, ...metadata } = route;
                    let key = `${GEOMETRY_PREFIX}${route.id}`;
                    const refs = [coordinates, elevations, times, segmentStarts];
                    const existing = cache.get(route.id);
                    const unchanged = existing && refs.every((value, i) => sameValues(value, existing.refs[i]));
                    if (unchanged && storage.getItem(existing.key) !== null) {
                        key = existing.key;
                    } else {
                        const base = key;
                        while (storage.getItem(key) !== null) key = `${base}_${++revision}`;
                        storage.setItem(key, JSON.stringify({ coordinates, elevations, times, segmentStarts }));
                        written.push(key);
                    }
                    nextCache.set(route.id, { key, refs });
                    nextKeys.add(key);
                    entries.push({ ...metadata, geometryKey: key });
                }
                storage.setItem(ROUTES_STORAGE_KEY, JSON.stringify({ version: 2, routes: entries }));
            } catch (error) {
                for (const key of written) { try { storage.removeItem(key); } catch { /* best effort */ } }
                // A full legacy store may have no room for a temporary second copy.
                if (legacy) { storage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(routes)); return; }
                throw error;
            }
            for (const key of committedKeys) if (!nextKeys.has(key)) {
                try { storage.removeItem(key); } catch { /* A stale geometry record cannot invalidate the committed index. */ }
            }
            cache.clear();
            for (const [id, value] of nextCache) cache.set(id, value);
            committedKeys = nextKeys;
        },
    };
}
