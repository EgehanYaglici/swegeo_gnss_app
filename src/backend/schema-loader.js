// Unified schema loader - loads all JSON5 schema files
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '..', 'shared', 'schemas');

// Caches
let _logSchema = null;
let _nmeaSchema = null;
let _ubxSchema = null;
let _displayConfig = null;
let _refTables = null;
let _asciiMap = null;
let _binaryMap = null;

// Simple JSON5 parser: strips comments + trailing commas
function parseJson5(text) {
  // Remove single-line comments (not inside strings)
  const lines = text.split('\n');
  const cleaned = [];
  for (const line of lines) {
    const idx = line.indexOf('//');
    if (idx !== -1) {
      let inString = false;
      for (let i = 0; i < idx; i++) {
        if (line[i] === '"' && (i === 0 || line[i - 1] !== '\\')) {
          inString = !inString;
        }
      }
      if (!inString) {
        cleaned.push(line.substring(0, idx));
        continue;
      }
    }
    cleaned.push(line);
  }
  let content = cleaned.join('\n');

  // Remove block comments
  content = content.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove trailing commas
  content = content.replace(/,(\s*[}\]])/g, '$1');

  // Convert hex literals to decimal for JSON.parse()
  content = content.replace(/\b0x([0-9A-Fa-f]+)\b/g, (_, hex) => parseInt(hex, 16));

  // Quote unquoted keys
  let result = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '"') {
      result += content[i++];
      while (i < content.length) {
        result += content[i];
        if (content[i] === '"' && content[i - 1] !== '\\') {
          i++;
          break;
        }
        i++;
      }
    } else if (/[A-Za-z_]/.test(content[i])) {
      let j = i + 1;
      while (j < content.length && /[A-Za-z0-9_]/.test(content[j])) j++;
      let k = j;
      while (k < content.length && /\s/.test(content[k])) k++;
      if (k < content.length && content[k] === ':') {
        result += `"${content.substring(i, j)}"`;
        i = j;
      } else {
        result += content[i++];
      }
    } else {
      result += content[i++];
    }
  }

  return JSON.parse(result);
}

function loadSchemaFile(filename) {
  const filePath = path.join(SCHEMA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.error(`[SchemaLoader] Schema not found: ${filePath}`);
    return {};
  }
  const text = fs.readFileSync(filePath, 'utf-8');
  try {
    return parseJson5(text);
  } catch (e) {
    console.error(`[SchemaLoader] Failed to parse ${filename}:`, e.message);
    return {};
  }
}

// SWEGEO device message schema (SS100D, SS100D-INS)
function getLogSchema() {
  if (!_logSchema) {
    _logSchema = loadSchemaFile('swegeo_messages.json5');
    console.log(`[SchemaLoader] Loaded SWEGEO message schema: ${Object.keys(_logSchema).length} entries`);
  }
  return _logSchema;
}

// NMEA schema
function getNmeaSchema() {
  if (!_nmeaSchema) {
    _nmeaSchema = loadSchemaFile('nmea0183.json5');
    console.log(`[SchemaLoader] Loaded NMEA schema: ${Object.keys(_nmeaSchema).length} entries`);
  }
  return _nmeaSchema;
}

// UBX F9P phase-1 schema
function getUbxSchema() {
  if (!_ubxSchema) {
    _ubxSchema = loadSchemaFile('ubx_f9p_messages.json5');
    console.log(`[SchemaLoader] Loaded UBX schema: ${Object.keys(_ubxSchema).length} entries`);
  }
  return _ubxSchema;
}

// Display config
function getDisplayConfig() {
  if (!_displayConfig) {
    _displayConfig = loadSchemaFile('display_config.json5');
    console.log('[SchemaLoader] Loaded display config');
  }
  return _displayConfig;
}

// Reference tables
function getReferenceTables() {
  if (!_refTables) {
    _refTables = loadSchemaFile('reference_tables.json5');
  }
  return _refTables;
}

function getReferenceTable(key) {
  const tables = getReferenceTables();
  return tables[key] || null;
}

function lookupRefValue(tableKey, numericValue) {
  const table = getReferenceTable(tableKey);
  if (!table || !table.rows) return null;
  const strVal = String(numericValue);
  for (const row of table.rows) {
    if (String(row.value) === strVal) return row.ascii || null;
    if (row.value && row.value.includes('-')) {
      const [lo, hi] = row.value.split('-').map(Number);
      const num = Number(numericValue);
      if (!isNaN(lo) && !isNaN(hi) && num >= lo && num <= hi) return row.ascii || null;
    }
  }
  return null;
}

