import { test, expect, vi } from 'vitest';
import { createElevationClient, elevationSamples } from '../elevation.js';

test('shares request spacing across concurrent routes', async () => {
    vi.useFakeTimers();
    try {
        const starts = [];
        const client = createElevationClient({ intervalMs: 1100, request: async () => { starts.push(Date.now()); return { status: 'OK', results: [{ elevation: 10 }] }; } });
        const first = client.fetch([[1, 1]]), second = client.fetch([[2, 2]]);
        await vi.runAllTimersAsync();
        await Promise.all([first, second]);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1100);
    } finally { vi.useRealTimers(); }
});

test('bounds sampling and interpolates without changing route geometry', async () => {
    const coordinates = Array.from({ length: 10001 }, (_, index) => [0, index / 10000]);
    expect(elevationSamples(coordinates, [0], 100)).toHaveLength(100);
    const client = createElevationClient({ intervalMs: 0, maxSamples: 100, request: async url => ({ status: 'OK', results: decodeURIComponent(url).split('locations=')[1].split('|').map(() => ({ elevation: 25 })) }) });
    const result = await client.fetch(coordinates);
    expect(result.elevations).toHaveLength(coordinates.length);
    expect(result.elevations.every(value => value === 25)).toBe(true);
    expect(result.sampled).toBe(true);
    expect(result.status).toBe('ready');
    expect(coordinates).toHaveLength(10001);
});

test('retains partial results and retries missing samples', async () => {
    let attempt = 0;
    const request = vi.fn(async () => ({ status: 'OK', results: ++attempt === 1 ? [{ elevation: 10 }, { elevation: null }] : [{ elevation: 20 }] }));
    const client = createElevationClient({ intervalMs: 0, request });
    const coordinates = [[1, 1], [2, 2]];
    const partial = await client.fetch(coordinates);
    expect(partial.status).toBe('partial');
    const retry = await client.fetch(coordinates, { existing: partial.elevations });
    expect(retry.elevations).toEqual([10, 20]);
    expect(retry.status).toBe('ready');
});

test('pause preserves completed elevation batches for storage and retry', async () => {
    const controller = new AbortController();
    const coordinates = Array.from({ length: 150 }, (_, index) => [0, index / 1000]);
    const request = vi.fn(async () => ({ status: 'OK', results: Array.from({ length: 100 }, () => ({ elevation: 25 })) }));
    const client = createElevationClient({ intervalMs: 0, request });
    const paused = await client.fetch(coordinates, { signal: controller.signal, onProgress: () => controller.abort() });
    expect(paused.status).toBe('cancelled');
    expect(paused.elevations.slice(0, 100)).toEqual(Array(100).fill(25));
    expect(paused.elevations.slice(100)).toEqual(Array(50).fill(null));
    expect(request).toHaveBeenCalledOnce();
    const resumed = await createElevationClient({ intervalMs: 0, request }).fetch(coordinates, { existing: paused.elevations });
    expect(resumed.status).toBe('ready');
    expect(request).toHaveBeenCalledTimes(2);
});

test('does not attribute retained recorded values to a failed elevation service', async () => {
    const client = createElevationClient({ intervalMs: 0, request: async () => { throw new Error('offline'); } });
    const result = await client.fetch([[0, 0], [0, 0.1]], { existing: [15, null] });
    expect(result.addedSamples).toBe(0);
    expect(result.elevations).toEqual([15, null]);
});

test('cancels queued work without waiting for another route response', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const request = vi.fn(() => waiting);
    const client = createElevationClient({ request, intervalMs: 0 });
    const first = client.fetch([[0, 0]]);
    await Promise.resolve();
    const controller = new AbortController();
    const second = client.fetch([[1, 1]], { signal: controller.signal });
    controller.abort();
    try {
        expect((await second).status).toBe('cancelled');
        expect(request).toHaveBeenCalledOnce();
    } finally {
        release({ status: 'OK', results: [{ elevation: 10 }] });
        await first;
    }
});
