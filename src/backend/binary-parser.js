// Schema-driven binary payload parser (port of binary_schema_loader.py)
const { getBinaryMessageMap } = require('./schema-loader');

let _nameIndex = null;
let _idIndex = null;

const TYPE_FORMATS = {
  uint8:   { size: 1, read: (dv, off) => dv.getUint8(off) },
  int8:    { size: 1, read: (dv, off) => dv.getInt8(off) },
  uint16:  { size: 2, read: (dv, off) => dv.getUint16(off, true) },
  int16:   { size: 2, read: (dv, off) => dv.getInt16(off, true) },
  uint32:  { size: 4, read: (dv, off) => dv.getUint32(off, true) },
  int32:   { size: 4, read: (dv, off) => dv.getInt32(off, true) },
  float32: { size: 4, read: (dv, off) => dv.getFloat32(off, true) },
  float:   { size: 4, read: (dv, off) => dv.getFloat32(off, true) },
  float64: { size: 8, read: (dv, off) => dv.getFloat64(off, true) },
  double:  { size: 8, read: (dv, off) => dv.getFloat64(off, true) },
};

function normalizeName(name) {
  return (name || '').trim().replace(/[ -]/g, '_').toUpperCase();
}

function buildIndexes(schema) {
  const nameIdx = {};
  const idIdx = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (key.startsWith('_') || typeof entry !== 'object') continue;
    nameIdx[normalizeName(key)] = key;
    for (const alias of (entry.aliases || [])) {
      nameIdx[normalizeName(alias)] = key;
    }
    if (typeof entry.id === 'number') {
      idIdx[entry.id] = key;
    }
  }
  return { nameIdx, idIdx };
}

function getIndexes() {
  if (!_nameIndex) {
    const { nameIdx, idIdx } = buildIndexes(getBinaryMessageMap());
    _nameIndex = nameIdx;
    _idIndex = idIdx;
  }
  return { nameIdx: _nameIndex, idIdx: _idIndex };
}

function getEntryById(msgId) {
  const schema = getBinaryMessageMap();
  const { idIdx } = getIndexes();
  const key = idIdx[msgId];
  return key ? { key, entry: schema[key] } : null;
}

function readChar(buf, offset, length) {
  const bytes = buf.slice(offset, offset + length);
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 32 && b < 127) text += String.fromCharCode(b);
  }
  return { value: text.trim(), newOffset: offset + length };
}

function readNumeric(dv, offset, typeName, count) {
  const fmt = TYPE_FORMATS[typeName];
  if (!fmt) throw new Error(`Unsupported type: ${typeName}`);

  if (count === 1) {
    return { value: fmt.read(dv, offset), newOffset: offset + fmt.size };
  }
  const values = [];
  let off = offset;
  for (let i = 0; i < count; i++) {
    values.push(fmt.read(dv, off));
    off += fmt.size;
  }
  return { value: values, newOffset: off };
}

// Simple expression evaluator for derived fields
function safeEval(expr, context) {
  if (!expr) return null;
  // Replace variable names with values
  let evalStr = expr;
  for (const [name, value] of Object.entries(context)) {
    if (typeof value === 'number') {
      evalStr = evalStr.replace(new RegExp(`\\b${name}\\b`, 'g'), String(value));
    }
  }
  // Only allow numbers, operators, parentheses
  if (!/^[\d\s+\-*/().eE]+$/.test(evalStr)) return null;
  try {
    return Function(`"use strict"; return (${evalStr})`)();
  } catch {
    return null;
  }
}

function parseBinaryPayload(msgId, payload, frameCrc) {
  const result = getEntryById(msgId);
  if (!result) return null;

  const { key: schemaKey, entry } = result;
  const buf = Buffer.from(payload);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const values = {};
  const fieldsInfo = [];
  let offset = 0;

  // Special case: TRACKSTATB (ID 83)
  if (entry.tag === 'TRACKSTATB' || entry.id === 83) {
    const solStatus = dv.getUint32(0, true);
    const posType = dv.getUint32(4, true);
    const cutoff = dv.getFloat32(8, true);
    const numChans = dv.getUint32(12, true);
    const channels = [];
    let off = 16;
    for (let i = 0; i < numChans; i++) {
      channels.push({
        prn_slot: dv.getUint16(off, true),
        glofreq: dv.getInt16(off + 2, true),
        ch_tr_status: dv.getUint32(off + 4, true),
        psr_m: dv.getFloat64(off + 8, true),
        doppler_hz: dv.getFloat32(off + 16, true),
        cno_dbhz: dv.getFloat32(off + 20, true),
        locktime_s: dv.getFloat32(off + 24, true),
        psr_res_m: dv.getFloat32(off + 28, true),
        reject_code: dv.getUint32(off + 32, true),
        psr_weight: dv.getFloat32(off + 36, true),
      });
      off += 40;
    }
    return {
      message_type: entry.name || schemaKey,
      schema_key: schemaKey,
      id: msgId,
      fields: {
        solution_status: { value: solStatus, unit: '', note: '' },
        position_type: { value: posType, unit: '', note: '' },
        cutoff_deg: { value: cutoff, unit: 'deg', note: '' },
        num_channels: { value: numChans, unit: '', note: '' },
        channels: { value: channels, unit: '', note: '' },
        crc32: { value: frameCrc, unit: '', note: '' },
      }
    };
  }

  // Generic schema-driven parsing
  for (const field of (entry.fields || [])) {
    const name = field.name;
    const ftype = field.type || 'uint8';
    const unit = field.unit || '';
    const note = field.note || '';
    if (!name) continue;

    if (field.source === 'crc' || name === 'crc32') {
      values[name] = frameCrc;
      fieldsInfo.push({ name, unit, note });
      continue;
    }

    if (ftype === 'char') {
      const length = field.length || field.count || 1;
      const { value, newOffset } = readChar(buf, offset, length);
      values[name] = value;
      offset = newOffset;
    } else if (ftype === 'bytes') {
      const length = field.length || field.count || 1;
      values[name] = buf.slice(offset, offset + length);
      offset += length;
    } else {
      const count = field.count || 1;
      const { value, newOffset } = readNumeric(dv, offset, ftype, count);
      let finalValue = value;
      if (field.scale != null) {
        if (typeof finalValue === 'number') {
          finalValue = finalValue * field.scale;
        } else if (Array.isArray(finalValue)) {
          finalValue = finalValue.map(v => v * field.scale);
        }
      }
      values[name] = finalValue;
      offset = newOffset;
    }
    fieldsInfo.push({ name, unit, note });
  }

  // Derived fields
  for (const dfield of (entry.derived || [])) {
    const name = dfield.name;
    if (!name) continue;
    values[name] = safeEval(dfield.expr || '', values);
    fieldsInfo.push({ name, unit: dfield.unit || '', note: dfield.note || '' });
  }

  // Format output
  const formattedFields = {};
  for (const { name, unit, note } of fieldsInfo) {
    formattedFields[name] = { value: values[name], unit, note };
  }

  return {
    message_type: entry.name || schemaKey,
    schema_key: schemaKey,
    id: msgId,
    fields: formattedFields,
  };
}

module.exports = { parseBinaryPayload, getEntryById };
