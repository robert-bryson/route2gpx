import { test, expect, vi } from 'vitest';
import { createRouteStorage, ROUTES_STORAGE_KEY } from '../route-storage.js';

function memoryStorage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: vi.fn((key, value) => values.set(key, value)), removeItem: key => values.delete(key) };
}

test('migrates legacy tracks and saves metadata without serializing unchanged geometry', () => {
    const storage = memoryStorage();
    const route = { id: 123, name: 'Old', coordinates: [[1, 1], [2, 2]], elevations: [0, null], times: null, segmentStarts: [0] };
    storage.setItem(ROUTES_STORAGE_KEY, JSON.stringify([route]));
    const store = createRouteStorage();
    expect(store.load(storage)).toEqual([route]);
    store.save(storage, [route]);
    storage.setItem.mockClear();
    store.save(storage, [{ ...route, name: 'New', visible: false }]);
    expect(storage.setItem.mock.calls.map(call => call[0])).toEqual([ROUTES_STORAGE_KEY]);
    expect(createRouteStorage().load(storage)[0]).toMatchObject({ name: 'New', elevations: [0, null], visible: false });
});

test('a failed index commit leaves the previous saved route readable', () => {
    const storage = memoryStorage(), store = createRouteStorage();
    const route = { id: 123, coordinates: [[1, 1], [2, 2]] };
    store.save(storage, [route]);
    const write = storage.setItem.getMockImplementation();
    storage.setItem.mockImplementation((key, value) => { if (key === ROUTES_STORAGE_KEY) throw new DOMException('full', 'QuotaExceededError'); return write(key, value); });
    expect(() => store.save(storage, [route, { ...route, id: 124 }])).toThrow('full');
    expect(createRouteStorage().load(storage).map(item => item.id)).toEqual([123]);
});

test('skips an individually corrupt geometry without blocking other records', () => {
    const storage = memoryStorage(), store = createRouteStorage();
    store.save(storage, [{ id: 1, coordinates: [[1, 1], [2, 2]] }, { id: 2, coordinates: [[3, 3], [4, 4]] }]);
    storage.setItem('route2gpx_geometry_1', '{broken');
    const invalid = vi.fn();
    expect(createRouteStorage().load(storage, invalid).map(route => route.id)).toEqual([2]);
    expect(invalid).toHaveBeenCalledTimes(1);
});

test('keeps legacy storage usable when migration has no room for a second geometry copy', () => {
    const storage = memoryStorage(), store = createRouteStorage();
    const route = { id: 123, name: 'Old', coordinates: [[1, 1], [2, 2]] };
    storage.setItem(ROUTES_STORAGE_KEY, JSON.stringify([route]));
    store.load(storage);
    const write = storage.setItem.getMockImplementation();
    storage.setItem.mockImplementation((key, value) => { if (key.startsWith('route2gpx_geometry_')) throw new DOMException('full', 'QuotaExceededError'); return write(key, value); });
    store.save(storage, [{ ...route, name: 'New' }]);
    expect(createRouteStorage().load(storage)[0].name).toBe('New');
});

test('a failed metadata commit preserves previous geometry and provenance together', () => {
    const storage = memoryStorage(), store = createRouteStorage();
    const route = { id: 123, coordinates: [[1, 1], [2, 2]], elevations: [null, null], elevationSource: null };
    store.save(storage, [route]);
    const originalKeys = JSON.parse(storage.getItem(ROUTES_STORAGE_KEY)).routes.map(item => item.geometryKey);
    const write = storage.setItem.getMockImplementation();
    storage.setItem.mockImplementation((key, value) => {
        if (key === ROUTES_STORAGE_KEY) throw new DOMException('full', 'QuotaExceededError');
        return write(key, value);
    });
    expect(() => store.save(storage, [{ ...route, elevations: [10, 20], elevationSource: { dataset: 'srtm90m' } }])).toThrow('full');
    expect(createRouteStorage().load(storage)[0]).toMatchObject({ elevations: [null, null], elevationSource: null });
    expect(JSON.parse(storage.getItem(ROUTES_STORAGE_KEY)).routes.map(item => item.geometryKey)).toEqual(originalKeys);
    storage.setItem.mockImplementation(write);
    store.save(storage, [{ ...route, elevations: [10, 20] }]);
    expect(createRouteStorage().load(storage)[0].elevations).toEqual([10, 20]);
    expect(storage.getItem(originalKeys[0])).toBeNull();
});

test('reuses geometry after reload even when validation copies the arrays', () => {
    const storage = memoryStorage();
    createRouteStorage().save(storage, [{ id: 1, coordinates: [[1, 1], [2, 2]], elevations: [0, null] }]);
    const store = createRouteStorage();
    const routes = JSON.parse(JSON.stringify(store.load(storage)));
    storage.setItem.mockClear();
    store.save(storage, routes.map(route => ({ ...route, name: 'Renamed' })));
    expect(storage.setItem.mock.calls.map(call => call[0])).toEqual([ROUTES_STORAGE_KEY]);
});
