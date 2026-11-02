const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const JSZip = require('jszip');
const { gzipSync, deflateSync } = require('node:zlib');

const track = '<gpx><trk><name>Recorded trail</name><trkseg><trkpt lat="47" lon="-122"><ele>0</ele><time>2020-01-01T00:00:00Z</time></trkpt><trkpt lat="47.001" lon="-122"/></trkseg><trkseg><trkpt lat="40" lon="-74"/><trkpt lat="40.001" lon="-74"/></trkseg></trk></gpx>';
const file = (name, content) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) });

test.beforeEach(async ({ page }) => {
    // Keep browser journeys independent of tile-provider availability and credentials.
    await page.route(/https:\/\/[a-d]\.basemaps\.cartocdn\.com\//, route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxXkAAAAASUVORK5CYII=', 'base64') }));
});

async function mockGeolocation(page) {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: { getCurrentPosition: (success, error) => { window.pendingPosition = { success, error }; } },
        });
    });
    await page.goto('/');
}

test('preserves edited planner values when geolocation completes late', async ({ page }) => {
    await mockGeolocation(page);
    await page.locator('#origin').fill('Original origin');
    await page.locator('[data-gps-field="origin"]').click();
    await page.locator('#origin').fill('New origin');
    await page.locator('#origin').fill('Original origin');
    await page.evaluate(() => window.pendingPosition.success({ coords: { latitude: 10, longitude: 20 } }));
    await expect(page.locator('#origin')).toHaveValue('Original origin');
});

test('persists accepted geolocation and reports permission errors', async ({ page }) => {
    await mockGeolocation(page);
    await page.locator('[data-gps-field="origin"]').click();
    await page.evaluate(() => window.pendingPosition.success({ coords: { latitude: 10, longitude: 20 } }));
    await expect(page.locator('#origin')).toHaveValue('10.000000, 20.000000');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('route2gpx_draft'))?.origin)).toBe('10.000000, 20.000000');
    await page.reload();
    await expect(page.locator('#origin')).toHaveValue('10.000000, 20.000000');
    await page.locator('[data-gps-field="destination"]').click();
    await page.evaluate(() => window.pendingPosition.error({ code: 1, message: 'Permission denied' }));
    await expect(page.locator('#status')).toContainText('Permission denied');
    await expect(page.locator('#destination')).toHaveValue('');
});

test('imports without a key, preserves gaps and recorded fields through reload and download', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.locator('#apiKeyModal')).not.toBeVisible();
    await page.locator('#importFileInput').setInputFiles(file('recorded.gpx', track));
    await expect(page.locator('.route-item')).toHaveCount(1);
    await expect(page.locator('.route-item-meta')).toContainText('0.2 km');
    await page.reload();
    await expect(page.locator('.route-item')).toHaveCount(1);
    await page.locator('[data-action="download-route"]').first().click();
    await expect(page.locator('#exportDataHint')).toContainText('2 segment(s)');
    const download = page.waitForEvent('download');
    await page.locator('#confirmFilenameBtn').click();
    const xml = await fs.readFile(await (await download).path(), 'utf8');
    const exported = await page.evaluate(source => {
        const doc = new DOMParser().parseFromString(source, 'application/xml');
        return { segments: doc.querySelectorAll('trkseg').length, points: doc.querySelectorAll('trkpt').length, elevations: [...doc.querySelectorAll('trkpt > ele')].map(node => node.textContent), times: [...doc.querySelectorAll('trkpt > time')].map(node => node.textContent) };
    }, xml);
    expect(exported).toEqual({ segments: 2, points: 4, elevations: ['0'], times: ['2020-01-01T00:00:00.000Z'] });
    expect(errors).toEqual([]);
});

test('exports every identically named KML track into a distinct ZIP entry', async ({ page }) => {
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles(file('two.kml', '<kml><Document><Placemark><name>Same</name><LineString><coordinates>1,1 2,2</coordinates></LineString></Placemark><Placemark><name>Same</name><LineString><coordinates>3,3 4,4</coordinates></LineString></Placemark></Document></kml>'));
    await expect(page.locator('.route-item')).toHaveCount(2);
    const download = page.waitForEvent('download');
    await page.locator('#downloadAllBtn').click();
    const zip = await JSZip.loadAsync(await fs.readFile(await (await download).path()));
    expect(Object.keys(zip.files)).toEqual(['imported_Same.gpx', 'imported_Same_2.gpx']);
    await expect(page.locator('#batchExportSummary')).toBeVisible();
    await expect(page.locator('#batchExportItems li')).toHaveCount(2);
    await expect(page.locator('#batchExportItems li').first()).toContainText('Elevation: 0/2 points');
});

test('keeps focus on route actions, renames, and restores a deleted route', async ({ page }) => {
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles(file('recorded.gpx', track));
    await expect(page.locator('.route-item')).toHaveCount(1);
    await page.locator('[data-action="toggle-visibility"]').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-action="toggle-visibility"]')).toBeFocused();
    await page.locator('[data-action="rename-route"]').click();
    await page.locator('#renameInput').fill('My renamed trail');
    await page.locator('#confirmRenameBtn').click();
    await expect(page.locator('.route-item-title')).toHaveText('My renamed trail');
    await page.locator('[data-action="remove-route"]').click();
    await expect(page.locator('.route-item')).toHaveCount(0);
    await page.locator('#undoDeleteBtn').click();
    await expect(page.locator('.route-item-title')).toHaveText('My renamed trail');
});

