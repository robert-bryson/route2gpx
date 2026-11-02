import { normalizeTrack, MAX_TRACK_POINTS } from './track-data.js';

// ============ FIT File Parser ============
// Extracts GPS trackpoints from Garmin FIT binary files
// Reference: Garmin FIT SDK Protocol specification

const SEMICIRCLE_TO_DEG = 180 / Math.pow(2, 31);
const FIT_EPOCH_OFFSET = 631065600; // seconds between Unix epoch (1970) and FIT epoch (1989-12-31)

function isValidLatitudeLongitude(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function parseFIT(buffer) {
    if (!buffer || buffer.byteLength < 12) throw new Error('Invalid FIT header');
    const view = new DataView(buffer);

    // Parse header (12 or 14 bytes)
    const headerSize = view.getUint8(0);
    if (headerSize < 12 || headerSize > buffer.byteLength) throw new Error('Invalid FIT header');

    const dataSize = view.getUint32(4, true);
    const magic = String.fromCharCode(
        view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
    );
    if (magic !== '.FIT') throw new Error('Not a valid FIT file');

    let offset = headerSize;
    const dataEnd = headerSize + dataSize;
    if (dataEnd > buffer.byteLength) throw new Error('Truncated FIT data');
    const definitions = {};
    const records = [];
    let timestamp = null;
    const recordPoint = data => {
        if (records.length >= MAX_TRACK_POINTS) throw new Error('FIT file contains too many track points.');
        records.push(extractGPSPoint(data) || { lat: null, lng: null, elevation: null, time: null });
    };

    while (offset < dataEnd) {
        const recordHeader = view.getUint8(offset);
        offset++;

        if (recordHeader & 0x80) {
            // Compressed timestamp header
            const localType = (recordHeader >> 5) & 0x03;
            const def = definitions[localType];
            if (!def) throw new Error('Undefined FIT message');
            if (offset + def.compressedSize > dataEnd) throw new Error('Truncated FIT record');
            if (timestamp === null) throw new Error('FIT compressed timestamp has no reference time');
            const fieldData = readFITFields(view, offset, def, true);
            offset += def.compressedSize;
            // Garmin FIT protocol: preserve the upper timestamp bits and roll the low five bits.
            timestamp += ((recordHeader & 0x1F) - timestamp % 32 + 32) % 32;
            fieldData[253] = timestamp;
            if (def.globalMessageNumber === 20) {
                recordPoint(fieldData);
            }
        } else if (recordHeader & 0x40) {
            // Definition message
            const localType = recordHeader & 0x0F;
            const hasDeveloperData = !!(recordHeader & 0x20);
            if (offset + 5 > dataEnd) throw new Error('Truncated FIT definition');

            offset++; // reserved
            const architecture = view.getUint8(offset);
            offset++;
            const littleEndian = architecture === 0;
            const globalMessageNumber = view.getUint16(offset, littleEndian);
            offset += 2;
            const numFields = view.getUint8(offset);
            offset++;
            if (offset + numFields * 3 > dataEnd) throw new Error('Truncated FIT field definitions');

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
                if (offset >= dataEnd) throw new Error('Truncated FIT developer fields');
                const numDevFields = view.getUint8(offset);
                offset++;
                if (offset + numDevFields * 3 > dataEnd) throw new Error('Truncated FIT developer fields');
                for (let i = 0; i < numDevFields; i++) {
                    const devSize = view.getUint8(offset + 1);
                    offset += 3;
                    totalSize += devSize;
                }
            }

            const compressedSize = totalSize - fields.filter(field => field.fieldDefNum === 253).reduce((size, field) => size + field.size, 0);
            definitions[localType] = { globalMessageNumber, fields, totalSize, compressedSize, littleEndian };
        } else {
            // Data message
            const localType = recordHeader & 0x0F;
            const def = definitions[localType];
            if (!def) throw new Error('Undefined FIT message');
            if (offset + def.totalSize > dataEnd) throw new Error('Truncated FIT record');
            const fieldData = readFITFields(view, offset, def);
            offset += def.totalSize;
            if (Number.isInteger(fieldData[253]) && fieldData[253] >= 0 && fieldData[253] < 0xFFFFFFFF) timestamp = fieldData[253];

            if (def.globalMessageNumber === 20) {
                recordPoint(fieldData);
            }
        }
    }

    const track = normalizeTrack({
        coordinates: records.map(r => [r.lat, r.lng]),
        elevations: records.map(r => r.elevation),
        times: records.map(r => r.time),
        segmentStarts: [0],
    });
    if (track.coordinates.length === 0) throw new Error('No GPS data found in FIT file');
    return { ...track, name: null };
}

function readFITFields(view, offset, def, compressed = false) {
    const data = {};
    let omitted = 0;
    for (const field of def.fields) {
        // Compressed headers supply timestamp 253 instead of storing its payload.
        if (compressed && field.fieldDefNum === 253) { omitted += field.size; continue; }
        const pos = offset + field.offset - omitted;
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

    if (!isValidLatitudeLongitude(lat, lng)) return null;

    let elevation = null;
    if (data[78] != null && data[78] !== 0xFFFFFFFF) {
        elevation = data[78] / 5 - 500; // enhanced_altitude
    } else if (data[2] != null && data[2] !== 0xFFFF) {
        elevation = data[2] / 5 - 500; // altitude
    }

    const timestamp = data[253];
    const time = Number.isFinite(timestamp) && timestamp !== 0xFFFFFFFF ? new Date((timestamp + FIT_EPOCH_OFFSET) * 1000).toISOString() : null;
    return { lat, lng, elevation, time };
}

export {
    parseFIT,
    isValidLatitudeLongitude,
    readFITFields,
    extractGPSPoint,
};
