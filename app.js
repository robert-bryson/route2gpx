import { parseFIT, parseTCX, parseGeoJSON } from './parsers.js';
import { parseGPX, parseKML } from './gps-import.js';
import { normalizeTrack, numericValue, haversineDistance, trackDistance } from './track-data.js';
import { generateGPX as serializeGPX, escapeXml, sanitizeFilename, uniqueGpxFilenames } from './gpx.js';
import { computeRoute, validateRouteRequest, MAX_WAYPOINTS } from './google-routes.js';
import { requestJson } from './network.js';
import { createElevationClient } from './elevation.js';
import { inflateBoundedAsync } from './compression.js';
import { createRouteStorage } from './route-storage.js';
import { canUseImportWorker, readInWorker } from './import-client.js';
import { createRouteMap } from './route-map.js';
import { setupFogOfWorld } from './fog.js';
import { iconSvg, getModeIconName, getModeIconSvg, renderIconPlaceholders } from './icons.js';

// ============ State ============
let routes = [];
let clickMode = null; // null, 'origin', 'destination', 'waypoint'
let clickModeFlow = 'single'; // 'single' or 'route'
let distanceUnit = 'km';
let previewMarkers = [];
let completedPlannerPoints = null;
let completedPlannerRouteId = null;
let activeModal = null;
let activeModalReturnFocus = null;
let activeModalReturnRoute = null;
let statusTimer = null;
let pendingMapClickPrompt = null;
let activeRoutePopup = null;
let suppressNextMapClickForPopup = false;
let storageWarningShown = false;
let geolocationRequestId = 0;
let routeRequestController = null;
let lastRouteId = Date.now();
let deletedRoutes = [];
let routeListBatch = false;
let routesDirty = false;
let draftTimer = null;
let undoTimer = null;
let renameRouteId = null;
let importController = null;

const API_KEY_STORAGE_KEY = 'route2gpx_apiKey';
const API_KEY_MEMORY_KEY = 'route2gpx_apiKey_session';
// Replaced by esbuild with CARTO_API_KEY from the build environment.
const CARTO_API_KEY = typeof __CARTO_API_KEY__ === 'string' ? __CARTO_API_KEY__ : '';
const routeStorage = createRouteStorage();
const UNIT_STORAGE_KEY = 'route2gpx_unit';
const DRAFT_STORAGE_KEY = 'route2gpx_draft';
const elevationClient = createElevationClient();
const REVERSE_GEOCODE_REQUEST_TIMEOUT_MS = 8000;
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_IMPORT_BYTES = 120 * 1024 * 1024;
const OLDER_ROUTE_ENDPOINT_DOT_SIZE = 8;

const CLICK_MODE_COPY = {
    origin: {
        indicator: 'Click the map to set origin',
        status: 'Origin set from map'
    },
    destination: {
        indicator: 'Click the map to set destination',
        status: 'Destination set from map'
    },
    waypoint: {
        indicator: 'Click the map to add a waypoint',
        status: 'Waypoint added from map'
    }
};

const THIRD_PARTY_SCRIPTS = {
    jszip: {
        globalName: 'JSZip',
        src: typeof __JSZIP_URL__ === 'string' ? __JSZIP_URL__ : 'vendor/jszip.min.js',
        integrity: typeof __JSZIP_INTEGRITY__ === 'string' ? __JSZIP_INTEGRITY__ : ''
    },
    pako: {
        globalName: 'pako',
        src: typeof __PAKO_URL__ === 'string' ? __PAKO_URL__ : 'vendor/pako.min.js',
        integrity: typeof __PAKO_INTEGRITY__ === 'string' ? __PAKO_INTEGRITY__ : ''
    }
};
const loadingScripts = new Map();

// Vibrant colors that pop on grayscale basemap
const COLOR_PALETTE = [
    '#ff4757', // Red
    '#2ed573', // Green
    '#1e90ff', // Dodger Blue
    '#ffa502', // Orange
    '#a55eea', // Purple
    '#ff6b81', // Pink
    '#00d4ff', // Cyan
    '#ffdd59', // Yellow
    '#26de81', // Mint
    '#fc5c65', // Coral
];
const COLOR_PALETTE_LABELS = Object.freeze([
    'Red',
    'Green',
    'Blue',
    'Orange',
    'Purple',
    'Pink',
    'Cyan',
    'Yellow',
    'Mint',
    'Coral'
]);
let selectedColorIndex = -1; // Will be set by selectRandomColor
let availableColorIndices = []; // Pool of unused color indices for random selection

function resetColorPool() {
    // Refill pool with all color indices
    availableColorIndices = COLOR_PALETTE.map((_, i) => i);
    // Remove currently selected if valid
    if (selectedColorIndex >= 0) {
        const idx = availableColorIndices.indexOf(selectedColorIndex);
        if (idx > -1) availableColorIndices.splice(idx, 1);
    }
}

function normalizeFallbackIndex(fallbackIndex = 0) {
    const numericIndex = Number.isInteger(fallbackIndex) ? fallbackIndex : 0;
    return ((numericIndex % COLOR_PALETTE.length) + COLOR_PALETTE.length) % COLOR_PALETTE.length;
}

function getPaletteColorIndex(color, fallbackIndex = 0) {
    const normalizedColor = typeof color === 'string' ? color.toLowerCase() : '';
    const paletteIndex = COLOR_PALETTE.findIndex(paletteColor => paletteColor.toLowerCase() === normalizedColor);
    return paletteIndex >= 0 ? paletteIndex : normalizeFallbackIndex(fallbackIndex);
}

function getRouteColorClass(color, fallbackIndex = 0) {
    return `route-color-${getPaletteColorIndex(color, fallbackIndex)}`;
}

function setElementRouteColorClass(element, color, fallbackIndex = 0) {
    if (!element) return;
    COLOR_PALETTE.forEach((_, index) => element.classList.remove(`route-color-${index}`));
    element.classList.add(getRouteColorClass(color, fallbackIndex));
}

// ============ Initialize Map ============
const map = L.map('map', {
    center: [39.8283, -98.5795],
    zoom: 4,
    keyboard: true,
    keyboardPanDelta: 100
});

// Grayscale basemap for better route visibility
const cartoTileUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
L.tileLayer(CARTO_API_KEY ? `${cartoTileUrl}?key=${encodeURIComponent(CARTO_API_KEY)}` : cartoTileUrl, {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
    subdomains: 'abcd'
}).addTo(map);

const routeMap = createRouteMap({ map, leaflet: L, markerIcon: createEndpointMarkerIcon, popupContent: createRoutePopup, onHighlight: highlightRouteListItem });

// ============ LocalStorage ============
function loadFromStorage() {
    try {
        // Distance unit
        const savedUnit = localStorage.getItem(UNIT_STORAGE_KEY);
        if (savedUnit) {
            setUnit(savedUnit, false);
        }

        // Saved routes
        const routeData = routeStorage.load(localStorage, () => console.warn('Skipping corrupt saved geometry.'));
        if (routeData.length) {
            if (!Array.isArray(routeData)) throw new Error('Saved routes payload is not an array');
            let restoredCount = 0;
            routeListBatch = true;
            routeData.forEach(data => {
                if (restoreRoute(data)) restoredCount++;
            });
            routeListBatch = false;
            updateRouteMapStyles();
            renderRoutesList();
            updateBulkButtons();
            fitVisibleRoutes();
            if (restoredCount > 0) {
                showStatus(`Restored ${restoredCount} route(s) from previous session`);
            }
        }
    } catch (error) {
        routeListBatch = false;
        console.error('Failed to restore from storage:', error.message);
        showStatus('Some saved routes could not be restored. Export any routes you need before clearing browser storage.', true);
    }
}

function routeSnapshot(route) {
    return {
        id: route.id,
        name: route.name,
        origin: route.origin,
        destination: route.destination,
        stops: normalizeStops(route.stops),
        travelMode: route.travelMode,
        color: route.color,
        coordinates: route.coordinates,
        elevations: route.elevations || null,
        times: route.times || null,
        segmentStarts: route.segmentStarts || [0],
        source: route.source || 'legacy',
        createdAt: route.createdAt || null,
        request: route.request || null,
        elevationSource: route.elevationSource || null,
        renamed: route.renamed === true,
        distance: route.distance,
        duration: route.duration,
        visible: route.visible !== false
    };
}

function saveToStorage() {
    try {
        // Distance unit
        localStorage.setItem(UNIT_STORAGE_KEY, distanceUnit);

        // Routes (without Leaflet objects)
        const routeData = routes.map(routeSnapshot);
        routeStorage.save(localStorage, routeData);
        storageWarningShown = false;
        routesDirty = false;
        updateStorageWarning();
        return true;
    } catch (error) {
        routesDirty = true;
        notifyStorageFailure(error);
        updateStorageWarning();
        return false;
    }
}

function updateStorageWarning() {
    const warning = document.getElementById('storageWarning');
    if (warning) warning.hidden = !routesDirty;
}

function fitVisibleRoutes() {
    routeMap.fitVisible();
}

function isStorageQuotaError(error) {
    return error?.name === 'QuotaExceededError' ||
        error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        error?.code === 22 ||
        error?.code === 1014;
}

function notifyStorageFailure(error) {
    console.error('Failed to save to storage:', error.message);
    if (storageWarningShown) return;

    storageWarningShown = true;
    const message = isStorageQuotaError(error)
        ? 'Routes were not saved because browser storage is full. Export or delete routes before adding more.'
        : 'Routes could not be saved in this browser.';
    showStatus(message, true);
}

function loadExternalScript(scriptConfig) {
    if (typeof window[scriptConfig.globalName] !== 'undefined') {
        return Promise.resolve(window[scriptConfig.globalName]);
    }

    if (loadingScripts.has(scriptConfig.globalName)) {
        return loadingScripts.get(scriptConfig.globalName);
    }

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const finish = error => {
            clearTimeout(timer);
            script.onload = script.onerror = null;
            if (error) { script.remove(); reject(error); }
            else resolve(window[scriptConfig.globalName]);
        };
        const timer = setTimeout(() => finish(new Error(`Timed out loading ${scriptConfig.globalName}. Please retry.`)), 15000);
        script.src = scriptConfig.src;
        script.integrity = scriptConfig.integrity;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.onload = () => finish(typeof window[scriptConfig.globalName] === 'undefined' ? new Error(`Failed to initialize ${scriptConfig.globalName}`) : null);
        script.onerror = () => finish(new Error(`Failed to load ${scriptConfig.globalName}. Please retry.`));
        document.head.appendChild(script);
    }).catch(error => { loadingScripts.delete(scriptConfig.globalName); throw error; });

    loadingScripts.set(scriptConfig.globalName, promise);
    return promise;
}

function ensureJSZip() {
    return loadExternalScript(THIRD_PARTY_SCRIPTS.jszip);
}

function ensurePako() {
    return loadExternalScript(THIRD_PARTY_SCRIPTS.pako);
}

function formatSizeLimit(bytes) {
    return formatFileSize(bytes).replace('.0 ', ' ');
}

function assertFileSize(file, maxBytes, label) {
    if (file.size > maxBytes) {
        throw new Error(`${label} is too large (${formatFileSize(file.size)}). Maximum size is ${formatSizeLimit(maxBytes)}.`);
    }
}

