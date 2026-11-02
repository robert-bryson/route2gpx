import { describe, expect, test, vi } from 'vitest';
import { createRouteMap } from '../route-map.js';

function fixture() {
    const lines = [], markers = [];
    const map = { fitBounds: vi.fn(), removeLayer: vi.fn() };
    function layer(options) {
        const element = document.createElement('div');
        const handlers = {};
        return {
            options, handlers,
            addTo: vi.fn().mockReturnThis(),
            on: vi.fn((event, callback) => { handlers[event] = callback; }),
            off: vi.fn(() => { for (const event of Object.keys(handlers)) delete handlers[event]; }),
            setStyle: vi.fn(), setIcon: vi.fn(),
            bindPopup: vi.fn().mockReturnThis(), bindTooltip: vi.fn().mockReturnThis(),
            setTooltipContent: vi.fn(), closeTooltip: vi.fn(), closePopup: vi.fn(),
            unbindTooltip: vi.fn(), unbindPopup: vi.fn(), openPopup: vi.fn(),
            getElement: () => element,
            getBounds: () => ({ getCenter: () => [2, 3] }),
        };
    }
    const leaflet = {
        polyline: vi.fn((coordinates, options) => { const line = layer(options); lines.push(line); return line; }),
        marker: vi.fn((coordinate, options) => { const marker = layer(options); markers.push(marker); return marker; }),
        popup: () => ({ setContent: vi.fn().mockReturnThis() }),
        featureGroup: vi.fn(() => ({ getBounds: () => 'visible bounds' })),
        DomEvent: { stopPropagation: vi.fn(), preventDefault: vi.fn() },
    };
    const onHighlight = vi.fn(), markerIcon = vi.fn((type, color, newest) => ({ type, color, newest }));
    const view = createRouteMap({ map, leaflet, markerIcon, popupContent: route => route.name, onHighlight });
    return { view, map, leaflet, lines, markers, onHighlight, markerIcon };
}

const route = (id, extra = {}) => ({ id, name: 'Trail', origin: 'A', destination: 'B', color: '#ff4757', coordinates: [[1, 2], [2, 3], [3, 4], [4, 5]], segmentStarts: [0, 2], visible: true, ...extra });

describe('route map lifecycle', () => {
    test('keeps map layers separate from route data and preserves full segments', () => {
        const { view, leaflet, lines, markers } = fixture();
        const data = route(1), original = structuredClone(data);
        view.add(data);
        expect(data).toEqual(original);
        expect(leaflet.polyline.mock.calls[0][0]).toEqual([data.coordinates.slice(0, 2), data.coordinates.slice(2)]);
        expect(lines[0].addTo).toHaveBeenCalledOnce();
        expect(markers).toHaveLength(2);
        expect(markers.map(marker => marker.getElement().getAttribute('aria-label'))).toEqual(['Start: A', 'End: B']);
        expect(() => view.add(data)).toThrow('already exists');
    });

    test('never mounts hidden routes during restoration and fits only visible layers', () => {
        const { view, lines, markers, leaflet, map } = fixture();
        view.add(route(1, { visible: false }));
        view.fitVisible();
        expect(map.fitBounds).not.toHaveBeenCalled();
        expect(lines[0].addTo).not.toHaveBeenCalled();
        expect(markers.every(marker => marker.addTo.mock.calls.length === 0)).toBe(true);
        view.add(route(2));
        view.fitVisible();
        expect(leaflet.featureGroup).toHaveBeenCalledWith([lines[1]]);
        view.setVisible(1, true);
        view.fitVisible();
        expect(leaflet.featureGroup).toHaveBeenLastCalledWith(lines);
    });

    test('updates endpoint labels and renders untrusted names as text', () => {
        const { view, lines, markers } = fixture();
        const data = route(1);
        view.add(data);
        data.name = '<img src=x onerror=alert(1)>';
        data.origin = '<Start>';
        data.destination = 'New end';
        view.updateLabels(1);
        const name = lines[0].setTooltipContent.mock.lastCall[0];
        expect(name.textContent).toBe(data.name);
        expect(name.querySelector('img')).toBeNull();
        expect(markers[0].getElement().getAttribute('aria-label')).toBe('Start: <Start>');
        expect(markers[1].setTooltipContent.mock.lastCall[0].textContent).toBe('End: New end');
    });

    test('restores older route styling after hover and clears highlights when hidden', () => {
        const { view, lines, markers, onHighlight } = fixture();
        view.add(route(1)); view.add(route(2)); view.updateStyles(2);
        lines[0].handlers.mouseover();
        expect(lines[0].setStyle).toHaveBeenLastCalledWith({ weight: 7, opacity: 1 });
        expect(markers[0].getElement().classList.contains('marker-highlighted')).toBe(true);
        lines[0].handlers.mouseout();
        expect(lines[0].setStyle).toHaveBeenLastCalledWith({ weight: 4, opacity: 0.56 });
        view.highlight(1, true);
        view.setVisible(1, false);
        expect(onHighlight).toHaveBeenLastCalledWith(1, false);
        expect(markers[0].getElement().classList.contains('marker-highlighted')).toBe(false);
        expect(lines[0].closeTooltip).toHaveBeenCalled();
        expect(lines[0].closePopup).toHaveBeenCalled();
        view.highlight(1, true);
        expect(onHighlight).toHaveBeenLastCalledWith(1, false);
    });

    test('updates endpoint icons only when newest-route status changes', () => {
        const { view, markers } = fixture();
        for (let id = 1; id <= 30; id++) view.add(route(id));
        view.updateStyles(30);
        markers.forEach(marker => marker.setIcon.mockClear());
        view.updateStyles(30);
        view.highlight(10, true); view.highlight(10, false);
        expect(markers.every(marker => marker.setIcon.mock.calls.length === 0)).toBe(true);
        view.updateStyles(29);
        expect(markers.filter(marker => marker.setIcon.mock.calls.length > 0)).toHaveLength(4);
    });

    test('cleans up layers, events, and popups on delete and allows undo', () => {
        const { view, lines, markers, map } = fixture();
        view.add(route(1)); view.remove(1);
        for (const layer of [lines[0], ...markers]) {
            expect(map.removeLayer).toHaveBeenCalledWith(layer);
            expect(layer.handlers).toEqual({});
            expect(layer.unbindTooltip).toHaveBeenCalledOnce();
            expect(layer.unbindPopup).toHaveBeenCalledOnce();
        }
        expect(() => view.add(route(1))).not.toThrow();
        view.remove(999); view.highlight(999, true); view.fit(999); view.open(999); view.updateLabels(999);
    });

    test('opens popups at a segment-independent center and suppresses context-menu propagation', () => {
        const { view, map, lines, leaflet } = fixture();
        view.add(route(1)); view.fit(1); view.open(1);
        expect(map.fitBounds).toHaveBeenCalledWith(expect.anything(), { padding: [50, 50] });
        expect(lines[0].openPopup).toHaveBeenLastCalledWith([2, 3]);
        const event = { latlng: [1, 2] };
        lines[0].handlers.contextmenu(event);
        expect(leaflet.DomEvent.stopPropagation).toHaveBeenCalledWith(event);
        expect(leaflet.DomEvent.preventDefault).toHaveBeenCalledWith(event);
        expect(lines[0].openPopup).toHaveBeenLastCalledWith(event.latlng);
        view.setVisible(1, false); lines[0].openPopup.mockClear(); view.open(1);
        expect(lines[0].openPopup).not.toHaveBeenCalled();
    });
});
