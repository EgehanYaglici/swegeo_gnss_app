// Unified schema loader - loads all JSON5 schema files
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '..', 'shared', 'schemas');

// Caches
let _logSchema = null;
let _nmeaSchema = null;
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

  // Quote unquoted keys
  let result = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '"') {
      // Skip string
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

// Log messages schema (unified ASCII + Binary)
function getLogSchema() {
  if (!_logSchema) {
    _logSchema = loadSchemaFile('log_messages.json5');
    console.log(`[SchemaLoader] Loaded log schema: ${Object.keys(_logSchema).length} entries`);
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

// Display config
function getDisplayConfig() {
  if (!_displayConfig) {
    _displayConfig = loadSchemaFile('display_config.json5');
    console.log(`[SchemaLoader] Loaded display config`);
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

/**
 * Lookup a numeric value in a reference table and return the ASCII label.
 * e.g. lookupRefValue("table_4_1_solution_status", 0) → "SOL_COMPUTED"
 */
function lookupRefValue(tableKey, numericValue) {
  const table = getReferenceTable(tableKey);
  if (!table || !table.rows) return null;
  const strVal = String(numericValue);
  for (const row of table.rows) {
    if (String(row.value) === strVal) return row.ascii || null;
    // Handle ranges like "10-12"
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

function getMessagesForCapability(capability) {
  const sources = getCapabilitySources(capability);
  const messages = [];
  for (const [sourceName, sourceConfig] of Object.entries(sources)) {
    const msgType = sourceConfig.type || 'binary';
    const entry = {
      name: sourceName,
      type: msgType,
      description: sourceConfig.description || '',
      log_command: sourceConfig.log_command || null
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

  // NMEA messages (nmea0183.json5)
  const nmea = getNmeaSchema();
  for (const [key, entry] of Object.entries(nmea)) {
    if (key.startsWith('_') || typeof entry !== 'object') continue;
    const ascii = entry.ascii || entry;
    results.push({
      name: ascii.tag || key,
      familyKey: key,
      command: ascii.log_command || key.toLowerCase(),
      description: entry.label || ascii.description || '',
      category: 'nmea',
      variant: 'nmea',
      defaultHz: ascii.default_rate_hz || 1,
      isOnnew: false
    });
  }

  // ASCII + Binary messages (log_messages.json5)
  const log = getLogSchema();
  for (const [key, entry] of Object.entries(log)) {
    if (key.startsWith('_') || typeof entry !== 'object') continue;
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
        isOnnew: !!v.on_new
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
        isOnnew: !!v.on_new
      });
    }
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
      case 'int': result = String(Math.round(Number(value))); break;
      case 'float': case 'coord': result = Number(value).toFixed(decimals); break;
      case 'sigma': result = `±${Number(value).toFixed(decimals)}`; break;
      default: result = String(value);
    }
    return unit ? `${result} ${unit}` : result;
  } catch {
    return value != null ? String(value) : '--';
  }
}

module.exports = {
  parseJson5,
  getLogSchema,
  getNmeaSchema,
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
  applyConversions,
  formatValue,
  getAllMessageDefinitions,
  getMessageSchema
};
