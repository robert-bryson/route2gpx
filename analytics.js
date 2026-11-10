const HOSTNAME = 'route2gpx.rsmb.tv';
const WEBSITE_ID = 'a7ba7f9f-4aa2-4264-aa0e-602ffd2ac4e2';
const SCRIPT_ID = 'umami-analytics';
const TAG = 'route2gpx';
const BUCKETS = ['0', '1', '2-10', '11-50', '51+'];
const SCHEMA = {
    'route-calculation-finished': { outcome: ['success', 'error', 'cancelled'], mode: ['DRIVE', 'BICYCLE', 'WALK', 'TRANSIT'] },
    'file-import-finished': { outcome: ['success', 'error', 'cancelled'], format: ['gpx', 'kml', 'fit', 'tcx', 'geojson', 'unsupported'] },
    'export-generated': { format: ['gpx', 'kml', 'tcx', 'geojson', 'csv', 'zip'], routeCount: BUCKETS },
};
const pending = [];
let activeWebsiteId = WEBSITE_ID;

export function trackingAllowed(hostname = typeof window === 'undefined' ? '' : window.location.hostname) {
    if (typeof window === 'undefined' || hostname !== HOSTNAME || ['1', 'yes'].includes(navigator.doNotTrack)
        || navigator.globalPrivacyControl === true) return false;
    try { return !window.localStorage.getItem('umami.disabled'); }
    catch { return true; }
}

function pagePath(value) {
    if (typeof value !== 'string') return '/other';
    try {
        const url = new URL(value, `https://${HOSTNAME}`);
        return url.hostname === HOSTNAME && url.pathname === '/' ? '/' : '/other';
    } catch { return '/other'; }
}

function referrerOrigin(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
        const url = new URL(value, `https://${HOSTNAME}`);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        return url.hostname === HOSTNAME ? pagePath(url.href) : url.origin;
    } catch { return ''; }
}

/** Reject unknown fields and never send arbitrary route, file, or page data. */
export function sanitizeAnalyticsPayload(type, payload, websiteId = WEBSITE_ID) {
    if (!['event', 'performance'].includes(type) || !payload || typeof payload !== 'object') return null;
    const url = pagePath(payload.url);
    const clean = { website: websiteId, hostname: HOSTNAME, url, title: 'route2gpx', referrer: referrerOrigin(payload.referrer), tag: TAG };
    if (typeof payload.screen === 'string' && /^\d{1,5}x\d{1,5}$/.test(payload.screen)) clean.screen = payload.screen;
    if (typeof payload.language === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(payload.language)) clean.language = payload.language;
    if (type === 'performance') {
        for (const metric of ['ttfb', 'fcp', 'lcp', 'inp', 'cls', 'duration']) {
            const value = payload[metric];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[metric] = value;
        }
    } else if (payload.name !== undefined) {
        if (typeof payload.name !== 'string' || !Object.hasOwn(SCHEMA, payload.name)) return null;
        const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
        clean.name = payload.name;
        clean.data = Object.fromEntries(Object.entries(SCHEMA[payload.name])
            .filter(([key, values]) => values.includes(data[key])).map(([key]) => [key, data[key]]));
    }
    return clean;
}

function flushEvents() {
    if (!trackingAllowed()) { pending.length = 0; return; }
    if (!window.umami?.track) return;
    for (const event of pending.splice(0)) {
        try {
            const promise = window.umami.track(defaults => sanitizeAnalyticsPayload('event', { ...defaults, ...event }, activeWebsiteId));
            void Promise.resolve(promise).catch(() => {});
        } catch { /* Analytics must not interrupt route work. */ }
    }
}

export function trackAnalyticsEvent(name, data = {}, pathname = typeof window === 'undefined' ? '/' : window.location.pathname) {
    try {
        if (!trackingAllowed() || !document.getElementById(SCRIPT_ID)) return;
        const safe = sanitizeAnalyticsPayload('event', { name, data, url: pathname }, activeWebsiteId);
        if (!safe) return;
        pending.push({ name, data: safe.data, url: safe.url });
        if (pending.length > 8) pending.shift();
        flushEvents();
    } catch { /* Analytics must not interrupt route work. */ }
}

export function analyticsResultBucket(count) {
    return count <= 0 ? '0' : count === 1 ? '1' : count <= 10 ? '2-10' : count <= 50 ? '11-50' : '51+';
}

export function initializeAnalytics(options = {}) {
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const { hostname = window.location.hostname, websiteId = WEBSITE_ID, document: target = document } = options;
        if (!websiteId || !trackingAllowed(hostname) || target.getElementById(SCRIPT_ID)) return;
        activeWebsiteId = websiteId;
        window.route2gpxBeforeSend = (type, payload) => {
            try { return trackingAllowed() ? sanitizeAnalyticsPayload(type, payload, websiteId) : null; }
            catch { return null; }
        };
        const script = target.createElement('script');
        script.id = SCRIPT_ID;
        script.defer = true;
        script.referrerPolicy = 'no-referrer';
        script.src = 'https://cloud.umami.is/script.js';
        script.dataset.websiteId = websiteId;
        script.dataset.domains = HOSTNAME;
        script.dataset.tag = TAG;
        script.dataset.excludeSearch = 'true';
        script.dataset.excludeHash = 'true';
        script.dataset.doNotTrack = 'true';
        script.dataset.performance = 'true';
        script.dataset.beforeSend = 'route2gpxBeforeSend';
        script.addEventListener('load', flushEvents);
        script.addEventListener('error', () => { pending.length = 0; });
        target.head.appendChild(script);
    } catch { /* A blocked tracker must not prevent the application from starting. */ }
}
