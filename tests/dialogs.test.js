import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAppDialogs, exportDataDescription } from '../app-dialogs.js';

const html = readFileSync('index.html', 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
let dialogs, routes, onRename, downloadFile, showStatus;
const element = id => document.getElementById(id);
const key = (id, value, extra = {}) => element(id).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));

beforeEach(() => {
    document.body.innerHTML = html;
    localStorage.clear(); sessionStorage.clear();
    routes = [{ id: 1, name: 'Trail', coordinates: [[1, 2], [3, 4]], elevations: [0, null], times: [null, null], travelMode: 'WALK' }];
    onRename = vi.fn(); downloadFile = vi.fn(); showStatus = vi.fn();
    dialogs = createAppDialogs({ getRoute: id => routes.find(route => route.id === id), onRename, downloadFile, showStatus });
});
afterEach(() => { dialogs.destroy(); vi.restoreAllMocks(); });

test('returns focus to the route action after the invoking map popup is removed', () => {
    element('routesList').innerHTML = '<div class="route-item" data-route-id="1" tabindex="0"><button data-action="download-route">GPX</button></div>';
    const popup = document.createElement('button');
    popup.dataset.routeId = '1';
    popup.dataset.action = 'download-route';
    document.body.append(popup);
    popup.focus();
    dialogs.openFilenameModal(1);
    popup.remove();
    element('cancelFilenameBtn').click();
    expect(document.activeElement).toBe(element('routesList').querySelector('button'));
});

test('returns focus to the planner when a detached dialog invoker has no surviving route', () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    invoker.focus();
    dialogs.openApiKeyModal();
    invoker.remove();
    key('apiKeyInput', 'Escape');
    expect(document.activeElement).toBe(element('getRouteBtn'));
});

test('traps focus in both directions and restores it after Escape', () => {
    element('apiKeyMapBtn').focus(); dialogs.openApiKeyModal();
    expect(dialogs.isOpen('apiKeyModal')).toBe(true);
    expect(element('app').inert).toBe(true);
    const last = element('apiKeyModal').querySelector('.help-link');
    last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement.id).toBe('apiKeyInput');
    key('apiKeyInput', 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    key('saveApiKeyBtn', 'Escape');
    expect(dialogs.isOpen()).toBe(false);
    expect(element('app').inert).toBe(false);
    expect(document.activeElement.id).toBe('apiKeyMapBtn');
});

test('recovers the invoking action after a row is rerendered and after deletion', () => {
    element('routesList').innerHTML = '<div class="route-item" data-route-id="1"><button data-action="rename-route">Rename</button></div>';
    element('routesList').querySelector('button').focus(); dialogs.openRenameModal(1);
    element('routesList').innerHTML = '<div class="route-item" data-route-id="1"><button data-action="rename-route">Rename again</button></div>';
    key('renameInput', 'Escape');
    expect(document.activeElement.textContent).toBe('Rename again');
    dialogs.openRenameModal(1); element('routesList').replaceChildren();
    key('renameInput', 'Escape');
    expect(document.activeElement.id).toBe('getRouteBtn');
});

test('switches dialogs while retaining the original focus target', () => {
    element('apiKeyMapBtn').focus(); dialogs.openApiKeyModal();
    dialogs.openFilenameModal(1, null, 'trail.gpx');
    expect(element('apiKeyModal').classList.contains('visible')).toBe(false);
    expect(dialogs.isOpen('filenameModal')).toBe(true);
    key('filenameInput', 'Escape');
    expect(document.activeElement.id).toBe('apiKeyMapBtn');
});

test('rejects empty names, bounds rename text, and ignores a route removed before confirmation', () => {
    dialogs.openRenameModal(999); expect(dialogs.isOpen()).toBe(false);
    dialogs.openRenameModal(1); element('renameInput').value = '  '; key('renameInput', 'Enter');
    expect(onRename).not.toHaveBeenCalled(); expect(dialogs.isOpen()).toBe(true);
    element('renameInput').value = 'x'.repeat(250); element('confirmRenameBtn').click();
    expect(onRename).toHaveBeenCalledWith(1, 'x'.repeat(200)); expect(dialogs.isOpen()).toBe(false);
    dialogs.openRenameModal(1); routes = []; element('confirmRenameBtn').click();
    expect(onRename).toHaveBeenCalledTimes(1);
});