function createRoutePopup(route) {
    const pointCount = route.coordinates.length;
    const segmentCount = route.segmentStarts?.length || 1;
    const stopCount = route.stops ? route.stops.length : 0;

    return `
        <div class="route-popup">
            <h4>${escapeHtml(route.name)}</h4>
            <div class="route-meta">
                <span>${iconSvg('ruler', 'icon-sm')} ${formatDistance(route.distance)}</span>
                <span>${iconSvg('clock', 'icon-sm')} ${formatDuration(route.duration)}</span>
            </div>
            <div class="route-meta">
                <span>${getModeIconSvg(route.travelMode)} ${escapeHtml(route.travelMode.toLowerCase())}</span>
                ${stopCount > 0 ? `<span>${iconSvg('map-pin', 'icon-sm')} ${stopCount} stop${stopCount > 1 ? 's' : ''}</span>` : ''}
            </div>
            <div class="route-meta route-meta-border">
                <span>${iconSvg('route', 'icon-sm')} ${segmentCount} segment${segmentCount === 1 ? '' : 's'}</span>
                <span>${iconSvg('route', 'icon-sm')} ${pointCount.toLocaleString()} points</span>
            </div>
            <div class="popup-actions">
                <button class="popup-btn download" data-action="download-route" data-route-id="${route.id}" title="Download GPX">
                    ${iconSvg('download', 'icon-sm')} Download
                </button>
                <button class="popup-btn delete" data-action="remove-route" data-route-id="${route.id}" title="Remove route">
                    ${iconSvg('trash-2', 'icon-sm')} Remove
                </button>
            </div>
        </div>
    `;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function scrollRouteItemIntoViewIfNeeded(routeItem) {
    const list = document.getElementById('routesList');
    if (!list || !routeItem || !list.contains(routeItem) || list.clientHeight === 0) return;

    const listRect = list.getBoundingClientRect();
    const itemRect = routeItem.getBoundingClientRect();
    const scrollPadding = 6;

    if (itemRect.top >= listRect.top && itemRect.bottom <= listRect.bottom) return;

    if (itemRect.top < listRect.top) {
        list.scrollTop += itemRect.top - listRect.top - scrollPadding;
    } else if (itemRect.bottom > listRect.bottom) {
        list.scrollTop += itemRect.bottom - listRect.bottom + scrollPadding;
    }
}

function highlightRouteListItem(id, active) {
    const item = document.querySelector(`.route-item[data-route-id="${id}"]`);
    if (!item) return;
    item.classList.toggle('highlighted', active);
    if (active) scrollRouteItemIntoViewIfNeeded(item);
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

const VALID_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DEFAULT_ROUTE_COLORS = COLOR_PALETTE;
function sanitizeColor(color, fallbackIndex) {
    if (typeof color === 'string' && VALID_COLOR_RE.test(color)) return color;
    return DEFAULT_ROUTE_COLORS[fallbackIndex % DEFAULT_ROUTE_COLORS.length];
}

function normalizeRouteColor(color, fallbackIndex = 0) {
    return COLOR_PALETTE[getPaletteColorIndex(sanitizeColor(color, fallbackIndex), fallbackIndex)];
}

function normalizeStops(stops) {
    if (!Array.isArray(stops)) return [];
    return stops
        .map(stop => typeof stop === 'string' ? stop.trim() : '')
        .filter(Boolean);
}


function fallbackCoordinateLabel(coordinate) {
    return `${coordinate[0].toFixed(4)}, ${coordinate[1].toFixed(4)}`;
}


function normalizeStoredRoute(data) {
    if (!data || typeof data !== 'object') return null;
    const track = normalizeTrack(data);
    if (track.coordinates.length < 2) return null;
    const fallbackIndex = routes.length;
    const id = numericValue(data.id);
    const distance = numericValue(data.distance);
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Saved route';
    const origin = typeof data.origin === 'string' && data.origin.trim() ? data.origin.trim() : fallbackCoordinateLabel(track.coordinates[0]);
    const destination = typeof data.destination === 'string' && data.destination.trim() ? data.destination.trim() : fallbackCoordinateLabel(track.coordinates.at(-1));
    const travelMode = ['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT', 'IMPORTED'].includes(data.travelMode) ? data.travelMode : 'DRIVE';
    const count = track.elevations.filter(value => value !== null).length;
    return {
        ...track,
        elevations: data.elevations == null ? null : track.elevations,
        times: data.times == null ? null : track.times,
        id: Number.isSafeInteger(id) && !routes.some(route => route.id === id) ? id : nextRouteId(),
        name, origin, destination,
        stops: normalizeStops(data.stops), travelMode,
        color: normalizeRouteColor(data.color, fallbackIndex),
        distance: distance !== null && distance >= 0 && data.coordinates.length === track.coordinates.length && track.segmentStarts.length === 1 ? distance : Math.round(trackDistance(track)),
        duration: typeof data.duration === 'string' ? data.duration : null,
        visible: data.visible !== false,
        source: ['google', 'import'].includes(data.source) ? data.source : 'legacy',
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
        request: normalizeRouteRequest(data.request),
        renamed: data.renamed === true,
        elevationSource: data.elevationSource?.dataset === 'srtm90m' ? { dataset: 'srtm90m', sampled: data.elevationSource.sampled === true, sampleCount: Number(data.elevationSource.sampleCount) || 0, mixed: data.elevationSource.mixed === true } : null,
        elevationStatus: count === track.coordinates.length ? 'ready' : count ? 'partial' : null,
    };
}

function nextRouteId() {
    lastRouteId = Math.max(Date.now(), lastRouteId + 1);
    while (routes.some(route => route.id === lastRouteId)) lastRouteId++;
    return lastRouteId;
}

function normalizeRouteRequest(value) {
    if (!value || typeof value.origin !== 'string' || typeof value.destination !== 'string') return null;
    return { origin: value.origin, destination: value.destination, departureTime: typeof value.departureTime === 'string' && Number.isFinite(Date.parse(value.departureTime)) ? value.departureTime : null, stops: normalizeStops(value.stops).slice(0, MAX_WAYPOINTS), travelMode: ['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT'].includes(value.travelMode) ? value.travelMode : 'DRIVE' };
}

function restoreRoute(data) {
    let restoredData;
    try { restoredData = normalizeStoredRoute(data); } catch (error) { console.warn('Skipping saved route:', error.message); return false; }
    if (!restoredData) {
        console.warn('Skipping saved route with invalid coordinates');
        return false;
    }

    routes.push(restoredData);
    routeMap.add(restoredData);
    if (!routeListBatch) { updateRouteMapStyles(); renderRoutesList(); }
    return true;
}

// ============ Custom Markers ============
function createEndpointDotIcon(color) {
    const dotSize = OLDER_ROUTE_ENDPOINT_DOT_SIZE;
    return L.divIcon({
        html: `<div class="marker-dot ${getRouteColorClass(color)}"></div>`,
        className: 'custom-marker endpoint-dot-marker',
        iconSize: [dotSize, dotSize],
        iconAnchor: [dotSize / 2, dotSize / 2]
    });
}

function createEndpointMarkerIcon(type, color, isNewest) {
    return isNewest ? createMarkerIcon(type, color) : createEndpointDotIcon(color);
}

function updateRouteMapStyles() {
    routeMap.updateStyles(routes.at(-1)?.id);
}

function createMarkerIcon(type, color, number = null) {
    const colorClass = getRouteColorClass(color);
    let html = '';
    if (type === 'start') {
        html = `<div class="marker-icon ${colorClass}"><span>A</span></div>`;
    } else if (type === 'end') {
        html = `<div class="marker-icon ${colorClass}"><span>B</span></div>`;
    } else if (type === 'waypoint') {
        html = `<div class="marker-number ${colorClass}">${escapeHtml(number)}</div>`;
    }

    return L.divIcon({
        html: html,
        className: 'custom-marker',
        iconSize: [32, 32],
        iconAnchor: type === 'waypoint' ? [12, 12] : [16, 32]
    });
}

function parseLatLngInput(input) {
    const latLngMatch = input.trim().match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (!latLngMatch) return null;

    const latitude = parseFloat(latLngMatch[1]);
    const longitude = parseFloat(latLngMatch[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    return { latitude, longitude };
}

function isValidLatLng({ latitude, longitude }) {
    return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function looksLikeCoordinatePair(input) {
    return /^-?\d+\.?\d*\s*,\s*-?\d+\.?\d*$/.test(input.trim());
}

function validateLocationInput(input, label) {
    if (!looksLikeCoordinatePair(input)) return true;
    const latLng = parseLatLngInput(input);
    if (latLng && isValidLatLng(latLng)) return true;
    showStatus(`${label} coordinates must be latitude -90 to 90 and longitude -180 to 180`, true);
    return false;
}

function clearPreviewMarkers() {
    previewMarkers.forEach(m => map.removeLayer(m));
    previewMarkers = [];
}

function updatePreviewMarkers() {
    clearPreviewMarkers();

    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    const stops = getStops();
    if (JSON.stringify([origin, destination, ...stops]) === completedPlannerPoints && routes.some(route => route.id === completedPlannerRouteId && route.visible)) return;
    const previewColor = document.getElementById('routeColor').value || '#888';

    if (origin) {
        const latLng = parseLatLngInput(origin);
        if (latLng && isValidLatLng(latLng)) {
            const marker = L.marker([latLng.latitude, latLng.longitude], {
                icon: createMarkerIcon('start', previewColor),
                opacity: 0.7
            }).addTo(map);
            previewMarkers.push(marker);
        }
    }

    if (destination) {
        const latLng = parseLatLngInput(destination);
        if (latLng && isValidLatLng(latLng)) {
            const marker = L.marker([latLng.latitude, latLng.longitude], {
                icon: createMarkerIcon('end', previewColor),
                opacity: 0.7
            }).addTo(map);
            previewMarkers.push(marker);
        }
    }

    stops.forEach((stop, idx) => {
        const latLng = parseLatLngInput(stop);
        if (latLng && isValidLatLng(latLng)) {
            const marker = L.marker([latLng.latitude, latLng.longitude], {
                icon: createMarkerIcon('waypoint', previewColor, idx + 1),
                opacity: 0.7
            }).addTo(map);
            previewMarkers.push(marker);
        }
    });
}

// ============ Click-to-Add Mode ============
function toggleClickMode() {
    if (clickMode) {
        exitClickMode();
    } else {
        enterClickMode(getNextMapPickTarget(), 'route');
    }
}

function getNextMapPickTarget() {
    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    if (!origin) return 'origin';
    if (!destination) return 'destination';
    return 'waypoint';
}

function getClickModeInput(target) {
    if (target === 'origin') return document.getElementById('origin');
    if (target === 'destination') return document.getElementById('destination');
    return null;
}

function updateClickModeUi() {
    const btn = document.getElementById('clickModeBtn');
    const indicator = document.getElementById('mapModeIndicator');
    const targetSpan = document.getElementById('clickModeTarget');
    const mapElement = document.getElementById('map');
    const isPicking = Boolean(clickMode);

    btn.classList.toggle('active', isPicking);
    btn.setAttribute('aria-pressed', isPicking ? 'true' : 'false');
    btn.setAttribute('aria-label', isPicking ? 'Cancel map picking' : 'Start guided map picker');
    btn.title = isPicking ? 'Cancel map picking' : 'Guided map picker: set origin, destination, then waypoints';

    indicator.hidden = !isPicking;
    if (isPicking) {
        targetSpan.textContent = CLICK_MODE_COPY[clickMode]?.indicator || 'Click the map to set a point';
    }

    mapElement.classList.toggle('map-picking', isPicking);

    document.querySelectorAll('[data-map-pick-target]').forEach(pickButton => {
        const targetMatches = pickButton.dataset.mapPickTarget === clickMode;
        const flowMatches = (pickButton.dataset.mapPickFlow || 'single') === clickModeFlow;
        const active = isPicking && targetMatches && flowMatches;
        pickButton.classList.toggle('active', active);
        pickButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    document.querySelectorAll('.input-with-btn.picking').forEach(group => group.classList.remove('picking'));
    const activeInput = getClickModeInput(clickMode);
    activeInput?.closest('.input-with-btn')?.classList.add('picking');
}

function enterClickMode(target, flow = 'single') {
    setMobileView('map');
    clickMode = target;
    clickModeFlow = flow;
    updateClickModeUi();
}

function exitClickMode() {
    clickMode = null;
    clickModeFlow = 'single';
    updateClickModeUi();
}

// Programmatic edits must run the same validation, draft, and stale-request hooks.
function setEndpointValue(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setMapPickValue(target, latLng) {
    if (target === 'origin' || target === 'destination') {
        const input = document.getElementById(target);
        setEndpointValue(input, latLng);
    } else if (target === 'waypoint') {
        addStop(latLng);
    }
}

function formatLeafletLatLng(latlng) {
    return `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
}

function getPassiveMapPickTarget() {
    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    if (!origin) return 'origin';
    if (!destination) return 'destination';
    return null;
}

function createMapClickPrompt(target, latLng) {
    const label = target === 'origin' ? 'origin' : 'destination';
    const labelTitle = target === 'origin' ? 'Origin' : 'Destination';

    return `
        <div class="map-click-prompt">
            <div class="map-click-prompt-title">${iconSvg('map-pin', 'icon-sm')} Use this spot as ${label}?</div>
            <div class="map-click-prompt-coords">${escapeHtml(latLng)}</div>
            <div class="popup-actions">
                <button type="button" class="popup-btn confirm" data-action="confirm-map-click-prompt">
                    ${iconSvg('plus', 'icon-sm')} Set ${labelTitle}
                </button>
                <button type="button" class="popup-btn cancel" data-action="cancel-map-click-prompt">
                    ${iconSvg('x', 'icon-sm')} Cancel
                </button>
            </div>
        </div>
    `;
}

function openMapClickPrompt(target, leafletLatLng) {
    const latLng = formatLeafletLatLng(leafletLatLng);
    const popup = L.popup({ closeButton: true, className: 'map-click-prompt-container' })
        .setLatLng(leafletLatLng)
        .setContent(createMapClickPrompt(target, latLng))
        .openOn(map);
    popup.route2gpxPopupType = 'map-click-prompt';

    pendingMapClickPrompt = { target, latLng, popup };
}

function confirmMapClickPrompt() {
    if (!pendingMapClickPrompt) return;

    const { target, latLng } = pendingMapClickPrompt;
    pendingMapClickPrompt = null;
    setMapPickValue(target, latLng);
    updatePreviewMarkers();
    map.closePopup();
    showStatus(CLICK_MODE_COPY[target]?.status || 'Point set from map');
}

function cancelMapClickPrompt() {
    pendingMapClickPrompt = null;
    map.closePopup();
}

map.on('click', function (e) {
    if (suppressNextMapClickForPopup) {
        suppressNextMapClickForPopup = false;
        map.closePopup();
        return;
    }

    if (!clickMode) {
        const target = getPassiveMapPickTarget();
        if (target) openMapClickPrompt(target, e.latlng);
        return;
    }

    const latLng = formatLeafletLatLng(e.latlng);
    const target = clickMode;
    const flow = clickModeFlow;

    setMapPickValue(target, latLng);
    updatePreviewMarkers();

    if (flow === 'route') {
        const nextTarget = target === 'waypoint' ? 'waypoint' : getNextMapPickTarget();
        enterClickMode(nextTarget, 'route');
        showStatus(`${CLICK_MODE_COPY[target]?.status || 'Point set from map'}. ${CLICK_MODE_COPY[nextTarget]?.indicator || 'Click the map to continue'}.`);
    } else {
        exitClickMode();
        showStatus(CLICK_MODE_COPY[target]?.status || 'Point set from map');
    }
});

map.on('preclick', function () {
    if (!activeRoutePopup) return;
    suppressNextMapClickForPopup = true;
    map.closePopup(activeRoutePopup);
});

map.on('popupopen', function (event) {
    if (event?.popup?.route2gpxPopupType === 'route') {
        activeRoutePopup = event.popup;
    }
});

map.on('popupclose', function (event) {
    if (!event?.popup || event.popup === activeRoutePopup) {
        activeRoutePopup = null;
    }

    if (!pendingMapClickPrompt) return;
    if (!event?.popup || event.popup === pendingMapClickPrompt.popup) {
        pendingMapClickPrompt = null;
    }
});

// ============ Help Toggle ============
function toggleHelp() {
    const content = document.getElementById('helpContent');
    const btn = document.querySelector('.help-toggle');
    const isVisible = content.classList.toggle('visible');
    btn.setAttribute('aria-expanded', isVisible);
}

function getFocusableElements(container) {
    return Array.from(container.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
}

function setAppInert(isInert) {
    const app = document.getElementById('app');
    if (!app) return;
    document.querySelectorAll('#app, .mobile-view-toggle, .skip-link').forEach(element => { element.inert = isInert; });
    if (isInert) {
        app.setAttribute('aria-hidden', 'true');
    } else {
        app.removeAttribute('aria-hidden');
    }
}

function openModal(modal, initialFocusElement) {
    activeModal = modal;
    activeModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const row = activeModalReturnFocus?.closest('.route-item');
    activeModalReturnRoute = row ? { id: row.dataset.routeId, action: activeModalReturnFocus.dataset.action } : null;
    setAppInert(true);
    modal.classList.add('visible');
    (initialFocusElement || getFocusableElements(modal)[0] || modal).focus();
}

function closeModal(modal) {
    modal.classList.remove('visible');
    if (activeModal === modal) {
        activeModal = null;
        setAppInert(false);
        if (activeModalReturnFocus && typeof activeModalReturnFocus.focus === 'function' && document.contains(activeModalReturnFocus)) {
            activeModalReturnFocus.focus();
        }
        if (activeModalReturnRoute && !document.contains(activeModalReturnFocus)) {
            const row = document.querySelector(`#routesList [data-route-id="${activeModalReturnRoute.id}"]`);
            (row?.querySelector(`[data-action="${activeModalReturnRoute.action}"]`) || row || document.getElementById('getRouteBtn'))?.focus();
        }
        activeModalReturnFocus = null;
        activeModalReturnRoute = null;
    }
}

function handleModalKeydown(event) {
    if (!activeModal) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        if (activeModal.id === 'apiKeyModal') closeApiKeyModal();
        else if (activeModal.id === 'filenameModal') closeFilenameModal();
        else if (activeModal.id === 'renameModal') closeRenameModal();
        return;
    }

    if (event.key !== 'Tab') return;

    const focusableElements = getFocusableElements(activeModal);
    if (focusableElements.length === 0) {
        event.preventDefault();
        activeModal.focus();
        return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

document.addEventListener('keydown', handleModalKeydown, true);

// ============ API Key Modal ============
function getApiKey() {
    return getStorageItem('sessionStorage', API_KEY_MEMORY_KEY) || getStorageItem('localStorage', API_KEY_STORAGE_KEY);
}

function isApiKeyRemembered() {
    return Boolean(getStorageItem('localStorage', API_KEY_STORAGE_KEY));
}

function getStorageItem(storage, key) {
    try {
        return globalThis[storage].getItem(key) || '';
    } catch {
        return '';
    }
}

function removeStorageItem(storage, key) {
    try {
        globalThis[storage].removeItem(key);
    } catch {
        // Best effort cleanup only.
    }
}

function updateApiKeyStatus() {
    const apiKey = getApiKey();
    const btn = document.getElementById('apiKeyMapBtn');

    if (apiKey) {
        btn.classList.remove('missing');
        btn.classList.add('valid');
        btn.title = isApiKeyRemembered() ? 'API key saved on this browser — click to edit' : 'API key saved for this tab — click to edit';
        btn.setAttribute('aria-label', btn.title);
    } else {
        btn.classList.remove('valid');
        btn.classList.add('missing');
        btn.title = 'No API key — click to add';
        btn.setAttribute('aria-label', 'No API key, click to add');
    }
}


function openApiKeyModal() {
    const error = document.getElementById('apiKeyError');
    if (error) error.hidden = true;
    const modal = document.getElementById('apiKeyModal');
    const input = document.getElementById('apiKeyInput');
    const rememberInput = document.getElementById('rememberApiKey');
    input.value = getApiKey();
    if (rememberInput) rememberInput.checked = isApiKeyRemembered();
    updateApiKeyStorageHint();
    const remove = document.getElementById('removeApiKeyBtn');
    if (remove) remove.disabled = !getApiKey();
    openModal(modal, input);
}

function closeApiKeyModal() {
    const modal = document.getElementById('apiKeyModal');
    closeModal(modal);
}

function updateApiKeyStorageHint() {
    const rememberInput = document.getElementById('rememberApiKey');
    const hint = document.getElementById('apiKeyStorageHint');
    if (!rememberInput || !hint) return;
    hint.textContent = rememberInput.checked
        ? 'Stored in this browser until you clear it. Restrict the key to this website and the Routes API.'
        : 'Stored only in this tab and cleared when the tab closes.';
}

function saveApiKey() {
    const input = document.getElementById('apiKeyInput');
    const rememberInput = document.getElementById('rememberApiKey');
    const key = input.value.trim();

    if (key) {
        try {
            if (rememberInput && rememberInput.checked) {
                localStorage.setItem(API_KEY_STORAGE_KEY, key);
                removeStorageItem('sessionStorage', API_KEY_MEMORY_KEY);
                showStatus('API key saved on this browser');
            } else {
                sessionStorage.setItem(API_KEY_MEMORY_KEY, key);
                removeStorageItem('localStorage', API_KEY_STORAGE_KEY);
                showStatus('API key saved for this tab');
            }
        } catch (error) {
            if (!(rememberInput && rememberInput.checked)) {
                console.error('Failed to save API key:', error.message);
                showStatus('API key could not be saved in this browser.', true);
                input.focus();
                return;
            }

            console.warn('Persistent API key storage unavailable; falling back to session storage:', error.message);
            try {
                sessionStorage.setItem(API_KEY_MEMORY_KEY, key);
                removeStorageItem('localStorage', API_KEY_STORAGE_KEY);
                if (rememberInput) rememberInput.checked = false;
                updateApiKeyStorageHint();
                showStatus('API key saved for this tab because browser storage is unavailable');
            } catch (fallbackError) {
                console.error('Failed to save API key:', fallbackError.message);
                showStatus('API key could not be saved in this browser.', true);
                input.focus();
                return;
            }
        }
        updateApiKeyStatus();
        closeApiKeyModal();
    } else {
        showStatus('Please enter a valid API key', true);
        input.focus();
    }
}


// Close modal on Escape or click outside
document.getElementById('apiKeyModal').addEventListener('click', function (e) {
    if (e.target === this) {
        closeApiKeyModal();
    }
});

document.getElementById('apiKeyInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveApiKey();
    } else if (e.key === 'Escape') {
        closeApiKeyModal();
    }
});

// ============ Geolocation ============
function getValidatedPositionLatLng(position) {
    const latitude = numericValue(position?.coords?.latitude);
    const longitude = numericValue(position?.coords?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !isValidLatLng({ latitude, longitude })) {
        return null;
    }
    return { latitude, longitude };
}

function locateMe() {
    if (!navigator.geolocation) {
        showStatus('Geolocation is not supported by your browser', true);
        return;
    }

    const requestId = ++geolocationRequestId;
    showStatus('Getting your location...');
    navigator.geolocation.getCurrentPosition(
        (position) => {
            if (requestId !== geolocationRequestId) return;
            const latLng = getValidatedPositionLatLng(position);
            if (!latLng) {
                showStatus('Unable to use the reported location coordinates', true);
                return;
            }
            const { latitude, longitude } = latLng;
            map.setView([latitude, longitude], 14);
            showStatus('Centered on your location');
        },
        (error) => {
            if (requestId !== geolocationRequestId) return;
            showStatus('Unable to get your location: ' + error.message, true);
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function useMyLocation(field) {
    if (!navigator.geolocation) {
        showStatus('Geolocation is not supported by your browser', true);
        return;
    }

    const input = document.getElementById(field);
    if (!input) return;
    const originalValue = input.value;
    const requestId = ++geolocationRequestId;
    const invalidate = () => { if (requestId === geolocationRequestId) geolocationRequestId++; };
    input.addEventListener('input', invalidate, { once: true });
    const isCurrent = () => {
        input.removeEventListener('input', invalidate);
        return requestId === geolocationRequestId && input.isConnected && input.value === originalValue;
    };
    showStatus('Getting your location...');
    navigator.geolocation.getCurrentPosition(
        (position) => {
            if (!isCurrent()) return;
            const latLngPosition = getValidatedPositionLatLng(position);
            if (!latLngPosition) {
                showStatus('Unable to use the reported location coordinates', true);
                return;
            }
            const { latitude, longitude } = latLngPosition;
            const latLng = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
            setEndpointValue(input, latLng);
            updatePreviewMarkers();
            showStatus('Location set');
        },
        (error) => {
            if (!isCurrent()) return;
            showStatus('Unable to get your location: ' + error.message, true);
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============ Polyline Decoder ============
function decodePolyline(encoded) {
    const points = [];
    let index = 0, lat = 0, lng = 0;

    if (typeof encoded !== 'string' || encoded.length === 0) return points;

    function decodeValue() {
        let shift = 0, result = 0;

        while (true) {
            if (index >= encoded.length) {
                throw new Error('Encoded polyline ended unexpectedly');
            }

            const byte = encoded.charCodeAt(index++) - 63;
            if (!Number.isFinite(byte) || byte < 0) {
                throw new Error('Encoded polyline contains an invalid character');
            }

            result |= (byte & 0x1f) << shift;
            if (byte < 0x20) break;

            shift += 5;
            if (shift > 30) {
                throw new Error('Encoded polyline value is too large');
            }
        }

        return (result & 1) ? ~(result >> 1) : (result >> 1);
    }

    try {
        while (index < encoded.length) {
            lat += decodeValue();
            lng += decodeValue();
            points.push([lat / 1e5, lng / 1e5]);
        }
    } catch (error) {
        console.warn('Invalid encoded polyline:', error.message);
        return [];
    }

    return points;
}

// ============ Waypoint Management ============
function addStop(value = '') {
    if (document.querySelectorAll('.stop-row').length >= MAX_WAYPOINTS) { showStatus(`You can add up to ${MAX_WAYPOINTS} waypoints.`, true); return; }
    const container = document.getElementById('stopsContainer');
    const stopNumber = container.children.length + 1;

    const row = document.createElement('div');
    row.className = 'stop-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
        <span class="stop-number" aria-hidden="true">${stopNumber}</span>
        <input type="text" class="stop-input" placeholder="Waypoint ${stopNumber}"
               value="${escapeHtml(value)}" aria-label="Waypoint ${stopNumber}" />
        <div class="stop-row-actions" aria-label="Waypoint ${stopNumber} actions">
            <button type="button" class="stop-action-btn stop-move-btn" data-action="move-stop-up"
                    aria-label="Move waypoint ${stopNumber} up" title="Move waypoint up">
                ${iconSvg('chevron-up', 'icon-sm')}
            </button>
            <button type="button" class="stop-action-btn stop-move-btn" data-action="move-stop-down"
                    aria-label="Move waypoint ${stopNumber} down" title="Move waypoint down">
                ${iconSvg('chevron-down', 'icon-sm')}
            </button>
            <button type="button" class="stop-action-btn stop-remove-btn" data-action="remove-stop"
                    aria-label="Remove waypoint ${stopNumber}" title="Remove waypoint">
                ${iconSvg('x', 'icon-sm')}
            </button>
        </div>
    `;
    container.appendChild(row);

    if (!value) {
        row.querySelector('input').focus();
    }

    updatePreviewMarkers();
    renumberStops();
}

function removeStop(btn) {
    btn.closest('.stop-row').remove();
    renumberStops();
    updatePreviewMarkers();
}

function moveStop(btn, direction) {
    const row = btn.closest('.stop-row');
    const container = document.getElementById('stopsContainer');
    if (!row || !container) return;

    if (direction < 0 && row.previousElementSibling) {
        container.insertBefore(row, row.previousElementSibling);
    } else if (direction > 0 && row.nextElementSibling) {
        container.insertBefore(row.nextElementSibling, row);
    }

    renumberStops();
    updatePreviewMarkers();
    const moveButton = row.querySelector(`[data-action="${direction < 0 ? 'move-stop-up' : 'move-stop-down'}"]`);
    if (moveButton && !moveButton.disabled) moveButton.focus();
    else row.querySelector('input')?.focus();
}

function renumberStops() {
    const rows = document.querySelectorAll('.stop-row');
    rows.forEach((row, idx) => {
        const num = idx + 1;
        row.querySelector('.stop-number').textContent = num;
        row.querySelector('input').setAttribute('aria-label', `Waypoint ${num}`);
        row.querySelector('input').placeholder = `Waypoint ${num}`;
        row.querySelector('.stop-row-actions')?.setAttribute('aria-label', `Waypoint ${num} actions`);
        const moveUpButton = row.querySelector('[data-action="move-stop-up"]');
        const moveDownButton = row.querySelector('[data-action="move-stop-down"]');
        const removeButton = row.querySelector('[data-action="remove-stop"]');
        moveUpButton?.setAttribute('aria-label', `Move waypoint ${num} up`);
        moveDownButton?.setAttribute('aria-label', `Move waypoint ${num} down`);
        removeButton?.setAttribute('aria-label', `Remove waypoint ${num}`);
        if (moveUpButton) moveUpButton.disabled = idx === 0;
        if (moveDownButton) moveDownButton.disabled = idx === rows.length - 1;
    });
    updateWaypointHint();
    scheduleDraftSave();
}

function getStops() {
    const inputs = document.querySelectorAll('.stop-input');
    return Array.from(inputs)
        .map(input => input.value.trim())
        .filter(val => val !== '');
}

function replaceStops(stops) {
    const container = document.getElementById('stopsContainer');
    container.innerHTML = '';
    stops.forEach(stop => addStop(stop));
    renumberStops();
}

function updateEndpointValidation() {
    updateInputValidation(document.getElementById('origin'));
    updateInputValidation(document.getElementById('destination'));
}

function moveEndpoint(endpoint, direction) {
    const originInput = document.getElementById('origin');
    const destInput = document.getElementById('destination');
    const routePoints = [originInput.value.trim(), ...getStops(), destInput.value.trim()];
    const endpointIndex = endpoint === 'origin' ? 0 : routePoints.length - 1;
    const targetIndex = endpointIndex + direction;

    if (targetIndex < 0 || targetIndex >= routePoints.length) return;

    [routePoints[endpointIndex], routePoints[targetIndex]] = [routePoints[targetIndex], routePoints[endpointIndex]];
    setEndpointValue(originInput, routePoints[0]);
    setEndpointValue(destInput, routePoints[routePoints.length - 1]);
    replaceStops(routePoints.slice(1, -1).filter(Boolean));

    updateEndpointValidation();
    updatePreviewMarkers();
    showStatus(`${endpoint === 'origin' ? 'Origin' : 'Destination'} moved`);
}

function reverseRoute() {
    const originInput = document.getElementById('origin');
    const destInput = document.getElementById('destination');

    // Swap origin and destination
    const temp = originInput.value;
    setEndpointValue(originInput, destInput.value);
    setEndpointValue(destInput, temp);

    // Reverse waypoints
    const stops = getStops();
    stops.reverse();

    replaceStops(stops);

    updateEndpointValidation();
    updatePreviewMarkers();
    showStatus('Route reversed');
}

// ============ Distance Unit ============
function setUnit(unit, save = true) {
    if (!['km', 'mi'].includes(unit)) return;
    distanceUnit = unit;
    document.getElementById('unitKm').classList.toggle('active', unit === 'km');
    document.getElementById('unitMi').classList.toggle('active', unit === 'mi');
    document.getElementById('unitKm').setAttribute('aria-checked', unit === 'km');
    document.getElementById('unitMi').setAttribute('aria-checked', unit === 'mi');

    renderRoutesList();
    document.getElementById('unitKm').tabIndex = unit === 'km' ? 0 : -1;
    document.getElementById('unitMi').tabIndex = unit === 'mi' ? 0 : -1;
    if (save) { try { localStorage.setItem(UNIT_STORAGE_KEY, unit); } catch { showStatus('Distance preference could not be saved.', true); } }
}

// ============ Status Messages ============
function showStatus(message, isError = false) {
    const status = document.getElementById('status');
    clearTimeout(statusTimer);
    if (activeModal?.id === 'apiKeyModal' && isError) {
        const error = document.getElementById('apiKeyError');
        if (error) { error.textContent = message; error.hidden = false; }
    }
    status.textContent = message;
    status.className = 'status ' + (isError ? 'error' : 'success');
    status.hidden = false;

    if (!isError) statusTimer = setTimeout(() => { status.hidden = true; }, 5000);
}

// ============ Location Parsing ============
function parseLocation(input) {
    const latLng = parseLatLngInput(input);
    if (latLng && isValidLatLng(latLng)) {
        return {
            location: {
                latLng: {
                    latitude: latLng.latitude,
                    longitude: latLng.longitude
                }
            }
        };
    }
    return { address: input };
}

function getHumanPlaceName(place) {
    if (!place || typeof place !== 'object') return '';

    const candidates = [
        place.displayName?.text,
        place.shortFormattedAddress,
        place.formattedAddress,
        place.formatted_address,
        place.plus_code?.compound_code,
        place.plusCode?.compoundCode
    ];

    const name = candidates.find(value => typeof value === 'string' && value.trim());
    return name ? name.trim() : '';
}

function getReverseGeocodeDisplayName(data) {
    if (!data || typeof data !== 'object') return '';

    if (Array.isArray(data.results)) {
        const result = data.results.find(item => getHumanPlaceName(item));
        return getHumanPlaceName(result);
    }

    if (Array.isArray(data.places)) {
        const place = data.places.find(item => getHumanPlaceName(item));
        return getHumanPlaceName(place);
    }

    return getHumanPlaceName(data);
}

async function reverseGeocodeCoordinate(input, apiKey) {
    const latLng = parseLatLngInput(input);
    if (!latLng || !isValidLatLng(latLng)) return '';

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${latLng.latitude},${latLng.longitude}`);
    url.searchParams.set('key', apiKey);

    try {
        const data = await requestJson(url.toString(), { timeoutMs: REVERSE_GEOCODE_REQUEST_TIMEOUT_MS });
        if (data.status && data.status !== 'OK') return '';
        return getReverseGeocodeDisplayName(data);
    } catch (error) {
        console.warn('Reverse geocoding unavailable:', error.message);
        return '';
    }
}

async function resolveRouteEndpointLabel(input, apiKey) {
    if (!parseLatLngInput(input)) return input;
    const placeName = await reverseGeocodeCoordinate(input, apiKey);
    return placeName || input;
}

async function resolveRouteEndpointLabels(origin, destination, apiKey) {
    const [originLabel, destinationLabel] = await Promise.all([
        resolveRouteEndpointLabel(origin, apiKey),
        resolveRouteEndpointLabel(destination, apiKey)
    ]);
    return { originLabel, destinationLabel };
}

function buildRouteName(originLabel, destinationLabel) {
    return `${truncate(originLabel, 20)} → ${truncate(destinationLabel, 20)}`;
}

function getTravelModeButtons() {
    return Array.from(document.querySelectorAll('[data-travel-mode]'));
}

function selectTravelMode(mode, emitChange = true) {
    const input = document.getElementById('travelMode');
    const buttons = getTravelModeButtons();
    const selectedButton = buttons.find(button => button.dataset.travelMode === mode) || buttons[0];
    const selectedMode = selectedButton?.dataset.travelMode || mode;

    if (input && selectedMode) {
        input.value = selectedMode;
        if (emitChange) input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    buttons.forEach(button => {
        const isSelected = button === selectedButton;
        button.setAttribute('aria-checked', String(isSelected));
        button.tabIndex = isSelected ? 0 : -1;
    });
    updateWaypointHint();
    scheduleDraftSave();
}

function updateWaypointHint() {
    const mode = document.getElementById('travelMode')?.value;
    const count = getStops().length;
    const hint = document.getElementById('waypointHint');
    if (hint) hint.textContent = mode === 'TRANSIT' && count ? 'Transit does not support waypoints. Remove them or switch mode.' : `${count}/${MAX_WAYPOINTS} waypoints${count > 10 ? ' · Higher Google billing tier above 10 stops' : ''}`;
    const add = document.getElementById('addStopBtn');
    if (add) add.disabled = document.querySelectorAll('.stop-row').length >= MAX_WAYPOINTS;
    const departure = document.getElementById('departureTimeGroup');
    if (departure) departure.hidden = mode !== 'TRANSIT';
}

function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 250);
}

function saveDraft() {
    const draft = { origin: document.getElementById('origin').value, destination: document.getElementById('destination').value, stops: getStops(), travelMode: document.getElementById('travelMode').value, departureTime: document.getElementById('departureTime')?.value || '', labelCoordinates: document.getElementById('labelCoordinates')?.checked || false, fetchElevation: document.getElementById('fetchElevation')?.checked !== false };
    try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft)); } catch { /* Completed routes have a separate persistent warning. */ }
}

function loadDraft() {
    try {
        const draft = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY));
        const request = normalizeRouteRequest(draft);
        if (!request) return;
        setEndpointValue(document.getElementById('origin'), request.origin);
        setEndpointValue(document.getElementById('destination'), request.destination);
        replaceStops(request.stops); selectTravelMode(request.travelMode, false);
        const departure = document.getElementById('departureTime');
        if (departure && typeof draft.departureTime === 'string') departure.value = draft.departureTime;
        const labels = document.getElementById('labelCoordinates');
        if (labels) labels.checked = draft.labelCoordinates === true;
        const elevation = document.getElementById('fetchElevation');
        if (elevation) elevation.checked = draft.fetchElevation !== false;
        updateEndpointValidation(); updatePreviewMarkers();
    } catch { /* A malformed draft must not block the application. */ }
}

function moveTravelModeSelection(currentButton, direction) {
    const buttons = getTravelModeButtons();
    if (!buttons.length) return;

    const currentIndex = Math.max(0, buttons.indexOf(currentButton));
    const nextIndex = (currentIndex + direction + buttons.length) % buttons.length;
    const nextButton = buttons[nextIndex];
    selectTravelMode(nextButton.dataset.travelMode);
    nextButton.focus();
}

function handleTravelModeKeydown(event) {
    const button = event.target.closest('[data-travel-mode]');
    if (!button) return;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveTravelModeSelection(button, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveTravelModeSelection(button, -1);
    } else if (event.key === 'Home') {
        event.preventDefault();
        const firstButton = getTravelModeButtons()[0];
        selectTravelMode(firstButton.dataset.travelMode);
        firstButton.focus();
    } else if (event.key === 'End') {
        event.preventDefault();
        const buttons = getTravelModeButtons();
        const lastButton = buttons[buttons.length - 1];
        selectTravelMode(lastButton.dataset.travelMode);
        lastButton.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTravelMode(button.dataset.travelMode);
    }
}

function setupTravelModeToggle() {
    const buttons = getTravelModeButtons();
    const input = document.getElementById('travelMode');
    if (!buttons.length || !input) return;

    buttons.forEach(button => {
        button.addEventListener('click', () => selectTravelMode(button.dataset.travelMode));
    });

    buttons[0].closest('[role="radiogroup"]')?.addEventListener('keydown', handleTravelModeKeydown);
    selectTravelMode(input.value || buttons[0].dataset.travelMode, false);
}


// ============ Get Route from API ============
async function getRoute() {
    if (routeRequestController) return;
    const apiKey = getApiKey();
    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    const travelMode = document.getElementById('travelMode').value;
    let color = document.getElementById('routeColor').value;

    // Ensure we have a valid color
    if (!color || color === '') {
        color = COLOR_PALETTE[selectedColorIndex] || COLOR_PALETTE[0];
    }
    color = normalizeRouteColor(color, selectedColorIndex >= 0 ? selectedColorIndex : routes.length);
    document.getElementById('routeColor').value = color;
    const stops = getStops();

    // Validation
    if (!apiKey) {
        showStatus('API key required', true);
        openApiKeyModal();
        return;
    }
    if (!origin) {
        showStatus('Please enter an origin', true);
        document.getElementById('origin').focus();
        return;
    }
    if (!destination) {
        showStatus('Please enter a destination', true);
        document.getElementById('destination').focus();
        return;
    }
    if (!validateLocationInput(origin, 'Origin')) {
        document.getElementById('origin').focus();
        return;
    }
    if (!validateLocationInput(destination, 'Destination')) {
        document.getElementById('destination').focus();
        return;
    }
    const invalidStopIndex = stops.findIndex(stop => !validateLocationInput(stop, 'Waypoint'));
    if (invalidStopIndex !== -1) {
        [...document.querySelectorAll('.stop-input')].filter(input => input.value.trim())[invalidStopIndex]?.focus();
        return;
    }

    const request = { origin, destination, travelMode, stops: [...stops] };
    try { validateRouteRequest(request); }
    catch (error) { showStatus(error.message, true); return; }
    const departure = document.getElementById('departureTime')?.value;
    if (travelMode === 'TRANSIT' && departure) {
        const date = new Date(departure);
        const offset = date.getTime() - Date.now();
        if (!Number.isFinite(offset) || offset < -7 * 86400000 || offset > 100 * 86400000) {
            showStatus('Choose a transit departure within the past 7 days or the next 100 days.', true);
            return;
        }
        request.departureTime = date.toISOString();
    }
    const controller = new AbortController();
    routeRequestController = controller;
    const btn = document.getElementById('getRouteBtn');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="spinner"></span>Finding route...';
    const cancel = document.getElementById('cancelRouteBtn');
    if (cancel) cancel.hidden = false;
    saveDraft();

    try {
        const result = await computeRoute(request, { apiKey, signal: controller.signal, parseLocation });
        if (controller.signal.aborted) return;
        const coordinates = decodePolyline(result.polyline?.encodedPolyline);
        if (coordinates.length < 2) throw new Error('Route geometry was missing or invalid. Please try again.');
        const distance = numericValue(result.distanceMeters) ?? Math.round(trackDistance({ coordinates }));
        const duration = typeof result.duration === 'string' ? result.duration : null;
        const routeId = nextRouteId();
        const routeName = buildRouteName(origin, destination);

        // Store route
        const route = {
            id: routeId,
            name: routeName,
            origin, destination, request,
            source: 'google',
            createdAt: new Date().toISOString(),
            segmentStarts: [0],
            times: null,
            stops: [...stops],
            travelMode,
            color,
            coordinates,
            distance,
            duration,
            visible: true,
            elevationStatus: null
        };
        routes.push(route);
        routeMap.add(route);
        updateRouteMapStyles();
        setMobileView('map');
        routeMap.fit(route.id);

        // Update UI
        renderRoutesList();
        updateBulkButtons();
        if (!saveToStorage()) setMobileView('planner');
        showStatus(`Route added: ${formatDistance(distance)}, ${formatDuration(duration)}. Edit, add, or reorder points to create another route.`);
        exitClickMode();

        // Pick a random color for the next route
        completedPlannerPoints = JSON.stringify([origin, destination, ...stops]);
        completedPlannerRouteId = route.id;
        selectRandomColor();
        clearPreviewMarkers();

        // Optional labels never delay drawing or exporting the route.
        if (document.getElementById('labelCoordinates')?.checked) {
            resolveRouteEndpointLabels(origin, destination, apiKey).then(labels => {
                if (!routes.includes(route)) return;
                route.origin = labels.originLabel;
                route.destination = labels.destinationLabel;
                if (!route.renamed) route.name = buildRouteName(route.origin, route.destination);
                routeMap.updateLabels(route.id);
                renderRoutesList(); saveToStorage();
            });
        }
        enrichRouteElevations(route);
    } catch (error) {
        showStatus(error.name === 'AbortError' ? 'Route calculation cancelled.' : error.message, error.name !== 'AbortError');
    } finally {
        if (routeRequestController === controller) routeRequestController = null;
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.innerHTML = 'Get Route';
        if (cancel) cancel.hidden = true;
    }
}

function cancelRouteRequest() {
    routeRequestController?.abort();
}

// ============ Formatting Helpers ============
function truncate(str, len) {
    const value = String(str ?? '');
    return value.length > len ? value.substring(0, len) + '...' : value;
}

function formatDistance(meters) {
    if (!Number.isFinite(meters) || meters < 0) return '—';
    if (distanceUnit === 'mi') {
        const miles = meters / 1609.34;
        return miles >= 10 ? miles.toFixed(0) + ' mi' : miles.toFixed(1) + ' mi';
    } else {
        const km = meters / 1000;
        return km >= 10 ? km.toFixed(0) + ' km' : km.toFixed(1) + ' km';
    }
}

function formatDuration(durationStr) {
    const seconds = parseInt(durationStr?.replace('s', ''), 10);
    if (!Number.isFinite(seconds)) return '—';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}


// ============ Route List Rendering ============
function renderRoutesList() {
    const list = document.getElementById('routesList');
    const focused = document.activeElement;
    const focusedRow = focused?.closest?.('.route-item');
    const focusState = focusedRow && list.contains(focused) ? { id: focusedRow.dataset.routeId, action: focused.dataset.action, index: [...list.children].indexOf(focusedRow) } : null;

    if (routes.length === 0) {
        list.innerHTML = `
            <div class="routes-empty-state">
                <div class="routes-empty-state-icon">${iconSvg('map', 'empty-state-icon')}</div>
                <div class="routes-empty-state-title">No routes yet</div>
                <div class="routes-empty-state-copy">Enter an origin and destination, or open a GPS file.</div>
                <button type="button" class="btn-outline" data-action="browse-import">Import GPS file</button>
            </div>
        `;
        if (focusState) list.querySelector('button')?.focus();
        return;
    }

    list.innerHTML = routes.map((route, idx) => `
        <div class="route-item ${getRouteColorClass(route.color, idx)}" role="listitem"
             data-route-id="${route.id}"
             tabindex="0"
             aria-label="Route ${idx + 1}: ${escapeHtml(route.name)}. Press Enter to zoom and view details.">
            <div class="route-item-header">
                <div>
                    <div class="route-title-row">
                    <span class="route-number" aria-hidden="true">${idx + 1}</span>
                    <div class="route-item-title">${escapeHtml(route.name)}</div>
                    </div>
                    <div class="route-item-meta">
                        <span class="route-meta-item">${getModeIconSvg(route.travelMode)} ${escapeHtml(route.travelMode.toLowerCase())}</span> •
                        ${formatDistance(route.distance)} • ${formatDuration(route.duration)}
                        ${route.stops.length > 0 ? ` • ${route.stops.length} stop(s)` : ''}
                        ${getElevationStatusText(route) ? ` • <span class="route-elevation-status">${getElevationStatusText(route)}</span>` : ''}
                    </div>
                </div>
            </div>
            <div class="route-item-actions">
                ${route.request ? `<button type="button" class="btn-outline btn-small" data-action="edit-route" data-route-id="${route.id}">Edit / reuse</button>` : ''}
                <button type="button" class="btn-outline btn-small" data-action="rename-route" data-route-id="${route.id}" aria-label="Rename ${escapeHtml(route.name)}">Rename</button>
                ${route.elevationStatus !== 'ready' ? `<button type="button" class="btn-outline btn-small" data-action="${route.elevationController ? 'cancel-elevation' : 'retry-elevation'}" data-route-id="${route.id}">${route.elevationController ? 'Pause elevation' : route.elevations?.some(value => value !== null) ? 'Retry elevation' : 'Add elevation'}</button>` : ''}
                <button class="btn-outline btn-small" data-action="toggle-visibility" data-route-id="${route.id}"
                        aria-label="${route.visible ? 'Hide' : 'Show'} route"
                        title="${route.visible ? 'Hide this route from the map' : 'Show this route on the map'}">
                    <span class="icon-label">${iconSvg(route.visible ? 'eye-off' : 'eye', 'icon-sm')} ${route.visible ? 'Hide' : 'Show'}</span>
                </button>
                <button class="btn-outline btn-small" data-action="download-route" data-route-id="${route.id}"
                        aria-label="Download GPX for ${escapeHtml(route.name)}"
                        title="Download as GPX file for GPS devices">
                    <span class="icon-label">${iconSvg('file-down', 'icon-sm')} GPX</span>
                </button>
                <button class="btn-secondary btn-small" data-action="remove-route" data-route-id="${route.id}"
                        aria-label="Delete route ${escapeHtml(route.name)}"
                        title="Remove this route permanently">
                    ${iconSvg('trash-2', 'icon-sm')}
                </button>
            </div>
        </div>
    `).join('');
    if (focusState) {
        const row = [...list.children].find(item => item.dataset.routeId === focusState.id) || list.children[Math.min(focusState.index, list.children.length - 1)];
        (row?.querySelector(`[data-action="${focusState.action}"]`) || row)?.focus({ preventScroll: true });
    }
}

function getElevationStatusText(route) {
    if (route.elevationStatus === 'loading') return route.elevationProgress ? `elevation ${route.elevationProgress.completed}/${route.elevationProgress.total}` : 'adding elevation';
    if (route.elevationStatus === 'partial') return 'partial elevation';
    if (route.elevationStatus === 'cancelled') return 'elevation paused';
    if (route.elevationStatus === 'ready') return route.elevationSource?.sampled ? 'sampled elevation' : 'elevation ready';
    if (route.elevationStatus === 'unavailable') return 'no elevation';
    return '';
}

// ============ Route Actions ============
function updateBulkButtons() {
    const hasRoutes = routes.length > 0;
    document.getElementById('downloadAllBtn').disabled = !hasRoutes;
    document.getElementById('clearAllBtn').disabled = !hasRoutes;
}

function zoomToRoute(id) {
    const route = routes.find(item => item.id === id);
    if (!route) return;
    if (!route.visible) {
        route.visible = true;
        routeMap.setVisible(id, true);
        renderRoutesList();
        saveToStorage();
    }
    setMobileView('map');
    routeMap.fit(id);
    routeMap.open(id);
}

function highlightRouteById(id) {
    routeMap.highlight(id, true);
}

function unhighlightRouteById(id) {
    routeMap.highlight(id, false);
}

function toggleRouteVisibility(id) {
    const route = routes.find(item => item.id === id);
    if (!route) return;
    route.visible = !route.visible;
    routeMap.setVisible(id, route.visible);
    renderRoutesList();
    saveToStorage();
}

function removeRoute(id) {
    const index = routes.findIndex(r => r.id === id);
    if (index !== -1) {
        rememberDeleted([{ data: routeSnapshot(routes[index]), index }]);
        routes[index].elevationController?.abort();
        routeMap.remove(id);
        routes.splice(index, 1);
        updateRouteMapStyles();
        renderRoutesList();
        updateBulkButtons();
        saveToStorage();
    }
}

function clearAllRoutes() {
    if (!confirm('Remove all routes? You can undo this for 15 seconds.')) return;
    rememberDeleted(routes.map((route, index) => ({ data: routeSnapshot(route), index })));
    routes.forEach(route => {
        route.elevationController?.abort();
        routeMap.remove(route.id);
    });
    routes = [];
    renderRoutesList();
    updateBulkButtons();
    saveToStorage();
}

function rememberDeleted(items) {
    deletedRoutes = items;
    clearTimeout(undoTimer);
    const notice = document.getElementById('undoNotice');
    if (notice) {
        notice.hidden = !items.length;
        document.getElementById('undoMessage').textContent = `${items.length} route(s) removed.`;
    }
    undoTimer = setTimeout(() => { deletedRoutes = []; if (notice) notice.hidden = true; }, 15000);
}

function undoDelete() {
    const items = deletedRoutes;
    deletedRoutes = [];
    clearTimeout(undoTimer);
    routeListBatch = true;
    for (const { data, index } of items) {
        if (restoreRoute(data)) {
            const restored = routes.pop();
            routes.splice(Math.min(index, routes.length), 0, restored);
        }
    }
    routeListBatch = false;
    updateRouteMapStyles(); renderRoutesList(); updateBulkButtons(); saveToStorage();
    const notice = document.getElementById('undoNotice');
    if (notice) notice.hidden = true;
    showStatus(`Restored ${items.length} route(s).`);
}

function loadRouteIntoPlanner(id) {
    const route = routes.find(item => item.id === id);
    if (!route?.request) return;
    setEndpointValue(document.getElementById('origin'), route.request.origin);
    setEndpointValue(document.getElementById('destination'), route.request.destination);
    replaceStops(route.request.stops); selectTravelMode(route.request.travelMode);
    const departure = document.getElementById('departureTime');
    if (departure) departure.value = route.request.departureTime ? toLocalDatetime(route.request.departureTime) : '';
    updateEndpointValidation(); updatePreviewMarkers(); saveDraft();
    setMobileView('planner');
    document.getElementById('origin').focus();
    showStatus('Route loaded into the planner. Calculate to add a new version.');
}

function toLocalDatetime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
}

function openRenameModal(id) {
    const route = routes.find(item => item.id === id);
    if (!route) return;
    renameRouteId = id;
    const input = document.getElementById('renameInput');
    input.value = route.name;
    openModal(document.getElementById('renameModal'), input);
    input.select();
}

function closeRenameModal() {
    closeModal(document.getElementById('renameModal'));
    renameRouteId = null;
}

function confirmRename() {
    const route = routes.find(item => item.id === renameRouteId);
    const name = document.getElementById('renameInput').value.trim();
    if (!name) { document.getElementById('renameInput').focus(); return; }
    if (route) { route.name = name.slice(0, 200); route.renamed = true; routeMap.updateLabels(route.id); }
    closeRenameModal(); renderRoutesList(); saveToStorage();
}

function setMobileView(view) {
    document.body.dataset.mobileView = view;
    document.querySelectorAll('[data-mobile-view]').forEach(button => {
        if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.mobileView === view));
    });
    if (typeof map.invalidateSize === 'function') map.invalidateSize({ pan: false });
}

// ============ GPX Export ============
function generateGPX(route, options = {}) {
    return serializeGPX(route, options);
}

// ============ Filename Confirmation Modal ============
let pendingDownload = null; // { routeId, gpxContent, defaultFilename }

function exportDataDescription(route) {
    const known = route.elevations?.filter(Number.isFinite).length || 0;
    const recorded = route.times?.filter(Boolean).length || 0;
    return `${route.coordinates.length.toLocaleString()} points · ${route.segmentStarts?.length || 1} segment(s). Elevation: ${known}/${route.coordinates.length} points${route.elevationController || route.elevationPending ? ' (still loading)' : ''}. Recorded times: ${recorded}/${route.coordinates.length} points. Missing elevations and times are omitted.${route.elevationSource?.sampled ? ' Elevation between samples is interpolated.' : ''}${route.elevationSource?.mixed ? ' Recorded and SRTM elevations are combined.' : ''}`;
}

function openFilenameModal(routeId, gpxContent, defaultFilename) {
    pendingDownload = { routeId, gpxContent, defaultFilename };
    const modal = document.getElementById('filenameModal');
    const input = document.getElementById('filenameInput');
    const preview = document.getElementById('filenamePreview');
    input.value = defaultFilename;
    preview.textContent = defaultFilename;
    const checkbox = document.getElementById('synthesizeTimes');
    if (checkbox) checkbox.checked = false;
    const route = routes.find(item => item.id === routeId);
    const hint = document.getElementById('exportDataHint');
    if (hint && route) hint.textContent = exportDataDescription(route);
    openModal(modal, input);
    input.select();
}

function closeFilenameModal() {
    closeModal(document.getElementById('filenameModal'));
    pendingDownload = null;
}

function confirmFilenameDownload() {
    if (!pendingDownload) return;
    let filename = document.getElementById('filenameInput').value.trim();
    if (!filename) filename = pendingDownload.defaultFilename;
    if (!filename.toLowerCase().endsWith('.gpx')) filename += '.gpx';
    filename = sanitizeFilename(filename.replace(/\.gpx$/i, '')) + '.gpx';
    const route = routes.find(item => item.id === pendingDownload.routeId);
    const content = route ? generateGPX(route, { timePolicy: document.getElementById('synthesizeTimes')?.checked ? 'synthesize' : 'preserve' }) : pendingDownload.gpxContent;
    downloadFile(content, filename, 'application/gpx+xml');
    closeFilenameModal();
}

// Modal event listeners
document.getElementById('filenameModal').addEventListener('click', function (e) {
    if (e.target === this) closeFilenameModal();
});
document.getElementById('filenameInput').addEventListener('input', function () {
    let val = this.value.trim();
    if (!val) val = pendingDownload?.defaultFilename || 'route.gpx';
    if (!val.toLowerCase().endsWith('.gpx')) val += '.gpx';
    document.getElementById('filenamePreview').textContent = sanitizeFilename(val.replace(/\.gpx$/i, '')) + '.gpx';
});
document.getElementById('filenameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); confirmFilenameDownload(); }
    else if (e.key === 'Escape') closeFilenameModal();
});

