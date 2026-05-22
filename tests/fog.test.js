/** Tests for Fog of World import hardening. */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import '../fog.js';

beforeEach(() => {
  globalThis.showStatus = vi.fn();
  globalThis.assertFileSize = vi.fn();
  globalThis.ensureJSZip = vi.fn();
  globalThis.ensurePako = vi.fn();
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