test('keeps a persistence failure visible after import success', async ({ page }) => {
    await page.addInitScript(() => {
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === 'route2gpx_routes' || key.startsWith('route2gpx_geometry_')) throw new DOMException('Storage full', 'QuotaExceededError');
            return write.call(this, key, value);
        };
    });
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles(file('recorded.gpx', track));
    await expect(page.locator('.route-item')).toHaveCount(1);
    await expect(page.locator('#status')).toContainText('Imported');
    await expect(page.locator('#storageWarning')).toBeVisible();
});

test('uses the local import worker for gzip and large GeoJSON files', async ({ page }) => {
    await page.goto('/');
    const workerRequests = [];
    page.on('request', request => { if (request.url().includes('/import-worker.')) workerRequests.push(request.url()); });
    await page.locator('#importFileInput').setInputFiles({ name: 'recorded.gpx.gz', mimeType: 'application/gzip', buffer: gzipSync(track) });
    await expect(page.locator('.route-item')).toHaveCount(1);
    const json = JSON.stringify({ type: 'LineString', coordinates: Array.from({ length: 20000 }, (_, i) => [-120 + i / 100000, 40 + i / 100000]) });
    await page.locator('#importFileInput').setInputFiles(file('large.geojson', json));
    await expect(page.locator('.route-item')).toHaveCount(2);
    expect(workerRequests).toHaveLength(2);
    await expect(page.locator('#storageWarning')).not.toBeVisible();
});

test('loads the self-hosted Pako browser build for Fog of World imports', async ({ page }) => {
    const tile = new Uint8Array(32768 + 515);
    new DataView(tile.buffer).setUint16(0, 1, true);
    tile[32768] = 0x80;
    const zip = new JSZip();
    zip.file('0000oaa', deflateSync(tile));
    await page.goto('/');
    await page.locator('#fogFileInput').setInputFiles({ name: 'fog.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
    await expect(page.locator('#fogBadge')).toBeVisible();
    await expect(page.locator('#status')).toContainText('Fog of World loaded: 1 tile(s)');
});

test('cancels a worker import and keeps mixed-file results visible', async ({ page }) => {
    await page.route('**/import-worker.*.js', route => route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage = () => {};' }));
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles({ name: 'recorded.gpx.gz', mimeType: 'application/gzip', buffer: gzipSync(track) });
    await expect(page.locator('#cancelImportBtn')).toBeVisible();
    await page.locator('#cancelImportBtn').click();
    await expect(page.locator('#importSummaryItems')).toContainText('Import cancelled');
    await expect(page.locator('.route-item')).toHaveCount(0);
    await page.locator('#importFileInput').setInputFiles([file('bad.txt', 'invalid'), file('good.gpx', track)]);
    await expect(page.locator('#importSummaryTitle')).toHaveText('Imported 1 of 2 file(s)');
    await expect(page.locator('#importSummaryItems')).toContainText('bad.txt: Unsupported file type');
    await expect(page.locator('.route-item')).toHaveCount(1);
});

test('keeps warnings for partially imported file contents in the results', async ({ page }) => {
    await page.goto('/');
    const partial = '<gpx><trk><trkseg><trkpt/><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk><trk><trkseg><trkpt lat="3" lon="3"/></trkseg></trk></gpx>';
    await page.locator('#importFileInput').setInputFiles(file('partial.gpx', partial));
    await expect(page.locator('.route-item')).toHaveCount(1);
    await expect(page.locator('#importSummaryTitle')).toHaveText('Imported 1 of 1 file(s)');
    await expect(page.locator('#importSummary')).toHaveAttribute('open', '');
    await expect(page.locator('#importSummaryItems')).toContainText('Skipped 1 invalid point(s).');
    await expect(page.locator('#importSummaryItems')).toContainText('Skipped 1 track(s)');
    await page.locator('#importFileInput').setInputFiles(file('mixed.geojson', JSON.stringify({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[1, 1], [2, 2]] }, { type: 'Polygon', coordinates: [] }] })));
    await expect(page.locator('#importSummaryItems')).toContainText('Skipped 1 unsupported geometry item(s).');
    await expect(page.locator('#importSummary')).toHaveAttribute('open', '');
});