function downloadRoute(id) {
    const route = routes.find(r => r.id === id);
    if (!route) return;

    const gpx = null;
    const filename = `${sanitizeFilename(route.travelMode.toLowerCase())}_${sanitizeFilename(route.name)}.gpx`;
    openFilenameModal(id, gpx, filename);
}

async function downloadAllRoutes() {
    if (routes.length === 0) return;

    if (routes.length === 1) {
        downloadRoute(routes[0].id);
        return;
    }

    const snapshot = routes.map(route => ({ ...routeSnapshot(route), elevationPending: Boolean(route.elevationController) }));
    const filenames = uniqueGpxFilenames(snapshot);
    const summary = document.getElementById('batchExportSummary');
    if (summary) {
        summary.hidden = false;
        summary.open = true;
        document.getElementById('batchExportItems').replaceChildren(...snapshot.map(route => {
            const item = document.createElement('li');
            item.textContent = `${route.name}: ${exportDataDescription(route)}`;
            return item;
        }));
    }
    // Batch download as ZIP
    try {
        await ensureJSZip();
        const zip = new JSZip();
        for (const [index, route] of snapshot.entries()) {
            zip.file(filenames[index], generateGPX(route));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'routes.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showStatus(`Downloaded ${snapshot.length} routes as ZIP. See ZIP export data for elevation and time coverage.`);
    } catch (error) {
        console.warn('ZIP download unavailable, falling back to sequential GPX downloads:', error.message);
        // Fallback: sequential downloads
        snapshot.forEach((route, idx) => {
            setTimeout(() => {
                const gpx = generateGPX(route);
                const filename = filenames[idx];
                downloadFile(gpx, filename, 'application/gpx+xml');
            }, idx * 300);
        });
        showStatus('ZIP support failed to load; downloading GPX files individually', true);
    }
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============ Elevation Data (Open-Topo-Data) ============
async function fetchElevations(coordinates, options = {}) {
    return (await elevationClient.fetch(coordinates, options)).elevations;
}

async function enrichRouteElevations(route, { force = false } = {}) {
    if (route.elevationController || route.elevationStatus === 'ready') return;
    if (!force && document.getElementById('fetchElevation')?.checked === false) return;
    const controller = new AbortController();
    route.elevationController = controller;
    route.elevationStatus = 'loading';
    renderRoutesList();
    try {
        const result = await elevationClient.fetch(route.coordinates, {
            signal: controller.signal, segmentStarts: route.segmentStarts, existing: route.elevations || [],
            interpolateExisting: route.elevationSource?.dataset === 'srtm90m',
            onProgress(progress) { if (routes.includes(route)) { route.elevationProgress = progress; renderRoutesList(); } },
        });
        if (!routes.includes(route)) return;
        const mixed = route.elevationSource?.mixed === true || (!route.elevationSource && route.elevations?.some(Number.isFinite));
        route.elevations = result.elevations;
        route.elevationStatus = result.status;
        if (result.addedSamples > 0) route.elevationSource = { dataset: 'srtm90m', sampled: result.sampled, sampleCount: result.sampleCount, mixed: Boolean(mixed) };
        saveToStorage();
    } catch (error) {
        if (routes.includes(route)) route.elevationStatus = controller.signal.aborted ? 'cancelled' : 'unavailable';
    } finally {
        delete route.elevationController;
        delete route.elevationProgress;
        if (routes.includes(route)) renderRoutesList();
    }
}

function cancelElevation(id) {
    routes.find(route => route.id === id)?.elevationController?.abort();
}

// ============ GPX Import ============
let fileDropGuardInstalled = false;

function eventHasFiles(event) {
    return Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file');
}

function isImportDropTarget(target) {
    return target instanceof Element && Boolean(target.closest('.import-section'));
}

function setupGlobalFileDropGuard() {
    if (fileDropGuardInstalled) return;
    fileDropGuardInstalled = true;

    window.addEventListener('dragover', (event) => {
        if (!eventHasFiles(event)) return;
        event.preventDefault();
        if (!isImportDropTarget(event.target)) {
            event.dataTransfer.dropEffect = 'none';
        }
    });

    window.addEventListener('drop', (event) => {
        if (!eventHasFiles(event)) return;
        if (!isImportDropTarget(event.target)) {
            event.preventDefault();
        }
    });
}

function setupImport() {
    const dropZone = document.getElementById('importDropZone');
    const fileInput = document.getElementById('importFileInput');
    setupGlobalFileDropGuard();

    dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', (e) => {
        if (e.target === dropZone) {
            dropZone.classList.remove('drag-over');
        }
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) handleImportFiles(files);
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) handleImportFiles(fileInput.files);
        fileInput.value = ''; // Reset so same file can be re-imported
    });
}

