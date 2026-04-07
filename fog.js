// ============ Fog of World Data Format ============
// Ported from https://github.com/CaviarChen/fog-machine (MIT License)
// Implements parsing of Fog of World app data exports

const FOW_FILENAME_MASK1 = 'olhwjsktri';
const FOW_FILENAME_MASK2 = 'eizxdwknmo';
const FOW_FILENAME_ENCODING = {};
for (let i = 0; i < FOW_FILENAME_MASK1.length; i++) {
    FOW_FILENAME_ENCODING[FOW_FILENAME_MASK1.charAt(i)] = i;
}

const FOW_MAP_WIDTH = 512;
const FOW_TILE_WIDTH_OFFSET = 7;
const FOW_TILE_WIDTH = 1 << FOW_TILE_WIDTH_OFFSET; // 128
const FOW_TILE_HEADER_LEN = FOW_TILE_WIDTH ** 2; // 16384
const FOW_TILE_HEADER_SIZE = FOW_TILE_HEADER_LEN * 2; // 32768 bytes
const FOW_BLOCK_BITMAP_SIZE = 512;
const FOW_BLOCK_EXTRA_DATA = 3;
const FOW_BLOCK_SIZE = FOW_BLOCK_BITMAP_SIZE + FOW_BLOCK_EXTRA_DATA; // 515
const FOW_BITMAP_WIDTH_OFFSET = 6;
const FOW_BITMAP_WIDTH = 1 << FOW_BITMAP_WIDTH_OFFSET; // 64

// ============ Block ============
class FowBlock {
    constructor(x, y, bitmap) {
        this.x = x;
        this.y = y;
        this.bitmap = bitmap; // Uint8Array(512)
    }

    isVisited(x, y) {
        const bitOffset = 7 - (x % 8);
        const i = Math.floor(x / 8);
        const j = y;
        return (this.bitmap[i + j * 8] & (1 << bitOffset)) !== 0;
    }
}

// ============ Tile ============
class FowTile {
    constructor(id, x, y, blocks) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.blocks = blocks; // Map<string, FowBlock>
    }

    static makeKey(x, y) {
        return `${x}-${y}`;
    }

    static create(filename, data) {
        // Decode tile ID from filename
        const id = Number.parseInt(
            filename
                .slice(4, -2)
                .split('')
                .map(ch => FOW_FILENAME_ENCODING[ch])
                .join('')
        );
        const x = id % FOW_MAP_WIDTH;
        const y = Math.floor(id / FOW_MAP_WIDTH);

        // Decompress with pako
        const actualData = pako.inflate(new Uint8Array(data));

        // Parse header - 128x128 grid, each entry is uint16 index
        const header = new Uint16Array(
            actualData.slice(0, FOW_TILE_HEADER_SIZE).buffer
        );

        const blocks = new Map();

        for (let i = 0; i < header.length; i++) {
            const blockIdx = header[i];
            if (blockIdx > 0) {
                const blockX = i % FOW_TILE_WIDTH;
                const blockY = Math.floor(i / FOW_TILE_WIDTH);
                const startOffset = FOW_TILE_HEADER_SIZE + (blockIdx - 1) * FOW_BLOCK_SIZE;
                const endOffset = startOffset + FOW_BLOCK_SIZE;
                const blockData = actualData.slice(startOffset, endOffset);
                const bitmap = blockData.slice(0, FOW_BLOCK_BITMAP_SIZE);
                blocks.set(FowTile.makeKey(blockX, blockY), new FowBlock(blockX, blockY, bitmap));
            }
        }

        return new FowTile(id, x, y, blocks);
    }

    // Convert tile x,y to lng,lat (top-left corner of tile)
    static xyToLngLat(x, y) {
        const lng = (x / 512) * 360 - 180;
        const lat = (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 512)) * 180) / Math.PI;
        return [lng, lat];
    }
}

