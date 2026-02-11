// Device Query - handles COMCONFIG, ICOMCONFIG and LOGLISTA request/response cycles
// Supports both COM (serial) and ICOM (ethernet) ports
const { EventEmitter } = require('events');

const COMCONFIG_TIMEOUT_MS = 2500;
const COMCONFIG_EARLY_EXIT_MS = 300;
const ICOMCONFIG_TIMEOUT_MS = 2500;
const ICOMCONFIG_EARLY_EXIT_MS = 300;
const LOGLISTA_TIMEOUT_MS = 2500;
const LOGLISTA_COOLDOWN_MS = 1500;

const PORT_REGEX = /^(COM\d+|ICOM\d+)$/i;
const ICOM_REGEX = /^ICOM\d+$/i;

class DeviceQuery extends EventEmitter {
  constructor(serialManager) {
    super();
    this._serial = serialManager;
    this._mode = null;          // null | 'COMCONFIG' | 'LOGLISTA'
    this._buffer = [];
    this._timeoutId = null;
    this._earlyExitId = null;
    this._resolve = null;
    this._loglistaCooldownUntil = 0;

    // Listen to serial lines
    this._lineHandler = (text) => this._onLine(text);
    this._serial.on('line', this._lineHandler);
  }

  // --- Public API ---

  requestComconfig() {
    return new Promise((resolve) => {
      if (this._mode) {
        resolve({ ports: [], error: 'Another query is in progress' });
        return;
      }
      this._mode = 'COMCONFIG';
      this._buffer = [];
      this._resolve = resolve;

      this._serial.sendCommand('LOG COMCONFIG ONCE');

      this._timeoutId = setTimeout(() => {
        const ports = this._parseComconfig(this._buffer);
        this._finish({ ports });
      }, COMCONFIG_TIMEOUT_MS);
    });
  }

  requestIcomconfig() {
    return new Promise((resolve) => {
      if (this._mode) {
        resolve({ ports: [], error: 'Another query is in progress' });
        return;
      }
      this._mode = 'ICOMCONFIG';
      this._buffer = [];
      this._resolve = resolve;

      this._serial.sendCommand('LOG ICOMCONFIG ONCE');

      this._timeoutId = setTimeout(() => {
        const ports = this._parseIcomconfig(this._buffer);
        this._finish({ ports });
      }, ICOMCONFIG_TIMEOUT_MS);
    });
  }

  requestLoglista() {
    return new Promise((resolve) => {
      if (this._mode) {
        resolve({ entries: [], error: 'Another query is in progress' });
        return;
      }

      const now = Date.now();
      if (now < this._loglistaCooldownUntil) {
        resolve({ entries: [], error: 'Cooldown active' });
        return;
      }

      this._mode = 'LOGLISTA';
      this._buffer = [];
      this._resolve = resolve;

      this._serial.sendCommand('LOG LOGLISTA ONCE');

      this._timeoutId = setTimeout(() => {
        this._finish({ entries: [], error: 'Timeout waiting for LOGLISTA' });
      }, LOGLISTA_TIMEOUT_MS);
    });
  }

  destroy() {
    this._serial.removeListener('line', this._lineHandler);
    this._clearTimers();
  }

  // --- Internal ---

  _onLine(text) {
    if (!this._mode) return;
    const line = typeof text === 'string' ? text : String(text);

    if (this._mode === 'COMCONFIG') {
      this._onComconfigLine(line);
    } else if (this._mode === 'ICOMCONFIG') {
      this._onIcomconfigLine(line);
    } else if (this._mode === 'LOGLISTA') {
      this._onLoglistaLine(line);
    }
  }

  _onComconfigLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[') || trimmed.startsWith('>')) return;

    this._buffer.push(trimmed);

    // Check if this line contains a COM/ICOM port entry
    const tokens = trimmed.split(/\s+/);
    if (tokens.length > 0 && PORT_REGEX.test(tokens[0])) {
      // Reset the early-exit timer each time we see a port line
      if (this._earlyExitId) clearTimeout(this._earlyExitId);
      this._earlyExitId = setTimeout(() => {
        this._clearTimers();
        const ports = this._parseComconfig(this._buffer);
        this._finish({ ports });
      }, COMCONFIG_EARLY_EXIT_MS);
    }
  }

  _onIcomconfigLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[') || trimmed.startsWith('>')) return;

    this._buffer.push(trimmed);

    // Check if this line contains an ICOM port entry
    const tokens = trimmed.split(/\s+/);
    if (tokens.length > 0 && ICOM_REGEX.test(tokens[0])) {
      // Reset the early-exit timer each time we see an ICOM line
      if (this._earlyExitId) clearTimeout(this._earlyExitId);
      this._earlyExitId = setTimeout(() => {
        this._clearTimers();
        const ports = this._parseIcomconfig(this._buffer);
        this._finish({ ports });
      }, ICOMCONFIG_EARLY_EXIT_MS);
    }
  }