async function handleImportFiles(files) {
    if (importController) { showStatus('An import is already running. Cancel it before starting another.', true); return; }
    const fileArray = Array.from(files);
    if (fileArray.length > 100 || fileArray.reduce((sum, file) => sum + file.size, 0) > 250 * 1024 * 1024) {
        showStatus('Import at most 100 files and 250 MB at a time.', true); return;
    }
    const controller = new AbortController();
    importController = controller;
    setMobileView('planner');
    const cancel = document.getElementById('cancelImportBtn');
    if (cancel) cancel.hidden = false;
    let imported = 0;
    let hasWarnings = false;
    const outcomes = [];
    for (const file of fileArray) {
        if (controller.signal.aborted) break;
        try {
            showStatus(`Importing ${file.name}...`);
            const { added, diagnostics } = await handleSingleImportFile(file, { signal: controller.signal });
            imported++;
            const warnings = importWarnings(diagnostics);
            hasWarnings ||= warnings.length > 0;
            outcomes.push(`${file.name}: imported ${added.length} track(s).${warnings.length ? ` ${warnings.join(' ')}` : ''}`);
        } catch (error) { outcomes.push(`${file.name}: ${error.message}`); }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    importController = null;
    if (cancel) cancel.hidden = true;
    if (controller.signal.aborted) outcomes.push('Import cancelled. Completed tracks are retained.');
    const summary = document.getElementById('importSummary');
    if (summary) {
        summary.hidden = false;
        summary.open = hasWarnings || imported < fileArray.length;
        document.getElementById('importSummaryTitle').textContent = `Imported ${imported} of ${fileArray.length} file(s)`;
        const list = document.getElementById('importSummaryItems');
        list.replaceChildren(...outcomes.map(message => { const item = document.createElement('li'); item.textContent = message; return item; }));
    }
    showStatus(`Imported ${imported} of ${fileArray.length} file(s).${hasWarnings || imported < fileArray.length ? ' See import results for details.' : ''}`, imported < fileArray.length);
}

function importWarnings(diagnostics) {
    const warnings = [];
    if (diagnostics.skippedPoints) warnings.push(`Skipped ${diagnostics.skippedPoints} invalid point(s).`);
    if (diagnostics.skippedTracks) warnings.push(`Skipped ${diagnostics.skippedTracks} track(s) with fewer than two points.`);
    if (diagnostics.unsupportedGeometries) warnings.push(`Skipped ${diagnostics.unsupportedGeometries} unsupported geometry item(s).`);
    return warnings;
}

function detectImportFormat(filename) {
    const name = filename.toLowerCase();
    if (/\.(geojson|json)\.gz$/.test(name)) return { format: 'geojson', gzipped: true };
    if (name.endsWith('.fit.gz')) return { format: 'fit', gzipped: true };
    if (name.endsWith('.tcx.gz')) return { format: 'tcx', gzipped: true };
    if (name.endsWith('.gpx.gz')) return { format: 'gpx', gzipped: true };
    if (name.endsWith('.kml.gz')) return { format: 'kml', gzipped: true };
    if (name.endsWith('.fit')) return { format: 'fit', gzipped: false };
    if (name.endsWith('.tcx')) return { format: 'tcx', gzipped: false };
    if (name.endsWith('.gpx')) return { format: 'gpx', gzipped: false };
    if (name.endsWith('.kml')) return { format: 'kml', gzipped: false };
    if (name.endsWith('.geojson') || name.endsWith('.json')) return { format: 'geojson', gzipped: false };
    return null;
}

async function handleSingleImportFile(file, { signal } = {}) {
    assertFileSize(file, MAX_IMPORT_FILE_BYTES, file.name);
    const detected = detectImportFormat(file.name);
    if (!detected) {
        throw new Error('Unsupported file type');
    }

    const { format, gzipped } = detected;
    let arrayBuffer = await file.arrayBuffer();

    let result;
    if (canUseImportWorker() && (gzipped || ((format === 'fit' || format === 'geojson') && arrayBuffer.byteLength > 256 * 1024))) {
        const processed = await readInWorker(arrayBuffer, { signal, format, gzipped, maxBytes: MAX_DECOMPRESSED_IMPORT_BYTES });
        result = processed.result;
        arrayBuffer = processed.buffer;
    } else if (gzipped) {
        await ensurePako();
        arrayBuffer = (await inflateBoundedAsync(new Uint8Array(arrayBuffer), MAX_DECOMPRESSED_IMPORT_BYTES)).buffer;
    }
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const baseName = file.name.replace(/\.(fit|tcx|gpx|kml|geojson|json)(\.gz)?$/i, '');
    if (!result) {
        if (format === 'fit') result = parseFIT(arrayBuffer);
        else result = { gpx: parseGPX, kml: parseKML, tcx: parseTCX, geojson: parseGeoJSON }[format](new TextDecoder().decode(arrayBuffer));
    }
    const tracks = result.tracks || [result];
    const validTracks = tracks.filter(track => track.coordinates.length >= 2);
    if (!validTracks.length) throw new Error('A track needs at least two valid points.');
    routeListBatch = true;
    const added = [];
    try {
        for (const [index, track] of validTracks.entries()) added.push(addImportedRoute(track.name || (validTracks.length > 1 ? `${baseName} ${index + 1}` : baseName), track.coordinates, track.elevations, track));
    } finally { routeListBatch = false; }
    updateRouteMapStyles(); renderRoutesList(); updateBulkButtons();
    saveToStorage(); setMobileView(routesDirty ? 'planner' : 'map'); fitVisibleRoutes();
    const diagnostics = { skippedPoints: 0, skippedTracks: tracks.length - validTracks.length, unsupportedGeometries: 0, ...result.diagnostics };
    showStatus(`Imported ${added.length} track(s) from ${file.name}. ${importWarnings(diagnostics).join(' ')}`.trim());
    return { added, diagnostics };
}

function addImportedRoute(name, coordinates, elevations, metadata = {}) {
    const track = normalizeTrack({ ...metadata, coordinates, elevations });
    const safeCoordinates = track.coordinates;
    if (safeCoordinates.length < 2) throw new Error('A track needs at least two valid points.');

    // Pick a color
    if (availableColorIndices.length === 0) resetColorPool();
    if (availableColorIndices.length === 0) availableColorIndices = COLOR_PALETTE.map((_, i) => i);
    const poolIdx = Math.floor(Math.random() * availableColorIndices.length);
    const colorIndex = availableColorIndices.splice(poolIdx, 1)[0];
    const color = COLOR_PALETTE[colorIndex];

    const routeId = nextRouteId();
    const safeElevations = track.elevations;
    const distance = trackDistance(track);

    const hasElevation = safeElevations && safeElevations.some(e => e !== null);
    const route = {
        ...track,
        source: 'import',
        createdAt: new Date().toISOString(),
        id: routeId,
        name: typeof name === 'string' && name.trim() ? name.trim() : 'Imported route',
        origin: fallbackCoordinateLabel(safeCoordinates[0]),
        destination: fallbackCoordinateLabel(safeCoordinates[safeCoordinates.length - 1]),
        stops: [],
        travelMode: 'IMPORTED',
        color: color,
        coordinates: safeCoordinates,
        elevations: hasElevation ? safeElevations : null,
        distance: Math.round(distance),
        duration: null,
        visible: true,
        elevationStatus: hasElevation ? (safeElevations.every(value => value !== null) ? 'ready' : 'partial') : null
    };

    routes.push(route);
    routeMap.add(route);
    if (!routeListBatch) {
        updateRouteMapStyles(); renderRoutesList(); updateBulkButtons();
        routeMap.fit(route.id);
        saveToStorage();
        showStatus(`Imported: ${route.name} (${safeCoordinates.length} points, ${formatDistance(distance)})`);
    }
    return route;
}

// ============ Keyboard Navigation ============
document.addEventListener('keydown', function (e) {
    if (activeModal || e.defaultPrevented) return;

    // Escape to exit click mode
    if (e.key === 'Escape' && clickMode) {
        exitClickMode();
        return;
    }

    // Ctrl+Enter to get route from anywhere
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        getRoute();
        return;
    }

    // Enter in form fields
    if (e.key === 'Enter' && e.target.matches('input[type="text"]')) {
        e.preventDefault();
        getRoute();
        return;
    }
});