// ============ FogMap ============
class FogMap {
    constructor(tiles) {
        this.tiles = tiles; // Map<string, FowTile>
    }

    static createFromFiles(files) {
        const tiles = new Map();
        files.forEach(([filename, data]) => {
            try {
                const tile = FowTile.create(filename, data);
                if (tile.blocks.size > 0) {
                    tiles.set(FowTile.makeKey(tile.x, tile.y), tile);
                }
            } catch (e) {
                console.warn(`Skipping invalid tile file: ${filename}`, e);
            }
        });
        return new FogMap(tiles);
    }

    getBounds() {
        let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
        for (const tile of this.tiles.values()) {
            const [lng1, lat1] = FowTile.xyToLngLat(tile.x, tile.y);
            const [lng2, lat2] = FowTile.xyToLngLat(tile.x + 1, tile.y + 1);
            minLng = Math.min(minLng, lng1, lng2);
            maxLng = Math.max(maxLng, lng1, lng2);
            minLat = Math.min(minLat, lat1, lat2);
            maxLat = Math.max(maxLat, lat1, lat2);
        }
        return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
    }
}

// ============ Parse Fog of World ZIP ============
async function parseFogOfWorldZip(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const tileFiles = [];

    const entries = Object.entries(zip.files);
    for (const [path, file] of entries) {
        if (file.dir) continue;
        // Strip directory prefix, keep just filename
        const filename = path.replace(/^.*[\\/]/, '');
        if (!filename) continue;
        const data = await file.async('arraybuffer');
        tileFiles.push([filename, data]);
    }

    if (tileFiles.length === 0) {
        throw new Error('No tile files found in ZIP');
    }

    return FogMap.createFromFiles(tileFiles);
}

// ============ Leaflet Fog Layer ============
// Renders the fog overlay as a canvas tile layer on the Leaflet map.
// Visited areas are shown as transparent; unvisited areas have a semi-transparent overlay.

const FOW_TILE_ZOOM = 9; // Fog of World tiles correspond to zoom level 9 in slippy map tiles

