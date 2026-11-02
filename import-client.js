export function canUseImportWorker() {
    return typeof Worker === 'function' && typeof __IMPORT_WORKER_URL__ === 'string';
}

export function readInWorker(buffer, { signal, ...options }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__IMPORT_WORKER_URL__);
        const cleanup = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', cancel); };
        const cancel = () => { cleanup(); reject(new DOMException('Import cancelled.', 'AbortError')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Import took too long. Try a smaller file.')); }, 60000);
        worker.onmessage = ({ data }) => { cleanup(); if (data.error) reject(new Error(data.error)); else resolve(data); };
        worker.onerror = () => { cleanup(); reject(new Error('The import worker could not start. Reload and retry.')); };
        if (signal?.aborted) { cancel(); return; }
        signal?.addEventListener('abort', cancel, { once: true });
        worker.postMessage({ buffer, ...options }, [buffer]);
    });
}
