const { EventEmitter } = require('events');

const COMCONFIG_TIMEOUT_MS = 4000;
const COMCONFIG_SETTLE_MS = 600;
const ICOMCONFIG_TIMEOUT_MS = 4000;
const ICOMCONFIG_SETTLE_MS = 600;
const LOGLISTA_TIMEOUT_MS = 4000;
const LOGLISTA_SETTLE_MS = 800;
const LOGLISTA_COOLDOWN_MS = 1000;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 2;

const PORT_REGEX = /^(COM\d+|ICOM\d+)$/i;
const ICOM_REGEX = /^ICOM\d+$/i;

class DeviceQuery extends EventEmitter {
  constructor(serialManager) {
    super();
    this._serial = serialManager;
    this._mode = null;
    this._buffer = [];
    this._timeoutId = null;
    this._settleId = null;
    this._resolve = null;
    this._loglistaCooldownUntil = 0;
    this._retryCount = 0;
    this._retryTimer = null;

    this._lineHandler = (text) => this._onLine(text);
    this._serial.on('line', this._lineHandler);
  }

  requestComconfig() {
    return this._requestWithRetry('COMCONFIG');
  }

  requestIcomconfig() {
    return this._requestWithRetry('ICOMCONFIG');
  }

  requestLoglista() {
    return this._requestWithRetry('LOGLISTA');
  }

  _requestWithRetry(type) {
    return new Promise((resolve) => {
      this._retryCount = 0;
      this._doRequest(type, resolve);
    });
  }

  _doRequest(type, finalResolve) {
    if (this._mode) {
      this._finish(this._emptyResult(type));
    }

    if (type === 'LOGLISTA') {
      const now = Date.now();
      if (now < this._loglistaCooldownUntil) {
        finalResolve(this._lastLoglistaResult || { entries: [] });
        return;
      }
    }

    this._mode = type;
    this._buffer = [];
    this._resolve = (result) => {
      const isEmpty = type === 'LOGLISTA'
        ? (!result.entries || result.entries.length === 0)
        : (!result.ports || result.ports.length === 0);

      if (isEmpty && !result.error && this._retryCount < MAX_RETRIES) {
        this._retryCount++;
        if (this._retryTimer) clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => {
          this._doRequest(type, finalResolve);
        }, RETRY_DELAY_MS);
        return;
      }

      if (type === 'LOGLISTA' && result.entries && result.entries.length > 0) {
        this._lastLoglistaResult = result;
        this._loglistaCooldownUntil = Date.now() + LOGLISTA_COOLDOWN_MS;
      }

      finalResolve(result);
    };

    const cmd = type === 'COMCONFIG' ? 'LOG COMCONFIG ONCE'
      : type === 'ICOMCONFIG' ? 'LOG ICOMCONFIG ONCE'
        : 'LOG LOGLISTA ONCE';
    this._serial.sendCommand(cmd);

    const timeout = type === 'LOGLISTA' ? LOGLISTA_TIMEOUT_MS
      : type === 'ICOMCONFIG' ? ICOMCONFIG_TIMEOUT_MS
        : COMCONFIG_TIMEOUT_MS;

