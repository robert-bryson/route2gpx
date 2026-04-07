#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const dist = path.join(__dirname, 'dist');

// Clean & create dist
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

// Bundle & minify JS
const src = ['parsers.js', 'fog.js', 'app.js'].map(f => fs.readFileSync(f, 'utf8')).join('\n');
const minified = execSync('npx esbuild --minify --loader=js', { input: src, encoding: 'utf8' });

// Content hash for cache busting
const hash = crypto.createHash('md5').update(minified).digest('hex').slice(0, 8);
const bundleName = `app.bundle.${hash}.min.js`;
fs.writeFileSync(path.join(dist, bundleName), minified);

// Process index.html: replace bundle reference + minify
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace('app.bundle.min.js', bundleName);

// Minify inline CSS
html = html.replace(/<style>([\s\S]*?)<\/style>/g, (match, css) => {
    const minCss = css
        .replace(/\/\*[\s\S]*?\*\//g, '')   // remove comments
        .replace(/\s*([{}:;,>~+])\s*/g, '$1') // collapse around symbols
        .replace(/\s+/g, ' ')                // collapse whitespace
        .replace(/;\}/g, '}')                // drop trailing semicolons
        .trim();
    return `<style>${minCss}</style>`;
});

// Minify HTML (collapse whitespace between tags, preserve pre/script/textarea)
html = html.replace(/>\s+</g, '><');
html = html.replace(/\s{2,}/g, ' ');

fs.writeFileSync(path.join(dist, 'index.html'), html);

// Copy static files
fs.copyFileSync('robots.txt', path.join(dist, 'robots.txt'));

// Report
const origSize = fs.statSync('index.html').size + src.length;
const distSize = fs.statSync(path.join(dist, 'index.html')).size + minified.length;
console.log(`Built ${bundleName} (${(minified.length / 1024).toFixed(1)}KB)`);
console.log(`Total: ${(origSize / 1024).toFixed(1)}KB → ${(distSize / 1024).toFixed(1)}KB (${(100 - distSize / origSize * 100).toFixed(0)}% smaller)`);
