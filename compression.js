function inflator(data, maxBytes, implementation) {
    if (!implementation?.Inflate) throw new Error('Decompression support is unavailable. Please retry.');
    const chunks = [];
    let size = 0;
    const stream = new implementation.Inflate({ chunkSize: 64 * 1024 });
    stream.onData = chunk => {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error('Decompressed file is too large.');
        chunks.push(chunk);
    };
    return {
        stream,
        finish() {
            if (stream.err || !stream.ended) throw new Error(`Invalid compressed file.${stream.msg ? ` ${stream.msg}` : ''}`);
            const result = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
            return result;
        },
        data: data instanceof Uint8Array ? data : new Uint8Array(data),
    };
}

export function inflateBounded(data, maxBytes, implementation = globalThis.pako) {
    const operation = inflator(data, maxBytes, implementation);
    operation.stream.push(operation.data, true);
    return operation.finish();
}

export async function inflateBoundedAsync(data, maxBytes, implementation = globalThis.pako) {
    const operation = inflator(data, maxBytes, implementation);
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < operation.data.length; offset += chunkSize) {
        operation.stream.push(operation.data.subarray(offset, offset + chunkSize), offset + chunkSize >= operation.data.length);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return operation.finish();
}

export function readZipEntryBounded(file, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0, failed = false;
        const stream = file.internalStream('uint8array');
        stream.on('data', chunk => {
            if (failed) return;
            bytes += chunk.byteLength;
            if (bytes > maxBytes) { failed = true; stream.pause(); reject(new Error('Fog of World ZIP is too large after decompression.')); return; }
            chunks.push(chunk);
        }).on('error', reject).on('end', () => {
            if (failed) return;
            const result = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
            resolve(result.buffer);
        }).resume();
    });
}
