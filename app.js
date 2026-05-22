import { parseFIT, parseTCX, parseGeoJSON } from './parsers.js';
import { setupFogOfWorld } from './fog.js';
import { iconSvg, getModeIconName, getModeIconSvg, renderIconPlaceholders } from './icons.js';

// ============ State ============
let routes = [];
let clickMode = null; // null, 'origin', 'destination', 'waypoint'
let clickModeFlow = 'single'; // 'single' or 'route'
let distanceUnit = 'km';
let previewMarkers = [];
let activeModal = null;
let activeModalReturnFocus = null;
let statusTimer = null;
let pendingMapClickPrompt = null;
let activeRoutePopup = null;
let suppressNextMapClickForPopup = false;
let storageWarningShown = false;
let geolocationRequestId = 0;

const API_KEY_STORAGE_KEY = 'route2gpx_apiKey';
const API_KEY_MEMORY_KEY = 'route2gpx_apiKey_session';
const ROUTES_STORAGE_KEY = 'route2gpx_routes';
const UNIT_STORAGE_KEY = 'route2gpx_unit';
const ROUTE_REQUEST_TIMEOUT_MS = 30000;
const ELEVATION_REQUEST_TIMEOUT_MS = 20000;
const REVERSE_GEOCODE_REQUEST_TIMEOUT_MS = 8000;
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_IMPORT_BYTES = 120 * 1024 * 1024;
const ROUTE_LINE_WEIGHT = 4;
const ROUTE_LINE_OPACITY = 0.8;
const OLDER_ROUTE_LINE_OPACITY = 0.56;
const HIGHLIGHT_ROUTE_LINE_WEIGHT = 7;
const HIGHLIGHT_ROUTE_LINE_OPACITY = 1;
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
        src: 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
        integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG'
    },
    pako: {
        globalName: 'pako',
        src: 'https://unpkg.com/pako@2.1.0/dist/pako.min.js',
        integrity: 'sha384-rNlaE5fs9dGIjmxWDALQh/RBAaGRYT5ChrzHo6tRfgrZ36iRFAiquP5g41Jsv+0j'
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
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
    subdomains: 'abcd'
}).addTo(map);

// ============ LocalStorage ============
function loadFromStorage() {
    try {
        // Distance unit
        const savedUnit = localStorage.getItem(UNIT_STORAGE_KEY);
        if (savedUnit) {
            setUnit(savedUnit, false);
        }

        // Saved routes
        const savedRoutes = localStorage.getItem(ROUTES_STORAGE_KEY);
        if (savedRoutes) {
            const routeData = JSON.parse(savedRoutes);
            if (!Array.isArray(routeData)) throw new Error('Saved routes payload is not an array');
            let restoredCount = 0;
            routeData.forEach(data => {
                if (restoreRoute(data)) restoredCount++;
            });
            updateBulkButtons();
            if (restoredCount > 0) {
                showStatus(`Restored ${restoredCount} route(s) from previous session`);
            }
        }
    } catch (error) {
        console.error('Failed to restore from storage:', error.message);
    }
}

function saveToStorage() {
    try {
        // Distance unit
        localStorage.setItem(UNIT_STORAGE_KEY, distanceUnit);

        // Routes (without Leaflet objects)
        const routeData = routes.map(r => ({
            id: r.id,
            name: r.name,
            origin: r.origin,
            destination: r.destination,
            stops: normalizeStops(r.stops),
            travelMode: r.travelMode,
            color: r.color,
            coordinates: r.coordinates,
            elevations: r.elevations || null,
            distance: r.distance,
            duration: r.duration,
            visible: r.visible !== false
        }));
        localStorage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(routeData));
        storageWarningShown = false;
    } catch (error) {
        notifyStorageFailure(error);
    }
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
        script.src = scriptConfig.src;
        script.integrity = scriptConfig.integrity;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.onload = () => resolve(window[scriptConfig.globalName]);
        script.onerror = () => reject(new Error(`Failed to load ${scriptConfig.globalName}`));
        document.head.appendChild(script);
    });

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
    const gpxContent = generateGPX(route);
    const fileSize = formatFileSize(new Blob([gpxContent]).size);
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
                <span>${iconSvg('file-down', 'icon-sm')} ${fileSize}</span>
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

