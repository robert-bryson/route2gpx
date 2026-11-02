/** Tests for Fog of World import hardening. */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as pako from 'pako';
import JSZip from 'jszip';
import { FowBlock, FowTile, FogMap, createFogCanvasLayer, addFogOfWorldLayer, parseFogOfWorldZip, handleFogOfWorldFile, setupFogOfWorld, removeFogOfWorldLayer } from '../fog.js';

let context;
const memoryLimit = 512 * 1024 * 1024;
function compressedTile(references = [0]) {
  const bytes = new Uint8Array(32768 + 515);
  const header = new DataView(bytes.buffer);
  for (const index of references) header.setUint16(index * 2, 1, true);
  bytes[32768] = 0x80;
  return pako.deflate(bytes);
}

beforeEach(() => {
  globalThis.pako = pako;
  document.body.innerHTML = '<div id="fogDropZone"></div><input id="fogFileInput" type="file"><div id="fogBadge"></div><button id="fogRemoveBtn"></button><input id="fogVisibilityToggle" type="checkbox">';
  context = { showStatus: vi.fn(), assertFileSize: vi.fn(), ensureJSZip: vi.fn(), ensurePako: vi.fn(), map: {} };
  setupFogOfWorld(context);
});

describe('Fog memory limits', () => {
  test('charges each retained bitmap, including aliased block references', () => {
    const budget = { bytes: 0 };
    const tile = FowTile.create('0000oaa', compressedTile([0, 1, 2]), budget);
    expect(tile.blocks.size).toBe(3);
    expect(budget.bytes).toBe(32768 + 515 + 3 * 512);
    expect(tile.blocks.get('0-0').isVisited(0, 0)).toBe(true);
  });

  test('stops allocation when aliased blocks exhaust the budget', () => {
    const budget = { bytes: memoryLimit - 32768 - 515 - 512 };
    expect(() => FowTile.create('0000oaa', compressedTile([0, 1, 2]), budget)).toThrow('too large');
    expect(budget.bytes).toBeLessThanOrEqual(memoryLimit);
  });

  test('shares the budget across tiles and fails the import when it is exhausted', () => {
    const budget = { bytes: memoryLimit - 2 * (32768 + 515) - 512 };
    const files = [['0000oaa', compressedTile()], ['0000laa', compressedTile()]];
    expect(() => FogMap.createFromFiles(files, budget)).toThrow('too large');
  });

  test('still skips ordinary corrupt tiles while retaining valid tiles', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = FogMap.createFromFiles([['0000oaa', pako.deflate(new Uint8Array(4))], ['0000laa', compressedTile()]]);
    expect(map.tiles.size).toBe(1);
    expect(map.tiles.get('1-0').blocks.size).toBe(1);
  });
});

afterEach(() => {
  removeFogOfWorldLayer();
  vi.restoreAllMocks();
});

describe('parseFogOfWorldZip', () => {
  test('rejects ZIPs without tile files', async () => {
    globalThis.JSZip = {
      loadAsync: vi.fn().mockResolvedValue({ files: {} }),
    };

    await expect(parseFogOfWorldZip(new ArrayBuffer(1))).rejects.toThrow('No tile files');
  });

  test('rejects declared decompressed size before inflating entries', async () => {
    const readEntry = vi.fn();
    globalThis.JSZip = {
      loadAsync: vi.fn().mockResolvedValue({
        files: {
          'tiles/oversized.tile': {
            dir: false,
            _data: { uncompressedSize: Number.MAX_SAFE_INTEGER },
            async: readEntry,
          },
        },
      }),
    };

    await expect(parseFogOfWorldZip(new ArrayBuffer(1))).rejects.toThrow('too large after decompression');
    expect(readEntry).not.toHaveBeenCalled();
  });
});