// Debounce function for performance
function debounce(fn, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
}

// Visual feedback for input validation
function updateInputValidation(input) {
    const value = input.value.trim();
    const latLng = parseLatLngInput(value);

    input.classList.remove('valid-coords', 'has-text');

    if (latLng && isValidLatLng(latLng)) {
        input.classList.add('valid-coords');
    } else if (value.length > 0) {
        input.classList.add('has-text');
    }
}

// Update preview markers on input change (debounced for performance)
const debouncedPreviewUpdate = debounce(updatePreviewMarkers, 150);
document.getElementById('origin').addEventListener('input', function () {
    debouncedPreviewUpdate();
    updateInputValidation(this);
    scheduleDraftSave();
});
document.getElementById('destination').addEventListener('input', function () {
    debouncedPreviewUpdate();
    updateInputValidation(this);
    scheduleDraftSave();
});
document.getElementById('stopsContainer').addEventListener('input', function (e) {
    if (!e.target.matches('.stop-input')) return;
    debouncedPreviewUpdate();
    updateInputValidation(e.target);
    updateWaypointHint();
    scheduleDraftSave();
});

// Enter key in origin/destination triggers route
document.getElementById('origin').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        getRoute();
    }
});
document.getElementById('destination').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        getRoute();
    }
});

// ============ Color Presets ============
function getColorLabel(index) {
    return COLOR_PALETTE_LABELS[index] || `Color ${index + 1}`;
}

