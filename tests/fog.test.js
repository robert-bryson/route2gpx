/** Tests for Fog of World import hardening. */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as pako from 'pako';
import { FowTile, FogMap } from '../fog.js';

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
  globalThis.showStatus = vi.fn();
  globalThis.assertFileSize = vi.fn();
  globalThis.ensureJSZip = vi.fn();
  globalThis.ensurePako = vi.fn();
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
  vi.restoreAllMocks();
});

describe('parseFogOfWorldZip', () => {
  test('rejects ZIPs without tile files', async () => {
    globalThis.JSZip = {
      loadAsync: vi.fn().mockResolvedValue({ files: {} }),
    };

    await expect(globalThis.parseFogOfWorldZip(new ArrayBuffer(1))).rejects.toThrow('No tile files');
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

    await expect(globalThis.parseFogOfWorldZip(new ArrayBuffer(1))).rejects.toThrow('too large after decompression');
    expect(readEntry).not.toHaveBeenCalled();
  });
});

describe('handleFogOfWorldFile', () => {
  test('rejects non-zip files before loading ZIP dependencies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await globalThis.handleFogOfWorldFile({
      name: 'notes.txt',
      size: 12,
      arrayBuffer: vi.fn(),
    });

    expect(globalThis.showStatus).toHaveBeenLastCalledWith(
      'Failed to load Fog of World data: Fog of World import requires a .zip export.',
      true,
    );
    expect(globalThis.ensureJSZip).not.toHaveBeenCalled();
    expect(globalThis.ensurePako).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