describe('handleFogOfWorldFile', () => {
  test('rejects non-zip files before loading ZIP dependencies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleFogOfWorldFile({
      name: 'notes.txt',
      size: 12,
      arrayBuffer: vi.fn(),
    });

    expect(context.showStatus).toHaveBeenLastCalledWith(
      'Failed to load Fog of World data: Fog of World import requires a .zip export.',
      true,
    );
    expect(context.ensureJSZip).not.toHaveBeenCalled();
    expect(context.ensurePako).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// The adapter supplies Leaflet's layer contract; drawing uses the real renderer.
describe('Fog canvas rendering', () => {
  let drawing;
  beforeEach(() => {
    drawing = { fillRect: vi.fn(), clearRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(drawing);
    vi.stubGlobal('L', {
      GridLayer: { extend: definition => class {
        constructor(options) { this.options = options; }
        getTileSize() { return { x: 256, y: 256 }; }
        createTile(coords) { return definition.createTile.call(this, coords); }
      } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function fogMap(blockX = 0, blockY = 0, pixelX = 0, pixelY = 0, tileX = 0, tileY = 0) {
    const bitmap = new Uint8Array(512);
    bitmap[pixelY * 8 + Math.floor(pixelX / 8)] = 1 << (7 - pixelX % 8);
    const block = new FowBlock(blockX, blockY, bitmap);
    const tile = new FowTile(0, tileX, tileY, new Map([[`${blockX}-${blockY}`, block]]));
    return new FogMap(new Map([[`${tileX}-${tileY}`, tile]]));
  }

  test.each([
    [7, 0, 0, 0, 0, 0, 0, [0, 0, 1, 1]],
    [9, 1, 2, 32, 32, 0, 0, [3, 5, 1, 1]],
    [10, 64, 64, 0, 0, 1, 1, [0, 0, 1, 1]],
    [16, 1, 2, 4, 5, 1, 2, [16, 20, 4, 4]],
    [17, 1, 2, 34, 3, 3, 4, [16, 24, 8, 8]],
    [19, 1, 2, 17, 26, 10, 19, [32, 64, 32, 32]],
  ])('clears the visited cell at zoom %s with correct offsets', (zoom, bx, by, px, py, x, y, rectangle) => {
    const layer = createFogCanvasLayer(fogMap(bx, by, px, py), 0.5);
    const canvas = layer.createTile({ x, y, z: zoom });
    expect(canvas.width).toBe(256); expect(canvas.height).toBe(256);
    expect(drawing.fillStyle).toBe('rgba(0, 0, 0, 0.5)');
    expect(drawing.fillRect).toHaveBeenCalledWith(0, 0, 256, 256);
    expect(drawing.clearRect.mock.calls).toEqual([rectangle]);
  });

  test.each([7, 10, 17])('leaves missing tiles covered at zoom %s', zoom => {
    createFogCanvasLayer(new FogMap(new Map()), 0.4).createTile({ x: 0, y: 0, z: zoom });
    expect(drawing.clearRect).not.toHaveBeenCalled();
  });

  test('places multiple Fog tiles within one lower-zoom map tile', () => {
    createFogCanvasLayer(fogMap(0, 0, 0, 0, 1, 1), 0.5).createTile({ x: 0, y: 0, z: 8 });
    expect(drawing.clearRect).toHaveBeenCalledWith(128, 128, 1, 1);
  });

  test('keeps unvisited blocks covered even when a whole block is smaller than a pixel', () => {
    const empty = new FowTile(0, 0, 0, new Map([['0-0', new FowBlock(0, 0, new Uint8Array(512))]]));
    createFogCanvasLayer(new FogMap(new Map([['0-0', empty]])), 0.5).createTile({ x: 0, y: 0, z: 7 });
    expect(drawing.clearRect).not.toHaveBeenCalled();
  });

  test('reports renderer failures and keeps the overlay tile usable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = fogMap(); map.tiles.get('0-0').blocks.values = () => { throw new Error('Corrupt block'); };
    const canvas = createFogCanvasLayer(map, 0.5).createTile({ x: 0, y: 0, z: 9 });
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(warn).toHaveBeenCalledWith('Fog tile render error at zoom', 9, expect.any(Object), expect.any(Error));
  });
});

describe('Fog overlay lifecycle and controls', () => {
  let layers;
  beforeEach(() => {
    layers = new Set();
    context.map = {
      fitBounds: vi.fn(), hasLayer: layer => layers.has(layer),
      removeLayer: vi.fn(layer => layers.delete(layer)),
    };
    vi.stubGlobal('L', {
      GridLayer: { extend: () => class {
        addTo() { layers.add(this); return this; }
      } },
      latLngBounds: vi.fn((southWest, northEast) => ({ southWest, northEast, isValid: () => true })),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const mapWithTile = () => new FogMap(new Map([['1-0', FowTile.create('0000laa', compressedTile())]]));
  test('fits visited tile bounds and supports hiding, showing, replacing, and removing overlays', () => {
    const fogMap = mapWithTile();
    addFogOfWorldLayer(fogMap);
    const first = [...layers][0];
    expect(context.map.fitBounds).toHaveBeenCalledWith(expect.objectContaining({ southWest: expect.any(Array) }), { padding: [50, 50] });
    expect(document.getElementById('fogBadge').hidden).toBe(false);
    const toggle = document.getElementById('fogVisibilityToggle');
    expect(toggle.checked).toBe(true);
    toggle.checked = false; toggle.dispatchEvent(new Event('change')); expect(layers.size).toBe(0);
    toggle.checked = true; toggle.dispatchEvent(new Event('change')); expect(layers.has(first)).toBe(true);
    addFogOfWorldLayer(mapWithTile());
    expect(layers.size).toBe(1); expect(layers.has(first)).toBe(false);
    document.getElementById('fogRemoveBtn').click();
    expect(layers.size).toBe(0); expect(document.getElementById('fogBadge').hidden).toBe(true);
    expect(context.showStatus).toHaveBeenLastCalledWith('Fog of World layer removed');
    toggle.dispatchEvent(new Event('change')); expect(layers.size).toBe(0);
  });

  test('reads a real archive and installs its overlay', async () => {
    const zip = new JSZip(); zip.file('tiles/0000oaa', compressedTile());
    vi.stubGlobal('JSZip', JSZip);
    await handleFogOfWorldFile({ name: 'world.ZIP', size: 100, arrayBuffer: () => zip.generateAsync({ type: 'arraybuffer' }) });
    expect(context.assertFileSize).toHaveBeenCalledWith(expect.any(Object), 250 * 1024 * 1024, 'world.ZIP');
    expect(layers.size).toBe(1);
    expect(context.showStatus).toHaveBeenLastCalledWith('Fog of World loaded: 1 tile(s)');
  });

  test('reports corrupt archives without adding an empty overlay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const zip = new JSZip(); zip.file('0000oaa', new Uint8Array([0]));
    vi.stubGlobal('JSZip', JSZip);
    await handleFogOfWorldFile({ name: 'empty.zip', size: 100, arrayBuffer: () => zip.generateAsync({ type: 'arraybuffer' }) });
    expect(layers.size).toBe(0);
    expect(context.showStatus).toHaveBeenLastCalledWith('No fog data found in the file', true);
  });

  test('opens the picker by keyboard and manages drag highlighting across child elements', () => {
    const drop = document.getElementById('fogDropZone'), input = document.getElementById('fogFileInput');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    for (const key of ['Enter', ' ']) drop.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(2);
    const drag = new Event('dragover', { cancelable: true });
    Object.defineProperty(drag, 'dataTransfer', { value: { dropEffect: 'none' } });
    drop.dispatchEvent(drag);
    expect(drag.dataTransfer.dropEffect).toBe('copy'); expect(drop.classList.contains('drag-over')).toBe(true);
    const child = document.createElement('span'); drop.appendChild(child);
    child.dispatchEvent(new Event('dragleave', { bubbles: true })); expect(drop.classList.contains('drag-over')).toBe(true);
    drop.dispatchEvent(new Event('dragleave')); expect(drop.classList.contains('drag-over')).toBe(false);
  });

  test.each(['drop', 'change'])('reports invalid files selected through %s', async eventType => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const files = [{ name: 'notes.txt', size: 5 }];
    const event = new Event(eventType, { cancelable: true });
    if (eventType === 'drop') {
      Object.defineProperty(event, 'dataTransfer', { value: { files } });
      document.getElementById('fogDropZone').dispatchEvent(event);
    } else {
      const input = document.getElementById('fogFileInput');
      Object.defineProperty(input, 'files', { value: files }); input.dispatchEvent(event);
      expect(input.value).toBe('');
    }
    await vi.waitFor(() => expect(context.showStatus).toHaveBeenLastCalledWith(expect.stringContaining('requires a .zip'), true));
    expect(layers.size).toBe(0);
  });
});
