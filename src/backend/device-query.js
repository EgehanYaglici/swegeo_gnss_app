const { EventEmitter } = require('events');

const TIMEOUT_MS           = 3000;   // Fallback — <OK gelmezse bu kadar bekle
const AUTH_TIMEOUT_MS      = 2500;   // Cihaz AUTHORIZATION desteklemiyor olabilir
const SETTLE_MS            = 150;    // <OK gelmez ama data gelirse bu kadar bekle
const LOGLISTA_COOLDOWN_MS = 1000;
const RETRY_DELAY_MS       = 300;
const MAX_RETRIES          = 2;

const PORT_REGEX  = /^(COM\d+|ICOM\d+)$/i;
const ICOM_REGEX  = /^ICOM\d+$/i;

// Sürekli akan log satırları — response buffer'a karışmamalı
const NOISE_PREFIXES = [
  '#INSPVA', '#BESTPOS', '#BESTVEL', '#INSATT', '#RAWIMU', '#CORRIMU',
  '$INSPVA', '$BESTPOS', '$BESTVEL', '$INSATT', '$RAWIMU', '$CORRIMU',
];

class DeviceQuery extends EventEmitter {
  constructor(serialManager) {
    super();
    this._serial      = serialManager;
    this._mode        = null;
    this._buffer      = [];
    this._timeoutId   = null;
    this._settleId    = null;
    this._resolve     = null;
    this._retryCount  = 0;
    this._retryTimer  = null;
    this._queue       = [];
    this._loglistaCooldownUntil = 0;
    this._lastLoglistaResult    = null;

    this._lineHandler = (text) => this._onLine(text);
    this._serial.on('line', this._lineHandler);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  requestComconfig()    { return this._enqueue('COMCONFIG');    }
  requestIcomconfig()   { return this._enqueue('ICOMCONFIG');   }
  requestLoglista()     { return this._enqueue('LOGLISTA');     }
  requestAuthorization(){ return this._enqueue('AUTHORIZATION'); }

  destroy() {
    this._serial.removeListener('line', this._lineHandler);
    this._clearTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._queue = [];
  }

  // ─── Queue ─────────────────────────────────────────────────────────────────

  _enqueue(type) {
    return new Promise((resolve) => {
      // LOGLISTA cooldown — cached result döndür
      if (type === 'LOGLISTA') {
        const now = Date.now();
        if (now < this._loglistaCooldownUntil && this._lastLoglistaResult) {
          resolve(this._lastLoglistaResult);
          return;
        }
      }

      // Aynı istek zaten kuyrukta var → tek resolve'a piggyback ol
      const existing = this._queue.find(q => q.type === type);
      if (existing) {
        const orig = existing.resolve;
        existing.resolve = (r) => { orig(r); resolve(r); };
        return;
      }

      this._queue.push({ type, resolve });
      this._processQueue();
    });
  }

  _processQueue() {
    if (this._mode || this._queue.length === 0) return;
    const { type, resolve } = this._queue.shift();
    this._startRequest(type, resolve, 0);
  }

  // ─── Request lifecycle ─────────────────────────────────────────────────────

  _startRequest(type, finalResolve, retryCount) {
    this._retryCount = retryCount;
    this._mode       = type;
    this._buffer     = [];

    this._resolve = (result) => {
      // Sonuç boşsa ve retry hakkı varsa tekrar dene
      const isEmpty = type === 'AUTHORIZATION'
        ? false   // Cihaz desteklemiyorsa retry etme — timeout zaten null döner
        : type === 'LOGLISTA'
        ? (!result.entries || result.entries.length === 0)
        : (!result.ports   || result.ports.length   === 0);

      if (isEmpty && !result.error && this._retryCount < MAX_RETRIES) {
        this._retryCount++;
        if (this._retryTimer) clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(
          () => this._startRequest(type, finalResolve, this._retryCount),
          RETRY_DELAY_MS
        );
        return;
      }

      if (type === 'LOGLISTA' && result.entries?.length > 0) {
        this._lastLoglistaResult    = result;
        this._loglistaCooldownUntil = Date.now() + LOGLISTA_COOLDOWN_MS;
      }

      finalResolve(result);
      this._processQueue();
    };

    const cmd = type === 'COMCONFIG'     ? 'LOG COMCONFIG ONCE'
              : type === 'ICOMCONFIG'    ? 'LOG ICOMCONFIG ONCE'
              : type === 'AUTHORIZATION' ? 'LOG AUTHORIZATION ONCE'
              :                            'LOG LOGLISTA ONCE';
    this._serial.sendCommand(cmd);

    // Son kale: <OK hiç gelmezse timeout ile bitir
    const timeoutMs = type === 'AUTHORIZATION' ? AUTH_TIMEOUT_MS : TIMEOUT_MS;
    this._timeoutId = setTimeout(() => {
      this._finish(this._parseCurrentBuffer(type));
    }, timeoutMs);
  }

  // ─── Line handler ──────────────────────────────────────────────────────────

  _onLine(text) {
    if (!this._mode) return;
    const line    = typeof text === 'string' ? text : String(text);
    const trimmed = line.trim();

    // BYNAV response sonu → hemen bitir, settle veya timeout bekleme
    if (trimmed === '<OK' || trimmed === '[OK]') {
      this._finish(this._parseCurrentBuffer(this._mode));
      return;
    }

    if      (this._mode === 'COMCONFIG')     this._onComconfigLine(line);
    else if (this._mode === 'ICOMCONFIG')    this._onIcomconfigLine(line);
    else if (this._mode === 'LOGLISTA')      this._onLoglistaLine(line);
    else if (this._mode === 'AUTHORIZATION') this._onAuthorizationLine(line);
  }

  _onComconfigLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // < > [ ile başlayanlar komut echo'su — data değil
    if (trimmed.startsWith('<') || trimmed.startsWith('>') || trimmed.startsWith('[')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (this._isNoise(upper)) return;
    if (upper.includes('LOGLISTA') || upper.includes('ICOMCONFIG')) return;

    const tokens      = trimmed.split(/\s+/);
    const hasHeader   = upper.includes('COMCONFIG');
    const isPortLine  = tokens.length > 0
                     && PORT_REGEX.test(tokens[0])
                     && !ICOM_REGEX.test(tokens[0]);

    if (hasHeader || isPortLine) {
      this._buffer.push(trimmed);
      // <OK gelmezse 150ms settle ile bitir
      this._resetSettle(SETTLE_MS, () => {
        this._finish({ ports: this._parseComconfig(this._buffer) });
      });
    }
  }

  _onIcomconfigLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('<') || trimmed.startsWith('>') || trimmed.startsWith('[')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (this._isNoise(upper)) return;
    if (upper.includes('LOGLISTA')) return;
    if (upper.includes('COMCONFIG') && !upper.includes('ICOMCONFIG')) return;

    const tokens      = trimmed.split(/\s+/);
    const hasHeader   = upper.includes('ICOMCONFIG');
    const isIcomLine  = tokens.length > 0 && ICOM_REGEX.test(tokens[0]);

    if (hasHeader || isIcomLine) {
      this._buffer.push(trimmed);
      this._resetSettle(SETTLE_MS, () => {
        this._finish({ ports: this._parseIcomconfig(this._buffer) });
      });
    }
  }