test('retains completed elevation batches when paused and reloaded', async ({ page }) => {
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles(file('partial.geojson', JSON.stringify({ type: 'LineString', coordinates: Array.from({ length: 150 }, (_, index) => [index / 1000, 0]) })));
    await expect(page.locator('.route-item')).toHaveCount(1);
    let requests = 0, release;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('**/api/elevation/**', async route => {
        requests++;
        if (requests > 1) await waiting;
        const count = new URL(route.request().url()).searchParams.get('locations').split('|').length;
        await route.fulfill({ json: { status: 'OK', results: Array.from({ length: count }, () => ({ elevation: 25 })) } });
    });
    await page.locator('[data-action="retry-elevation"]').click();
    await expect.poll(() => requests).toBe(2);
    await page.locator('[data-action="cancel-elevation"]').click();
    await expect(page.locator('.route-item-meta')).toContainText('elevation paused');
    release();
    await page.reload();
    await page.locator('[data-action="download-route"]').click();
    await expect(page.locator('#exportDataHint')).toContainText('Elevation: 100/150 points');
});

test('prevents unsupported transit waypoints before requesting a route', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    await page.locator('#origin').fill('Seattle');
    await page.locator('#destination').fill('Portland');
    await page.locator('#addStopBtn').click();
    await page.locator('.stop-input').fill('Tacoma');
    await page.locator('[data-travel-mode="TRANSIT"]').click();
    let requests = 0;
    await page.route('https://routes.googleapis.com/**', route => { requests++; return route.abort(); });
    await page.locator('#getRouteBtn').click();
    await expect(page.locator('#status')).toContainText('Transit routes do not support');
    expect(requests).toBe(0);
});

test('guards keyboard resubmissions, retains billing errors and key, and supports reuse', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    await page.locator('#fetchElevation').uncheck();
    await page.locator('#origin').fill('Seattle');
    await page.locator('#destination').fill('Portland');
    let count = 0, release;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('https://routes.googleapis.com/**', async route => {
        count++;
        await waiting;
        await route.fulfill({ json: { routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, distanceMeters: 1234, duration: '600s' }] } });
    });
    await page.locator('#origin').press('Enter');
    await page.locator('#origin').press('Enter');
    await expect(page.locator('#getRouteBtn')).toBeDisabled();
    await expect.poll(() => count).toBe(1);
    release();
    await expect(page.locator('.route-item')).toHaveCount(1);
    await page.locator('[data-action="edit-route"]').click();
    await expect(page.locator('#origin')).toHaveValue('Seattle');
    await page.unroute('https://routes.googleapis.com/**');
    await page.route('https://routes.googleapis.com/**', route => route.fulfill({ status: 403, json: { error: { message: 'Billing is disabled.' } } }));
    await page.locator('#getRouteBtn').click();
    await expect(page.locator('#status')).toContainText('Billing is disabled.');
    await expect(page.locator('#apiKeyModal')).not.toBeVisible();
    await page.locator('[data-action="open-api-key"]').click();
    await expect(page.locator('#apiKeyInput')).toHaveValue('synthetic-test-key');
});

test('draws a route before labels resolve and updates named map endpoints', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    await page.locator('#fetchElevation').uncheck();
    await page.locator('#labelCoordinates').check();
    await page.locator('#origin').fill('38.5, -120.2');
    await page.locator('#destination').fill('43.252, -126.453');
    await page.route('https://routes.googleapis.com/**', route => route.fulfill({ json: { routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }] } }));
    let release;
    const labels = new Promise(resolve => { release = resolve; });
    await page.route('https://maps.googleapis.com/**', async route => {
        await labels;
        const origin = new URL(route.request().url()).searchParams.get('latlng').startsWith('38.5');
        await route.fulfill({ json: { status: 'OK', results: [{ formatted_address: origin ? 'Start town' : 'End town' }] } });
    });
    await page.locator('#getRouteBtn').click();
    await expect(page.locator('.route-item')).toHaveCount(1);
    await expect(page.locator('.route-item-meta')).not.toContainText('adding elevation');
    release();
    await expect(page.locator('.route-item-title')).toHaveText('Start town → End town');
    const start = page.getByRole('button', { name: 'Start: Start town', exact: true });
    await expect(start).toHaveAttribute('title', 'Start: Start town');
    await start.hover();
    await expect(page.locator('.leaflet-tooltip')).toHaveText('Start: Start town');
    await expect(page.getByRole('button', { name: 'End: End town', exact: true })).toHaveAttribute('title', 'End: End town');
    await page.locator('[data-action="remove-route"]').click();
    await expect(page.locator('.route-item')).toHaveCount(0);
    await page.locator('#origin').dispatchEvent('input');
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
});

for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
    test(`keeps dialogs and map controls reachable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/');
        expect((await page.locator('#origin').boundingBox()).width).toBeGreaterThan(200);
        await page.locator('[data-action="open-api-key"]').click();
        const modal = await page.locator('#apiKeyModal .modal').boundingBox();
        expect(modal.y).toBeGreaterThanOrEqual(0);
        expect(modal.y + modal.height).toBeLessThanOrEqual(viewport.height);
        await page.locator('#closeModalBtn').click();
        await page.locator('button[data-mobile-view="map"]').click();
        const controls = await page.locator('.map-controls').boundingBox();
        expect(controls.y).toBeGreaterThanOrEqual(0);
        expect(controls.y + controls.height).toBeLessThanOrEqual(viewport.height - 56);
        await page.locator('button[data-mobile-view="planner"]').click();
        await expect(page.locator('#origin')).toBeVisible();
    });
}
