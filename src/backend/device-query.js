const { EventEmitter } = require('events');

const COMCONFIG_TIMEOUT_MS = 5000;
const COMCONFIG_SETTLE_MS = 600;
const ICOMCONFIG_TIMEOUT_MS = 5000;
const ICOMCONFIG_SETTLE_MS = 600;
const LOGLISTA_TIMEOUT_MS = 5000;
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
    this._lastLoglistaResult = null;
    this._retryCount = 0;
    this._retryTimer = null;

    // Request queue: pending requests waiting for current one to finish
    this._queue = [];

    this._lineHandler = (text) => this._onLine(text);
    this._serial.on('line', this._lineHandler);
  }

  requestComconfig() {
    return this._enqueue('COMCONFIG');
  }

  requestIcomconfig() {
    return this._enqueue('ICOMCONFIG');
  }

  requestLoglista() {
    return this._enqueue('LOGLISTA');
  }

  // Enqueue a request — if nothing is in-flight, start immediately
  _enqueue(type) {
    return new Promise((resolve) => {
      // LOGLISTA cooldown: return cached result immediately without queuing
      if (type === 'LOGLISTA') {
        const now = Date.now();
        if (now < this._loglistaCooldownUntil && this._lastLoglistaResult) {
          resolve(this._lastLoglistaResult);
          return;
        }
      }

      // Deduplicate: if same type already waiting in queue, reuse its promise
      const existing = this._queue.find(q => q.type === type);
      if (existing) {
        // Piggyback on existing queued request
        const origResolve = existing.resolve;
        existing.resolve = (result) => {
          origResolve(result);
          resolve(result);
        };
        return;
      }

      this._queue.push({ type, resolve, retryCount: 0 });
      this._processQueue();
    });
  }

  // Process next item in queue if not busy
  _processQueue() {
    if (this._mode) return; // busy, will be called again from _finish
    if (this._queue.length === 0) return;

    const { type, resolve, retryCount } = this._queue.shift();
    this._startRequest(type, resolve, retryCount);
  }

  _startRequest(type, finalResolve, retryCount) {
    this._retryCount = retryCount || 0;
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
          this._startRequest(type, finalResolve, this._retryCount);
        }, RETRY_DELAY_MS);
        return;
      }

      if (type === 'LOGLISTA' && result.entries && result.entries.length > 0) {
        this._lastLoglistaResult = result;
        this._loglistaCooldownUntil = Date.now() + LOGLISTA_COOLDOWN_MS;
      }

      finalResolve(result);

      // Process next item in queue
      this._processQueue();
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
    this._queue = [];
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
      let data = line.trim();
      if (data.includes(';')) {
        data = data.split(';')[1];
      }

      let tokens = data.includes(',') ? data.split(',').map(t => t.trim()) : data.split(/\s+/);

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

        if (tokens.length >= 2 && /^\d+$/.test(tokens[1])) {
          baud = tokens[1];
        }

        if (tokens.length >= 9) {
          if (data.includes(',')) {
            if (tokens[8]) inMode = tokens[8];
            if (tokens[9]) outMode = tokens[9];
          }
        }

        if (!inMode) {
          const inMatch = line.match(/IN:(\S+)/i);
          if (inMatch) inMode = inMatch[1];
        }
        if (!outMode) {
          const outMatch = line.match(/OUT:(\S+)/i);
          if (outMatch) outMode = outMatch[1];
        }

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
      if (tokens.length > 0) {
        tokens[tokens.length - 1] = tokens[tokens.length - 1].split('*')[0];
      }

      if (tokens.length === 0) continue;

      if (ICOM_REGEX.test(tokens[0])) {
        const name = tokens[0].toUpperCase();
        if (seen.has(name)) continue;
        seen.add(name);

        let protocol = null, tcpPort = null, inMode = null, outMode = null;

        if (tokens.length >= 2) protocol = tokens[1];
        if (tokens.length >= 3) tcpPort = tokens[2];

        if (data.includes(',')) {
          if (tokens.length > 4) inMode = tokens[4];
          if (tokens.length > 5) outMode = tokens[5];
        }

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

    return ports;
  }

  _parseLoglista(lines) {
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

      if (PORT_REGEX.test(port)) {
        entries.push({ port, msg, mode, period, extra, hold });
      }
      i += 6;
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
    // Note: _processQueue is called inside the resolve callback above
  }

  _clearTimers() {
    if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    if (this._settleId) { clearTimeout(this._settleId); this._settleId = null; }
  }
}

module.exports = DeviceQuery;
