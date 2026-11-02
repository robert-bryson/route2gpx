import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as pako from 'pako';

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('self', { postMessage: vi.fn() });
    await import('../import-worker.js');
});
afterEach(() => vi.unstubAllGlobals());

const geojson = JSON.stringify({ type: 'LineString', coordinates: [[2, 1, 0], [4, 3]] });
const bufferFrom = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test.each([false, true])('parses GeoJSON in the worker with gzip: %s', gzipped => {
    const bytes = gzipped ? pako.gzip(geojson) : new TextEncoder().encode(geojson);
    self.onmessage({ data: { buffer: bufferFrom(bytes), format: 'geojson', gzipped, maxBytes: 1000 } });
    expect(self.postMessage).toHaveBeenCalledWith({ result: expect.objectContaining({
        coordinates: [[1, 2], [3, 4]], elevations: [0, null], segmentStarts: [0],
    }) });
});

test('parses XML completely in the worker after bounded decompression', () => {
    const source = '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trkseg></trk></gpx>';
    self.onmessage({ data: { buffer: bufferFrom(pako.gzip(source)), format: 'gpx', gzipped: true, maxBytes: 1000 } });
    expect(self.postMessage).toHaveBeenCalledWith({ result: expect.objectContaining({ coordinates: [[1, 2], [3, 4]] }) });
});

test('reports decompression limits instead of returning an expanded payload', () => {
    self.onmessage({ data: { buffer: bufferFrom(pako.gzip(geojson)), format: 'geojson', gzipped: true, maxBytes: 1 } });
    expect(self.postMessage).toHaveBeenCalledWith({ error: 'Decompressed file is too large.' });
});

test('reports malformed FIT data as a structured import error', () => {
    self.onmessage({ data: { buffer: new ArrayBuffer(1), format: 'fit', gzipped: false } });
    expect(self.postMessage).toHaveBeenCalledWith({ error: 'Invalid FIT header' });
});

test.each(['unknown', 'toString', '__proto__'])('rejects an unsupported format: %s', format => {
    self.onmessage({ data: { buffer: new ArrayBuffer(1), format, gzipped: false } });
    expect(self.postMessage).toHaveBeenCalledWith({ error: 'Unsupported file type' });
});
