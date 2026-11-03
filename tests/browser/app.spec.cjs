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

for (const format of ['kml', 'geojson', 'tcx', 'csv']) {
    test(`downloads ${format} from the format popup with separate segments`, async ({ page }) => {
        await page.goto('/');
        await page.locator('#importFileInput').setInputFiles(file('recorded.gpx', track));
        const trigger = page.getByRole('button', { name: 'Download Recorded trail', exact: true });
        await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Download route', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('radio', { name: 'GPX GPS devices & outdoor apps', exact: true })).toBeFocused();
        await page.locator(`input[name="exportFormat"][value="${format}"]`).check();
        await expect(page.locator('#filenameInput')).toHaveValue(`imported_Recorded trail.${format}`);
        await page.locator('#filenameInput').fill('My route');
        await expect(page.locator('#filenamePreview')).toHaveText(`My route.${format}`);
        await page.locator('#exportDetails summary').click();
        await expect(page.locator('#exportDataHint')).toContainText('2 segment(s)');
        if (format === 'tcx') {
            await expect(page.locator('#synthesizeTimes')).toBeVisible();
            await expect(page.locator('#confirmFilenameBtn')).toBeDisabled();
            await expect(page.locator('#exportError')).toContainText('TCX needs a time for every point');
            await page.locator('#synthesizeTimes').check();
            await expect(page.locator('#synthesizeTimes')).toBeFocused();
            await expect(page.locator('#confirmFilenameBtn')).toBeEnabled();
        } else {
            await expect(page.locator('#synthesizeTimes')).not.toBeVisible();
        }
        const waiting = page.waitForEvent('download');
        await page.locator('#confirmFilenameBtn').click();
        const download = await waiting;
        expect(download.suggestedFilename()).toBe(`My route.${format}`);
        const source = await fs.readFile(await download.path(), 'utf8');
        if (format === 'geojson') {
            const json = JSON.parse(source);
            expect(json.geometry.type).toBe('MultiLineString');
            expect(json.geometry.coordinates.map(segment => segment.length)).toEqual([2, 2]);
            expect(json.geometry.coordinates[0][0]).toEqual([-122, 47, 0]);
            expect(json.properties.coordTimes).toEqual([['2020-01-01T00:00:00.000Z', null], [null, null]]);
        } else if (format === 'csv') {
            expect(source.split('\r\n')).toEqual([
                'segment,point,latitude,longitude,elevation_m,time',
                '1,1,47,-122,0,2020-01-01T00:00:00.000Z',
                '1,2,47.001,-122,,', '2,3,40,-74,,', '2,4,40.001,-74,,', '',
            ]);
        } else if (format === 'tcx') {
            expect(await page.evaluate(xml => {
                const doc = new DOMParser().parseFromString(xml, 'application/xml');
                return {
                    tracks: doc.querySelectorAll('Course > Track').length,
                    times: doc.querySelectorAll('Trackpoint > Time').length,
                    generated: doc.querySelector('Notes').textContent.includes('generated estimates'),
                    error: Boolean(doc.querySelector('parsererror')),
                };
            }, source)).toEqual({ tracks: 2, times: 4, generated: true, error: false });
        } else {
            expect(await page.evaluate(xml => {
                const doc = new DOMParser().parseFromString(xml, 'application/xml');
                return { lines: doc.querySelectorAll('MultiGeometry > LineString').length, error: Boolean(doc.querySelector('parsererror')) };
            }, source)).toEqual({ lines: 2, error: false });
        }
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
    });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
    test(`keeps the download popup usable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/');
        await page.locator('#importFileInput').setInputFiles(file('recorded.gpx', track));
        await page.locator('button[data-mobile-view="planner"]').click();
        const trigger = page.locator('.route-item [data-action="download-route"]');
        await trigger.click();
        const modal = page.locator('#filenameModal .modal');
        const bounds = await modal.boundingBox();
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        expect(await modal.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
        for (const id of ['cancelFilenameBtn', 'confirmFilenameBtn']) {
            const button = await page.locator(`#${id}`).boundingBox();
            expect(button.y).toBeGreaterThanOrEqual(0);
            expect(button.y + button.height).toBeLessThanOrEqual(viewport.height);
        }
        await page.keyboard.press('ArrowDown');
        await expect(page.locator('input[value="kml"]')).toBeChecked();
        await page.keyboard.press('Shift+Tab');
        await expect(page.locator('#confirmFilenameBtn')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('input[value="kml"]')).toBeFocused();
        await page.locator('#exportDetails summary').click();
        await page.locator('input[value="tcx"]').check();
        await expect(page.locator('#synthesizeTimes')).toBeVisible();
        await page.locator('#synthesizeTimes').check();
        await expect(page.locator('#synthesizeTimes')).toBeFocused();
        await expect(page.locator('#confirmFilenameBtn')).toBeEnabled();
        expect(await modal.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
        await page.locator('#filenameInput').focus();
        const focusSpace = await page.locator('#filenameInput').evaluate(input => {
            const bounds = input.getBoundingClientRect();
            const body = input.closest('.export-body').getBoundingClientRect();
            const style = getComputedStyle(input);
            return { left: bounds.left - body.left, right: body.right - bounds.right,
                outline: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) };
        });
        expect(focusSpace.left).toBeGreaterThanOrEqual(focusSpace.outline);
        expect(focusSpace.right).toBeGreaterThanOrEqual(focusSpace.outline);
        await page.locator('#cancelFilenameBtn').click();
        await expect(trigger).toBeFocused();
    });
}

