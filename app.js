// ============ State ============
let routes = [];
let clickMode = null; // null, 'origin', 'destination', 'waypoint'
let distanceUnit = 'km';
let previewMarkers = [];

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
        const savedUnit = localStorage.getItem('route2gpx_unit');
        if (savedUnit) {
            setUnit(savedUnit, false);
        }

        // Saved routes
        const savedRoutes = localStorage.getItem('route2gpx_routes');
        if (savedRoutes) {
            const routeData = JSON.parse(savedRoutes);
            routeData.forEach(data => {
                restoreRoute(data);
            });
            updateBulkButtons();
            if (routes.length > 0) {
                showStatus(`Restored ${routes.length} route(s) from previous session`);
            }
        }
    } catch (e) {
        console.error('Failed to restore from storage:', e);
    }
}

function saveToStorage() {
    try {
        // Distance unit
        localStorage.setItem('route2gpx_unit', distanceUnit);

        // Routes (without Leaflet objects)
        const routeData = routes.map(r => ({
            id: r.id,
            name: r.name,
            origin: r.origin,
            destination: r.destination,
            stops: r.stops,
            travelMode: r.travelMode,
            color: r.color,
            coordinates: r.coordinates,
            distance: r.distance,
            duration: r.duration
        }));
        localStorage.setItem('route2gpx_routes', JSON.stringify(routeData));
    } catch (e) {
        console.error('Failed to save to storage:', e);
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
                <span>📏 ${formatDistance(route.distance)}</span>
                <span>⏱️ ${formatDuration(route.duration)}</span>
            </div>
            <div class="route-meta">
                <span>${getModeEmoji(route.travelMode)} ${escapeHtml(route.travelMode.toLowerCase())}</span>
                ${stopCount > 0 ? `<span>📍 ${stopCount} stop${stopCount > 1 ? 's' : ''}</span>` : ''}
            </div>
            <div class="route-meta" style="border-top: 1px solid #eee; padding-top: 8px; margin-top: 4px;">
                <span>📄 ${fileSize}</span>
                <span>📌 ${pointCount.toLocaleString()} points</span>
            </div>
            <div class="popup-actions">
                <button class="popup-btn download" data-action="download-route" data-route-id="${route.id}" title="Download GPX">
                    ⬇️ Download
                </button>
                <button class="popup-btn delete" data-action="remove-route" data-route-id="${route.id}" title="Remove route">
                    🗑️ Remove
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

    polylineLayer.bindPopup(popup);

    // Right-click also opens the popup
    polylineLayer.on('contextmenu', function (e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        this.openPopup(e.latlng);
    });
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
        polylineLayer.setStyle({ weight: 7, opacity: 1 });
        markers.forEach(m => {
            if (m._icon) m._icon.classList.add('marker-highlighted');
        });
        // Highlight sidebar item
        const sidebarItem = document.querySelector(`[data-route-id="${route.id}"]`);
        if (sidebarItem) sidebarItem.classList.add('highlighted');
    };

    const unhighlightRoute = () => {
        polylineLayer.setStyle({ weight: 4, opacity: 0.8 });
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
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

const VALID_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const DEFAULT_ROUTE_COLORS = ['#4285F4', '#EA4335', '#34A853', '#FBBC05', '#9C27B0', '#00BCD4', '#FF9800', '#795548'];
function sanitizeColor(color, fallbackIndex) {
    if (typeof color === 'string' && VALID_COLOR_RE.test(color)) return color;
    return DEFAULT_ROUTE_COLORS[fallbackIndex % DEFAULT_ROUTE_COLORS.length];
}

function restoreRoute(data) {
    if (!Number.isFinite(data.id)) data.id = Date.now();
    data.color = sanitizeColor(data.color, routes.length);
    const polylineLayer = L.polyline(data.coordinates, {
        color: data.color,
        weight: 4,
        opacity: 0.8
    }).addTo(map);

    const markers = createRouteMarkers(data.coordinates, data.color);

    const route = {
        ...data,
        polylineLayer,
        markers
    };
    routes.push(route);

    // Bind popup after route is in array
    bindRoutePopup(polylineLayer, route);
    bindRouteHoverEffects(route);

    renderRoutesList();
}

// ============ Custom Markers ============
function createMarkerIcon(type, color, number = null) {
    const safeColor = VALID_COLOR_RE.test(color) ? color : '#4285F4';
    let html = '';
    if (type === 'start') {
        html = `<div class="marker-icon" style="background: ${safeColor}"><span>A</span></div>`;
    } else if (type === 'end') {
        html = `<div class="marker-icon" style="background: ${safeColor}"><span>B</span></div>`;
    } else if (type === 'waypoint') {
        html = `<div class="marker-number" style="background: ${safeColor}">${number}</div>`;
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

function updatePreviewMarkers() {
    // Clear existing preview markers
    previewMarkers.forEach(m => map.removeLayer(m));
    previewMarkers = [];

    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();
    const stops = getStops();
    const previewColor = document.getElementById('routeColor').value || '#888';

    // Only show preview markers for lat,lng inputs
    const latLngRegex = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/;

    if (origin) {
        const match = origin.match(latLngRegex);
        if (match) {
            const marker = L.marker([parseFloat(match[1]), parseFloat(match[2])], {
                icon: createMarkerIcon('start', previewColor),
                opacity: 0.7
            }).addTo(map);
            previewMarkers.push(marker);
        }
    }

    if (destination) {
        const match = destination.match(latLngRegex);
        if (match) {
            const marker = L.marker([parseFloat(match[1]), parseFloat(match[2])], {
                icon: createMarkerIcon('end', previewColor),
                opacity: 0.7
            }).addTo(map);
            previewMarkers.push(marker);
        }
    }

    stops.forEach((stop, idx) => {
        const match = stop.match(latLngRegex);
        if (match) {
            const marker = L.marker([parseFloat(match[1]), parseFloat(match[2])], {
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
        enterClickMode('origin');
    }
}

function enterClickMode(target) {
    clickMode = target;
    const btn = document.getElementById('clickModeBtn');
    const indicator = document.getElementById('mapModeIndicator');
    const targetSpan = document.getElementById('clickModeTarget');

    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    indicator.style.display = 'block';

    const labels = {
        'origin': 'Set Origin',
        'destination': 'Set Destination',
        'waypoint': 'Add Waypoint'
    };
    targetSpan.textContent = labels[target] || target;

    document.getElementById('map').style.cursor = 'crosshair';
}

function exitClickMode() {
    clickMode = null;
    const btn = document.getElementById('clickModeBtn');
    const indicator = document.getElementById('mapModeIndicator');

    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    indicator.style.display = 'none';
    document.getElementById('map').style.cursor = '';
}

function advanceClickMode() {
    const origin = document.getElementById('origin').value.trim();
    const destination = document.getElementById('destination').value.trim();

    if (!origin) {
        enterClickMode('origin');
    } else if (!destination) {
        enterClickMode('destination');
    } else {
        enterClickMode('waypoint');
    }
}

map.on('click', function (e) {
    if (!clickMode) return;

    const latLng = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;

    if (clickMode === 'origin') {
        document.getElementById('origin').value = latLng;
        advanceClickMode();
    } else if (clickMode === 'destination') {
        document.getElementById('destination').value = latLng;
        advanceClickMode();
    } else if (clickMode === 'waypoint') {
        addStop(latLng);
        // Stay in waypoint mode for adding more
    }

    updatePreviewMarkers();
});

// ============ Help Toggle ============
function toggleHelp() {
    const content = document.getElementById('helpContent');
    const btn = document.querySelector('.help-toggle');
    const isVisible = content.classList.toggle('visible');
    btn.setAttribute('aria-expanded', isVisible);
}

// ============ API Key Modal ============
function getApiKey() {
    try { return localStorage.getItem('route2gpx_apiKey') || ''; } catch { return ''; }
}

function updateApiKeyStatus() {
    const apiKey = getApiKey();
    const btn = document.getElementById('apiKeyMapBtn');

    if (apiKey) {
        btn.classList.remove('missing');
        btn.classList.add('valid');
        btn.title = 'API key saved — click to edit';
        btn.setAttribute('aria-label', 'API key saved, click to edit');
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
    input.value = getApiKey();
    modal.classList.add('visible');
    input.focus();
}

function closeApiKeyModal() {
    const modal = document.getElementById('apiKeyModal');
    modal.classList.remove('visible');
}

function saveApiKey() {
    const input = document.getElementById('apiKeyInput');
    const key = input.value.trim();

    if (key) {
        localStorage.setItem('route2gpx_apiKey', key);
        showStatus('API key saved');
        updateApiKeyStatus();
        closeApiKeyModal();
    } else {
        showStatus('Please enter a valid API key', true);
        input.focus();
    }
}

function clearApiKey() {
    localStorage.removeItem('route2gpx_apiKey');
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
function locateMe() {
    if (!navigator.geolocation) {
        showStatus('Geolocation is not supported by your browser', true);
        return;
    }

    showStatus('Getting your location...');
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            map.setView([latitude, longitude], 14);
            showStatus('Centered on your location');
        },
        (error) => {
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

    showStatus('Getting your location...');
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            const latLng = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
            document.getElementById(field).value = latLng;
            updatePreviewMarkers();
            showStatus('Location set');
        },
        (error) => {
            showStatus('Unable to get your location: ' + error.message, true);
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============ Polyline Decoder ============
function decodePolyline(encoded) {
    const points = [];
    let index = 0, lat = 0, lng = 0;

    while (index < encoded.length) {
        let shift = 0, result = 0, byte;
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);

        shift = 0;
        result = 0;
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);

        points.push([lat / 1e5, lng / 1e5]);
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
        <button type="button" data-action="remove-stop" aria-label="Remove waypoint ${stopNumber}">✕</button>
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

function renumberStops() {
    const rows = document.querySelectorAll('.stop-row');
    rows.forEach((row, idx) => {
        const num = idx + 1;
        row.querySelector('.stop-number').textContent = num;
        row.querySelector('input').setAttribute('aria-label', `Waypoint ${num}`);
        row.querySelector('input').placeholder = `Waypoint ${num}`;
    });
}

function getStops() {
    const inputs = document.querySelectorAll('.stop-input');
    return Array.from(inputs)
        .map(input => input.value.trim())
        .filter(val => val !== '');
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

    const container = document.getElementById('stopsContainer');
    container.innerHTML = '';
    stops.forEach(stop => addStop(stop));

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
    status.textContent = message;
    status.className = 'status ' + (isError ? 'error' : 'success');
    status.style.display = 'block';

    if (!isError) {
        setTimeout(() => { status.style.display = 'none'; }, 3000);
    }
}

// ============ Location Parsing ============
function parseLocation(input) {
    const latLngMatch = input.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (latLngMatch) {
        return {
            location: {
                latLng: {
                    latitude: parseFloat(latLngMatch[1]),
                    longitude: parseFloat(latLngMatch[2])
                }
            }
        };
    }
    return { address: input };
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
        document.getElementById('routeColor').value = color;
    }
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

        const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'routes.polyline,routes.distanceMeters,routes.duration'
            },
            body: JSON.stringify(payload)
        });

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
        const distance = data.routes[0].distanceMeters;
        const duration = data.routes[0].duration;

        // Generate route name (always auto-generated from origin → destination)
        const routeId = Date.now();
        const routeName = `${truncate(origin, 20)} → ${truncate(destination, 20)}`;

        // Create polyline
        const polylineLayer = L.polyline(coordinates, {
            color: color,
            weight: 4,
            opacity: 0.8
        }).addTo(map);

        // Create markers
        const markers = createRouteMarkers(coordinates, color);

        // Fit map
        map.fitBounds(polylineLayer.getBounds(), { padding: [50, 50] });

        // Store route
        const route = {
            id: routeId,
            name: routeName,
            origin,
            destination,
            stops: [...stops],
            travelMode,
            color,
            coordinates,
            polylineLayer,
            markers,
            distance,
            duration,
            visible: true
        };
        routes.push(route);

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
        showStatus(`Route added: ${formatDistance(distance)}, ${formatDuration(duration)}`);

        // Clear form for next route
        document.getElementById('stopsContainer').innerHTML = '';
        document.getElementById('origin').value = '';
        document.getElementById('destination').value = '';
        exitClickMode();

        // Pick a random color for the next route
        selectRandomColor();

        // Return focus to origin for next route
        document.getElementById('origin').focus();

    } catch (error) {
        showStatus(error.message, true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Get Route';
    }
}

// ============ Formatting Helpers ============
function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '...' : str;
}

function formatDistance(meters) {
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
    return text
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
            <div style="color: #888; text-align: center; padding: 24px;">
                <div style="font-size: 2rem; margin-bottom: 8px;">🗺️</div>
                <div style="font-weight: 600; margin-bottom: 4px;">No routes yet</div>
                <div style="font-size: 0.8rem; color: #666;">Enter an origin and destination above, then press Enter or click "Get Route"</div>
            </div>
        `;
        return;
    }

    list.innerHTML = routes.map((route, idx) => `
        <div class="route-item" style="border-left-color: ${route.color};" role="listitem"
             data-route-id="${route.id}"
             tabindex="0"
             aria-label="Route ${idx + 1}: ${escapeHtml(route.name)}. Press Enter to zoom and view details.">
            <div class="route-item-header">
                <div>
                    <div class="route-item-title">${escapeHtml(route.name)}</div>
                    <div class="route-item-meta">
                        ${getModeEmoji(route.travelMode)} ${escapeHtml(route.travelMode.toLowerCase())} •
                        ${formatDistance(route.distance)} • ${formatDuration(route.duration)}
                        ${route.stops.length > 0 ? ` • ${route.stops.length} stop(s)` : ''}
                    </div>
                </div>
            </div>
            <div class="route-item-actions">
                <button class="btn-outline btn-small" data-action="toggle-visibility" data-route-id="${route.id}"
                        aria-label="${route.visible ? 'Hide' : 'Show'} route"
                        title="${route.visible ? 'Hide this route from the map' : 'Show this route on the map'}">
                    ${route.visible ? '👁️ Hide' : '👁️‍🗨️ Show'}
                </button>
                <button class="btn-outline btn-small" data-action="download-route" data-route-id="${route.id}"
                        aria-label="Download GPX for ${escapeHtml(route.name)}"
                        title="Download as GPX file for GPS devices">
                    📥 GPX
                </button>
                <button class="btn-secondary btn-small" data-action="remove-route" data-route-id="${route.id}"
                        aria-label="Delete route ${escapeHtml(route.name)}"
                        title="Remove this route permanently">
                    🗑️
                </button>
            </div>
        </div>
    `).join('');
}

function getModeEmoji(mode) {
    const emojis = { DRIVE: '🚗', TRANSIT: '🚌', BICYCLE: '🚴', WALK: '🚶' };
    return emojis[mode] || '📍';
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
            map.removeLayer(route.polylineLayer);
            route.markers.forEach(m => map.removeLayer(m));
        }
        renderRoutesList();
    }
}

function removeRoute(id) {
    const index = routes.findIndex(r => r.id === id);
    if (index !== -1) {
        map.removeLayer(routes[index].polylineLayer);
        routes[index].markers.forEach(m => map.removeLayer(m));
        routes.splice(index, 1);
        renderRoutesList();
        updateBulkButtons();
        saveToStorage();
    }
}

function clearAllRoutes() {
    if (!confirm('Remove all routes? This cannot be undone.')) return;
    routes.forEach(route => {
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
        `    <desc>Route from ${escapeXml(route.origin)} to ${escapeXml(route.destination)} via ${route.travelMode.toLowerCase()}</desc>`,
        `    <time>${now.toISOString()}</time>`,
        `    <bounds minlat="${bounds.minlat}" minlon="${bounds.minlon}" maxlat="${bounds.maxlat}" maxlon="${bounds.maxlon}"/>`,
        '  </metadata>'
    ];

    // Add waypoints for origin, stops, and destination
    lines.push(`  <wpt lat="${coords[0][0].toFixed(6)}" lon="${coords[0][1].toFixed(6)}">`);
    lines.push(`    <name>Start: ${escapeXml(route.origin)}</name>`);
    lines.push('  </wpt>');

    route.stops.forEach((stop, idx) => {
        // Approximate waypoint location (we don't have exact coords, use middle of route)
        const approxIdx = Math.floor((idx + 1) * coords.length / (route.stops.length + 2));
        const coord = coords[Math.min(approxIdx, coords.length - 1)];
        lines.push(`  <wpt lat="${coord[0].toFixed(6)}" lon="${coord[1].toFixed(6)}">`);
        lines.push(`    <name>Stop ${idx + 1}: ${escapeXml(stop)}</name>`);
        lines.push('  </wpt>');
    });

    lines.push(`  <wpt lat="${coords[coords.length - 1][0].toFixed(6)}" lon="${coords[coords.length - 1][1].toFixed(6)}">`);
    lines.push(`    <name>End: ${escapeXml(route.destination)}</name>`);
    lines.push('  </wpt>');

    // Add track
    lines.push('  <trk>');
    lines.push(`    <name>${escapeXml(route.name)}</name>`);
    lines.push(`    <type>${escapeXml(route.travelMode)}</type>`);
    lines.push('    <trkseg>');

    const durationSeconds = parseInt(route.duration?.replace('s', ''), 10) || coords.length * 60;
    const intervalMs = (durationSeconds * 1000) / Math.max(coords.length - 1, 1);

    coords.forEach(([lat, lng], idx) => {
        const time = new Date(now.getTime() + idx * intervalMs).toISOString();
        lines.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">`);
        lines.push('        <ele>0</ele>');
        lines.push(`        <time>${time}</time>`);
        lines.push('      </trkpt>');
    });

    lines.push('    </trkseg>');
    lines.push('  </trk>');
    lines.push('</gpx>');

    return lines.join('\n');
}

function downloadRoute(id) {
    const route = routes.find(r => r.id === id);
    if (!route) return;

    const gpx = generateGPX(route);
    const filename = `${sanitizeFilename(route.travelMode.toLowerCase())}_${sanitizeFilename(route.name)}.gpx`;
    downloadFile(gpx, filename, 'application/gpx+xml');
}

function downloadAllRoutes() {
    if (routes.length === 0) return;

    if (routes.length === 1) {
        downloadRoute(routes[0].id);
        return;
    }

    // Download each with a slight delay
    routes.forEach((route, idx) => {
        setTimeout(() => downloadRoute(route.id), idx * 300);
    });
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

// ============ Keyboard Navigation ============
document.addEventListener('keydown', function (e) {
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
    const latLngRegex = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/;

    input.classList.remove('valid-coords', 'has-text');

    if (latLngRegex.test(value)) {
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
function initColorPresets() {
    const container = document.getElementById('colorOptions');
    container.innerHTML = COLOR_PALETTE.map((color, idx) => `
        <button type="button" class="color-option ${idx === selectedColorIndex ? 'selected' : ''}"
                style="background: ${color}"
                data-action="select-color" data-color-index="${idx}"
                role="option"
                aria-selected="${idx === selectedColorIndex}"
                aria-label="Color ${idx + 1}: ${color}"
                title="${color}"></button>
    `).join('');

    updateColorSwatch();
}

function updateColorSwatch() {
    // Ensure we have a valid color index
    if (selectedColorIndex < 0 || selectedColorIndex >= COLOR_PALETTE.length) {
        selectedColorIndex = Math.floor(Math.random() * COLOR_PALETTE.length);
    }
    const color = COLOR_PALETTE[selectedColorIndex];
    document.getElementById('colorSwatch').style.background = color;
    document.getElementById('routeColor').value = color;
}

function toggleColorDropdown() {
    const dropdown = document.getElementById('colorDropdown');
    const swatch = document.getElementById('colorSwatch');
    const isVisible = dropdown.classList.toggle('visible');
    swatch.setAttribute('aria-expanded', isVisible);
}

function closeColorDropdown() {
    const dropdown = document.getElementById('colorDropdown');
    const swatch = document.getElementById('colorSwatch');
    dropdown.classList.remove('visible');
    swatch.setAttribute('aria-expanded', 'false');
}

function selectColor(idx) {
    selectedColorIndex = idx;

    // Remove this color from the available pool if present
    const poolIdx = availableColorIndices.indexOf(idx);
    if (poolIdx > -1) {
        availableColorIndices.splice(poolIdx, 1);
    }

    updateColorSwatch();

    // Update selected state
    document.querySelectorAll('.color-option').forEach((btn, i) => {
        btn.classList.toggle('selected', i === idx);
        btn.setAttribute('aria-selected', i === idx);
    });

    closeColorDropdown();
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

// Close dropdown when clicking outside
document.addEventListener('click', function (e) {
    const wrapper = document.querySelector('.color-picker-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        closeColorDropdown();
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
        case 'select-color':
            selectColor(Number(actionEl.dataset.colorIndex));
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
document.getElementById('colorSwatch').addEventListener('click', toggleColorDropdown);
document.getElementById('unitKm').addEventListener('click', () => setUnit('km'));
document.getElementById('unitMi').addEventListener('click', () => setUnit('mi'));
document.getElementById('getRouteBtn').addEventListener('click', getRoute);
document.getElementById('downloadAllBtn').addEventListener('click', downloadAllRoutes);
document.getElementById('clearAllBtn').addEventListener('click', clearAllRoutes);
document.getElementById('apiKeyMapBtn').addEventListener('click', openApiKeyModal);
document.getElementById('clickModeBtn').addEventListener('click', toggleClickMode);
document.getElementById('locateMeBtn').addEventListener('click', locateMe);
document.getElementById('closeModalBtn').addEventListener('click', closeApiKeyModal);
document.getElementById('saveApiKeyBtn').addEventListener('click', saveApiKey);

// ============ Initialize ============
selectRandomColor(); // Pick initial random color
loadFromStorage();
renderRoutesList();
updateApiKeyStatus();
checkApiKeyOnLoad();
