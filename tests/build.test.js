// @vitest-environment node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tileTemplate = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const buildInputs = [
  'build.js', 'app.js', 'parsers.js', 'fog.js', 'icons.js',
  'styles.css', 'index.html', 'robots.txt', 'favicon.svg',
];
const unconfiguredKeys = [
  ['missing', {}],
  ['empty', { CARTO_API_KEY: '' }],
  ['whitespace-only', { CARTO_API_KEY: ' \t\n ' }],
];
let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'route2gpx-build-'));
  for (const filename of buildInputs) {
    copyFileSync(join(projectRoot, filename), join(workspace, filename));
  }
  symlinkSync(join(projectRoot, 'node_modules'), join(workspace, 'node_modules'), 'junction');
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function runBuild(environment = {}) {
  const env = { ...process.env };
  delete env.CARTO_API_KEY;
  delete env.AWS_APP_ID;
  return spawnSync(process.execPath, ['build.js'], {
    cwd: workspace,
    env: { ...env, ...environment },
    encoding: 'utf8',
    timeout: 15000,
  });
}

function readBuild() {
  const dist = join(workspace, 'dist');
  const bundles = readdirSync(dist).filter(name => /^app\.bundle\.[a-f0-9]+\.min\.js$/.test(name));
  expect(bundles).toHaveLength(1);
  return {
    name: bundles[0],
    source: readFileSync(join(dist, bundles[0]), 'utf8'),
    html: readFileSync(join(dist, 'index.html'), 'utf8'),
  };
}

// Stop at the Leaflet boundary. The browser bundle must reach it without Node globals.
function readBasemapUrl(source) {
  const stoppedAtTileLayer = new Error('Basemap initialized');
  let tileUrl;
  expect(() => runInNewContext(source, {
    L: {
      map: () => ({}),
      tileLayer: (url) => {
        tileUrl = url;
        throw stoppedAtTileLayer;
      },
    },
  }, { timeout: 1000 })).toThrow(stoppedAtTileLayer);
  expect(tileUrl).toBeTypeOf('string');
  return tileUrl;
}

describe('CARTO build configuration', () => {
  test.each(unconfiguredKeys)('rejects a %s key in Amplify before removing existing artifacts', (_, environment) => {
    mkdirSync(join(workspace, 'dist'));
    const existingArtifact = join(workspace, 'dist', 'previous-build.txt');
    writeFileSync(existingArtifact, 'Keep the previous build');

    const result = runBuild({ AWS_APP_ID: 'test-amplify-app', ...environment });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CARTO_API_KEY must be set in the Amplify build environment.');
    expect(readFileSync(existingArtifact, 'utf8')).toBe('Keep the previous build');
  });

  test.each([
    ['local', {}],
    ['Amplify', { AWS_APP_ID: 'test-amplify-app' }],
  ])('uses the trimmed and encoded key in the %s browser bundle', (_, environment) => {
    const key = 'synthetic key?&=+/#"\n{}';
    const unrelatedSecret = 'unrelated-build-secret-must-stay-out';
    const result = runBuild({
      ...environment,
      CARTO_API_KEY: ` \t${key}\n `,
      UNRELATED_BUILD_SECRET: unrelatedSecret,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const bundle = readBuild();
    expect(readBasemapUrl(bundle.source)).toBe(`${tileTemplate}?key=${encodeURIComponent(key)}`);
    expect(bundle.html).toContain(bundle.name);
    expect(bundle.source).not.toContain(unrelatedSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain('synthetic key');
    expect(`${result.stdout}${result.stderr}`).not.toContain(unrelatedSecret);
  });

  test.each(unconfiguredKeys)('allows a %s key for local builds', (_, environment) => {
    const result = runBuild(environment);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(readBasemapUrl(readBuild().source)).toBe(tileTemplate);
  });

  test('changes the bundle URL when the key changes', () => {
    const firstResult = runBuild({ CARTO_API_KEY: 'first-synthetic-key' });
    expect(firstResult.status, firstResult.stderr).toBe(0);
    const first = readBuild();

    const secondResult = runBuild({ CARTO_API_KEY: 'second-synthetic-key' });
    expect(secondResult.status, secondResult.stderr).toBe(0);
    const second = readBuild();

    expect(first.html).toContain(first.name);
    expect(second.name).not.toBe(first.name);
    expect(second.html).toContain(second.name);
    expect(second.html).not.toContain(first.name);
    expect(readBasemapUrl(second.source)).toBe(`${tileTemplate}?key=second-synthetic-key`);
  });
});