test('updates sanitized download previews and exports the current route with optional times', () => {
    dialogs.openFilenameModal(1, null, 'trail.gpx');
    expect(element('exportDataHint').textContent).toContain('Elevation: 1/2');
    element('filenameInput').value = 'A/B'; element('filenameInput').dispatchEvent(new Event('input'));
    expect(element('filenamePreview').textContent).toBe('A_B.gpx');
    routes[0].name = 'Updated trail'; routes[0].duration = '60s'; element('synthesizeTimes').checked = true;
    key('filenameInput', 'Enter');
    expect(downloadFile).toHaveBeenCalledWith(expect.stringContaining('<name>Updated trail</name>'), 'A_B.gpx', 'application/gpx+xml');
    expect(downloadFile.mock.calls[0][0]).toContain('<time>');
    element('confirmFilenameBtn').click(); expect(downloadFile).toHaveBeenCalledTimes(1);
});

test('cancels pending downloads on backdrop click and preserves fallback content', () => {
    dialogs.openFilenameModal(999, '<gpx/>', 'original.gpx');
    element('filenameModal').click(); element('confirmFilenameBtn').click();
    expect(downloadFile).not.toHaveBeenCalled();
    dialogs.openFilenameModal(999, '<gpx/>', 'original.gpx'); element('filenameInput').value = ' ';
    element('filenameInput').dispatchEvent(new Event('input'));
    expect(element('filenamePreview').textContent).toBe('original.gpx');
    element('confirmFilenameBtn').click();
    expect(downloadFile).toHaveBeenCalledWith('<gpx/>', 'original.gpx', 'application/gpx+xml');
});

test('keeps recorded times when timestamp synthesis is not selected', () => {
    routes[0].times[0] = '2020-01-01T00:00:00Z';
    dialogs.openFilenameModal(1, null, 'trail.gpx'); element('confirmFilenameBtn').click();
    const output = downloadFile.mock.calls[0][0];
    expect(new DOMParser().parseFromString(output, 'application/xml').querySelectorAll('trkpt > time')).toHaveLength(1);
    expect(output).toContain('2020-01-01T00:00:00.000Z');
});

test('removes saved keys and handles empty and unavailable tab storage', () => {
    localStorage.setItem('route2gpx_apiKey', 'old'); dialogs.openApiKeyModal();
    expect(element('rememberApiKey').checked).toBe(true);
    element('removeApiKeyBtn').click(); expect(dialogs.getApiKey()).toBe('');
    dialogs.openApiKeyModal(); element('apiKeyInput').value = ' '; key('apiKeyInput', 'Enter');
    expect(showStatus).toHaveBeenLastCalledWith('Please enter a valid API key', true);
    element('apiKeyInput').value = 'new-key'; element('rememberApiKey').checked = false;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
    element('saveApiKeyBtn').click();
    expect(dialogs.isOpen()).toBe(true);
    expect(showStatus).toHaveBeenLastCalledWith('API key could not be saved in this browser.', true);
    expect(error).toHaveBeenCalled();
});

test('describes pending and mixed elevation coverage in exports', () => {
    expect(exportDataDescription({ ...routes[0], elevationPending: true, elevationSource: { sampled: true, mixed: true } })).toContain('(still loading)');
    expect(exportDataDescription({ ...routes[0], elevationSource: { sampled: true, mixed: true } })).toContain('Recorded and SRTM elevations are combined.');
});

test('does not report removal success when saved key cleanup fails', () => {
    localStorage.setItem('route2gpx_apiKey', 'old-key');
    dialogs.openApiKeyModal();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Blocked'); });
    element('removeApiKeyBtn').click();
    expect(dialogs.isOpen('apiKeyModal')).toBe(true);
    expect(dialogs.getApiKey()).toBe('old-key');
    expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining('could not be removed'), true);
});

test.each([false, true])('reports a stale key when switching persistent storage to %s fails to clean up', remember => {
    (remember ? sessionStorage : localStorage).setItem(remember ? 'route2gpx_apiKey_session' : 'route2gpx_apiKey', 'old-key');
    dialogs.openApiKeyModal();
    element('apiKeyInput').value = 'new-key';
    element('rememberApiKey').checked = remember;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Blocked'); });
    element('saveApiKeyBtn').click();
    expect(dialogs.isOpen('apiKeyModal')).toBe(true);
    expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining('previous API key could not be removed'), true);
});

test('destroy dismisses the dialog, clears inert state, and detaches its handlers', () => {
    dialogs.openApiKeyModal(); dialogs.destroy();
    element('apiKeyMapBtn').click(); expect(dialogs.isOpen()).toBe(false);
    expect(element('app').inert).toBe(false);
});
