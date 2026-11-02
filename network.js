export async function requestJson(url, { signal, timeoutMs = 30000, fetcher = globalThis.fetch, ...options } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
        if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
        const response = await fetcher(url, { ...options, signal: controller.signal });
        let data;
        try { data = await response.json(); }
        catch (error) {
            if (controller.signal.aborted) throw error;
            throw new Error(response.ok ? 'The server returned an invalid response. Please try again.' : `Request failed (HTTP ${response.status}). Please try again.`, { cause: error });
        }
        if (!response.ok) {
            const detail = typeof data?.error?.message === 'string' ? data.error.message : `Request failed (HTTP ${response.status}).`;
            const hint = response.status === 429 ? ' Please wait before retrying.' : [401, 403].includes(response.status) ? ' Check API enablement, billing, and key restrictions in Google Cloud.' : '';
            throw new Error(detail + hint);
        }
        return data;
    } catch (error) {
        if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
        if (controller.signal.aborted) throw new Error('Network request timed out. Please try again.', { cause: error });
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
