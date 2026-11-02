import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { canUseImportWorker, readInWorker } from '../import-client.js';

let worker;
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('__IMPORT_WORKER_URL__', 'import-worker.test.js');
    vi.stubGlobal('Worker', class {
        constructor(url) {
            this.url = url;
            this.postMessage = vi.fn();
            this.terminate = vi.fn();
            worker = this;
        }
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

test('requires both a Worker implementation and a built worker URL', () => {
    expect(canUseImportWorker()).toBe(true);
    vi.stubGlobal('__IMPORT_WORKER_URL__', undefined);
    expect(canUseImportWorker()).toBe(false);
    vi.stubGlobal('Worker', undefined);
    expect(canUseImportWorker()).toBe(false);
});

test('transfers file ownership, returns parsed data, and releases the worker', async () => {
    const buffer = new ArrayBuffer(8);
    const result = { coordinates: [[1, 1], [2, 2]] };
    const pending = readInWorker(buffer, { format: 'geojson', gzipped: false });
    expect(worker.url).toBe('import-worker.test.js');
    expect(worker.postMessage).toHaveBeenCalledWith({ buffer, format: 'geojson', gzipped: false }, [buffer]);
    worker.onmessage({ data: { result } });
    await expect(pending).resolves.toEqual({ result });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

test.each(['parse', 'startup'])('rejects a %s failure and releases the worker', async failure => {
    const pending = readInWorker(new ArrayBuffer(1), {});
    if (failure === 'parse') worker.onmessage({ data: { error: 'Invalid FIT header' } });
    else worker.onerror(new Error('startup failed'));
    await expect(pending).rejects.toThrow(failure === 'parse' ? 'Invalid FIT header' : 'could not start');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

test.each([true, false])('cancels the import when the signal is already aborted: %s', async preAborted => {
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const pending = readInWorker(new ArrayBuffer(1), { signal: controller.signal });
    if (!preAborted) controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledTimes(preAborted ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
});

test('terminates an unresponsive worker at the deadline', async () => {
    const pending = readInWorker(new ArrayBuffer(1), {});
    const assertion = expect(pending).rejects.toThrow('too long');
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

test('releases the worker and its deadline when transferring the input fails', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const original = Worker;
    vi.stubGlobal('Worker', class extends original {
        constructor(url) {
            super(url);
            this.postMessage.mockImplementation(() => { throw new DOMException('Cannot clone input.', 'DataCloneError'); });
        }
    });
    await expect(readInWorker(new ArrayBuffer(1), { signal: controller.signal })).rejects.toThrow('Cannot clone input');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
});