function getColorOptionButtons() {
    return Array.from(document.querySelectorAll('.color-option'));
}

function initColorPresets() {
    const container = document.getElementById('colorOptions');
    container.innerHTML = COLOR_PALETTE.map((color, idx) => `
    <button type="button" class="color-option route-color-${idx} ${idx === selectedColorIndex ? 'selected' : ''}"
                data-action="select-color" data-color-index="${idx}"
                role="radio"
                aria-checked="${idx === selectedColorIndex}"
                tabindex="${idx === selectedColorIndex ? '0' : '-1'}"
                aria-label="${escapeHtml(getColorLabel(idx))} route color"
                title="${escapeHtml(getColorLabel(idx))}"></button>
    `).join('');

    updateColorSelectionUi();
}

function updateColorSelectionUi(focusSelected = false) {
    // Ensure we have a valid color index
    if (selectedColorIndex < 0 || selectedColorIndex >= COLOR_PALETTE.length) {
        selectedColorIndex = Math.floor(Math.random() * COLOR_PALETTE.length);
    }
    const color = COLOR_PALETTE[selectedColorIndex];
    const label = getColorLabel(selectedColorIndex);
    const swatch = document.getElementById('colorSwatch');
    document.getElementById('routeColor').value = color;

    if (swatch) {
        setElementRouteColorClass(swatch, color, selectedColorIndex);
        swatch.setAttribute('aria-label', `${label} route color selected. Choose route color`);
        swatch.title = `${label} route color`;
    }

    getColorOptionButtons().forEach((button, index) => {
        const isSelected = index === selectedColorIndex;
        button.classList.toggle('selected', isSelected);
        button.setAttribute('aria-checked', String(isSelected));
        button.tabIndex = isSelected ? 0 : -1;
        if (focusSelected && isSelected) button.focus();
    });
}

