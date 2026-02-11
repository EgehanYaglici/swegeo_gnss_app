// Message Router - routes parsed binary/NMEA/ASCII messages to UI
const { EventEmitter } = require('events');
const { parseBinaryPayload } = require('./binary-parser');
const {
  getNmeaSchema,
  getAsciiMessageMap,
  getCapabilitySources,
  getFieldMapping,
  getExtraFields,
  getSourceConfig,
  applyConversions,
  lookupRefValue
} = require('./schema-loader');

class MessageRouter extends EventEmitter {
  constructor(serialManager) {
    super();
    this.serial = serialManager;

    // Subscriptions: { capability: [{ msgId, sourceName }] }
    this._subs = {
      position: [], velocity: [], heading: [],
      satellites: [], imu: [], time: []
    };

    // Reference counting for LOG/UNLOG
    this._refCount = new Map();

    // NMEA messages needing GP prefix
    this.NMEA_MESSAGES = new Set(['GGA', 'RMC', 'GLL', 'GNS', 'FPD', 'HPD', 'VTG', 'GSA', 'GSV']);

    // Connect to serial manager events
    if (this.serial) {
      this.serial.on('binary', (frame) => this._onBinary(frame));
      this.serial.on('line', (line) => this._onLine(line));
    }

    // Build source indexes
    this._buildIndexes();
  }

  _buildIndexes() {
    this._binaryIdx = {};  // int msgId -> [{cap, sourceName}]
    this._nmeaIdx = {};    // str sentenceType -> [{cap, sourceName}]
    this._asciiIdx = {};   // str tag -> [{cap, sourceName}]

    for (const cap of Object.keys(this._subs)) {
      const sources = getCapabilitySources(cap);
      for (const [name, config] of Object.entries(sources)) {
        const type = config.type || 'binary';
        if (type === 'binary' && typeof config.id === 'number') {
          (this._binaryIdx[config.id] ||= []).push({ cap, sourceName: name });
        } else if (type === 'nmea' && typeof config.id === 'string') {
          (this._nmeaIdx[config.id] ||= []).push({ cap, sourceName: name });
        } else if (type === 'ascii') {
          const tag = config.tag || name;
          (this._asciiIdx[tag] ||= []).push({ cap, sourceName: name });
        }
      }
    }
  }

  // --- Subscription management ---

  subscribe(capability, msgId, sourceName) {
    const subs = this._subs[capability];
    if (!subs) return;

    // Coerce numeric IDs to numbers (binary parser emits numbers, IPC may pass strings)
    const normalizedId = (typeof msgId === 'string' && /^\d+$/.test(msgId)) ? Number(msgId) : msgId;

    if (subs.some(s => s.msgId === normalizedId && s.sourceName === sourceName)) return;

    subs.push({ msgId: normalizedId, sourceName });

    const key = `${msgId}:${sourceName}`;
    const count = (this._refCount.get(key) || 0) + 1;
    this._refCount.set(key, count);

    if (count === 1) {
      // this._sendLogCommand(sourceName, true);
    }
  }

  unsubscribe(capability, msgId, sourceName) {
    const subs = this._subs[capability];
    if (!subs) return;

    // Coerce numeric IDs to match subscribe normalization
    const normalizedId = (msgId != null && typeof msgId === 'string' && /^\d+$/.test(msgId)) ? Number(msgId) : msgId;

    if (normalizedId == null && sourceName == null) {
      // Unsubscribe all
      for (const sub of subs) {
        const key = `${sub.msgId}:${sub.sourceName}`;
        const count = (this._refCount.get(key) || 1) - 1;
        if (count <= 0) {
          this._refCount.delete(key);
          // this._sendLogCommand(sub.sourceName, false);
        } else {
          this._refCount.set(key, count);
        }
      }
      this._subs[capability] = [];
    } else {
      this._subs[capability] = subs.filter(s => !(s.msgId === normalizedId && s.sourceName === sourceName));
      const key = `${normalizedId}:${sourceName}`;
      const count = (this._refCount.get(key) || 1) - 1;
      if (count <= 0) {
        this._refCount.delete(key);
        // this._sendLogCommand(sourceName, false);
      } else {
        this._refCount.set(key, count);
      }
    }
  }

  sendCommand(cmd) {
    if (this.serial) return this.serial.sendCommand(cmd);
    return { ok: false, msg: 'No serial connection' };
  }

  _sendLogCommand(sourceName, enable, rate = 1.0) {
    const cmdSource = this.NMEA_MESSAGES.has(sourceName) ? `GP${sourceName}` : sourceName;
    const cmd = enable
      ? `LOG ${cmdSource} ONTIME ${1.0 / rate}`
      : `UNLOG ${cmdSource}`;
    this.sendCommand(cmd);
  }

  // --- Binary frame handling ---

  _onBinary(frame) {
    if (!frame.ok) return;
    const { id: msgId, payload, crc } = frame;
    if (msgId == null || !payload) return;

    for (const [cap, subs] of Object.entries(this._subs)) {
      for (const sub of subs) {
        if (sub.msgId === msgId) {
          this._processBinary(cap, sub.sourceName, msgId, payload, crc);
        }
      }
    }
  }