function bindRoutePopup(polylineLayer, route) {
    const popup = L.popup({ closeButton: true, className: 'route-popup-container' })
        .setContent(() => createRoutePopup(route));
    popup.route2gpxPopupType = 'route';

    polylineLayer.bindPopup(popup);

    // Right-click also opens the popup
    polylineLayer.on('contextmenu', function (e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        this.openPopup(e.latlng);
    });
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

function bindRouteHoverEffects(route) {
    const { polylineLayer, markers, name, origin, destination } = route;

    // Tooltip for polyline (route name)
    polylineLayer.bindTooltip(escapeHtml(name), {
        sticky: true,
        className: 'route-tooltip'
    });

    // Tooltip for start marker (origin)
    if (markers[0]) {
        markers[0].bindTooltip(`Start: ${escapeHtml(origin)}`, {
            className: 'route-tooltip'
        });
    }

    // Tooltip for end marker (destination)
    if (markers[1]) {
        markers[1].bindTooltip(`End: ${escapeHtml(destination)}`, {
            className: 'route-tooltip'
        });
    }

    // Hover highlight function
    const highlightRoute = () => {
        polylineLayer.setStyle({ weight: HIGHLIGHT_ROUTE_LINE_WEIGHT, opacity: HIGHLIGHT_ROUTE_LINE_OPACITY });
        markers.forEach(m => {
            if (m._icon) m._icon.classList.add('marker-highlighted');
        });
        // Highlight sidebar item
        const sidebarItem = document.querySelector(`[data-route-id="${route.id}"]`);
        if (sidebarItem) {
            sidebarItem.classList.add('highlighted');
            scrollRouteItemIntoViewIfNeeded(sidebarItem);
        }
    };

    const unhighlightRoute = () => {
        applyRouteMapStyle(route);
        markers.forEach(m => {
            if (m._icon) m._icon.classList.remove('marker-highlighted');
        });
        // Unhighlight sidebar item
        const sidebarItem = document.querySelector(`[data-route-id="${route.id}"]`);
        if (sidebarItem) sidebarItem.classList.remove('highlighted');
    };

    // Store highlight functions on route for sidebar to use
    route.highlight = highlightRoute;
    route.unhighlight = unhighlightRoute;

    // Bind hover events to polyline
    polylineLayer.on('mouseover', highlightRoute);
    polylineLayer.on('mouseout', unhighlightRoute);

    // Bind hover events to markers
    markers.forEach(marker => {
        marker.on('mouseover', highlightRoute);
        marker.on('mouseout', unhighlightRoute);
    });
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

function normalizeCoordinate(coordinate) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
    const latitude = Number(coordinate[0]);
    const longitude = Number(coordinate[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (!isValidLatLng({ latitude, longitude })) return null;
    return [latitude, longitude];
}

function normalizeCoordinates(coordinates) {
    if (!Array.isArray(coordinates)) return [];
    return coordinates.map(normalizeCoordinate).filter(Boolean);
}

function normalizeElevations(elevations, coordinateCount) {
    if (!Array.isArray(elevations)) return null;
    const normalized = Array.from({ length: coordinateCount }, (_, index) => {
        const elevation = Number(elevations[index]);
        return Number.isFinite(elevation) ? elevation : null;
    });
    return normalized.some(elevation => elevation !== null) ? normalized : null;
}

function fallbackCoordinateLabel(coordinate) {
    return `${coordinate[0].toFixed(4)}, ${coordinate[1].toFixed(4)}`;
}

function calculateRouteDistance(coordinates) {
    let distance = 0;
    for (let index = 1; index < coordinates.length; index++) {
        distance += haversineDistance(coordinates[index - 1], coordinates[index]);
    }
    return distance;
}

function normalizeStoredRoute(data) {
    if (!data || typeof data !== 'object') return null;

    const coordinates = normalizeCoordinates(data.coordinates);
    if (coordinates.length < 2) return null;

    const fallbackIndex = routes.length;
    const id = Number(data.id);
    const distance = Number(data.distance);
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Saved route';
    const origin = typeof data.origin === 'string' && data.origin.trim() ? data.origin.trim() : fallbackCoordinateLabel(coordinates[0]);
    const destination = typeof data.destination === 'string' && data.destination.trim()
        ? data.destination.trim()
        : fallbackCoordinateLabel(coordinates[coordinates.length - 1]);
    const travelMode = typeof data.travelMode === 'string' && data.travelMode.trim() ? data.travelMode.trim() : 'DRIVE';
    const elevations = normalizeElevations(data.elevations, coordinates.length);

    return {
        id: Number.isFinite(id) ? id : Date.now() + fallbackIndex,
        name,
        origin,
        destination,
        stops: normalizeStops(data.stops),
        travelMode,
        color: normalizeRouteColor(data.color, fallbackIndex),
        coordinates,
        elevations,
        distance: Number.isFinite(distance) && distance >= 0 ? distance : Math.round(calculateRouteDistance(coordinates)),
        duration: typeof data.duration === 'string' ? data.duration : null,
        visible: data.visible !== false,
        elevationStatus: elevations ? 'ready' : null,
    };
}

function restoreRoute(data) {
    const restoredData = normalizeStoredRoute(data);
    if (!restoredData) {
        console.warn('Skipping saved route with invalid coordinates');
        return false;
    }

    const polylineLayer = L.polyline(restoredData.coordinates, {
        color: restoredData.color,
        weight: ROUTE_LINE_WEIGHT,
        opacity: ROUTE_LINE_OPACITY
    }).addTo(map);

    const markers = createRouteMarkers(restoredData.coordinates, restoredData.color);

    const route = {
        ...restoredData,
        polylineLayer,
        markers
    };
    routes.push(route);

    if (!route.visible) {
        map.removeLayer(polylineLayer);
        markers.forEach(marker => map.removeLayer(marker));
    }

    // Bind popup after route is in array
    bindRoutePopup(polylineLayer, route);
    bindRouteHoverEffects(route);
    updateRouteMapStyles();

    renderRoutesList();
    return true;
}

// ============ Custom Markers ============
function isNewestRoute(route) {
    return routes[routes.length - 1] === route;
}

function getRouteLineStyle(route) {
    return {
        weight: ROUTE_LINE_WEIGHT,
        opacity: isNewestRoute(route) ? ROUTE_LINE_OPACITY : OLDER_ROUTE_LINE_OPACITY
    };
}

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

function applyRouteMapStyle(route) {
    route.polylineLayer.setStyle(getRouteLineStyle(route));
    route.markers.forEach((marker, index) => {
        if (typeof marker.setIcon !== 'function') return;
        marker.setIcon(createEndpointMarkerIcon(index === 0 ? 'start' : 'end', route.color, isNewestRoute(route)));
    });
}

function updateRouteMapStyles() {
    routes.forEach(applyRouteMapStyle);
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

function createRouteMarkers(coordinates, color) {
    const markers = [];

    // Start marker
    const startMarker = L.marker(coordinates[0], {
        icon: createMarkerIcon('start', color)
    }).addTo(map);
    markers.push(startMarker);

    // End marker
    const endMarker = L.marker(coordinates[coordinates.length - 1], {
        icon: createMarkerIcon('end', color)
    }).addTo(map);
    markers.push(endMarker);

    return markers;
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

function updatePreviewMarkers() {
    // Clear existing preview markers
    previewMarkers.forEach(m => map.removeLayer(m));
    previewMarkers = [];

    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    const stops = getStops();
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
    clickMode = target;
    clickModeFlow = flow;
    updateClickModeUi();
}

function exitClickMode() {
    clickMode = null;
    clickModeFlow = 'single';
    updateClickModeUi();
}

function setMapPickValue(target, latLng) {
    if (target === 'origin') {
        const input = document.getElementById('origin');
        input.value = latLng;
        updateInputValidation(input);
    } else if (target === 'destination') {
        const input = document.getElementById('destination');
        input.value = latLng;
        updateInputValidation(input);
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
    app.inert = isInert;
    if (isInert) {
        app.setAttribute('aria-hidden', 'true');
    } else {
        app.removeAttribute('aria-hidden');
    }
}

function openModal(modal, initialFocusElement) {
    activeModal = modal;
    activeModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
        activeModalReturnFocus = null;
    }
}

function handleModalKeydown(event) {
    if (!activeModal) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        if (activeModal.id === 'apiKeyModal') closeApiKeyModal();
        else if (activeModal.id === 'filenameModal') closeFilenameModal();
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
    return getStorageItem(sessionStorage, API_KEY_MEMORY_KEY) || getStorageItem(localStorage, API_KEY_STORAGE_KEY);
}

function isApiKeyRemembered() {
    return Boolean(getStorageItem(localStorage, API_KEY_STORAGE_KEY));
}

function getStorageItem(storage, key) {
    try {
        return storage.getItem(key) || '';
    } catch {
        return '';
    }
}

function removeStorageItem(storage, key) {
    try {
        storage.removeItem(key);
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

function checkApiKeyOnLoad() {
    if (!getApiKey()) {
        openApiKeyModal();
    }
}

function openApiKeyModal() {
    const modal = document.getElementById('apiKeyModal');
    const input = document.getElementById('apiKeyInput');
    const rememberInput = document.getElementById('rememberApiKey');
    input.value = getApiKey();
    if (rememberInput) rememberInput.checked = isApiKeyRemembered();
    updateApiKeyStorageHint();
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
                removeStorageItem(sessionStorage, API_KEY_MEMORY_KEY);
                showStatus('API key saved on this browser');
            } else {
                sessionStorage.setItem(API_KEY_MEMORY_KEY, key);
                removeStorageItem(localStorage, API_KEY_STORAGE_KEY);
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
                removeStorageItem(localStorage, API_KEY_STORAGE_KEY);
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

function clearApiKey() {
    removeStorageItem(localStorage, API_KEY_STORAGE_KEY);
    removeStorageItem(sessionStorage, API_KEY_MEMORY_KEY);
    updateApiKeyStatus();
    openApiKeyModal();
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
    const latitude = Number(position?.coords?.latitude);
    const longitude = Number(position?.coords?.longitude);
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

    const requestId = ++geolocationRequestId;
    showStatus('Getting your location...');
    navigator.geolocation.getCurrentPosition(
        (position) => {
            if (requestId !== geolocationRequestId) return;
            const latLngPosition = getValidatedPositionLatLng(position);
            if (!latLngPosition) {
                showStatus('Unable to use the reported location coordinates', true);
                return;
            }
            const { latitude, longitude } = latLngPosition;
            const latLng = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
            const input = document.getElementById(field);
            input.value = latLng;
            updateInputValidation(input);
            updatePreviewMarkers();
            showStatus('Location set');
        },
        (error) => {
            if (requestId !== geolocationRequestId) return;
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
    originInput.value = routePoints[0];
    destInput.value = routePoints[routePoints.length - 1];
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
    originInput.value = destInput.value;
    destInput.value = temp;

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
    distanceUnit = unit;
    document.getElementById('unitKm').classList.toggle('active', unit === 'km');
    document.getElementById('unitMi').classList.toggle('active', unit === 'mi');
    document.getElementById('unitKm').setAttribute('aria-checked', unit === 'km');
    document.getElementById('unitMi').setAttribute('aria-checked', unit === 'mi');

    renderRoutesList();
    if (save) saveToStorage();
}

// ============ Status Messages ============
function showStatus(message, isError = false) {
    const status = document.getElementById('status');
    clearTimeout(statusTimer);
    status.textContent = message;
    status.className = 'status ' + (isError ? 'error' : 'success');
    status.hidden = false;

    statusTimer = setTimeout(() => { status.hidden = true; }, isError ? 9000 : 4000);
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
        const response = await fetchWithTimeout(url.toString(), {}, REVERSE_GEOCODE_REQUEST_TIMEOUT_MS);
        if (!response.ok) return '';
        const data = await response.json();
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

async function fetchWithTimeout(url, options = {}, timeoutMs = ROUTE_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Network request timed out. Please try again.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ============ Get Route from API ============
async function getRoute() {
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
        document.querySelectorAll('.stop-input')[invalidStopIndex]?.focus();
        return;
    }

    const btn = document.getElementById('getRouteBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Finding route...';

    try {
        const payload = {
            origin: parseLocation(origin),
            destination: parseLocation(destination),
            travelMode: travelMode,
            polylineQuality: 'HIGH_QUALITY'
        };

        if (stops.length > 0) {
            payload.intermediates = stops.map(stop => parseLocation(stop));
        }

        const response = await fetchWithTimeout('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'routes.polyline,routes.distanceMeters,routes.duration'
            },
            body: JSON.stringify(payload)
        }, ROUTE_REQUEST_TIMEOUT_MS);

        const data = await response.json();

        if (!response.ok) {
            const errorMsg = data.error?.message || 'API request failed';
            if (errorMsg.includes('API key') || response.status === 403 || response.status === 401) {
                clearApiKey();
                throw new Error('Invalid API key. Please check your Google Routes API key.');
            } else if (response.status === 429) {
                throw new Error('Rate limited. Please wait a moment and try again.');
            }
            throw new Error(errorMsg);
        }

        if (!data.routes || data.routes.length === 0) {
            throw new Error('No route found between these locations. Try different addresses or travel mode.');
        }

        const encodedPolyline = data.routes[0].polyline.encodedPolyline;
        const coordinates = decodePolyline(encodedPolyline);
        if (coordinates.length < 2) {
            throw new Error('Route geometry was missing or invalid. Please try again.');
        }
        const distance = data.routes[0].distanceMeters;
        const duration = data.routes[0].duration;

        // Generate route name (always auto-generated from origin → destination)
        const routeId = Date.now();
        const routeLabels = await resolveRouteEndpointLabels(origin, destination, apiKey);
        const routeName = buildRouteName(routeLabels.originLabel, routeLabels.destinationLabel);

        // Create polyline
        const polylineLayer = L.polyline(coordinates, {
            color: color,
            weight: ROUTE_LINE_WEIGHT,
            opacity: ROUTE_LINE_OPACITY
        }).addTo(map);

        // Create markers
        const markers = createRouteMarkers(coordinates, color);

        // Fit map
        map.fitBounds(polylineLayer.getBounds(), { padding: [50, 50] });

        // Store route
        const route = {
            id: routeId,
            name: routeName,
            origin: routeLabels.originLabel,
            destination: routeLabels.destinationLabel,
            stops: [...stops],
            travelMode,
            color,
            coordinates,
            polylineLayer,
            markers,
            distance,
            duration,
            visible: true,
            elevationStatus: 'loading'
        };
        routes.push(route);
        updateRouteMapStyles();

        // Bind popup for click/right-click
        bindRoutePopup(polylineLayer, route);
        bindRouteHoverEffects(route);

        // Clear preview markers
        previewMarkers.forEach(m => map.removeLayer(m));
        previewMarkers = [];

        // Update UI
        renderRoutesList();
        updateBulkButtons();
        saveToStorage();
        showStatus(`Route added: ${formatDistance(distance)}, ${formatDuration(duration)}. Edit, add, or reorder points to create another route.`);
        exitClickMode();

        // Pick a random color for the next route
        selectRandomColor();

        // Fetch elevation data in the background
        enrichRouteElevations(route).then(() => {
            if (route.elevations && route.elevations.some(e => e !== null)) {
                showStatus(`Elevation data added for: ${route.name}`);
            }
            renderRoutesList();
        });

    } catch (error) {
        showStatus(error.message, true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Get Route';
    }
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

function escapeXml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function sanitizeFilename(s) {
    return s.replace(/[^a-zA-Z0-9_\-\s]/g, '_').substring(0, 50);
}

// ============ Route List Rendering ============
function renderRoutesList() {
    const list = document.getElementById('routesList');

    if (routes.length === 0) {
        list.innerHTML = `
            <div class="routes-empty-state">
                <div class="routes-empty-state-icon">${iconSvg('map', 'empty-state-icon')}</div>
                <div class="routes-empty-state-title">No routes yet</div>
                <div class="routes-empty-state-copy">Enter an origin and destination, then press Enter</div>
            </div>
        `;
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
}

function getElevationStatusText(route) {
    if (route.elevationStatus === 'loading') return 'adding elevation';
    if (route.elevationStatus === 'ready') return 'elevation ready';
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
    const route = routes.find(r => r.id === id);
    if (route) {
        // Ensure route is visible
        if (!route.visible) {
            route.visible = true;
            route.polylineLayer.addTo(map);
            route.markers.forEach(m => m.addTo(map));
            renderRoutesList();
            saveToStorage();
        }

        map.fitBounds(route.polylineLayer.getBounds(), { padding: [50, 50] });

        // Open popup at the center of the route
        const center = route.polylineLayer.getCenter();
        route.polylineLayer.openPopup(center);
    }
}

function highlightRouteById(id) {
    const route = routes.find(r => r.id === id);
    if (route && route.highlight) {
        route.highlight();
    }
}

function unhighlightRouteById(id) {
    const route = routes.find(r => r.id === id);
    if (route && route.unhighlight) {
        route.unhighlight();
    }
}

function toggleRouteVisibility(id) {
    const route = routes.find(r => r.id === id);
    if (route) {
        route.visible = !route.visible;
        if (route.visible) {
            route.polylineLayer.addTo(map);
            route.markers.forEach(m => m.addTo(map));
        } else {
            route.polylineLayer.closeTooltip();
            route.markers.forEach(m => m.closeTooltip());
            map.removeLayer(route.polylineLayer);
            route.markers.forEach(m => map.removeLayer(m));
        }
        renderRoutesList();
        saveToStorage();
    }
}

function removeRoute(id) {
    const index = routes.findIndex(r => r.id === id);
    if (index !== -1) {
        routes[index].polylineLayer.closeTooltip();
        routes[index].markers.forEach(m => m.closeTooltip());
        map.removeLayer(routes[index].polylineLayer);
        routes[index].markers.forEach(m => map.removeLayer(m));
        routes.splice(index, 1);
        updateRouteMapStyles();
        renderRoutesList();
        updateBulkButtons();
        saveToStorage();
    }
}

function clearAllRoutes() {
    if (!confirm('Remove all routes? This cannot be undone.')) return;
    routes.forEach(route => {
        route.polylineLayer.closeTooltip();
        route.markers.forEach(m => m.closeTooltip());
        map.removeLayer(route.polylineLayer);
        route.markers.forEach(m => map.removeLayer(m));
    });
    routes = [];
    renderRoutesList();
    updateBulkButtons();
    saveToStorage();
}

// ============ GPX Generation ============
function generateGPX(route) {
    const now = new Date();
    const coords = route.coordinates;
    const stops = normalizeStops(route.stops);

    // Calculate bounds
    let minlat = Infinity, maxlat = -Infinity, minlon = Infinity, maxlon = -Infinity;
    for (const [lat, lng] of coords) {
        if (lat < minlat) minlat = lat;
        if (lat > maxlat) maxlat = lat;
        if (lng < minlon) minlon = lng;
        if (lng > maxlon) maxlon = lng;
    }
    const bounds = {
        minlat: minlat.toFixed(6),
        maxlat: maxlat.toFixed(6),
        minlon: minlon.toFixed(6),
        maxlon: maxlon.toFixed(6)
    };

    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="route2gpx-web" xmlns="http://www.topografix.com/GPX/1/1">',
        '  <metadata>',
        `    <name>${escapeXml(route.name)}</name>`,
        `    <desc>Route from ${escapeXml(route.origin)} to ${escapeXml(route.destination)} via ${route.travelMode.toLowerCase()}${formatStopDescription(stops)}</desc>`,
        `    <time>${now.toISOString()}</time>`,
        `    <bounds minlat="${bounds.minlat}" minlon="${bounds.minlon}" maxlat="${bounds.maxlat}" maxlon="${bounds.maxlon}"/>`,
        '  </metadata>'
    ];

    // Add waypoints for origin, stops, and destination
    appendWaypoint(lines, coords[0], `Start: ${route.origin}`);

    stops.forEach((stop, idx) => {
        const latLng = parseLatLngInput(stop);
        if (!latLng || !isValidLatLng(latLng)) return;
        appendWaypoint(lines, [latLng.latitude, latLng.longitude], `Stop ${idx + 1}: ${stop}`);
    });

    appendWaypoint(lines, coords[coords.length - 1], `End: ${route.destination}`);

    // Add track
    lines.push('  <trk>');
    lines.push(`    <name>${escapeXml(route.name)}</name>`);
    lines.push(`    <type>${escapeXml(route.travelMode)}</type>`);
    lines.push('    <trkseg>');

    const durationSeconds = parseInt(route.duration?.replace('s', ''), 10) || coords.length * 60;
    const intervalMs = (durationSeconds * 1000) / Math.max(coords.length - 1, 1);

    coords.forEach(([lat, lng], idx) => {
        const time = new Date(now.getTime() + idx * intervalMs).toISOString();
        const ele = (route.elevations && route.elevations[idx] != null) ? route.elevations[idx] : 0;
        lines.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`);
        lines.push(`        <ele>${ele}</ele>`);
        lines.push(`        <time>${time}</time>`);
        lines.push('      </trkpt>');
    });

    lines.push('    </trkseg>');
    lines.push('  </trk>');
    lines.push('</gpx>');

    return lines.join('\n');
}

function formatStopDescription(stops) {
    return stops.length > 0 ? `. Stops: ${stops.map(escapeXml).join(', ')}` : '';
}

function appendWaypoint(lines, [lat, lng], name) {
    lines.push(`  <wpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`);
    lines.push(`    <name>${escapeXml(name)}</name>`);
    lines.push('  </wpt>');
}

// ============ Filename Confirmation Modal ============
let pendingDownload = null; // { routeId, gpxContent, defaultFilename }

function openFilenameModal(routeId, gpxContent, defaultFilename) {
    pendingDownload = { routeId, gpxContent, defaultFilename };
    const modal = document.getElementById('filenameModal');
    const input = document.getElementById('filenameInput');
    const preview = document.getElementById('filenamePreview');
    input.value = defaultFilename;
    preview.textContent = defaultFilename;
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
    downloadFile(pendingDownload.gpxContent, filename, 'application/gpx+xml');
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

    const gpx = generateGPX(route);
    const filename = `${sanitizeFilename(route.travelMode.toLowerCase())}_${sanitizeFilename(route.name)}.gpx`;
    openFilenameModal(id, gpx, filename);
}

async function downloadAllRoutes() {
    if (routes.length === 0) return;

    if (routes.length === 1) {
        downloadRoute(routes[0].id);
        return;
    }

    // Batch download as ZIP
    try {
        await ensureJSZip();
        const zip = new JSZip();
        routes.forEach(route => {
            const gpx = generateGPX(route);
            const filename = `${sanitizeFilename(route.travelMode.toLowerCase())}_${sanitizeFilename(route.name)}.gpx`;
            zip.file(filename, gpx);
        });
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'routes.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showStatus(`Downloaded ${routes.length} routes as ZIP`);
    } catch (error) {
        console.warn('ZIP download unavailable, falling back to sequential GPX downloads:', error.message);
        // Fallback: sequential downloads
        routes.forEach((route, idx) => {
            setTimeout(() => {
                const gpx = generateGPX(route);
                const filename = `${sanitizeFilename(route.travelMode.toLowerCase())}_${sanitizeFilename(route.name)}.gpx`;
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
    URL.revokeObjectURL(url);
}

// ============ Elevation Data (Open-Topo-Data) ============
async function fetchElevations(coordinates) {
    // Open-Topo-Data allows up to 100 points per request
    const BATCH_SIZE = 100;
    const elevations = new Array(coordinates.length).fill(null);

    for (let i = 0; i < coordinates.length; i += BATCH_SIZE) {
        const batch = coordinates.slice(i, i + BATCH_SIZE);
        const locations = batch.map(([lat, lng]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join('|');

        try {
            const response = await fetchWithTimeout(
                `/api/elevation/v1/srtm90m?locations=${encodeURIComponent(locations)}`,
                {},
                ELEVATION_REQUEST_TIMEOUT_MS
            );
            if (!response.ok) throw new Error(`Elevation API error: ${response.status}`);

            const data = await response.json();
            if (data.status === 'OK' && Array.isArray(data.results)) {
                data.results.forEach((result, idx) => {
                    if (idx >= batch.length) return;
                    elevations[i + idx] = Number.isFinite(result?.elevation) ? result.elevation : null;
                });
            }
        } catch (e) {
            console.warn('Elevation fetch failed for batch:', e.message);
            // Leave as null, GPX will use 0 as fallback
        }

        // Rate limit: 1 request per second for the free API
        if (i + BATCH_SIZE < coordinates.length) {
            await new Promise(resolve => setTimeout(resolve, 1100));
        }
    }

    return elevations;
}

async function enrichRouteElevations(route) {
    if (route.elevations && route.elevations.some(e => e !== null)) return; // Already fetched

    try {
        route.elevationStatus = 'loading';
        renderRoutesList();
        route.elevations = await fetchElevations(route.coordinates);
        route.elevationStatus = route.elevations.some(elevation => elevation !== null) ? 'ready' : 'unavailable';
        saveToStorage();
    } catch (error) {
        route.elevationStatus = 'unavailable';
        renderRoutesList();
        console.warn('Failed to fetch elevations:', error.message);
    }
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
    const fileArray = Array.from(files);
    let imported = 0;

    for (const file of fileArray) {
        try {
            showStatus(`Importing ${file.name}...`);
            await handleSingleImportFile(file);
            imported++;
        } catch (e) {
            showStatus(`Failed to import ${file.name}: ${e.message}`, true);
        }
    }

    if (fileArray.length > 1 && imported > 0) {
        showStatus(`Imported ${imported} of ${fileArray.length} file(s)`);
    }
}

function detectImportFormat(filename) {
    const name = filename.toLowerCase();
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

async function handleSingleImportFile(file) {
    assertFileSize(file, MAX_IMPORT_FILE_BYTES, file.name);
    const detected = detectImportFormat(file.name);
    if (!detected) {
        throw new Error('Unsupported file type');
    }

    const { format, gzipped } = detected;
    let arrayBuffer = await file.arrayBuffer();

    // Decompress gzipped files using pako, loaded only when needed.
    if (gzipped) {
        await ensurePako();
        const inflated = pako.inflate(new Uint8Array(arrayBuffer));
        if (inflated.byteLength > MAX_DECOMPRESSED_IMPORT_BYTES) {
            throw new Error(`Decompressed file is too large. Maximum size is ${formatSizeLimit(MAX_DECOMPRESSED_IMPORT_BYTES)}.`);
        }
        arrayBuffer = inflated.buffer;
    }

    // Strip extensions to get base name for fallback
    const baseName = file.name.replace(/\.(fit|tcx|gpx|kml|geojson|json)(\.gz)?$/i, '');

    if (format === 'gpx') {
        const text = new TextDecoder().decode(arrayBuffer);
        importGPX(text, baseName + '.gpx');
        return;
    }
    if (format === 'kml') {
        const text = new TextDecoder().decode(arrayBuffer);
        importKML(text, baseName + '.kml');
        return;
    }

    let result;
    if (format === 'fit') {
        result = parseFIT(arrayBuffer);
    } else if (format === 'tcx') {
        const text = new TextDecoder().decode(arrayBuffer);
        result = parseTCX(text);
    } else if (format === 'geojson') {
        const text = new TextDecoder().decode(arrayBuffer);
        result = parseGeoJSON(text);
    }

    const routeName = result.name || baseName;
    const elevations = normalizeElevations(result.elevations, result.coordinates.length);
    addImportedRoute(routeName, result.coordinates, elevations);
}

function importGPX(xmlString, filename) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    if (doc.querySelector('parsererror')) {
        throw new Error('Invalid GPX file');
    }

    // Extract track points
    const trkpts = doc.querySelectorAll('trkpt');
    if (trkpts.length === 0) {
        // Try route points
        const rtepts = doc.querySelectorAll('rtept');
        if (rtepts.length === 0) throw new Error('No track or route points found');
        return importFromPoints(rtepts, doc, filename);
    }

    return importFromPoints(trkpts, doc, filename);
}

function importFromPoints(pointElements, doc, filename) {
    const coordinates = [];
    const elevations = [];

    pointElements.forEach(pt => {
        const lat = Number(pt.getAttribute('lat'));
        const lng = Number(pt.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lng) && isValidLatLng({ latitude: lat, longitude: lng })) {
            coordinates.push([lat, lng]);
            const eleEl = pt.querySelector('ele');
            const elevation = eleEl ? Number(eleEl.textContent) : null;
            elevations.push(Number.isFinite(elevation) ? elevation : null);
        }
    });

    if (coordinates.length === 0) throw new Error('No valid coordinates found');

    // Get name from metadata or track
    const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name') || doc.querySelector('rte > name');
    const name = nameEl ? nameEl.textContent : filename.replace(/\.(gpx|kml)$/i, '');

    addImportedRoute(name, coordinates, elevations);
}

function importKML(xmlString, filename) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    if (doc.querySelector('parsererror')) {
        throw new Error('Invalid KML file');
    }

    const coordsEl = doc.querySelector('coordinates');
    if (!coordsEl) throw new Error('No coordinates found in KML');

    const coordinates = [];
    const elevations = [];

    coordsEl.textContent.trim().split(/\s+/).forEach(triplet => {
        const parts = triplet.split(',');
        if (parts.length >= 2) {
            const lng = Number(parts[0]);
            const lat = Number(parts[1]);
            const ele = parts.length >= 3 ? Number(parts[2]) : null;
            if (Number.isFinite(lat) && Number.isFinite(lng) && isValidLatLng({ latitude: lat, longitude: lng })) {
                coordinates.push([lat, lng]);
                elevations.push(Number.isFinite(ele) ? ele : null);
            }
        }
    });

    if (coordinates.length === 0) throw new Error('No valid coordinates found in KML');

    const nameEl = doc.querySelector('Placemark > name') || doc.querySelector('Document > name');
    const name = nameEl ? nameEl.textContent : filename.replace(/\.(gpx|kml)$/i, '');

    addImportedRoute(name, coordinates, elevations);
}

function addImportedRoute(name, coordinates, elevations) {
    const safeCoordinates = normalizeCoordinates(coordinates);
    if (safeCoordinates.length === 0) throw new Error('No valid coordinates found');

    // Pick a color
    if (availableColorIndices.length === 0) resetColorPool();
    if (availableColorIndices.length === 0) availableColorIndices = COLOR_PALETTE.map((_, i) => i);
    const poolIdx = Math.floor(Math.random() * availableColorIndices.length);
    const colorIndex = availableColorIndices.splice(poolIdx, 1)[0];
    const color = COLOR_PALETTE[colorIndex];

    const routeId = Date.now() + Math.floor(Math.random() * 1000);
    const safeElevations = normalizeElevations(elevations, safeCoordinates.length);
    const distance = calculateRouteDistance(safeCoordinates);

    const polylineLayer = L.polyline(safeCoordinates, {
        color: color,
        weight: ROUTE_LINE_WEIGHT,
        opacity: ROUTE_LINE_OPACITY
    }).addTo(map);

    const markers = createRouteMarkers(safeCoordinates, color);

    const hasElevation = safeElevations && safeElevations.some(e => e !== null);
    const route = {
        id: routeId,
        name: typeof name === 'string' && name.trim() ? name.trim() : 'Imported route',
        origin: fallbackCoordinateLabel(safeCoordinates[0]),
        destination: fallbackCoordinateLabel(safeCoordinates[safeCoordinates.length - 1]),
        stops: [],
        travelMode: 'IMPORTED',
        color: color,
        coordinates: safeCoordinates,
        elevations: hasElevation ? safeElevations : null,
        polylineLayer: polylineLayer,
        markers: markers,
        distance: Math.round(distance),
        duration: null,
        visible: true,
        elevationStatus: hasElevation ? 'ready' : null
    };

    routes.push(route);
    updateRouteMapStyles();

    bindRoutePopup(polylineLayer, route);
    bindRouteHoverEffects(route);
    map.fitBounds(polylineLayer.getBounds(), { padding: [50, 50] });

    renderRoutesList();
    updateBulkButtons();
    saveToStorage();
    showStatus(`Imported: ${route.name} (${safeCoordinates.length} points, ${formatDistance(distance)})`);
}

function haversineDistance([lat1, lon1], [lat2, lon2]) {
    const R = 6371000; // Earth radius in meters
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
});
document.getElementById('destination').addEventListener('input', function () {
    debouncedPreviewUpdate();
    updateInputValidation(this);
});
document.getElementById('stopsContainer').addEventListener('input', function (e) {
    if (!e.target.matches('.stop-input')) return;
    debouncedPreviewUpdate();
    updateInputValidation(e.target);
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

function getNextColor() {
    // Return current color and pick a new random one
    const color = COLOR_PALETTE[selectedColorIndex];
    selectRandomColor();
    return color;
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
    if (e.key === 'Enter') {
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
document.getElementById('downloadAllBtn').addEventListener('click', downloadAllRoutes);
document.getElementById('clearAllBtn').addEventListener('click', clearAllRoutes);
document.getElementById('apiKeyMapBtn').addEventListener('click', openApiKeyModal);
document.getElementById('clickModeBtn').addEventListener('click', toggleClickMode);
document.getElementById('cancelClickModeBtn')?.addEventListener('click', exitClickMode);
document.getElementById('locateMeBtn').addEventListener('click', locateMe);
document.getElementById('closeModalBtn').addEventListener('click', closeApiKeyModal);
document.getElementById('saveApiKeyBtn').addEventListener('click', saveApiKey);
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
setupFogOfWorld();
loadFromStorage();
renderRoutesList();
updateApiKeyStatus();
checkApiKeyOnLoad();

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
