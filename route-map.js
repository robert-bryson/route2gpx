import { mapGeometry } from './track-data.js';

const LINE_WEIGHT = 4;
const LINE_OPACITY = 0.8;
const OLDER_LINE_OPACITY = 0.56;
const endpointLabels = route => [`Start: ${route.origin}`, `End: ${route.destination}`];

/**
 * Own route layers by ID. Route data contains no Leaflet objects or handlers.
 * Keep full track coordinates, including segment breaks, for map rendering.
 */
export function createRouteMap({ map, leaflet, markerIcon, popupContent, onHighlight = () => {} }) {
    const layers = new Map();

    function style(entry) {
        entry.line.setStyle({
            weight: entry.highlighted ? 7 : LINE_WEIGHT,
            opacity: entry.highlighted ? 1 : entry.newest ? LINE_OPACITY : OLDER_LINE_OPACITY,
        });
        for (const marker of entry.markers) {
            marker.getElement()?.classList.toggle('marker-highlighted', entry.highlighted);
        }
    }

    function highlight(id, active) {
        const entry = layers.get(id);
        if (!entry) return;
        entry.highlighted = active && entry.visible;
        style(entry);
        onHighlight(id, entry.highlighted);
    }

    // Leaflet treats tooltip strings as HTML. Supply text nodes for route labels.
    function text(value) {
        const node = document.createElement('span');
        node.textContent = value;
        return node;
    }

    function updateLabels(id) {
        const entry = layers.get(id);
        if (!entry) return;
        const { route, line, markers } = entry;
        line.setTooltipContent(text(route.name));
        const labels = endpointLabels(route);
        markers.forEach((marker, index) => {
            const label = labels[index];
            marker.options.title = marker.options.alt = label;
            const element = marker.getElement();
            if (element) {
                element.title = label;
                element.setAttribute('aria-label', label);
            }
            marker.setTooltipContent(text(label));
        });
    }

    function setVisible(id, visible) {
        const entry = layers.get(id);
        if (!entry) return;
        entry.visible = visible;
        const members = [entry.line, ...entry.markers];
        if (visible) {
            members.forEach(layer => layer.addTo(map));
            updateLabels(id);
        } else {
            highlight(id, false);
            members.forEach(layer => {
                layer.closePopup();
                layer.closeTooltip();
                map.removeLayer(layer);
            });
        }
    }

    return {
        add(route) {
            if (layers.has(route.id)) throw new Error(`Map route ${route.id} already exists.`);
            const line = leaflet.polyline(mapGeometry(route), { color: route.color, weight: LINE_WEIGHT, opacity: LINE_OPACITY });
            const labels = endpointLabels(route);
            const markers = [route.coordinates[0], route.coordinates.at(-1)].map((point, index) => leaflet.marker(point, {
                icon: markerIcon(index === 0 ? 'start' : 'end', route.color, true),
                title: labels[index], alt: labels[index],
            }));
            const entry = { route, line, markers, visible: route.visible !== false, highlighted: false, newest: undefined };
            layers.set(route.id, entry);
            const popup = leaflet.popup({ closeButton: true, className: 'route-popup-container' }).setContent(() => popupContent(route));
            popup.route2gpxPopupType = 'route';
            line.bindPopup(popup).bindTooltip(text(route.name), { sticky: true, className: 'route-tooltip' });
            markers.forEach((marker, index) => marker.bindTooltip(text(labels[index]), { className: 'route-tooltip' }));
            [line, ...markers].forEach(layer => {
                layer.on('mouseover', () => highlight(route.id, true));
                layer.on('mouseout', () => highlight(route.id, false));
            });
            line.on('contextmenu', event => {
                leaflet.DomEvent.stopPropagation(event);
                leaflet.DomEvent.preventDefault(event);
                line.openPopup(event.latlng);
            });
            if (entry.visible) [line, ...markers].forEach(layer => layer.addTo(map));
            updateLabels(route.id);
        },
        updateLabels,
        setVisible,
        highlight,
        updateStyles(newestId) {
            for (const [id, entry] of layers) {
                const newest = id === newestId;
                if (entry.newest === newest) continue;
                entry.newest = newest;
                entry.markers.forEach((marker, index) => marker.setIcon(markerIcon(index === 0 ? 'start' : 'end', entry.route.color, newest)));
                updateLabels(id);
                style(entry);
            }
        },
        fit(id) {
            const entry = layers.get(id);
            if (entry) map.fitBounds(entry.line.getBounds(), { padding: [50, 50] });
        },
        fitVisible() {
            const visible = [...layers.values()].filter(entry => entry.visible);
            if (visible.length) map.fitBounds(leaflet.featureGroup(visible.map(entry => entry.line)).getBounds(), { padding: [30, 30] });
        },
        open(id) {
            const entry = layers.get(id);
            if (!entry?.visible) return;
            // A bounds center works across all segments and does not project geometry again.
            entry.line.openPopup(entry.line.getBounds().getCenter());
        },
        remove(id) {
            const entry = layers.get(id);
            if (!entry) return;
            setVisible(id, false);
            [entry.line, ...entry.markers].forEach(layer => {
                layer.off();
                layer.unbindPopup();
                layer.unbindTooltip();
            });
            layers.delete(id);
        },
    };
}