test('keeps focus on route actions, renames, and restores a deleted route', async ({ page }) => {
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles(file('recorded.gpx', track));
    await expect(page.locator('.route-item')).toHaveCount(1);
    await page.locator('[data-action="toggle-visibility"]').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-action="toggle-visibility"]')).toBeFocused();
    await page.locator('[data-action="rename-route"]').click();
    await page.locator('#renameInput').focus();
    const spacing = await page.locator('#renameInput').evaluate(input => {
        const bounds = input.getBoundingClientRect();
        const label = document.querySelector('label[for="renameInput"]').getBoundingClientRect();
        const actions = document.querySelector('#renameModal .btn-row').getBoundingClientRect();
        const style = getComputedStyle(input);
        return {
            above: bounds.top - label.bottom,
            below: actions.top - bounds.bottom,
            outline: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
        };
    });
    expect(spacing.above).toBeGreaterThanOrEqual(spacing.outline);
    expect(spacing.below).toBeGreaterThan(spacing.outline);
    await page.locator('#renameInput').fill('My renamed trail');
    await page.locator('#confirmRenameBtn').click();
    await expect(page.locator('.route-item-title')).toHaveText('My renamed trail');
    await page.locator('[data-action="remove-route"]').click();
    await expect(page.locator('.route-item')).toHaveCount(0);
    await page.locator('#undoDeleteBtn').click();
    await expect(page.locator('.route-item-title')).toHaveText('My renamed trail');
});