// Build ASCII message map (tag -> entry)
function getAsciiMessageMap() {
  if (!_asciiMap) {
    _asciiMap = {};
    const schema = getLogSchema();
    for (const [key, entry] of Object.entries(schema)) {
      if (key.startsWith('_') || typeof entry !== 'object') continue;
      const asciiDef = entry.ascii;
      if (!asciiDef) continue;
      const normalized = { ...asciiDef };
      const tag = (normalized.tag || normalized.name || key).toUpperCase();
      normalized.name = normalized.name || tag;
      normalized.aliases = normalized.aliases || [];
      normalized._family = key;
      normalized._label = entry.label || key;
      normalized._description = normalized.description || entry.description || '';
      _asciiMap[tag] = normalized;
    }
  }
  return _asciiMap;
}

// Build binary message map (tag -> entry)
function getBinaryMessageMap() {
  if (!_binaryMap) {
    _binaryMap = {};

    // BYNAV / SWEGEO messages
    const schema = getLogSchema();
    for (const [key, entry] of Object.entries(schema)) {
      if (key.startsWith('_') || typeof entry !== 'object') continue;
      const binaryDef = entry.binary;
      if (!binaryDef) continue;
      const normalized = { ...binaryDef };
      const tag = (normalized.tag || key).toUpperCase();
      normalized.name = normalized.name || tag;
      normalized.aliases = normalized.aliases || [];
      normalized._family = key;
      normalized._label = entry.label || key;
      normalized._description = normalized.description || entry.description || '';
      _binaryMap[tag] = normalized;
    }

    // UBX messages
    const ubxSchema = getUbxSchema();
    for (const [key, entry] of Object.entries(ubxSchema)) {
      if (key.startsWith('_') || typeof entry !== 'object') continue;
      const binaryDef = entry.binary;
      if (!binaryDef) continue;
      const normalized = { ...binaryDef };
      const tag = (normalized.tag || key).toUpperCase();
      normalized.name = normalized.name || tag;
      normalized.aliases = normalized.aliases || [];
      normalized._family = key;
      normalized._label = entry.label || key;
      normalized._description = normalized.description || entry.description || '';
      normalized._ubx = true;
      _binaryMap[tag] = normalized;
    }
  }
  return _binaryMap;
}

// Display config helpers
function getCapabilities() {
  return getDisplayConfig().capabilities || {};
}

function getCapability(name) {
  return getCapabilities()[name] || null;
}

function getCapabilitySources(capability) {
  const cap = getCapability(capability);
  return cap ? (cap.sources || {}) : {};
}

function getSourceConfig(capability, sourceName) {
  return getCapabilitySources(capability)[sourceName] || null;
}

function getFieldMapping(capability, sourceName) {
  const source = getSourceConfig(capability, sourceName);
  return source ? (source.field_mapping || {}) : {};
}

function getExtraFields(capability, sourceName) {
  const source = getSourceConfig(capability, sourceName);
  return source ? (source.extra_fields || []) : [];
}

function _toUpperSafe(value) {
  return String(value || '').toUpperCase();
}

function getF9pNmeaConfigMap() {
  const map = {};
  const ubx = getUbxSchema();
  for (const [key, entry] of Object.entries(ubx)) {
    if (key.startsWith('_') || typeof entry !== 'object' || !entry.nmea) continue;
    const tag = _toUpperSafe(entry.nmea.tag || key.replace(/^NMEA_/, ''));
    if (tag) map[tag] = entry.nmea;
  }
  return map;
}

function getUbxCfgKeysBySource(sourceName) {
  const sourceUpper = _toUpperSafe(sourceName);
  const ubx = getUbxSchema();
  for (const [key, entry] of Object.entries(ubx)) {
    if (key.startsWith('_') || typeof entry !== 'object' || !entry.binary) continue;
    const keyUpper = _toUpperSafe(key);
    const tagUpper = _toUpperSafe(entry.binary.tag);
    if (sourceUpper === keyUpper || sourceUpper === tagUpper) {
      return entry.binary.cfg_keys || null;
    }
  }
  return null;
}

