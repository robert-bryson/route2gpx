import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRouteList } from '../route-list.js';

const route = (id, extra = {}) => ({
    id, name: `Route ${id}`, color: '#ff4757', origin: 'Start', destination: 'End',
    travelMode: 'WALK', distance: 1000, duration: '60s', stops: [], visible: true,
    coordinates: [[1, 2], [3, 4]], elevationStatus: 'idle', ...extra,
});
let list, view, onZoom, onHighlight;
beforeEach(() => {
    document.body.innerHTML = '<button id="outside">Planner</button><div id="routesList"></div>';
    list = document.getElementById('routesList');
    onZoom = vi.fn(); onHighlight = vi.fn();
    view = createRouteList({ list, onZoom, onHighlight, formatDistance: distance => `${distance} m`, getRouteColorClass: () => 'route-color-0' });
});

describe('route-list behavior', () => {
    test('escapes route names in rows, accessible labels, and popups', () => {
        const item = route(1, { name: '<img src=x onerror=alert(1)> & "Trail"', segmentStarts: [0, 1], stops: ['Stop'] });
        view.render([item]);
        expect(list.querySelector('.route-item-title').textContent).toBe(item.name);
        expect(list.querySelector('.route-item').getAttribute('aria-label')).toContain(item.name);
        const popup = document.createElement('div'); popup.innerHTML = view.popup(item);
        expect(popup.querySelector('h4').textContent).toBe(item.name);
        expect(popup.querySelector('img')).toBeNull();
        expect(popup.textContent).toContain('2 segments');
        expect(popup.textContent).toContain('1 stop');
    });

    test.each([
        ['loading', { elevationProgress: { completed: 1, total: 4 }, elevationController: {} }, 'elevation 1/4', 'Pause elevation'],
        ['loading', {}, 'adding elevation', 'Add elevation'],
        ['partial', { elevations: [0, null] }, 'partial elevation', 'Retry elevation'],
        ['cancelled', {}, 'elevation paused', 'Add elevation'],
        ['ready', { elevationSource: { sampled: true } }, 'sampled elevation', null],
        ['ready', {}, 'elevation ready', null],
        ['unavailable', {}, 'no elevation', 'Add elevation'],
    ])('presents %s elevation state and the available action', (status, extra, label, action) => {
        view.render([route(1, { elevationStatus: status, ...extra })]);
        expect(list.textContent).toContain(label);
        const elevationButton = list.querySelector('[data-action$="-elevation"]');
        expect(elevationButton?.textContent ?? null).toBe(action);
    });

    test('shows reuse only for planned routes and offers to show a hidden route', () => {
        view.render([route(1, { request: {}, visible: false }), route(2)]);
        expect(list.querySelectorAll('[data-action="edit-route"]')).toHaveLength(1);
        expect(list.querySelector('[data-action="toggle-visibility"]').getAttribute('aria-label')).toBe('Show route');
    });

    test('preserves the focused action after reorder and chooses a neighbor after deletion', () => {
        view.render([route(1), route(2)]);
        list.querySelector('[data-route-id="1"] [data-action="download-route"]').focus();
        view.render([route(2), route(1)]);
        expect(document.activeElement.dataset.routeId).toBe('1');
        expect(document.activeElement.dataset.action).toBe('download-route');
        view.render([route(2)]);
        expect(document.activeElement.dataset.routeId).toBe('2');
        view.render([]);
        expect(document.activeElement.dataset.action).toBe('browse-import');
    });

    test('falls back to the row when an action disappears and leaves outside focus alone', () => {
        view.render([route(1, { request: {} })]);
        list.querySelector('[data-action="edit-route"]').focus();
        view.render([route(1)]);
        expect(document.activeElement).toBe(list.firstElementChild);
        document.getElementById('outside').focus();
        view.render([route(1)]);
        expect(document.activeElement.id).toBe('outside');
    });

    test('delegates row clicks, keyboard activation, and hover without intercepting buttons', () => {
        view.render([route(1)]);
        const row = list.firstElementChild;
        row.querySelector('.route-item-title').click();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const button = row.querySelector('button'); button.click();
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(onZoom.mock.calls).toEqual([[1], [1]]);
        row.dispatchEvent(new MouseEvent('mouseenter'));
        row.dispatchEvent(new MouseEvent('mouseleave'));
        expect(onHighlight.mock.calls).toEqual([[1, true], [1, false]]);
    });

    test('scrolls highlighted rows into view only when necessary', () => {
        document.body.insertAdjacentHTML('afterbegin', '<div class="route-item" data-route-id="1">Another list</div>');
        view.render([route(1)]);
        const row = list.firstElementChild;
        Object.defineProperty(list, 'clientHeight', { value: 100 });
        list.getBoundingClientRect = () => ({ top: 100, bottom: 200 });
        row.getBoundingClientRect = () => ({ top: 80, bottom: 120 });
        list.scrollTop = 50;
        view.highlight(1, true);
        expect(row.classList.contains('highlighted')).toBe(true);
        expect(list.scrollTop).toBe(24);
        row.getBoundingClientRect = () => ({ top: 150, bottom: 180 });
        view.highlight(1, true); expect(list.scrollTop).toBe(24);
        row.getBoundingClientRect = () => ({ top: 190, bottom: 230 });
        view.highlight(1, true); expect(list.scrollTop).toBe(60);
        view.highlight(1, false); expect(row.classList.contains('highlighted')).toBe(false);
        expect(() => view.highlight(999, true)).not.toThrow();
    });

    test('keeps a route highlighted while the pointer moves between its descendants', () => {
        view.render([route(1), route(2)]);
        const row = list.firstElementChild;
        const title = row.querySelector('.route-item-title');
        const button = row.querySelector('button');
        row.dispatchEvent(new MouseEvent('mouseenter'));
        title.dispatchEvent(new MouseEvent('mouseenter', { relatedTarget: row }));
        title.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: button }));
        button.dispatchEvent(new MouseEvent('mouseenter', { relatedTarget: title }));
        button.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: row }));
        expect(onHighlight.mock.calls).toEqual([[1, true]]);
        row.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: list.lastElementChild }));
        expect(onHighlight.mock.calls).toEqual([[1, true], [1, false]]);
    });
});
