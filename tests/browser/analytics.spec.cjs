const { test, expect } = require('@playwright/test');

const source = '<?xml version="1.0"?><gpx><trk><name>Private route</name><trkseg><trkpt lat="38.1" lon="-90.1"/><trkpt lat="38.2" lon="-90.2"/></trkseg></trk></gpx>';
const tracker = `
  window.__events = [];
  const beforeSend = window[document.currentScript.dataset.beforeSend];
  window.umami = { track(callback) {
    const clean = beforeSend('event', callback({ url: location.href, title: document.title, referrer: document.referrer }));
    if (clean) window.__events.push(clean);
    return Promise.resolve();
  } };
`;

async function productionOrigin(page, baseURL) {
  await page.route('https://route2gpx.rsmb.tv/**', async route => {
    const request = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${baseURL}${request.pathname}${request.search}` }) });
  });
}

test('records a private import and a CSV export without collecting route data', async ({ page, baseURL }) => {
  await productionOrigin(page, baseURL);
  await page.route('https://cloud.umami.is/script.js', route => route.fulfill({ contentType: 'application/javascript', body: tracker }));
  await page.goto('https://route2gpx.rsmb.tv/?token=secret#private');
  await page.locator('#importFileInput').setInputFiles({ name: 'private-home.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(source) });
  await expect(page.locator('#importSummaryTitle')).toContainText('Imported 1 of 1');
  await page.locator('#routesList [data-action="download-route"]').first().click();
  await page.locator('input[name="exportFormat"][value="csv"]').check();
  await page.locator('#confirmFilenameBtn').click();
  await expect.poll(() => page.evaluate(() => window.__events)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'file-import-finished', data: { outcome: 'success', format: 'gpx' } }),
    expect.objectContaining({ name: 'export-generated', data: { format: 'csv', routeCount: '1' } }),
  ]));
  const events = await page.evaluate(() => window.__events);
  expect(JSON.stringify(events)).not.toMatch(/private|secret|38\.1|-90\.1/i);
});

test('does not load the tracker when Global Privacy Control is enabled', async ({ page, baseURL }) => {
  await productionOrigin(page, baseURL);
  let requests = 0;
  await page.route('https://cloud.umami.is/script.js', route => { requests++; return route.abort(); });
  await page.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
  await page.goto('https://route2gpx.rsmb.tv/');
  await expect(page.locator('#umami-analytics')).toHaveCount(0);
  expect(requests).toBe(0);
});