    this._timeoutId = setTimeout(() => {
      const result = this._parseCurrentBuffer(type);
      this._finish(result);
    }, timeout);
  }

  _parseCurrentBuffer(type) {
    if (type === 'COMCONFIG') return { ports: this._parseComconfig(this._buffer) };
    if (type === 'ICOMCONFIG') return { ports: this._parseIcomconfig(this._buffer) };
    if (type === 'LOGLISTA') return { entries: this._parseLoglista(this._buffer) };
    return {};
  }

  _emptyResult(type) {
    if (type === 'LOGLISTA') return { entries: [] };
    return { ports: [] };
  }

  destroy() {
    this._serial.removeListener('line', this._lineHandler);
    this._clearTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
  }

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
    if (!trimmed) return;
    if (trimmed.startsWith('<') || trimmed.startsWith('[') || trimmed.startsWith('>')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();


    if (upper.includes('LOGLISTA') || upper.includes('ICOMCONFIG')) return;
    if (upper.startsWith('#INSPVA') || upper.startsWith('#BESTPOS') || upper.startsWith('#BESTVEL')) return;
    if (upper.startsWith('$INSPVA') || upper.startsWith('$BESTPOS') || upper.startsWith('$BESTVEL')) return;
    if (upper.startsWith('#INSATT') || upper.startsWith('#RAWIMU') || upper.startsWith('#CORRIMU')) return;
    if (upper.startsWith('$INSATT') || upper.startsWith('$RAWIMU') || upper.startsWith('$CORRIMU')) return;

    const hasComconfig = upper.includes('COMCONFIG');
    const tokens = trimmed.split(/\s+/);
    const isPortLine = tokens.length > 0 && PORT_REGEX.test(tokens[0]) && !ICOM_REGEX.test(tokens[0]);

    if (hasComconfig || isPortLine) {
      this._buffer.push(trimmed);
      this._resetSettle(COMCONFIG_SETTLE_MS, () => {
        const ports = this._parseComconfig(this._buffer);
        this._finish({ ports });
      });
    }
  }

  _onIcomconfigLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('<') || trimmed.startsWith('[') || trimmed.startsWith('>')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (upper.includes('LOGLISTA') || (upper.includes('COMCONFIG') && !upper.includes('ICOMCONFIG'))) return;
    if (upper.startsWith('#INSPVA') || upper.startsWith('#BESTPOS') || upper.startsWith('#BESTVEL')) return;
    if (upper.startsWith('$INSPVA') || upper.startsWith('$BESTPOS') || upper.startsWith('$BESTVEL')) return;
    if (upper.startsWith('#INSATT') || upper.startsWith('#RAWIMU') || upper.startsWith('#CORRIMU')) return;
    if (upper.startsWith('$INSATT') || upper.startsWith('$RAWIMU') || upper.startsWith('$CORRIMU')) return;

    const hasIcomconfig = upper.includes('ICOMCONFIG');
    const tokens = trimmed.split(/\s+/);
    const isIcomLine = tokens.length > 0 && ICOM_REGEX.test(tokens[0]);

    if (hasIcomconfig || isIcomLine) {
      this._buffer.push(trimmed);
      this._resetSettle(ICOMCONFIG_SETTLE_MS, () => {
        const ports = this._parseIcomconfig(this._buffer);
        this._finish({ ports });
      });
    }
  }

  _onLoglistaLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('>')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (upper.includes('COMCONFIG') || upper.includes('ICOMCONFIG')) return;
    // Only filter if the line strictly STARTS with these logs (ignoring the LOGLISTA content itself)
    if (upper.startsWith('#INSPVA') || upper.startsWith('#BESTPOS') || upper.startsWith('#BESTVEL')) return;
    if (upper.startsWith('$INSPVA') || upper.startsWith('$BESTPOS') || upper.startsWith('$BESTVEL')) return;

    if (trimmed.includes('#LOGLISTA') || upper.includes('LOGLISTA')) {
      this._buffer.push(trimmed);
      this._resetSettle(LOGLISTA_SETTLE_MS, () => {
        const entries = this._parseLoglista(this._buffer);
        this._finish({ entries });
      });
    }
  }

  _resetSettle(ms, cb) {
    if (this._settleId) clearTimeout(this._settleId);
    this._settleId = setTimeout(() => {
      this._clearTimers();
      cb();
    }, ms);
  }

  _parseComconfig(lines) {
    const ports = [];
    const seen = new Set();
    const PORT_REGEX = /^(COM\d+|ICOM\d+)$/i;
    const ICOM_REGEX = /^ICOM\d+$/i;

    for (const line of lines) {
      // Handle both raw lines "COM1 9600..." and message format "...;COM1,9600..."
      let data = line.trim();
      if (data.includes(';')) {
        data = data.split(';')[1]; // Take part after header
      }

      // Try comma-separated (standard standard) vs space-separated (abbreviated)
      let tokens = data.includes(',') ? data.split(',').map(t => t.trim()) : data.split(/\s+/);

      // Remove CRC if present (*1234abcd)
      if (tokens.length > 0) {
        tokens[tokens.length - 1] = tokens[tokens.length - 1].split('*')[0];
      }

      if (tokens.length === 0) continue;

      if (PORT_REGEX.test(tokens[0]) && !ICOM_REGEX.test(tokens[0])) {
        const name = tokens[0].toUpperCase();
        if (seen.has(name)) continue;
        seen.add(name);

        const type = 'serial';
        let baud = null, inMode = null, outMode = null;

        // Standard COMCONFIG: port, baud, parity, data, stop, hand, echo, break, rx_type, tx_type
        if (tokens.length >= 2 && /^\d+$/.test(tokens[1])) {
          baud = tokens[1];
        }

        // Try to find RX/TX types if present (usually indices 8 and 9 if baud is 1)
        // But tokens might be mixed. Let's look for known keywords or positions.
        // COMCONFIG format: 
        // 1: baud, 2: parity, 3: data, 4: stop, 5: hand, 6: echo, 7: break, 8: rx, 9: tx
        if (tokens.length >= 9) {
          // Assume standard position logic if comma separated
          if (data.includes(',')) {
            // tokens[8] is rx, tokens[9] is tx
            if (tokens[8]) inMode = tokens[8];
            if (tokens[9]) outMode = tokens[9];
          }
        }

        // Fallback to regex search if positional failed or strictly looking for "IN:..." tags
        if (!inMode) {
          const inMatch = line.match(/IN:(\S+)/i);
          if (inMatch) inMode = inMatch[1];
        }
        if (!outMode) {
          const outMatch = line.match(/OUT:(\S+)/i);
          if (outMatch) outMode = outMatch[1];
        }

        // Fallback for abbreviated "COM1 9600 N 8 1 N CTS ON ALL ALL"
        if (!inMode && tokens.length > 8) inMode = tokens[8];
        if (!outMode && tokens.length > 9) outMode = tokens[9];

        ports.push({ name, type, baud, inMode, outMode });
      }
    }

    ports.sort((a, b) => {
      const numA = parseInt(a.name.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.name.replace(/\D/g, '')) || 0;
      return numA - numB;
    });

    return ports;
  }

  _parseIcomconfig(lines) {
    const ports = [];
    const seen = new Set();
    const ICOM_REGEX = /^ICOM\d+$/i;

    for (const line of lines) {
      let data = line.trim();
      if (data.includes(';')) {
        data = data.split(';')[1];
      }

      let tokens = data.includes(',') ? data.split(',').map(t => t.trim()) : data.split(/\s+/);
      // Remove CRC
      if (tokens.length > 0) {
        tokens[tokens.length - 1] = tokens[tokens.length - 1].split('*')[0];
      }

      if (tokens.length === 0) continue;

      if (ICOM_REGEX.test(tokens[0])) {
        const name = tokens[0].toUpperCase();
        if (seen.has(name)) continue;
        seen.add(name);

        let protocol = null, tcpPort = null, inMode = null, outMode = null;

        // ICOMCONFIG format: port, protocol, protocol_port, ...
        // e.g. ICOM1,TCP,3001,ALL,ALL...
        if (tokens.length >= 2) protocol = tokens[1];
        if (tokens.length >= 3) tcpPort = tokens[2];

        // Try positions
        if (data.includes(',')) {
          // tokens[4] input, tokens[5] output
          if (tokens.length > 4) inMode = tokens[4];
          if (tokens.length > 5) outMode = tokens[5];
        }

        // Fallbacks
        const portMatch = line.match(/:(\d+)/);
        if (!tcpPort && portMatch) tcpPort = portMatch[1];

        if (!inMode) {
          const inMatch = line.match(/IN:(\S+)/i);
          if (inMatch) inMode = inMatch[1];
        }
        if (!outMode) {
          const outMatch = line.match(/OUT:(\S+)/i);
          if (outMatch) outMode = outMatch[1];
        }

        ports.push({ name, type: 'ethernet', protocol, tcpPort, inMode, outMode });
      }
    }

    ports.sort((a, b) => {
      const numA = parseInt(a.name.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.name.replace(/\D/g, '')) || 0;
      return numA - numB;
    });

    console.log('[DeviceQuery] Parsed ICOM ports:', ports);
    return ports;
  }

  _parseLoglista(lines) {
    console.log('[DeviceQuery] Parsing LOGLISTA lines:', lines);
    const entries = [];

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

    const starIdx = payload.lastIndexOf('*');
    if (starIdx !== -1) payload = payload.substring(0, starIdx);

    const semiIdx = payload.indexOf(';');
    if (semiIdx !== -1) payload = payload.substring(semiIdx + 1);

    const tokens = payload.split(',').map(t => t.trim()).filter(t => t);

    let i = 0;
    if (tokens.length > 0 && /^\d+$/.test(tokens[0])) i = 1;

    while (i + 6 <= tokens.length) {
      const port = tokens[i].toUpperCase();
      const msg = tokens[i + 1].toUpperCase();
      const mode = tokens[i + 2].toUpperCase();
      const period = parseFloat(tokens[i + 3]) || 0;
      const extra = parseFloat(tokens[i + 4]) || 0;
      const hold = tokens[i + 5];

      // Check if port is valid (e.g. COM1, ICOM1)
      if (PORT_REGEX.test(port)) {
        entries.push({ port, msg, mode, period, extra, hold });
        i += 6;
      } else {
        // If not a valid port, maybe we are misaligned? 
        // Try to skip one token and continue? Or just break?
        // For now, just increment by 1 to search for next valid port?
        // But usually the structure is strict.
        // Let's assume strict structure but skip if port doesn't match
        i += 6;
      }
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
    if (this._settleId) { clearTimeout(this._settleId); this._settleId = null; }
  }
}

module.exports = DeviceQuery;