function createFogCanvasLayer(fogMap, opacity) {
    const FogLayer = L.GridLayer.extend({
        createTile: function (coords) {
            const canvas = document.createElement('canvas');
            const tileSize = this.getTileSize();
            canvas.width = tileSize.x;
            canvas.height = tileSize.y;
            const ctx = canvas.getContext('2d');

            // Fill with semi-transparent overlay color
            ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
            ctx.fillRect(0, 0, tileSize.x, tileSize.y);

            const zoom = coords.z;

            try {
                if (zoom <= FOW_TILE_ZOOM) {
                    // One map tile may contain multiple FoW tiles
                    const fowTilesPerMapTile = 1 << (FOW_TILE_ZOOM - zoom);
                    const fowTileXMin = coords.x * fowTilesPerMapTile;
                    const fowTileYMin = coords.y * fowTilesPerMapTile;

                    const fowTilePixelSize = tileSize.x / fowTilesPerMapTile;

                    for (let fx = 0; fx < fowTilesPerMapTile; fx++) {
                        for (let fy = 0; fy < fowTilesPerMapTile; fy++) {
                            const fowTileX = fowTileXMin + fx;
                            const fowTileY = fowTileYMin + fy;
                            const tile = fogMap.tiles.get(FowTile.makeKey(fowTileX, fowTileY));
                            if (tile) {
                                renderFowTileOnCanvas(ctx, tile, fowTilePixelSize,
                                    fx * fowTilePixelSize, fy * fowTilePixelSize);
                            }
                        }
                    }
                } else if (zoom <= FOW_TILE_ZOOM + FOW_TILE_WIDTH_OFFSET) {
                    // One map tile corresponds to a portion of one FoW tile
                    const tileOverOffset = zoom - FOW_TILE_ZOOM;
                    const fowTileX = coords.x >> tileOverOffset;
                    const fowTileY = coords.y >> tileOverOffset;
                    const subTileMask = (1 << tileOverOffset) - 1;

                    const blocksPerMapTile = FOW_TILE_WIDTH >> tileOverOffset;
                    const blockXMin = (coords.x & subTileMask) * blocksPerMapTile;
                    const blockYMin = (coords.y & subTileMask) * blocksPerMapTile;

                    const blockPixelSize = tileSize.x / blocksPerMapTile;

                    const tile = fogMap.tiles.get(FowTile.makeKey(fowTileX, fowTileY));
                    if (tile) {
                        for (let bx = 0; bx < blocksPerMapTile; bx++) {
                            for (let by = 0; by < blocksPerMapTile; by++) {
                                const block = tile.blocks.get(FowTile.makeKey(blockXMin + bx, blockYMin + by));
                                if (block) {
                                    renderBlockOnCanvas(ctx, block, blockPixelSize,
                                        bx * blockPixelSize, by * blockPixelSize);
                                }
                            }
                        }
                    }
                } else {
                    // Sub-block rendering: one map tile shows part of one block
                    const tileOverOffset = zoom - FOW_TILE_ZOOM;
                    const fowTileX = coords.x >> tileOverOffset;
                    const fowTileY = coords.y >> tileOverOffset;

                    const blockOverOffset = zoom - FOW_TILE_ZOOM - FOW_TILE_WIDTH_OFFSET;
                    const subTileMask = (1 << (zoom - FOW_TILE_ZOOM)) - 1;
                    const blockX = (coords.x & subTileMask) >> blockOverOffset;
                    const blockY = (coords.y & subTileMask) >> blockOverOffset;

                    const subBlockMask = (1 << blockOverOffset) - 1;
                    const pixelsPerMapTile = FOW_BITMAP_WIDTH >> blockOverOffset;
                    const pixelXMin = (coords.x & subBlockMask) * pixelsPerMapTile;
                    const pixelYMin = (coords.y & subBlockMask) * pixelsPerMapTile;
                    const pixelSize = tileSize.x / pixelsPerMapTile;

                    const tile = fogMap.tiles.get(FowTile.makeKey(fowTileX, fowTileY));
                    if (tile) {
                        const block = tile.blocks.get(FowTile.makeKey(blockX, blockY));
                        if (block) {
                            for (let px = 0; px < pixelsPerMapTile; px++) {
                                for (let py = 0; py < pixelsPerMapTile; py++) {
                                    if (block.isVisited(pixelXMin + px, pixelYMin + py)) {
                                        ctx.clearRect(
                                            px * pixelSize, py * pixelSize,
                                            pixelSize, pixelSize
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('Fog tile render error at zoom', zoom, coords, e);
            }

            return canvas;
        }
    });

    return new FogLayer({
        tileSize: 256,
        maxZoom: 19,
        minZoom: 0
    });
}

function renderFowTileOnCanvas(ctx, fowTile, tilePixelSize, dx, dy) {
    const blockPixelSize = tilePixelSize / FOW_TILE_WIDTH;

    if (blockPixelSize < 1) {
        // Sub-pixel blocks: each block with data clears one output pixel
        for (const block of fowTile.blocks.values()) {
            const bx = Math.floor(block.x * blockPixelSize);
            const by = Math.floor(block.y * blockPixelSize);
            ctx.clearRect(dx + bx, dy + by, 1, 1);
        }
        return;
    }

    for (const block of fowTile.blocks.values()) {
        const blockDx = dx + block.x * blockPixelSize;
        const blockDy = dy + block.y * blockPixelSize;
        renderBlockOnCanvas(ctx, block, blockPixelSize, blockDx, blockDy);
    }
}

function renderBlockOnCanvas(ctx, block, blockPixelSize, dx, dy) {
    const pixelSize = blockPixelSize / FOW_BITMAP_WIDTH;

    if (pixelSize < 1) {
        // Sub-pixel bitmap: each visited pixel clears one output pixel
        for (let x = 0; x < FOW_BITMAP_WIDTH; x++) {
            for (let y = 0; y < FOW_BITMAP_WIDTH; y++) {
                if (block.isVisited(x, y)) {
                    const px = Math.floor(x * pixelSize);
                    const py = Math.floor(y * pixelSize);
                    ctx.clearRect(dx + px, dy + py, 1, 1);
                }
            }
        }
    } else {
        for (let x = 0; x < FOW_BITMAP_WIDTH; x++) {
            for (let y = 0; y < FOW_BITMAP_WIDTH; y++) {
                if (block.isVisited(x, y)) {
                    ctx.clearRect(
                        dx + x * pixelSize,
                        dy + y * pixelSize,
                        Math.ceil(pixelSize),
                        Math.ceil(pixelSize)
                    );
                }
            }
        }
    }
}

// ============ Fog of World Integration State ============
let currentFogLayer = null;
let currentFogMap = null;

function addFogOfWorldLayer(fogMap) {
    // Remove existing fog layer if any
    removeFogOfWorldLayer();

    currentFogMap = fogMap;
    currentFogLayer = createFogCanvasLayer(fogMap, 0.5);
    currentFogLayer.addTo(map);

    // Fit map to fog data bounds
    const bounds = fogMap.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    updateFogControls();
}

function removeFogOfWorldLayer() {
    if (currentFogLayer) {
        map.removeLayer(currentFogLayer);
        currentFogLayer = null;
        currentFogMap = null;
        updateFogControls();
    }
}

function toggleFogVisibility() {
    const checkbox = document.getElementById('fogVisibilityToggle');
    if (!currentFogLayer || !currentFogMap) return;
    if (checkbox.checked) {
        currentFogLayer.addTo(map);
    } else {
        map.removeLayer(currentFogLayer);
    }
}

function updateFogControls() {
    const badge = document.getElementById('fogBadge');
    if (currentFogMap) {
        badge.style.display = 'flex';
        document.getElementById('fogVisibilityToggle').checked = currentFogLayer && map.hasLayer(currentFogLayer);
    } else {
        badge.style.display = 'none';
    }
}

// ============ Fog of World File Handling ============
async function handleFogOfWorldFile(file) {
    showStatus('Loading Fog of World data...');

    try {
        const arrayBuffer = await file.arrayBuffer();
        const fogMap = await parseFogOfWorldZip(arrayBuffer);
        const tileCount = fogMap.tiles.size;

        if (tileCount === 0) {
            showStatus('No fog data found in the file', true);
            return;
        }

        addFogOfWorldLayer(fogMap);
        showStatus(`Fog of World loaded: ${tileCount} tile(s)`);
    } catch (e) {
        console.error('Failed to load Fog of World data:', e);
        showStatus('Failed to load Fog of World data: ' + e.message, true);
    }
}

function isFogOfWorldZip(file) {
    return file.name.toLowerCase().endsWith('.zip') &&
        !file.name.toLowerCase().endsWith('.gpx') &&
        !file.name.toLowerCase().endsWith('.kml');
}

// ============ Setup Fog of World UI ============
function setupFogOfWorld() {
    const dropZone = document.getElementById('fogDropZone');
    const fileInput = document.getElementById('fogFileInput');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', (e) => {
        // Only remove highlight when leaving the drop zone itself, not its children
        if (e.target === dropZone) {
            dropZone.classList.remove('drag-over');
        }
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFogOfWorldFile(files[0]);
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            handleFogOfWorldFile(fileInput.files[0]);
        }
        fileInput.value = '';
    });

    document.getElementById('fogRemoveBtn').addEventListener('click', () => {
        removeFogOfWorldLayer();
        showStatus('Fog of World layer removed');
    });

    document.getElementById('fogVisibilityToggle').addEventListener('change', toggleFogVisibility);

    updateFogControls();
}
