#!/usr/bin/env node
const esbuild = require('esbuild');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const dist = path.join(__dirname, 'dist');

// Clean & create dist
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

// Bundle & minify JS from the ES module entry point.
const sourceFiles = ['app.js', 'parsers.js', 'fog.js', 'icons.js'];
const bundle = esbuild.buildSync({
    entryPoints: ['app.js'],
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'iife',
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
html = html.replace('app.bundle.min.js', bundleName);
html = html.replace('styles.css', stylesheetName);

// Minify HTML (collapse whitespace between tags, preserve pre/script/textarea)
html = html.replace(/>\s+</g, '><');
html = html.replace(/\s{2,}/g, ' ');

fs.writeFileSync(path.join(dist, 'index.html'), html);

// Copy static files
fs.copyFileSync('robots.txt', path.join(dist, 'robots.txt'));
fs.copyFileSync('favicon.svg', path.join(dist, 'favicon.svg'));

// Report
const origSize = fs.statSync('index.html').size + fs.statSync('styles.css').size + sourceFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
const distSize = fs.statSync(path.join(dist, 'index.html')).size + minified.length + minifiedCss.length;
console.log(`Built ${bundleName} (${(minified.length / 1024).toFixed(1)}KB)`);
console.log(`Built ${stylesheetName} (${(minifiedCss.length / 1024).toFixed(1)}KB)`);
console.log(`Total: ${(origSize / 1024).toFixed(1)}KB → ${(distSize / 1024).toFixed(1)}KB (${(100 - distSize / origSize * 100).toFixed(0)}% smaller)`);
