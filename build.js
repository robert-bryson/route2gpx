#!/usr/bin/env node
const esbuild = require('esbuild');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { parse } = require('yaml');

const cartoApiKey = (process.env.CARTO_API_KEY || '').trim();
if (process.env.AWS_APP_ID && !cartoApiKey) {
    console.error('CARTO_API_KEY must be set in the Amplify build environment.');
    process.exit(1);
}

const dist = path.join(__dirname, 'dist');

// Clean & create dist
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

// Runtime dependencies are pinned in the lockfile and served with the application.
const vendorDir = path.join(dist, 'vendor');
fs.mkdirSync(vendorDir);
function vendorAsset(packageName, filename, entry = `${packageName}/dist/${filename}`) {
    const source = fs.readFileSync(require.resolve(entry));
    const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
    const extension = path.extname(filename);
    const name = `${filename.slice(0, -extension.length)}.${hash}${extension}`;
    fs.writeFileSync(path.join(vendorDir, name), source);
    return { url: `vendor/${name}`, integrity: `sha384-${crypto.createHash('sha384').update(source).digest('base64')}` };
}
const leafletJs = vendorAsset('leaflet', 'leaflet.js');
const leafletCss = vendorAsset('leaflet', 'leaflet.css');
const jszip = vendorAsset('jszip', 'jszip.min.js');
const pako = vendorAsset('pako', 'pako.min.js', 'pako/browser');
const worker = esbuild.buildSync({ entryPoints: ['import-worker.js'], bundle: true, minify: true, platform: 'browser', format: 'iife', write: false });
const workerSource = worker.outputFiles[0].contents;
const workerName = `import-worker.${crypto.createHash('sha256').update(workerSource).digest('hex').slice(0, 12)}.js`;
fs.writeFileSync(path.join(dist, workerName), workerSource);
fs.cpSync(path.join(path.dirname(require.resolve('leaflet/dist/leaflet.css')), 'images'), path.join(vendorDir, 'images'), { recursive: true });
for (const [name, license] of [['leaflet', 'LICENSE'], ['jszip', 'LICENSE.markdown'], ['pako', 'LICENSE'], ['xmlchars', 'LICENSE']]) {
    fs.copyFileSync(path.join(path.dirname(require.resolve(`${name}/package.json`)), license), path.join(vendorDir, `${name}-LICENSE.txt`));
}
// The saxes 6.0.0 npm tarball omits its upstream license file.
fs.copyFileSync(path.join(__dirname, 'licenses/saxes.txt'), path.join(vendorDir, 'saxes-LICENSE.txt'));

// Bundle & minify JS from the ES module entry point.
const bundle = esbuild.buildSync({
    entryPoints: ['app.js'],
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'iife',
    define: {
        __CARTO_API_KEY__: JSON.stringify(cartoApiKey),
        __JSZIP_URL__: JSON.stringify(jszip.url),
        __JSZIP_INTEGRITY__: JSON.stringify(jszip.integrity),
        __PAKO_URL__: JSON.stringify(pako.url),
        __PAKO_INTEGRITY__: JSON.stringify(pako.integrity),
        __IMPORT_WORKER_URL__: JSON.stringify(workerName),
    },
    metafile: true,
    write: false,
    logLevel: 'silent',
});
const minified = bundle.outputFiles[0].text;

// Content hash for cache busting
const hash = crypto.createHash('md5').update(minified).digest('hex').slice(0, 8);
const bundleName = `app.bundle.${hash}.min.js`;
fs.writeFileSync(path.join(dist, bundleName), minified);

// Minify CSS and add a content hash for cache busting.
const cssSource = fs.readFileSync('styles.css', 'utf8');
const minifiedCss = esbuild.transformSync(cssSource, {
    loader: 'css',
    minify: true,
}).code;
const cssHash = crypto.createHash('md5').update(minifiedCss).digest('hex').slice(0, 8);
const stylesheetName = `styles.${cssHash}.css`;
fs.writeFileSync(path.join(dist, stylesheetName), minifiedCss);

// Process index.html: replace bundle reference + minify
let html = fs.readFileSync('index.html', 'utf8');
const headerConfig = parse(fs.readFileSync('customHttp.yml', 'utf8'));
const csp = headerConfig.customHeaders[0].headers.find(header => header.key === 'Content-Security-Policy').value;
html = html.replace('__CONTENT_SECURITY_POLICY__', csp.replace("; frame-ancestors 'none'", ''));
html = html.replace('app.bundle.min.js', bundleName);
html = html.replace('styles.css', stylesheetName);
html = html.replace('vendor/leaflet.js', leafletJs.url).replace('__LEAFLET_JS_SRI__', leafletJs.integrity);
html = html.replace('vendor/leaflet.css', leafletCss.url).replace('__LEAFLET_CSS_SRI__', leafletCss.integrity);

// Preserve whitespace-sensitive content; compression handles HTML whitespace well.

fs.writeFileSync(path.join(dist, 'index.html'), html);

// Copy static files
fs.copyFileSync('robots.txt', path.join(dist, 'robots.txt'));
fs.copyFileSync('favicon.svg', path.join(dist, 'favicon.svg'));

// Report
const origSize = fs.statSync('index.html').size + fs.statSync('styles.css').size + Object.keys(bundle.metafile.inputs).reduce((total, file) => total + fs.statSync(file).size, 0);
const distSize = fs.statSync(path.join(dist, 'index.html')).size + minified.length + minifiedCss.length;
console.log(`Built ${bundleName} (${(minified.length / 1024).toFixed(1)}KB)`);
console.log(`Built ${stylesheetName} (${(minifiedCss.length / 1024).toFixed(1)}KB)`);
console.log(`Total: ${(origSize / 1024).toFixed(1)}KB → ${(distSize / 1024).toFixed(1)}KB (${(100 - distSize / origSize * 100).toFixed(0)}% smaller)`);