test('restores keyboard focus after a map popup download dialog closes', async ({ page }) => {
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles(file('recorded.gpx', track));
    const row = page.locator('.route-item');
    const rowDownload = row.locator('[data-action="download-route"]');
    for (const dismiss of ['cancel', 'escape']) {
        await row.focus();
        await page.keyboard.press('Enter');
        const popupDownload = page.locator('.leaflet-popup [data-action="download-route"]');
        await popupDownload.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#filenameModal')).toBeVisible();
        await expect(popupDownload).toHaveCount(0);
        if (dismiss === 'cancel') await page.locator('#cancelFilenameBtn').click();
        else await page.keyboard.press('Escape');
        await expect(page.locator('#filenameModal')).not.toBeVisible();
        await expect(rowDownload).toBeFocused();
    }
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

test('imports XML on the main thread and in workers without DOMParser or compatibility globals', async ({ page }) => {
    await page.addInitScript(() => {
        window.DOMParser = class { constructor() { throw new Error('XML DOM parsing is disabled for this test'); } };
    });
    const workerRequests = [];
    page.on('request', request => { if (request.url().includes('/import-worker.')) workerRequests.push(request.url()); });
    await page.goto('/');
    await page.locator('#importFileInput').setInputFiles(file('small.gpx', track));
    await expect(page.locator('.route-item')).toHaveCount(1);
    const kml = `<kml><!--${'x'.repeat(300 * 1024)}--><Placemark><name>Large KML</name><LineString><coordinates>2,1,0 4,3,5</coordinates></LineString></Placemark></kml>`;
    await page.locator('#importFileInput').setInputFiles(file('large.kml', kml));
    await expect(page.locator('.route-item')).toHaveCount(2);
    const tcx = '<TrainingCenterDatabase><Course><Name>Compressed TCX</Name><Track><Trackpoint><Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position></Trackpoint><Trackpoint><Position><LatitudeDegrees>3</LatitudeDegrees><LongitudeDegrees>4</LongitudeDegrees></Position></Trackpoint></Track></Course></TrainingCenterDatabase>';
    await page.locator('#importFileInput').setInputFiles({ name: 'course.tcx.gz', mimeType: 'application/gzip', buffer: gzipSync(tcx) });
    await expect(page.locator('.route-item')).toHaveCount(3);
    expect(workerRequests).toHaveLength(2);
    expect(await page.evaluate(() => ['getRoute', 'routes', 'distanceUnit', 'parseFIT', 'setupFogOfWorld', 'ICON_PATHS', 'iconSvg', 'renderIconPlaceholders'].filter(name => Object.hasOwn(window, name)))).toEqual([]);
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
    const start = page.getByRole('button', { name: 'Origin: Start town', exact: true });
    await expect(start).toHaveAttribute('title', 'Origin: Start town');
    await start.hover();
    await expect(page.locator('.leaflet-tooltip')).toHaveText('Origin: Start town');
    await expect(page.getByRole('button', { name: 'Destination: End town', exact: true })).toHaveAttribute('title', 'Destination: End town');
    await page.locator('[data-action="remove-route"]').click();
    await expect(page.locator('.route-item')).toHaveCount(0);
    await page.locator('#origin').dispatchEvent('input');
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
});

test('names picked points, retains planner pins, clears points, and reuses a saved route', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    await page.locator('#fetchElevation').uncheck();
    let lookups = 0, request;
    await page.route('https://maps.googleapis.com/**', route => route.fulfill({ json: { status: 'OK', results: [{ formatted_address: `Picked place ${++lookups}` }] } }));
    await page.route('https://routes.googleapis.com/**', route => {
        request = route.request().postDataJSON();
        return route.fulfill({ json: { routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }] } });
    });
    let picked = 0;
    for (const [button, label, x, y] of [
        ['originMapPickBtn', '#originPlaceName', 240, 180],
        ['destinationMapPickBtn', '#destinationPlaceName', 480, 350],
        ['pickWaypointMapBtn', '.stop-location .location-name', 380, 240],
    ]) {
        await page.locator(`#${button}`).click();
        await page.locator('#map').click({ position: { x, y } });
        await expect(page.locator(label)).toHaveText(`Picked place ${++picked}`);
    }
    await page.keyboard.press('Escape');
    const origin = await page.locator('#origin').inputValue();
    const destination = await page.locator('#destination').inputValue();
    const waypoint = await page.locator('.stop-input').inputValue();
    await expect(page.getByRole('button', { name: 'Origin: Picked place 1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Waypoint 1: Picked place 3', exact: true })).toBeVisible();
    await page.locator('#getRouteBtn').click();
    await expect(page.locator('.route-item-title')).toHaveText('Picked place 1 → Picked place 2');
    const coordinates = value => { const [latitude, longitude] = value.split(',').map(Number); return { location: { latLng: { latitude, longitude } } }; };
    expect(request.origin).toEqual(coordinates(origin));
    expect(request.destination).toEqual(coordinates(destination));
    expect(request.intermediates).toEqual([coordinates(waypoint)]);
    await expect(page.locator('.planner-marker')).toHaveCount(3);
    await page.reload();
    await expect(page.locator('#originPlaceName')).toHaveText('Picked place 1');
    await expect(page.locator('.planner-marker')).toHaveCount(3);
    await page.getByRole('button', { name: 'Clear origin', exact: true }).click();
    await expect(page.locator('#origin')).toHaveValue('');
    await expect(page.locator('#originPlaceName')).not.toBeVisible();
    await expect(page.locator('#destination')).toHaveValue(destination);
    await expect(page.locator('.stop-input')).toHaveValue(waypoint);
    await expect(page.locator('.planner-marker')).toHaveCount(2);
    await page.getByRole('button', { name: 'Clear planner', exact: true }).click();
    await expect(page.locator('#destination')).toHaveValue('');
    await expect(page.locator('.stop-input')).toHaveCount(0);
    await expect(page.locator('.planner-marker')).toHaveCount(0);
    await expect(page.locator('.route-item')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('#origin')).toHaveValue('');
    await expect(page.locator('.planner-marker')).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit / reuse', exact: true }).click();
    await expect(page.locator('#origin')).toHaveValue(origin);
    await expect(page.locator('.stop-input')).toHaveValue(waypoint);
    await expect(page.locator('#destinationPlaceName')).toHaveText('Picked place 2');
    await expect(page.locator('.planner-marker')).toHaveCount(3);
    expect(lookups).toBe(3);
});

