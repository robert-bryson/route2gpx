import { expect, test } from 'vitest';
import { prepareExportTrack } from '../export-data.js';

const startTime = '2020-01-01T00:00:00Z';

test('generated times follow distance within segments and never add distance across a gap', () => {
    const input = { coordinates: [[0, 0], [0, 0.1], [0, 1], [50, 50], [50, 50.1]], segmentStarts: [0, 3], duration: '100s' };
    const track = prepareExportTrack(input, { timePolicy: 'synthesize', startTime });
    expect(track.distances[3]).toBe(track.distances[2]);
    expect(track.times[3]).toBe(track.times[2]);
    expect(track.times.at(-1)).toBe('2020-01-01T00:01:40.000Z');
    expect(Date.parse(track.times[1]) - Date.parse(startTime)).toBeLessThan(10000);
    expect(input.times).toBeUndefined();
});

test('stationary routes use point order and unknown duration uses a one-minute interval estimate', () => {
    const track = prepareExportTrack({ coordinates: [[0, 0], [0, 0], [0, 0]] }, { timePolicy: 'synthesize', startTime });
    expect(track.times).toEqual(['2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z', '2020-01-01T00:02:00.000Z']);
});

test('explicit zero duration stays zero and does not use the unknown-duration fallback', () => {
    const track = prepareExportTrack({ coordinates: [[0, 0], [0, 1]], duration: 0 }, { timePolicy: 'synthesize', startTime });
    expect(track.times).toEqual([startTime.replace('Z', '.000Z'), startTime.replace('Z', '.000Z')]);
});

test('preservation normalizes aligned data without changing source arrays or inferring a timezone', () => {
    const route = { coordinates: [[0, 0], ['bad', 2], [1, 1]], elevations: [0, 99, null], times: [startTime, '2020-01-01T00:01:00Z', '2020-01-01T00:02:00'] };
    const before = structuredClone(route);
    const track = prepareExportTrack(route, { startTime });
    expect(track.coordinates).toEqual([[0, 0], [1, 1]]);
    expect(track.elevations).toEqual([0, null]);
    expect(track.times).toEqual(['2020-01-01T00:00:00.000Z', '2020-01-01T00:02:00']);
    expect(track.distances).toBeNull();
    expect(route).toEqual(before);
});

test('rejects invalid start dates, overflowing duration, and too few valid points', () => {
    const route = { coordinates: [[0, 0], [0, 1]], duration: '1e100s' };
    expect(() => prepareExportTrack(route, { startTime: 'invalid' })).toThrow('Invalid export start time');
    expect(() => prepareExportTrack(route, { startTime, timePolicy: 'synthesize' })).toThrow('duration is too large');
    expect(() => prepareExportTrack({ coordinates: [] })).toThrow('two valid points');
});

test('generated dates stay within the four-digit year range accepted by track timestamps', () => {
    const route = { coordinates: [[0, 0], [0, 1]], duration: '2s' };
    for (const startTime of ['0000-01-01T00:00:00Z', '+010000-01-01T00:00:00Z']) {
        expect(() => prepareExportTrack(route, { startTime })).toThrow('Invalid export start time');
    }
    expect(() => prepareExportTrack(route, { timePolicy: 'synthesize', startTime: '9999-12-31T23:59:59Z' })).toThrow('duration is too large');
});
