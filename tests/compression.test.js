import { test, expect } from 'vitest';
import * as pako from 'pako';
import JSZip from 'jszip';
import { inflateBounded, inflateBoundedAsync, readZipEntryBounded } from '../compression.js';

test('inflates valid content and stops over-budget expansion while streaming', async () => {
    const compressed = pako.gzip(new Uint8Array(200000));
    expect(inflateBounded(compressed, 200000, pako).length).toBe(200000);
    expect(() => inflateBounded(compressed, 1024, pako)).toThrow('too large');
    await expect(inflateBoundedAsync(compressed, 1024, pako)).rejects.toThrow('too large');
    expect(() => inflateBounded(compressed.subarray(0, 10), 200000, pako)).toThrow('compressed file');
});

test('bounds ZIP entry output independently of declared metadata', async () => {
    const zip = new JSZip();
    zip.file('test', new Uint8Array(200000));
    const file = zip.file('test');
    await expect(readZipEntryBounded(file, 1024)).rejects.toThrow('too large');
    expect((await readZipEntryBounded(file, 200000)).byteLength).toBe(200000);
});
