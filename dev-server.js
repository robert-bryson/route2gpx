#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse } = require('yaml');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4173;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid --port.');
const root = path.join(__dirname, 'dist');
const watch = args.includes('--watch');
if (watch) execFileSync(process.execPath, ['build.js'], { cwd: __dirname, stdio: 'inherit' });
if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('Build first with npm run build, or use npm run dev.');
const policy = parse(fs.readFileSync(path.join(__dirname, 'customHttp.yml'), 'utf8'));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname.startsWith('/api/elevation/')) {
            response.writeHead(503, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'Elevation requires the deployed proxy; local imports and exports are available.' } }));
            return;
        }
        const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404); response.end('Not found'); return;
        }
        for (const { key, value } of policy.customHeaders[0].headers) response.setHeader(key, value);
        // Preview revalidates assets so a source edit is visible on refresh.
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Content-Type', mimeTypes[path.extname(file)] || 'application/octet-stream');
        fs.createReadStream(file).pipe(response);
    } catch { response.writeHead(400); response.end('Invalid request'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Route to GPX preview: http://127.0.0.1:${port}`));

if (watch) {
    let timer;
    fs.watch(__dirname, (_event, filename) => {
        if (!filename || !/\.(js|css|html|yml)$/.test(filename) || filename === 'dev-server.js') return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            try { execFileSync(process.execPath, ['build.js'], { cwd: __dirname, stdio: 'inherit' }); }
            catch { console.error('Build failed; fix the source and save again.'); }
        }, 150);
    });
}