  _onLoglistaLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('>')) return;

    this._buffer.push(trimmed);

    // When we see LOGLISTA in any line, start an early-exit timer
    // (give time for multi-line responses to arrive fully)
    if (trimmed.includes('#LOGLISTA') || trimmed.toUpperCase().includes('LOGLISTA')) {
      if (this._earlyExitId) clearTimeout(this._earlyExitId);
      this._earlyExitId = setTimeout(() => {
        this._clearTimers();
        const entries = this._parseLoglista(this._buffer);
        this._loglistaCooldownUntil = Date.now() + LOGLISTA_COOLDOWN_MS;
        this._finish({ entries });
      }, 400); // Wait 400ms for all data to arrive
    }
  }

  _parseComconfig(lines) {
    const ports = [];
    const seen = new Set();

    for (const line of lines) {
      const tokens = line.split(/\s+/);
      if (tokens.length === 0) continue;

      if (PORT_REGEX.test(tokens[0])) {
        const name = tokens[0].toUpperCase();
        if (seen.has(name)) continue;
        seen.add(name);

        const type = name.startsWith('ICOM') ? 'ethernet' : 'serial';
        // Try to extract baud, in_mode, out_mode from the line
        let baud = null, inMode = null, outMode = null;
        // Format: COM1 115200 N 8 1 IN:AUTO OUT:BYNAV
        if (tokens.length >= 2) baud = tokens[1];
        const inMatch = line.match(/IN:(\S+)/i);
        const outMatch = line.match(/OUT:(\S+)/i);
        if (inMatch) inMode = inMatch[1];
        if (outMatch) outMode = outMatch[1];

        ports.push({ name, type, baud, inMode, outMode });
      }
    }

    // Sort: COM before ICOM, then by number
    ports.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'serial' ? -1 : 1;
      const numA = parseInt(a.name.replace(/\D/g, ''));
      const numB = parseInt(b.name.replace(/\D/g, ''));
      return numA - numB;
    });

    return ports;
  }

  // Parse ICOMCONFIG response
  // Format: ICOM1 TCP :1111 IN:NONE OUT:NONE
  _parseIcomconfig(lines) {
    const ports = [];
    const seen = new Set();

    for (const line of lines) {
      const tokens = line.split(/\s+/);
      if (tokens.length === 0) continue;

      if (ICOM_REGEX.test(tokens[0])) {
        const name = tokens[0].toUpperCase();
        if (seen.has(name)) continue;
        seen.add(name);

        // Extract protocol and port number
        let protocol = null, tcpPort = null, inMode = null, outMode = null;
        if (tokens.length >= 2) protocol = tokens[1];  // TCP, UDP, etc.

        // Look for :PORT pattern
        const portMatch = line.match(/:(\d+)/);
        if (portMatch) tcpPort = portMatch[1];

        const inMatch = line.match(/IN:(\S+)/i);
        const outMatch = line.match(/OUT:(\S+)/i);
        if (inMatch) inMode = inMatch[1];
        if (outMatch) outMode = outMatch[1];

        ports.push({ name, type: 'ethernet', protocol, tcpPort, inMode, outMode });
      }
    }

    // Sort by number
    ports.sort((a, b) => {
      const numA = parseInt(a.name.replace(/\D/g, ''));
      const numB = parseInt(b.name.replace(/\D/g, ''));
      return numA - numB;
    });

    return ports;
  }

  _parseLoglista(lines) {
    const entries = [];

    // Find the LOGLISTA line
    let payload = '';
    for (const line of lines) {
      const idx = line.indexOf('#LOGLISTA');
      if (idx !== -1) {
        payload = line.substring(idx);
        break;
      }
      if (line.toUpperCase().includes('LOGLISTA')) {
        payload = line;
        break;
      }
    }

    if (!payload) return entries;

    // Strip checksum: everything after last *
    const starIdx = payload.lastIndexOf('*');
    if (starIdx !== -1) payload = payload.substring(0, starIdx);

    // Strip header: everything before first ;
    const semiIdx = payload.indexOf(';');
    if (semiIdx !== -1) payload = payload.substring(semiIdx + 1);

    // Tokenize on comma
    const tokens = payload.split(',').map(t => t.trim()).filter(t => t);

    // Skip first token if it's a numeric count
    let i = 0;
    if (tokens.length > 0 && /^\d+$/.test(tokens[0])) i = 1;

    // Parse 6-token groups: port, msg, mode, period, extra, hold
    // Need indices i..i+5 (6 items), so i+5 must be < tokens.length
    while (i + 6 <= tokens.length) {
      const port = tokens[i].toUpperCase();
      const msg = tokens[i + 1].toUpperCase();
      const mode = tokens[i + 2].toUpperCase();
      const period = parseFloat(tokens[i + 3]) || 0;
      const extra = parseFloat(tokens[i + 4]) || 0;
      const hold = tokens[i + 5];
      i += 6;

      // Accept both COM and ICOM port prefixes
      if (!PORT_REGEX.test(port)) continue;

      entries.push({ port, msg, mode, period, extra, hold });
    }

    return entries;
  }

  _finish(result) {
    this._clearTimers();
    const resolve = this._resolve;
    this._mode = null;
    this._buffer = [];
    this._resolve = null;
    if (resolve) resolve(result);
  }

  _clearTimers() {
    if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    if (this._earlyExitId) { clearTimeout(this._earlyExitId); this._earlyExitId = null; }
  }
}

module.exports = DeviceQuery;
