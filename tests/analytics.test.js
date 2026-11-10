// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsResultBucket, initializeAnalytics, sanitizeAnalyticsPayload, trackAnalyticsEvent } from '../analytics.js';

beforeEach(() => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
    });
});
afterEach(() => {
    document.getElementById('umami-analytics')?.dispatchEvent(new Event('error'));
    document.getElementById('umami-analytics')?.remove();
    delete window.umami;
    delete window.route2gpxBeforeSend;
    vi.unstubAllGlobals();
});

describe('private route analytics', () => {
    it('whitelists event data and removes route, key, identity, and title content', () => {
        const payload = sanitizeAnalyticsPayload('event', {
            website: 'other', hostname: 'other', url: '/?token=private#38.123,-90.123', title: 'Private filename',
            referrer: 'https://other.example/private/path?key=secret', id: 'private-user', extra: 'private',
            name: 'export-generated', data: { format: 'csv', routeCount: '1', filename: 'home.gpx', coordinates: [38, -90] },
        });
        expect(payload).toMatchObject({ website: 'a7ba7f9f-4aa2-4264-aa0e-602ffd2ac4e2', url: '/', tag: 'route2gpx', title: 'route2gpx', referrer: 'https://other.example', data: { format: 'csv', routeCount: '1' } });
        expect(JSON.stringify(payload)).not.toMatch(/private|secret|home\.gpx|38\.123/i);
        expect(payload).not.toHaveProperty('id');
        expect(payload).not.toHaveProperty('extra');
        expect(sanitizeAnalyticsPayload('event', { name: 'arbitrary', data: {} })).toBeNull();
        expect(sanitizeAnalyticsPayload('identify', { id: 'private' })).toBeNull();
        expect(sanitizeAnalyticsPayload('error', { message: 'private' })).toBeNull();
    });

    it('retains only finite Web Vitals and maps unknown paths to a generic section', () => {
        expect(sanitizeAnalyticsPayload('performance', { url: '/private/file?key=secret', lcp: 1400, inp: 80, cls: NaN, extra: 'private' }))
            .toMatchObject({ url: '/other', lcp: 1400, inp: 80 });
        const result = sanitizeAnalyticsPayload('performance', { url: '/', cls: NaN, fcp: -1, duration: Infinity });
        expect(result).not.toHaveProperty('cls');
        expect(result).not.toHaveProperty('fcp');
        expect(result).not.toHaveProperty('duration');
    });

    it.each([[0, '0'], [1, '1'], [2, '2-10'], [10, '2-10'], [11, '11-50'], [50, '11-50'], [51, '51+']])('buckets %i results as %s', (count, bucket) => {
        expect(analyticsResultBucket(count)).toBe(bucket);
    });

    it('queues early outcomes, drops overflow, and isolates tracker failures', () => {
        vi.stubGlobal('location', { hostname: 'route2gpx.rsmb.tv', pathname: '/' });
        initializeAnalytics({ websiteId: 'configured-property' });
        for (let i = 0; i < 10; i++) trackAnalyticsEvent('export-generated', { format: 'gpx', routeCount: '1', filename: 'secret' });
        const track = vi.fn();
        window.umami = { track };
        document.getElementById('umami-analytics').dispatchEvent(new Event('load'));
        expect(track).toHaveBeenCalledTimes(8);
        expect(track.mock.calls[0][0]({ url: '/?secret', website: 'wrong' })).toMatchObject({
            website: 'configured-property', url: '/', name: 'export-generated', data: { format: 'gpx', routeCount: '1' },
        });
        track.mockImplementation(() => { throw new Error('blocked'); });
        expect(() => trackAnalyticsEvent('export-generated', { format: 'gpx' })).not.toThrow();
    });

    it('excludes non-production hosts, browser privacy signals, and local opt-out', () => {
        initializeAnalytics({ hostname: 'localhost' });
        expect(document.getElementById('umami-analytics')).toBeNull();
        for (const preference of [{ doNotTrack: 'yes' }, { doNotTrack: '1' }, { globalPrivacyControl: true }]) {
            vi.stubGlobal('navigator', preference);
            initializeAnalytics({ hostname: 'route2gpx.rsmb.tv' });
            expect(document.getElementById('umami-analytics')).toBeNull();
        }
        vi.stubGlobal('navigator', { doNotTrack: '0' });
        localStorage.setItem('umami.disabled', '1');
        initializeAnalytics({ hostname: 'route2gpx.rsmb.tv' });
        expect(document.getElementById('umami-analytics')).toBeNull();
    });

    it('rechecks privacy preferences when automatic tracker payloads are sent', () => {
        vi.stubGlobal('location', { hostname: 'route2gpx.rsmb.tv', pathname: '/' });
        vi.stubGlobal('navigator', { doNotTrack: '0' });
        initializeAnalytics();
        expect(window.route2gpxBeforeSend('event', { url: '/' })).toMatchObject({ url: '/' });
        vi.stubGlobal('navigator', { doNotTrack: 'yes' });
        expect(window.route2gpxBeforeSend('event', { url: '/' })).toBeNull();
    });

    it('isolates failures while reading analytics payloads and starting the tracker', () => {
        vi.stubGlobal('location', { hostname: 'route2gpx.rsmb.tv', pathname: '/' });
        initializeAnalytics();
        const broken = new Proxy({}, { get() { throw new Error('unavailable'); } });
        expect(() => trackAnalyticsEvent('export-generated', broken)).not.toThrow();
        expect(window.route2gpxBeforeSend('event', broken)).toBeNull();
        document.getElementById('umami-analytics').remove();
        expect(() => initializeAnalytics({ document: { getElementById() { throw new Error('unavailable'); } } })).not.toThrow();
    });
});
