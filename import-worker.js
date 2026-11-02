import * as pako from 'pako';
import { inflateBounded } from './compression.js';
import { parseImportBuffer } from './gps-import.js';

self.onmessage = ({ data: { buffer, format, gzipped, maxBytes } }) => {
    try {
        const input = gzipped ? inflateBounded(new Uint8Array(buffer), maxBytes, pako).buffer : buffer;
        const result = parseImportBuffer(input, format);
        self.postMessage({ result });
    } catch (error) { self.postMessage({ error: error.message || 'Unable to read GPS file.' }); }
};