// Resolve "requires" flag for a display source.
function inferSourceRequires(sourceName, sourceConfig, msgType) {
  if (sourceConfig && Object.prototype.hasOwnProperty.call(sourceConfig, 'requires')) {
    return sourceConfig.requires ?? null;
  }

  const sourceUpper = _toUpperSafe(sourceName);
  const tagUpper = _toUpperSafe(sourceConfig?.tag);

  if (msgType === 'ubx') {
    const ubx = getUbxSchema();
    const byKey = ubx[sourceName];
    if (byKey && typeof byKey === 'object') return byKey.requires ?? null;

    for (const [key, entry] of Object.entries(ubx)) {
      if (key.startsWith('_') || typeof entry !== 'object') continue;
      const keyUpper = _toUpperSafe(key);
      const binaryTagUpper = _toUpperSafe(entry.binary?.tag);
      if (
        sourceUpper === keyUpper ||
        sourceUpper === binaryTagUpper ||
        (tagUpper && (tagUpper === keyUpper || tagUpper === binaryTagUpper))
      ) {
        return entry.requires ?? null;
      }
    }
    return null;
  }

  if (msgType === 'ascii' || msgType === 'binary') {
    const log = getLogSchema();
    for (const [key, entry] of Object.entries(log)) {
      if (key.startsWith('_') || typeof entry !== 'object') continue;
      const keyUpper = _toUpperSafe(key);
      const asciiTagUpper = _toUpperSafe(entry.ascii?.tag);
      const binaryTagUpper = _toUpperSafe(entry.binary?.tag);
      if (
        sourceUpper === keyUpper ||
        sourceUpper === asciiTagUpper ||
        sourceUpper === binaryTagUpper ||
        (tagUpper && (
          tagUpper === keyUpper ||
          tagUpper === asciiTagUpper ||
          tagUpper === binaryTagUpper
        ))
      ) {
        return entry.requires ?? null;
      }
    }
  }

  return null;
}

function getMessagesForCapability(capability) {
  const sources = getCapabilitySources(capability);
  const messages = [];
  const f9pNmea = getF9pNmeaConfigMap();

  for (const [sourceName, sourceConfig] of Object.entries(sources)) {
    const msgType = sourceConfig.type || 'binary';

    let device_family = null;
    if (msgType === 'ascii' || msgType === 'binary') device_family = 'bynav';
    else if (msgType === 'ubx') device_family = 'ublox';

    let cfgKeys = null;
    if (msgType === 'ubx') {
      cfgKeys = getUbxCfgKeysBySource(sourceName);
    } else if (msgType === 'nmea') {
      const nmeaTag = _toUpperSafe(sourceConfig.id || sourceName);
      cfgKeys = f9pNmea[nmeaTag]?.cfg_keys || null;
    }

    const entry = {
      name: sourceName,
      type: msgType,
      description: sourceConfig.description || '',
      log_command: sourceConfig.log_command || null,
      requires: inferSourceRequires(sourceName, sourceConfig, msgType),
      device_family,
      cfg_keys: cfgKeys,
      cfg_key_uart1: cfgKeys?.uart1 ?? (sourceConfig.cfg_key_uart1 != null ? sourceConfig.cfg_key_uart1 : null)
    };

    if (msgType === 'ascii') {
      entry.tag = sourceConfig.tag || sourceName;
      entry.id = entry.tag;
    } else {
      entry.id = sourceConfig.id;
    }
    messages.push(entry);
  }

  return messages;
}

function applyConversions(values, conversions) {
  const result = { ...values };
  for (const [field, conv] of Object.entries(conversions || {})) {
    if (result[field] != null) {
      const factor = conv.factor || 1.0;
      const val = parseFloat(result[field]);
      if (!isNaN(val)) result[field] = val * factor;
    }
  }
  return result;
}