function openColorPalette(focusSelected = true) {
    const dropdown = document.getElementById('colorDropdown');
    const swatch = document.getElementById('colorSwatch');
    dropdown.classList.add('visible');
    dropdown.setAttribute('aria-hidden', 'false');
    swatch.setAttribute('aria-expanded', 'true');
    if (focusSelected) document.querySelector('.color-option.selected')?.focus();
}

function closeColorPalette(focusSwatch = false) {
    const dropdown = document.getElementById('colorDropdown');
    const swatch = document.getElementById('colorSwatch');
    dropdown.classList.remove('visible');
    dropdown.setAttribute('aria-hidden', 'true');
    swatch.setAttribute('aria-expanded', 'false');
    if (focusSwatch) swatch.focus();
}

function toggleColorPalette(focusSelected = false) {
    const dropdown = document.getElementById('colorDropdown');
    if (dropdown.classList.contains('visible')) {
        closeColorPalette();
    } else {
        openColorPalette(focusSelected);
    }
}

function selectColor(idx, focusSelected = false, closePalette = false) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= COLOR_PALETTE.length) return;

    selectedColorIndex = idx;

    // Remove this color from the available pool if present
    const poolIdx = availableColorIndices.indexOf(idx);
    if (poolIdx > -1) {
        availableColorIndices.splice(poolIdx, 1);
    }

    updateColorSelectionUi(focusSelected);
    if (closePalette) closeColorPalette(true);
}

