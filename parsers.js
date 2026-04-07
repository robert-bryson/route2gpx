// ============ FIT File Parser ============
// Extracts GPS trackpoints from Garmin FIT binary files
// Reference: Garmin FIT SDK Protocol specification

const SEMICIRCLE_TO_DEG = 180 / Math.pow(2, 31);
const FIT_EPOCH_OFFSET = 631065600; // seconds between Unix epoch (1970) and FIT epoch (1989-12-31)

function parseFIT(buffer) {
    const view = new DataView(buffer);

    // Parse header (12 or 14 bytes)
    const headerSize = view.getUint8(0);
    if (headerSize < 12) throw new Error('Invalid FIT header');

    const dataSize = view.getUint32(4, true);
    const magic = String.fromCharCode(
        view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
    );
    if (magic !== '.FIT') throw new Error('Not a valid FIT file');

    let offset = headerSize;
    const dataEnd = headerSize + dataSize;
    const definitions = {};
    const records = [];

    while (offset < dataEnd && offset < buffer.byteLength - 1) {
        const recordHeader = view.getUint8(offset);
        offset++;

        if (recordHeader & 0x80) {
            // Compressed timestamp header
            const localType = (recordHeader >> 5) & 0x03;
            const def = definitions[localType];
            if (!def) break;
            if (offset + def.totalSize > buffer.byteLength) break;
            const fieldData = readFITFields(view, offset, def);
            offset += def.totalSize;
            if (def.globalMessageNumber === 20) {
                const point = extractGPSPoint(fieldData);
                if (point) records.push(point);
            }
        } else if (recordHeader & 0x40) {
            // Definition message
            const localType = recordHeader & 0x0F;
            const hasDeveloperData = !!(recordHeader & 0x20);

            offset++; // reserved
            const architecture = view.getUint8(offset);
            offset++;
            const littleEndian = architecture === 0;
            const globalMessageNumber = view.getUint16(offset, littleEndian);
            offset += 2;
            const numFields = view.getUint8(offset);
            offset++;

            const fields = [];
            let totalSize = 0;
            for (let i = 0; i < numFields; i++) {
                const fieldDefNum = view.getUint8(offset);
                const size = view.getUint8(offset + 1);
                const baseType = view.getUint8(offset + 2) & 0x1F;
                offset += 3;
                fields.push({ fieldDefNum, size, baseType, offset: totalSize });
                totalSize += size;
            }

            if (hasDeveloperData) {
                const numDevFields = view.getUint8(offset);
                offset++;
                for (let i = 0; i < numDevFields; i++) {
                    const devSize = view.getUint8(offset + 1);
                    offset += 3;
                    totalSize += devSize;
                }
            }

            definitions[localType] = { globalMessageNumber, fields, totalSize, littleEndian };
        } else {
            // Data message
            const localType = recordHeader & 0x0F;
            const def = definitions[localType];
            if (!def) break;
            if (offset + def.totalSize > buffer.byteLength) break;
            const fieldData = readFITFields(view, offset, def);
            offset += def.totalSize;

            if (def.globalMessageNumber === 20) {
                const point = extractGPSPoint(fieldData);
                if (point) records.push(point);
            }
        }
    }

    if (records.length === 0) {
        throw new Error('No GPS data found in FIT file');
    }

    return {
        coordinates: records.map(r => [r.lat, r.lng]),
        elevations: records.map(r => r.elevation),
        name: null
    };
}

function readFITFields(view, offset, def) {
    const data = {};
    for (const field of def.fields) {
        const pos = offset + field.offset;
        if (pos + field.size > view.byteLength) continue;
        try {
            switch (field.baseType) {
                case 0: case 2: case 10: case 13: // enum, uint8, uint8z, byte
                    data[field.fieldDefNum] = view.getUint8(pos);
                    break;
                case 1: // sint8
                    data[field.fieldDefNum] = view.getInt8(pos);
                    break;
                case 3: // sint16
                    if (field.size >= 2) data[field.fieldDefNum] = view.getInt16(pos, def.littleEndian);
                    break;
                case 4: case 11: // uint16, uint16z
                    if (field.size >= 2) data[field.fieldDefNum] = view.getUint16(pos, def.littleEndian);
                    break;
                case 5: // sint32
                    if (field.size >= 4) data[field.fieldDefNum] = view.getInt32(pos, def.littleEndian);
                    break;
                case 6: case 12: // uint32, uint32z
                    if (field.size >= 4) data[field.fieldDefNum] = view.getUint32(pos, def.littleEndian);
                    break;
                case 8: // float32
                    if (field.size >= 4) data[field.fieldDefNum] = view.getFloat32(pos, def.littleEndian);
                    break;
                case 9: // float64
                    if (field.size >= 8) data[field.fieldDefNum] = view.getFloat64(pos, def.littleEndian);
                    break;
            }
        } catch (e) { /* skip unreadable field */ }
    }
    return data;
}