test('does not restore cleared planner points when a place lookup finishes late', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    let release, started = false;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('https://maps.googleapis.com/**', async route => {
        started = true;
        await waiting;
        await route.fulfill({ json: { status: 'OK', results: [{ formatted_address: 'Old place' }] } });
    });
    await page.locator('#originMapPickBtn').click();
    await page.locator('#map').click({ position: { x: 250, y: 200 } });
    await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: 'Clear planner', exact: true }).click();
    release();
    await page.locator('#origin').fill('New origin');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('route2gpx_draft')).origin)).toBe('New origin');
    await expect(page.locator('#originPlaceName')).not.toBeVisible();
    await expect(page.locator('.planner-marker')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#origin')).toHaveValue('New origin');
});

test('names GPS points as plain text and retains exact coordinates', async ({ page }) => {
    await mockGeolocation(page);
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    const name = '<img src=x onerror=alert(1)> Trailhead';
    await page.route('https://maps.googleapis.com/**', route => route.fulfill({ json: { status: 'OK', results: [{ formatted_address: name }] } }));
    await page.locator('[data-gps-field="origin"]').click();
    await page.evaluate(() => window.pendingPosition.success({ coords: { latitude: 38.5, longitude: -120.2 } }));
    await expect(page.locator('#originPlaceName')).toHaveText(name);
    await expect(page.locator('#origin')).toHaveValue('38.500000, -120.200000');
    await expect(page.getByRole('button', { name: `Origin: ${name}`, exact: true })).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test('clearing the planner cancels a pending route calculation', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    await page.locator('#origin').fill('Seattle');
    await page.locator('#destination').fill('Portland');
    let release, started = false;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('https://routes.googleapis.com/**', async route => {
        started = true;
        await waiting;
        await route.fulfill({ json: { routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }] } });
    });
    await page.locator('#getRouteBtn').click();
    await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: 'Clear planner', exact: true }).click();
    release();
    await expect(page.locator('#getRouteBtn')).toBeEnabled();
    await expect(page.locator('#origin')).toHaveValue('');
    await expect(page.locator('#destination')).toHaveValue('');
    await expect(page.locator('.route-item')).toHaveCount(0);
});

test('keeps typed-coordinate geocoding off when saving a key and reusing a route', async ({ page }) => {
    await page.goto('/');
    let lookups = 0;
    await page.route('https://maps.googleapis.com/**', route => {
        lookups++;
        return route.fulfill({ json: { status: 'OK', results: [{ formatted_address: 'Unrequested place' }] } });
    });
    await page.route('https://routes.googleapis.com/**', route => route.fulfill({ json: { routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] } }));
    await page.locator('#origin').fill('38.5, -120.2');
    await page.locator('#destination').fill('40.7, -120.95');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    await page.locator('#fetchElevation').uncheck();
    await expect(page.locator('#labelCoordinates')).not.toBeChecked();
    await page.locator('#getRouteBtn').click();
    await expect(page.locator('.route-item')).toHaveCount(1);
    expect(lookups).toBe(0);
    await page.getByRole('button', { name: 'Clear planner', exact: true }).click();
    await page.getByRole('button', { name: 'Edit / reuse', exact: true }).click();
    await expect(page.locator('#origin')).toBeFocused();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('route2gpx_draft')).origin)).toBe('38.5, -120.2');
    expect(lookups).toBe(0);
});

test('invalidates typed-coordinate names when the planner is reset', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    await page.locator('#fetchElevation').uncheck();
    await page.locator('#labelCoordinates').check();
    await page.locator('#origin').fill('38.5, -120.2');
    await page.locator('#destination').fill('40.7, -120.95');
    let release, started = 0, delivered = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('https://maps.googleapis.com/**', async route => {
        started++;
        await waiting;
        await route.fulfill({ json: { status: 'OK', results: [{ formatted_address: 'Cleared name' }] } });
        delivered++;
    });
    await page.route('https://routes.googleapis.com/**', route => route.fulfill({ json: { routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] } }));
    await page.locator('#getRouteBtn').click();
    await expect.poll(() => started).toBe(2);
    await page.getByRole('button', { name: 'Clear planner', exact: true }).click();
    release();
    await expect.poll(() => delivered).toBe(2);
    await page.locator('#origin').fill('38.5, -120.2');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('route2gpx_draft')).origin)).toBe('38.5, -120.2');
    await expect(page.locator('#originPlaceName')).not.toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('route2gpx_draft')).placeNames)).toEqual({});
    await expect(page.locator('.route-item')).toHaveCount(1);
});