  _onLoglistaLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('>')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (upper.includes('COMCONFIG') || upper.includes('ICOMCONFIG')) return;
    if (this._isNoise(upper)) return;

    if (upper.includes('LOGLISTA')) {
      this._buffer.push(trimmed);
      // Tek satır response — hemen bitir, bekleme yok
      this._finish({ entries: this._parseLoglista(this._buffer) });
    }
  }

  _onAuthorizationLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('<') || trimmed.startsWith('>') || trimmed.startsWith('[')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (this._isNoise(upper)) return;

    // Tek satır response, noktalı virgül ile ayrılan header + data içeriyor
    if (upper.includes('AUTHORIZATION') && trimmed.includes(';')) {
      this._buffer.push(trimmed);
      // <OK ile biter; settle gerekmez
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _isNoise(upper) {
    return NOISE_PREFIXES.some(p => upper.startsWith(p));
  }

  _resetSettle(ms, cb) {
    if (this._settleId) clearTimeout(this._settleId);
    this._settleId = setTimeout(() => { this._clearTimers(); cb(); }, ms);
  }

  _parseCurrentBuffer(type) {
    if (type === 'COMCONFIG')     return { ports:         this._parseComconfig(this._buffer)    };
    if (type === 'ICOMCONFIG')    return { ports:         this._parseIcomconfig(this._buffer)   };
    if (type === 'LOGLISTA')      return { entries:       this._parseLoglista(this._buffer)     };
    if (type === 'AUTHORIZATION') return { authorization: this._parseAuthorization(this._buffer)};
    return {};
  }

  _finish(result) {
    this._clearTimers();
    const resolve  = this._resolve;
    this._mode     = null;
    this._buffer   = [];
    this._resolve  = null;
    if (resolve) resolve(result);
  }

  _clearTimers() {
    if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    if (this._settleId)  { clearTimeout(this._settleId);  this._settleId  = null; }
  }

  // ─── Parsers ───────────────────────────────────────────────────────────────

  _parseAuthorization(lines) {
    for (const line of lines) {
      const upper = line.toUpperCase();
      if (!upper.includes('AUTHORIZATION')) continue;

      const semiIdx = line.indexOf(';');
      if (semiIdx === -1) continue;

      let payload = line.substring(semiIdx + 1);
      // CRC'yi at
      const starIdx = payload.lastIndexOf('*');
      if (starIdx !== -1) payload = payload.substring(0, starIdx);

      // fields: AuthMode, TimeRemaining, InsEnable, DualAntEnable, MaxRTKFreq, MaxInsFreq, ...
      const fields = payload.split(',').map(t => t.trim());
      if (fields.length < 4) continue;

      return {
        authMode:     fields[0] || 'UNKNOWN',
        insEnable:    fields[2]?.toUpperCase() === 'TRUE',
        dualAntEnable:fields[3]?.toUpperCase() === 'TRUE',
        maxRtkFreq:   parseInt(fields[4]) || 0,
        maxInsFreq:   parseInt(fields[5]) || 0
      };
    }
    return null;  // Cihaz AUTHORIZATION desteklemiyor veya timeout
  }

  _parseComconfig(lines) {
    const ports = [];
    const seen  = new Set();

    for (const line of lines) {
      let data = line.trim();
      if (data.includes(';')) data = data.split(';')[1];

      let tokens = data.includes(',')
        ? data.split(',').map(t => t.trim())
        : data.split(/\s+/);

      if (tokens.length > 0)
        tokens[tokens.length - 1] = tokens[tokens.length - 1].split('*')[0];

      if (!tokens.length) continue;

      if (PORT_REGEX.test(tokens[0]) && !ICOM_REGEX.test(tokens[0])) {
        const name = tokens[0].toUpperCase();
        if (seen.has(name)) continue;
        seen.add(name);

        let baud = null, inMode = null, outMode = null;

        if (tokens.length >= 2 && /^\d+$/.test(tokens[1])) baud = tokens[1];

        if (data.includes(',') && tokens.length >= 9) {
          if (tokens[8]) inMode  = tokens[8];
          if (tokens[9]) outMode = tokens[9];
        }

        if (!inMode)  { const m = line.match(/IN:(\S+)/i);  if (m) inMode  = m[1]; }
        if (!outMode) { const m = line.match(/OUT:(\S+)/i); if (m) outMode = m[1]; }

        if (!inMode  && tokens.length > 8) inMode  = tokens[8];
        if (!outMode && tokens.length > 9) outMode = tokens[9];

        ports.push({ name, type: 'serial', baud, inMode, outMode });
      }
    }

    ports.sort((a, b) =>
      (parseInt(a.name.replace(/\D/g, '')) || 0) -
      (parseInt(b.name.replace(/\D/g, '')) || 0)
    );
    return ports;
  }

  _parseIcomconfig(lines) {
    const ports = [];
    const seen  = new Set();

    for (const line of lines) {
      let data = line.trim();
      if (data.includes(';')) data = data.split(';')[1];

      let tokens = data.includes(',')
        ? data.split(',').map(t => t.trim())
        : data.split(/\s+/);

      if (tokens.length > 0)
        tokens[tokens.length - 1] = tokens[tokens.length - 1].split('*')[0];

      if (!tokens.length) continue;

      if (ICOM_REGEX.test(tokens[0])) {
        const name = tokens[0].toUpperCase();
        if (seen.has(name)) continue;
        seen.add(name);

        let protocol = null, tcpPort = null, inMode = null, outMode = null;

        if (tokens.length >= 2) protocol = tokens[1];
        if (tokens.length >= 3) tcpPort  = tokens[2];

        if (data.includes(',')) {
          if (tokens.length > 4) inMode  = tokens[4];
          if (tokens.length > 5) outMode = tokens[5];
        }

        const portMatch = line.match(/:(\d+)/);
        if (!tcpPort && portMatch) tcpPort = portMatch[1];

        if (!inMode)  { const m = line.match(/IN:(\S+)/i);  if (m) inMode  = m[1]; }
        if (!outMode) { const m = line.match(/OUT:(\S+)/i); if (m) outMode = m[1]; }

        ports.push({ name, type: 'ethernet', protocol, tcpPort, inMode, outMode });
      }
    }

    ports.sort((a, b) =>
      (parseInt(a.name.replace(/\D/g, '')) || 0) -
      (parseInt(b.name.replace(/\D/g, '')) || 0)
    );
    return ports;
  }

  _parseLoglista(lines) {
    const entries = [];

    let payload = '';
    for (const line of lines) {
      const idx = line.indexOf('#LOGLISTA');
      if (idx !== -1) { payload = line.substring(idx); break; }
      if (line.toUpperCase().includes('LOGLISTA')) { payload = line; break; }
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
      const port   = tokens[i].toUpperCase();
      const msg    = tokens[i + 1].toUpperCase();
      const mode   = tokens[i + 2].toUpperCase();
      const period = parseFloat(tokens[i + 3]) || 0;
      const extra  = parseFloat(tokens[i + 4]) || 0;
      const hold   = tokens[i + 5];

      if (PORT_REGEX.test(port)) entries.push({ port, msg, mode, period, extra, hold });
      i += 6;
    }

    return entries;
  }
}

module.exports = DeviceQuery;
