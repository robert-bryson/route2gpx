import * as pako from 'pako';
import { inflateBounded } from './compression.js';
import { parseFIT } from './parsers.js';
import { parseGeoJSON } from './gps-import.js';

self.onmessage = ({ data: { buffer, format, gzipped, maxBytes } }) => {
    try {
        const input = gzipped ? inflateBounded(new Uint8Array(buffer), maxBytes, pako).buffer : buffer;
        if (format === 'fit' || format === 'geojson') {
            const result = format === 'fit' ? parseFIT(input) : parseGeoJSON(new TextDecoder().decode(input));
            self.postMessage({ result });
        } else self.postMessage({ buffer: input }, [input]);
    } catch (error) { self.postMessage({ error: error.message || 'Unable to read GPS file.' }); }
};