test('keeps a planner pin focused when its place name arrives', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-action="open-api-key"]').click();
    await page.locator('#apiKeyInput').fill('synthetic-test-key');
    await page.locator('#saveApiKeyBtn').click();
    let release, started = false;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('https://maps.googleapis.com/**', async route => {
        started = true;
        await waiting;
        await route.fulfill({ json: { status: 'OK', results: [{ formatted_address: 'Named trailhead' }] } });
    });
    await page.locator('#originMapPickBtn').click();
    await page.locator('#map').click({ position: { x: 250, y: 200 } });
    await expect.poll(() => started).toBe(true);
    const pin = page.locator('.planner-marker');
    const original = await pin.elementHandle();
    await pin.focus();
    release();
    await expect(pin).toHaveAttribute('aria-label', 'Origin: Named trailhead');
    await expect(pin).toBeFocused();
    expect(await original.evaluate(element => element.isConnected)).toBe(true);
    for (const key of ['Enter', 'Space']) {
        await pin.focus();
        await page.keyboard.press(key);
        await expect(page.locator('#origin')).toBeFocused();
    }
});

test('keeps waypoint pin numbers and keyboard focus aligned with input rows', async ({ page }) => {
    await page.goto('/');
    await page.locator('#addStopBtn').click();
    await page.locator('#addStopBtn').click();
    await page.locator('.stop-input').nth(1).fill('38.5, -120.2');
    await expect(page.getByRole('button', { name: 'Waypoint 2: 38.5, -120.2', exact: true })).toBeVisible();
    const remove = page.getByRole('button', { name: 'Remove waypoint 1', exact: true });
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.stop-input')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Waypoint 1: 38.5, -120.2', exact: true })).toBeVisible();
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#destination')).toBeFocused();
    await expect(page.locator('.planner-marker')).toHaveCount(0);
});

for (const [reason, encodedPolyline] of [
    ['latitude above 90', '_mljP???'],
    ['positive delta with its high bit set', '}~~~~~B???'],
    ['negative delta with its high bit set', '~~~~~~B???'],
]) {
    test(`rejects invalid route geometry before saving or drawing: ${reason}`, async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-action="open-api-key"]').click();
        await page.locator('#apiKeyInput').fill('synthetic-test-key');
        await page.locator('#saveApiKeyBtn').click();
        await page.locator('#origin').fill('Origin');
        await page.locator('#destination').fill('Destination');
        await page.route('https://routes.googleapis.com/**', route => route.fulfill({ json: { routes: [{ polyline: { encodedPolyline } }] } }));
        await page.locator('#getRouteBtn').click();
        await expect(page.locator('#status')).toContainText('Route geometry was missing or invalid');
        await expect(page.locator('#getRouteBtn')).toBeEnabled();
        await expect(page.locator('.route-item')).toHaveCount(0);
        await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem('route2gpx_routes'))).toBeNull();
    });
}

for (const width of [1440, 390, 320]) {
    test(`keeps planner tooltips inside the sidebar at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        const sidebar = page.locator('.sidebar');
        const expectNoHorizontalScroll = async () => {
            const sizes = await sidebar.evaluate(element => {
                element.scrollLeft = 1000;
                return { width: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft };
            });
            expect(sizes.scrollWidth).toBe(sizes.width);
            expect(sizes.scrollLeft).toBe(0);
        };
        await expectNoHorizontalScroll();
        for (const id of ['origin-help', 'waypoints-help', 'destination-help']) {
            await page.locator(`[aria-describedby="${id}"]`).focus();
            const tooltip = page.locator(`#${id}`);
            await expect(tooltip).toBeVisible();
            const bounds = await sidebar.boundingBox();
            const tip = await tooltip.boundingBox();
            expect(tip.x).toBeGreaterThanOrEqual(bounds.x);
            expect(tip.x + tip.width).toBeLessThanOrEqual(bounds.x + bounds.width);
            await expectNoHorizontalScroll();
        }
    });
}

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