// Get all message definitions for the Messages Settings table
function getAllMessageDefinitions() {
  const results = [];
  const f9pNmea = getF9pNmeaConfigMap();

  // NMEA messages (nmea0183.json5)
  const nmea = getNmeaSchema();
  for (const [key, entry] of Object.entries(nmea)) {
    if (key.startsWith('_') || typeof entry !== 'object') continue;
    const ascii = entry.ascii || entry;
    const cfgKeys = f9pNmea[_toUpperSafe(ascii.tag || key)]?.cfg_keys || null;

    results.push({
      name: ascii.tag || key,
      familyKey: key,
      command: ascii.log_command || key.toLowerCase(),
      description: entry.label || ascii.description || '',
      category: 'nmea',
      variant: 'nmea',
      defaultHz: ascii.default_rate_hz || 1,
      isOnnew: false,
      device_family: null,
      supportedOnUblox: !!cfgKeys,
      cfgKeys,
      cfgKeyUart1: cfgKeys?.uart1 || null
    });
  }

  // SWEGEO device messages (BYNAV ASCII + Binary)
  const log = getLogSchema();
  for (const [key, entry] of Object.entries(log)) {
    if (key.startsWith('_') || typeof entry !== 'object') continue;
    const requires = entry.requires || null;

    if (entry.ascii) {
      const v = entry.ascii;
      results.push({
        name: (v.tag || key).toUpperCase(),
        familyKey: key,
        command: (v.log_command || (v.tag || key)).toLowerCase(),
        description: v.description || entry.description || entry.label || '',
        category: 'ascii',
        variant: 'ascii',
        defaultHz: v.default_rate_hz || 1,
        isOnnew: !!v.on_new,
        requires,
        device_family: 'bynav',
        supportedOnUblox: false,
        cfgKeys: null,
        cfgKeyUart1: null
      });
    }

    if (entry.binary) {
      const v = entry.binary;
      results.push({
        name: (v.tag || key).toUpperCase(),
        familyKey: key,
        command: (v.log_command || (v.tag || key)).toLowerCase(),
        description: v.description || entry.description || entry.label || '',
        category: 'binary',
        variant: 'binary',
        defaultHz: v.default_rate_hz || 1,
        isOnnew: !!v.on_new,
        requires,
        device_family: 'bynav',
        supportedOnUblox: false,
        cfgKeys: null,
        cfgKeyUart1: null
      });
    }
  }

  // UBX messages (u-blox)
  const ubxSchema = getUbxSchema();
  for (const [key, entry] of Object.entries(ubxSchema)) {
    if (key.startsWith('_') || typeof entry !== 'object') continue;
    const requires = entry.requires || null;
    if (!entry.binary) continue;

    const v = entry.binary;
    const cfgKeys = v.cfg_keys || null;

    results.push({
      name: (v.tag || key).toUpperCase(),
      familyKey: key,
      command: null,
      description: v.description || entry.description || entry.label || '',
      category: 'ubx',
      variant: 'binary',
      defaultHz: v.default_rate_hz || 1,
      isOnnew: false,
      requires,
      device_family: 'ublox',
      supportedOnUblox: true,
      cfgKeys,
      cfgKeyUart1: cfgKeys?.uart1 || null,
      specialParser: !!v.special_parser
    });
  }

  return results;
}

// Get detailed schema for a specific message (used by info panel)
function getMessageSchema(familyKey, variant) {
  if (variant === 'nmea') {
    const nmea = getNmeaSchema();
    const entry = nmea[familyKey];
    if (!entry) return null;
    const def = entry.ascii || entry;
    return {
      name: def.tag || familyKey,
      description: entry.label || def.description || '',
      fields: def.fields || [],
      notes: def.notes || null
    };
  }

  const ubx = getUbxSchema();
  const ubxEntry = ubx[familyKey];
  if (ubxEntry && ubxEntry.binary) {
    const def = ubxEntry.binary;
    return {
      name: def.tag || familyKey,
      description: def.description || ubxEntry.description || ubxEntry.label || '',
      fields: def.fields || [],
      derived: def.derived || [],
      notes: def.notes || null
    };
  }

  const log = getLogSchema();
  const entry = log[familyKey];
  if (!entry) return null;
  const def = entry[variant];
  if (!def) return null;
  return {
    name: def.tag || familyKey,
    description: def.description || entry.description || entry.label || '',
    fields: def.fields || [],
    derived: def.derived || [],
    notes: def.notes || null
  };
}

function formatValue(value, formatType, decimals = 2, unit = '') {
  if (value == null) return '--';
  try {
    let result;
    switch (formatType) {
      case 'int':
        result = String(Math.round(Number(value)));
        break;
      case 'float':
      case 'coord':
        result = Number(value).toFixed(decimals);
        break;
      case 'sigma':
        result = `±${Number(value).toFixed(decimals)}`;
        break;
      default:
        result = String(value);
    }
    return unit ? `${result} ${unit}` : result;
  } catch {
    return value != null ? String(value) : '--';
  }
}

// Return all UBX/NMEA messages that have F9P cfg keys.
function getAllUbxCfgKeys() {
  const defs = getAllMessageDefinitions();
  const results = [];
  for (const msg of defs) {
    if (!msg.cfgKeys) continue;
    if (msg.category !== 'ubx' && msg.category !== 'nmea') continue;
    results.push({
      name: msg.name,
      familyKey: msg.familyKey,
      category: msg.category,
      cfg_keys: msg.cfgKeys
    });
  }
  return results;
}

module.exports = {
  parseJson5,
  getLogSchema,
  getNmeaSchema,
  getUbxSchema,
  getDisplayConfig,
  getReferenceTables,
  getReferenceTable,
  lookupRefValue,
  getAsciiMessageMap,
  getBinaryMessageMap,
  getCapabilities,
  getCapability,
  getCapabilitySources,
  getSourceConfig,
  getFieldMapping,
  getExtraFields,
  getMessagesForCapability,
  getAllUbxCfgKeys,
  applyConversions,
  formatValue,
  getAllMessageDefinitions,
  getMessageSchema
};
