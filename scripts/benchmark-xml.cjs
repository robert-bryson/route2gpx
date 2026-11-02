// Compare peak process memory against a historical DOM parser in isolated runs.
// Usage: node scripts/benchmark-xml.cjs [points=50000] [baseline=f4c77eb]
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

if (process.argv[2] === '--sample') {
    // Give both parsers the same jsdom startup cost for a fair comparison.
    const { JSDOM } = require('jsdom');
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
    const { parseGPX } = require(process.argv[3]);
    const points = Number(process.argv[4]);
    const point = '<trkpt lat="47" lon="-122"><ele>0</ele><time>2020-01-01T00:00:00Z</time></trkpt>';
    const source = `<gpx><trk><trkseg>${point.repeat(points)}</trkseg></trk></gpx>`;
    globalThis.gc();
    const started = performance.now();
    const result = parseGPX(source);
    if (result.coordinates.length !== points || result.times.length !== points) throw new Error('Incorrect benchmark output.');
    console.log(JSON.stringify({ points, milliseconds: Math.round(performance.now() - started), peakMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} else {
    const points = Number(process.argv[2] || 50000);
    if (!Number.isInteger(points) || points < 1 || points > 1000000) throw new Error('Choose 1 to 1,000,000 points.');
    const baseline = process.argv[3] || 'f4c77eb';
    const root = path.resolve(__dirname, '..');
    const directory = mkdtempSync(path.join(tmpdir(), 'route2gpx-xml-'));
    const esbuild = require('esbuild');
    try {
        const original = execFileSync('git', ['show', `${baseline}:gps-import.js`], { cwd: root, encoding: 'utf8' });
        const options = { bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' };
        const previous = path.join(directory, 'dom.cjs'), current = path.join(directory, 'incremental.cjs');
        esbuild.buildSync({ ...options, stdin: { contents: original, resolveDir: root }, outfile: previous });
        esbuild.buildSync({ ...options, entryPoints: [path.join(root, 'gps-import.js')], outfile: current });
        for (const [name, bundle] of [['DOM', previous], ['incremental', current]]) {
            const output = execFileSync(process.execPath, ['--expose-gc', __filename, '--sample', bundle, String(points)], { cwd: root, encoding: 'utf8', timeout: 60000 });
            console.log(`${name}: ${output.trim()}`);
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