function extractGPSPoint(data) {
    // Field 0: position_lat (sint32, semicircles)
    // Field 1: position_long (sint32, semicircles)
    // Field 2: altitude (uint16, scale 5, offset 500)
    // Field 78: enhanced_altitude (uint32, scale 5, offset 500)
    const latRaw = data[0];
    const lngRaw = data[1];

    if (latRaw == null || lngRaw == null) return null;
    if (latRaw === 0x7FFFFFFF || lngRaw === 0x7FFFFFFF) return null; // invalid sentinel

    const lat = latRaw * SEMICIRCLE_TO_DEG;
    const lng = lngRaw * SEMICIRCLE_TO_DEG;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    let elevation = null;
    if (data[78] != null && data[78] !== 0xFFFFFFFF) {
        elevation = data[78] / 5 - 500; // enhanced_altitude
    } else if (data[2] != null && data[2] !== 0xFFFF) {
        elevation = data[2] / 5 - 500; // altitude
    }

    return { lat, lng, elevation };
}

// ============ TCX Parser ============
// Parses Garmin Training Center XML files

function parseTCX(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    if (doc.querySelector('parsererror')) {
        throw new Error('Invalid TCX file');
    }

    const coordinates = [];
    const elevations = [];

    const trackpoints = doc.querySelectorAll('Trackpoint');

    trackpoints.forEach(tp => {
        const pos = tp.querySelector('Position');
        if (!pos) return;

        const latEl = pos.querySelector('LatitudeDegrees');
        const lngEl = pos.querySelector('LongitudeDegrees');
        if (!latEl || !lngEl) return;

        const lat = parseFloat(latEl.textContent);
        const lng = parseFloat(lngEl.textContent);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        coordinates.push([lat, lng]);

        const altEl = tp.querySelector('AltitudeMeters');
        elevations.push(altEl ? parseFloat(altEl.textContent) : null);
    });

    if (coordinates.length === 0) throw new Error('No valid trackpoints found in TCX file');

    let name = null;
    const notesEl = doc.querySelector('Activity > Notes');
    if (notesEl) name = notesEl.textContent.trim();
    if (!name) {
        const idEl = doc.querySelector('Activity > Id');
        if (idEl) name = idEl.textContent.trim();
    }

    return { coordinates, elevations, name };
}

// ============ GeoJSON Parser ============

function parseGeoJSON(jsonString) {
    const geojson = JSON.parse(jsonString);
    const coordinates = [];
    const elevations = [];

    function extractCoord(coord) {
        if (typeof coord[0] === 'number' && typeof coord[1] === 'number') {
            coordinates.push([coord[1], coord[0]]); // GeoJSON is [lng, lat], we use [lat, lng]
            elevations.push(coord.length >= 3 && Number.isFinite(coord[2]) ? coord[2] : null);
        }
    }

    function processCoordArray(coords) {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0] === 'number') {
            extractCoord(coords);
        } else {
            coords.forEach(c => processCoordArray(c));
        }
    }

    function processGeometry(geometry) {
        if (!geometry || !geometry.coordinates) return;
        processCoordArray(geometry.coordinates);
    }

    if (geojson.type === 'FeatureCollection') {
        (geojson.features || []).forEach(f => processGeometry(f.geometry));
    } else if (geojson.type === 'Feature') {
        processGeometry(geojson.geometry);
    } else if (geojson.coordinates) {
        processGeometry(geojson);
    }

    if (coordinates.length === 0) throw new Error('No valid coordinates found in GeoJSON');

    let name = null;
    if (geojson.type === 'Feature' && geojson.properties?.name) {
        name = geojson.properties.name;
    } else if (geojson.type === 'FeatureCollection' && geojson.features?.[0]?.properties?.name) {
        name = geojson.features[0].properties.name;
    } else if (geojson.name) {
        name = geojson.name;
    }

    return { coordinates, elevations, name };
}