  _processBinary(capability, sourceName, msgId, payload, crc) {
    try {
      const parsed = parseBinaryPayload(msgId, payload, crc);
      if (!parsed) return;

      const flat = this._flattenFields(parsed);
      const normalized = this._normalize(capability, sourceName, msgId, flat);
      this.emit(capability, normalized);
    } catch (e) {
      console.error(`[Router] Binary error id=${msgId}:`, e.message);
    }
  }

  // --- ASCII/NMEA line handling ---

  _onLine(line) {
    if (!line) return;
    const stripped = line.trim();

    if (stripped.startsWith('$')) {
      this._handleNmea(stripped);
    } else if (stripped.startsWith('#')) {
      this._handleAscii(stripped);
    } else if (stripped.includes(',')) {
      // Try as bare ASCII tag
      const tag = this._getAsciiTag(stripped);
      if (tag && this._findSchemaForTag(tag)) {
        this._handleAscii(stripped);
      }
    }
  }

  _handleNmea(line) {
    try {
      const parts = line.split(',');
      if (parts.length < 2) return;
      const talkerAndType = parts[0].substring(1);
      const sentenceType = talkerAndType.length >= 3 ? talkerAndType.slice(-3) : talkerAndType;

      for (const [cap, subs] of Object.entries(this._subs)) {
        for (const sub of subs) {
          if (typeof sub.msgId === 'string' && sentenceType === sub.msgId) {
            this._processNmea(cap, sub.sourceName, sentenceType, line);
          }
        }
      }
    } catch { }
  }