function moveColorSelection(currentIndex, direction) {
    const nextIndex = (currentIndex + direction + COLOR_PALETTE.length) % COLOR_PALETTE.length;
    selectColor(nextIndex, true);
}

function handleColorPickerKeydown(event) {
    const button = event.target.closest('.color-option');
    if (!button) return;

    const currentIndex = Number(button.dataset.colorIndex);

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveColorSelection(currentIndex, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveColorSelection(currentIndex, -1);
    } else if (event.key === 'Home') {
        event.preventDefault();
        selectColor(0, true);
    } else if (event.key === 'End') {
        event.preventDefault();
        selectColor(COLOR_PALETTE.length - 1, true);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeColorPalette(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectColor(currentIndex, false, true);
    }
}

function handleColorSwatchKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleColorPalette(true);
    }
}

function closeVisibleTooltips() {
    document.querySelectorAll('.tooltip-text.visible').forEach(tooltip => tooltip.classList.remove('visible'));
}

function setupInfoTooltips() {
    document.querySelectorAll('.info-tooltip').forEach(button => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            const tooltip = document.getElementById(button.getAttribute('aria-describedby'));
            const shouldShow = tooltip && !tooltip.classList.contains('visible');
            closeVisibleTooltips();
            if (shouldShow) tooltip.classList.add('visible');
        });
        button.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeVisibleTooltips();
                button.focus();
            }
        });
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('.info-wrapper')) closeVisibleTooltips();
    });
}


function selectRandomColor() {
    // Refill pool if empty
    if (availableColorIndices.length === 0) {
        resetColorPool();
    }

    // Safety check - if pool is still empty, fill with all indices
    if (availableColorIndices.length === 0) {
        availableColorIndices = COLOR_PALETTE.map((_, i) => i);
    }

    // Pick a random index from the available pool and remove it
    const poolIdx = Math.floor(Math.random() * availableColorIndices.length);
    selectedColorIndex = availableColorIndices.splice(poolIdx, 1)[0];

    initColorPresets();
}

document.addEventListener('click', function (event) {
    const wrapper = document.querySelector('.color-picker-wrapper');
    if (wrapper && !wrapper.contains(event.target)) {
        closeColorPalette();
    }
});

// ============ Event Delegation ============
// Handle all data-action clicks via delegation instead of inline handlers
document.addEventListener('click', function (e) {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    const action = actionEl.dataset.action;
    const routeId = actionEl.dataset.routeId ? Number(actionEl.dataset.routeId) : null;

    switch (action) {
        case 'browse-import': document.getElementById('importFileInput').click(); break;
        case 'open-api-key': openApiKeyModal(); break;
        case 'download-all': downloadAllRoutes(); break;
        case 'edit-route': loadRouteIntoPlanner(routeId); break;
        case 'rename-route': openRenameModal(routeId); break;
        case 'retry-elevation': {
            const route = routes.find(item => item.id === routeId);
            if (route) enrichRouteElevations(route, { force: true });
            break;
        }
        case 'cancel-elevation': cancelElevation(routeId); break;
        case 'download-route':
            if (routeId != null) { downloadRoute(routeId); map.closePopup(); }
            break;
        case 'remove-route':
            if (routeId != null) { removeRoute(routeId); map.closePopup(); }
            break;
        case 'toggle-visibility':
            if (routeId != null) toggleRouteVisibility(routeId);
            break;
        case 'remove-stop':
            removeStop(actionEl);
            break;
        case 'move-stop-up':
            moveStop(actionEl, -1);
            break;
        case 'move-stop-down':
            moveStop(actionEl, 1);
            break;
        case 'move-origin-down':
            moveEndpoint('origin', 1);
            break;
        case 'move-destination-up':
            moveEndpoint('destination', -1);
            break;
        case 'select-color':
            selectColor(Number(actionEl.dataset.colorIndex), false, true);
            break;
        case 'confirm-map-click-prompt':
            confirmMapClickPrompt();
            break;
        case 'cancel-map-click-prompt':
            cancelMapClickPrompt();
            break;
    }
});

// Handle route-item clicks and hover via delegation on routesList
const routesList = document.getElementById('routesList');
routesList.addEventListener('click', function (e) {
    // If click is on an action button, let the data-action handler above deal with it
    if (e.target.closest('[data-action]')) return;
    // Stop propagation container
    if (e.target.closest('.route-item-actions')) return;

    const item = e.target.closest('.route-item');
    if (item) {
        const id = Number(item.dataset.routeId);
        zoomToRoute(id);
    }
});

routesList.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.target.closest('button, input, a')) {
        e.preventDefault();
        const item = e.target.closest('.route-item');
        if (item) {
            zoomToRoute(Number(item.dataset.routeId));
        }
    }
});

routesList.addEventListener('mouseenter', function (e) {
    const item = e.target.closest('.route-item');
    if (item) highlightRouteById(Number(item.dataset.routeId));
}, true);

routesList.addEventListener('mouseleave', function (e) {
    const item = e.target.closest('.route-item');
    if (item) unhighlightRouteById(Number(item.dataset.routeId));
}, true);

// ============ Sidebar Button Bindings ============
document.querySelector('.help-toggle').addEventListener('click', toggleHelp);

document.querySelectorAll('[data-gps-field]').forEach(btn => {
    btn.addEventListener('click', () => useMyLocation(btn.dataset.gpsField));
});

document.getElementById('addStopBtn').addEventListener('click', () => addStop());
document.getElementById('reverseRouteBtn').addEventListener('click', reverseRoute);
document.getElementById('colorSwatch').addEventListener('click', () => toggleColorPalette(false));
document.getElementById('colorSwatch').addEventListener('keydown', handleColorSwatchKeydown);
document.getElementById('colorOptions').addEventListener('keydown', handleColorPickerKeydown);
document.getElementById('unitKm').addEventListener('click', () => setUnit('km'));
document.getElementById('unitMi').addEventListener('click', () => setUnit('mi'));
document.getElementById('getRouteBtn').addEventListener('click', getRoute);
document.getElementById('cancelRouteBtn')?.addEventListener('click', cancelRouteRequest);
document.getElementById('cancelImportBtn')?.addEventListener('click', () => importController?.abort());
document.getElementById('departureTime')?.addEventListener('change', scheduleDraftSave);
document.getElementById('labelCoordinates')?.addEventListener('change', scheduleDraftSave);
document.getElementById('fetchElevation')?.addEventListener('change', scheduleDraftSave);
window.addEventListener('pagehide', saveDraft);
document.getElementById('downloadAllBtn').addEventListener('click', downloadAllRoutes);
document.getElementById('clearAllBtn').addEventListener('click', clearAllRoutes);
document.getElementById('undoDeleteBtn')?.addEventListener('click', undoDelete);
document.getElementById('cancelRenameBtn')?.addEventListener('click', closeRenameModal);
document.getElementById('confirmRenameBtn')?.addEventListener('click', confirmRename);
document.getElementById('renameInput')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); confirmRename(); } });
document.getElementById('renameModal')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeRenameModal(); });
document.querySelectorAll('button[data-mobile-view]').forEach(button => button.addEventListener('click', () => setMobileView(button.dataset.mobileView)));
for (const [id, unit] of [['unitKm', 'km'], ['unitMi', 'mi']]) {
    document.getElementById(id).addEventListener('keydown', event => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 'km' : event.key === 'End' ? 'mi' : unit === 'km' ? 'mi' : 'km';
            setUnit(next); document.getElementById(next === 'km' ? 'unitKm' : 'unitMi').focus();
        }
    });
}
document.getElementById('apiKeyMapBtn').addEventListener('click', openApiKeyModal);
document.getElementById('clickModeBtn').addEventListener('click', toggleClickMode);
document.getElementById('cancelClickModeBtn')?.addEventListener('click', exitClickMode);
document.getElementById('locateMeBtn').addEventListener('click', locateMe);
document.getElementById('closeModalBtn').addEventListener('click', closeApiKeyModal);
document.getElementById('saveApiKeyBtn').addEventListener('click', saveApiKey);
document.getElementById('removeApiKeyBtn')?.addEventListener('click', () => {
    removeStorageItem('localStorage', API_KEY_STORAGE_KEY);
    removeStorageItem('sessionStorage', API_KEY_MEMORY_KEY);
    updateApiKeyStatus(); closeApiKeyModal(); showStatus('Saved API key removed from this browser.');
});
document.getElementById('rememberApiKey')?.addEventListener('change', updateApiKeyStorageHint);
document.getElementById('cancelFilenameBtn').addEventListener('click', closeFilenameModal);
document.getElementById('confirmFilenameBtn').addEventListener('click', confirmFilenameDownload);
document.querySelectorAll('[data-map-pick-target]').forEach(btn => {
    btn.addEventListener('click', () => {
        const target = btn.dataset.mapPickTarget;
        const flow = btn.dataset.mapPickFlow || 'single';
        if (clickMode === target && clickModeFlow === flow) {
            exitClickMode();
            return;
        }
        enterClickMode(target, flow);
    });
});

function exposeAppCompatGlobals() {
    Object.assign(globalThis, {
        addStop,
        assertFileSize,
        buildRouteName,
        closeApiKeyModal,
        confirmMapClickPrompt,
        decodePolyline,
        detectImportFormat,
        enterClickMode,
        escapeHtml,
        escapeXml,
        exitClickMode,
        fetchElevations,
        formatDistance,
        formatDuration,
        formatFileSize,
        generateGPX,
        getApiKey,
        getModeIconName,
        getModeIconSvg,
        getPaletteColorIndex,
        getReverseGeocodeDisplayName,
        getRouteColorClass,
        getValidatedPositionLatLng,
        getRoute,
        getStops,
        handleSingleImportFile,
        haversineDistance,
        iconSvg,
        isValidLatLng,
        looksLikeCoordinatePair,
        moveEndpoint,
        moveStop,
        openApiKeyModal,
        openFilenameModal,
        parseGeoJSON,
        parseFIT,
        parseLocation,
        parseTCX,
        renderIconPlaceholders,
        resetColorPool,
        resolveRouteEndpointLabel,
        restoreRoute,
        sanitizeColor,
        sanitizeFilename,
        saveApiKey,
        saveToStorage,
        selectColor,
        selectRandomColor,
        selectTravelMode,
        setUnit,
        setupGlobalFileDropGuard,
        showStatus,
        truncate,
        updateInputValidation,
        useMyLocation,
        ensureJSZip,
        ensurePako,
    });

    Object.defineProperties(globalThis, {
        distanceUnit: {
            configurable: true,
            get: () => distanceUnit,
            set: value => { distanceUnit = value; },
        },
        routes: {
            configurable: true,
            get: () => routes,
            set: value => { if (Array.isArray(value)) routes = value; },
        },
        map: {
            configurable: true,
            get: () => map,
        },
    });
}

// ============ Initialize ============
exposeAppCompatGlobals();
renderIconPlaceholders();
setupTravelModeToggle();
selectRandomColor(); // Pick initial random color
setupInfoTooltips();
setupImport();
setupFogOfWorld({ map, showStatus, assertFileSize, ensureJSZip, ensurePako, setupGlobalFileDropGuard });
loadFromStorage();
loadDraft();
renderRoutesList();
updateApiKeyStatus();


export {
    addStop,
    assertFileSize,
    buildRouteName,
    closeApiKeyModal,
    confirmMapClickPrompt,
    decodePolyline,
    detectImportFormat,
    enterClickMode,
    escapeHtml,
    escapeXml,
    exitClickMode,
    fetchElevations,
    formatDistance,
    formatDuration,
    formatFileSize,
    generateGPX,
    getApiKey,
    getReverseGeocodeDisplayName,
    getRoute,
    getPaletteColorIndex,
    getRouteColorClass,
    getValidatedPositionLatLng,
    getStops,
    handleSingleImportFile,
    haversineDistance,
    isValidLatLng,
    looksLikeCoordinatePair,
    moveEndpoint,
    moveStop,
    openApiKeyModal,
    openFilenameModal,
    parseLocation,
    resetColorPool,
    resolveRouteEndpointLabel,
    restoreRoute,
    sanitizeColor,
    sanitizeFilename,
    saveApiKey,
    saveToStorage,
    selectColor,
    selectRandomColor,
    selectTravelMode,
    setUnit,
    showStatus,
    truncate,
    updateInputValidation,
    useMyLocation,
};
