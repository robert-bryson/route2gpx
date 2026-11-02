import { test, expect, vi } from 'vitest';
import { computeRoute } from '../google-routes.js';
import { requestJson } from '../network.js';

test('validates route capabilities before contacting Google', async () => {
    const fetcher = vi.fn();
    const request = { origin: 'A', destination: 'B', travelMode: 'TRANSIT', stops: ['C'] };
    await expect(computeRoute(request, { fetcher })).rejects.toThrow('Transit');
    await expect(computeRoute({ ...request, travelMode: 'DRIVE', stops: Array(26).fill('C') }, { fetcher })).rejects.toThrow('25');
    expect(fetcher).not.toHaveBeenCalled();
});

test('preserves the provider explanation for forbidden requests', async () => {
    await expect(requestJson('/test', { fetcher: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Billing is disabled.' } }) }) })).rejects.toThrow('Billing is disabled.');
});

test('explains rate limits and malformed response bodies', async () => {
    await expect(requestJson('/test', { fetcher: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Quota exhausted.' } }) }) })).rejects.toThrow('Quota exhausted. Please wait');
    await expect(requestJson('/test', { fetcher: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }) })).rejects.toThrow('invalid response');
});

test('keeps cancellation separate from network timeouts', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const result = requestJson('/test', { fetcher, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await expect(requestJson('/test', { fetcher, timeoutMs: 5 })).rejects.toThrow('timed out');
});