  _handleAscii(line) {
    try {
      let tagPart;
      if (line.includes(';')) {
        tagPart = line.split(';')[0].split(',')[0];
      } else {
        tagPart = line.split(',')[0]; // Simple comma separated
      }
      let tag = tagPart.trim().toUpperCase().replace(/^[#$]/, '');

      // Check schema for canonical name
      const schemaInfo = this._findSchemaForTag(tag);
      if (schemaInfo) {
        // Fix: Use the canonical TAG for routing if available (e.g. BESTPOSA), 
        // fallback to name (e.g. GGA) for NMEA or if tag matches name.
        // The display config expects the TAG/ID, not the human-readable description.
        tag = (schemaInfo.entry && schemaInfo.entry.tag)
          ? schemaInfo.entry.tag
          : schemaInfo.name;
      }

      for (const [cap, subs] of Object.entries(this._subs)) {
        for (const sub of subs) {
          if (typeof sub.msgId === 'string' && tag === sub.msgId) {
            this._processAscii(cap, sub.sourceName, tag, line);
          }
        }
      }
    } catch (err) {
      console.error('[Router] Error handling ASCII:', err);
    }
  }

  _processNmea(capability, sourceName, sentenceType, line) {
    try {
      const parsed = this._parseNmeaLine(line);
      if (!parsed) return;

      const flat = this._flattenFields(parsed);

      // Inject talker ID
      if (line.startsWith('$') && line.length >= 6) {
        flat.talker = line.substring(1, 3);
        flat.msg_type = line.substring(3, 6);
      }

      const normalized = this._normalize(capability, sourceName, sentenceType, flat);
      this.emit(capability, normalized);
    } catch (e) {
      console.error(`[Router] NMEA error ${sentenceType}:`, e.message);
    }
  }

  _processAscii(capability, sourceName, tag, line) {
    try {
      const parsed = this._parseAsciiLine(line);
      if (!parsed) return;

      const flat = this._flattenFields(parsed);
      const normalized = this._normalize(capability, sourceName, tag, flat);
      this.emit(capability, normalized);
    } catch (e) {
      console.error(`[Router] ASCII error ${tag}:`, e.message);
    }
  }

  // --- Parsing helpers ---

  _parseNmeaLine(line) {
    if (!line || !line.startsWith('$')) return null;
    const [body] = line.split('*');
    const tokens = body.split(',');
    if (!tokens.length) return null;

    const header = tokens[0].substring(1);
    const sentenceType = header.length > 3 && /^[A-Z]{2}/.test(header)
      ? header.substring(2) : header;

    const schema = getNmeaSchema();
    const entry = schema[sentenceType];
    if (!entry) return null;

    const asciiEntry = entry.ascii || entry;
    const fields = {};
    for (const fieldDef of (asciiEntry.fields || [])) {
      const idx = fieldDef.index || 0;
      const name = fieldDef.name || `field_${idx}`;
      const type = fieldDef.type || 'str';
      const raw = idx < tokens.length ? tokens[idx].trim() : '';
      fields[name] = {
        value: this._convertField(raw, type),
        raw, type,
        unit: fieldDef.unit || '',
        note: fieldDef.note || ''
      };
    }

    return { message_type: sentenceType, fields };
  }

  _parseAsciiLine(line) {
    const tag = this._getAsciiTag(line);
    if (!tag) return null;

    const schemaInfo = this._findSchemaForTag(tag);
    if (!schemaInfo) return null;

    const { family, name, entry } = schemaInfo;
    const [body] = line.split('*');

    let dataSection = body;
    if (family === 'ASCII' && body.includes(';')) {
      dataSection = body.split(';').slice(1).join(';');
    }
    const parts = dataSection ? dataSection.split(',') : [];
    const fieldParts = family === 'ASCII' ? parts : parts.slice(1);

    const fields = {};
    for (const f of (entry.fields || [])) {
      const idx = (f.index || 0) - 1;
      const nm = f.name;
      const tp = f.type || 'str';
      const raw = (idx >= 0 && idx < fieldParts.length) ? fieldParts[idx] : '';
      fields[nm] = {
        value: this._convertField(raw, tp),
        raw, type: tp,
        unit: f.unit || '',
        note: f.note || ''
      };
    }

    return { message_type: name, _family: family, fields };
  }

  _convertField(raw, type) {
    if (!raw) return null;
    switch (type) {
      case 'int': return parseInt(raw, 10) || null;
      case 'float': return parseFloat(raw) || null;
      case 'lat_dm':
      case 'lon_dm': {
        const val = parseFloat(raw);
        if (isNaN(val)) return null;
        const deg = Math.floor(val / 100);
        const min = val % 100;
        return deg + (min / 60);
      }
      default: return raw;
    }
  }

  _getAsciiTag(line) {
    const s = (line || '').trim();
    if (!s) return '';
    if (s.startsWith('$')) {
      return s.substring(1, 6).toUpperCase();
    }
    const part = s.split(',')[0].split('*')[0].split(/\s/)[0];
    return part.replace(/^[#$]/, '').toUpperCase();
  }

  _findSchemaForTag(tag) {
    const t = (tag || '').toUpperCase();
    if (!t) return null;

    // 1) NMEA
    const nmea = getNmeaSchema();
    const short = /^(GP|GN|GA|GL|BD)/.test(t) ? t.slice(-3) : t;
    if (nmea[short]) return { family: 'NMEA', name: short, entry: nmea[short] };
    for (const [k, v] of Object.entries(nmea)) {
      if (k.startsWith('_')) continue;
      const aliases = (v.aliases || []).map(a => a.toUpperCase());
      if (aliases.includes(t) || aliases.includes(short)) {
        return { family: 'NMEA', name: k, entry: v };
      }
    }

    // 2) ASCII
    const ascii = getAsciiMessageMap();
    if (ascii[t]) return { family: 'ASCII', name: t, entry: ascii[t] };
    for (const [k, v] of Object.entries(ascii)) {
      const aliases = (v.aliases || []).map(a => a.toUpperCase());
      if (aliases.includes(t)) return { family: 'ASCII', name: k, entry: v };
    }

    return null;
  }

  // --- Normalization ---

  _flattenFields(parsed) {
    const flat = {};
    for (const [name, data] of Object.entries(parsed.fields || {})) {
      flat[name] = typeof data === 'object' && data !== null && 'value' in data
        ? data.value : data;
    }
    return flat;
  }

  _normalize(capability, sourceName, msgId, flatFields) {
    const mapping = getFieldMapping(capability, sourceName);
    const extraDefs = getExtraFields(capability, sourceName);
    const sourceConfig = getSourceConfig(capability, sourceName);
    const conversions = sourceConfig?.conversions || {};

    // Map standard fields
    const normalized = {};
    for (const [stdName, srcField] of Object.entries(mapping)) {
      normalized[stdName] = flatFields[srcField];
    }

    // Apply conversions
    const converted = applyConversions(normalized, conversions);
    Object.assign(normalized, converted);

    // Hemisphere corrections
    if (mapping.ns || mapping.ew) {
      const ns = flatFields[mapping.ns || 'ns'];
      const ew = flatFields[mapping.ew || 'ew'];
      if (ns === 'S' && normalized.latitude > 0) normalized.latitude = -normalized.latitude;
      if (ew === 'W' && normalized.longitude > 0) normalized.longitude = -normalized.longitude;
    }

    // Extra fields
    const extraFields = extraDefs.map(def => {
      let value = flatFields[def.field];
      if (def.field in conversions && value != null) {
        const factor = conversions[def.field]?.factor || 1;
        const num = parseFloat(value);
        if (!isNaN(num)) value = num * factor;
      }
      // Resolve reference table lookup (binary int → ASCII label)
      if (def.ref_table && value != null) {
        const label = lookupRefValue(def.ref_table, value);
        if (label) value = label;
      }
      return {
        field: def.field,
        label: def.label || def.field,
        value,
        format: def.format || 'str',
        unit: def.unit || '',
        decimals: def.decimals || 2
      };
    });

    normalized.source_id = msgId;
    normalized.source_name = sourceName;
    normalized.extra_fields = extraFields;
    normalized.raw_fields = flatFields;
    return normalized;
  }
}

module.exports = MessageRouter;
