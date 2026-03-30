const { EventEmitter } = require('events');

const TIMEOUT_MS           = 3000;   // COMCONFIG/ICOMCONFIG/LOGLISTA fallback timeout
const AUTH_TIMEOUT_MS      = 2000;   // AUTHORIZATION fallback timeout
const UBX_VER_TIMEOUT_MS   = 2000;   // MON-VER poll timeout — Ublox phase 2 detection
const SETTLE_MS            = 150;    // Data akışı durduğunda bitiş gecikmesi
const AUTH_SETTLE_MS       = 300;    // AUTHORIZATION: satırlar arası boşluk için biraz daha bekle
const LOGLISTA_COOLDOWN_MS = 1000;
const RETRY_DELAY_MS       = 300;
const MAX_RETRIES          = 2;

// UBX MON-VER composite ID: (0x0A << 8) | 0x04 = 2564
const UBX_MON_VER_ID = (0x0A << 8) | 0x04;
// UBX CFG-VALGET response ID: (0x06 << 8) | 0x8B = 1675
const UBX_CFG_VALGET_ID = (0x06 << 8) | 0x8B;
// UBX ACK IDs
const UBX_ACK_ACK_ID = (0x05 << 8) | 0x01;
const UBX_ACK_NAK_ID = (0x05 << 8) | 0x00;

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

    // ── Ana queue state (COMCONFIG / ICOMCONFIG / LOGLISTA) ──
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

    // ── AUTHORIZATION state — ana queue'dan bağımsız, paralel çalışır ──
    this._authRunning   = false;
    this._authBuffer    = [];
    this._authResolve   = null;
    this._authTimeoutId = null;
    this._authSettleId  = null;

    // ── UBX Phase-2 detection state (MON-VER poll) ──────────────────
    this._ubxRunning   = false;
    this._ubxResolve   = null;
    this._ubxTimeoutId = null;

    // ── UBX CFG-VALGET state ─────────────────────────────────────────
    this._cfgGetRunning   = false;
    this._cfgGetResolve   = null;
    this._cfgGetTimeoutId = null;

    this._lineHandler   = (text) => this._onLine(text);
    this._binaryHandler = (frame) => this._onBinaryFrame(frame);
    this._serial.on('line',   this._lineHandler);
    this._serial.on('binary', this._binaryHandler);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  requestComconfig()    { return this._enqueue('COMCONFIG');    }
  requestIcomconfig()   { return this._enqueue('ICOMCONFIG');   }
  requestLoglista()     { return this._enqueue('LOGLISTA');     }

  // AUTHORIZATION ana queue'dan bağımsız çalışır — COMCONFIG'i bloke etmez
  requestAuthorization() {
    return new Promise((resolve) => {
      if (this._authRunning) {
        // Zaten çalışıyor — aynı sonuca piggyback ol
        const orig = this._authResolve;
        this._authResolve = (r) => { orig(r); resolve(r); };
        return;
      }
      this._authRunning  = true;
      this._authBuffer   = [];
      this._authResolve  = resolve;
      this._serial.sendCommand('LOG AUTHORIZATION ONCE');
      this._authTimeoutId = setTimeout(() => {
        this._finishAuth({ authorization: this._parseAuthorization(this._authBuffer) });
      }, AUTH_TIMEOUT_MS);
    });
  }

  // Phase-2 Ublox detection: MON-VER poll — BYNAV AUTH timeout'tan sonra çağrılır.
  // serialManager.sendUbx() ile B5 62 frame gönderir; binary event'ten cevabı bekler.
  requestUbxVersion() {
    return new Promise((resolve) => {
      if (this._ubxRunning) {
        // Zaten çalışıyor — aynı sonuca piggyback ol
        const orig = this._ubxResolve;
        this._ubxResolve = (r) => { orig(r); resolve(r); };
        return;
      }
      this._ubxRunning = true;
      this._ubxResolve = resolve;

      // MON-VER poll: class=0x0A id=0x04, boş payload
      const sent = this._serial.sendUbx(0x0A, 0x04);
      if (!sent.ok) {
        // Bağlantı yok — hemen sonuç ver
        this._finishUbx({ ubxVersion: null });
        return;
      }

      this._ubxTimeoutId = setTimeout(() => {
        console.log('[DeviceQuery] UBX MON-VER: timeout — not a u-blox device');
        this._finishUbx({ ubxVersion: null });
      }, UBX_VER_TIMEOUT_MS);
    });
  }

  // UBX CFG-VALGET poll: sends a config query and resolves with { [numericKey]: value, ... }
  // Keys are 32-bit u-blox config key IDs (e.g. 0x40520001 for UART1 baud rate).
  requestUbxCfgGet(keys, options = {}) {
    return new Promise((resolve) => {
      if (this._cfgGetRunning) {
        resolve({});
        return;
      }
      const requestedKeys = Array.isArray(keys) ? keys : [];
      if (requestedKeys.length === 0) {
        resolve({});
        return;
      }
      this._cfgGetRunning = true;
      this._cfgGetResolve = resolve;
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : 2000;

      // CFG-VALGET poll payload: version(1) + layer(1=RAM) + position(2) + keys(4×N)
      const payload = Buffer.alloc(4 + requestedKeys.length * 4);
      payload.writeUInt8(0x00, 0);          // version
      payload.writeUInt8(0x00, 1);          // layer: 0=RAM
      payload.writeUInt16LE(0x0000, 2);     // position (start from first)
      requestedKeys.forEach((key, i) => payload.writeUInt32LE(key >>> 0, 4 + i * 4));

      const sent = this._serial.sendUbx(0x06, 0x8B, payload);
      if (!sent || !sent.ok) {
        this._finishCfgGet({});
        return;
      }

      this._cfgGetTimeoutId = setTimeout(() => {
        console.log('[DeviceQuery] CFG-VALGET: timeout');
        this._finishCfgGet({});
      }, timeoutMs);
    });
  }

  // Disconnect'ta çağrılır — stale istekleri temizle, yeni bağlantıya hazırla
  reset() {
    // Ana queue
    this._clearTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    const stale = [...this._queue];
    this._queue  = [];
    this._mode   = null;
    this._buffer = [];
    // { error: 'reset' } kullan: _resolve wrapper'ındaki retry logic'i atlatır,
    // böylece disconnect sonrası stale retry döngüsü oluşmaz.
    if (this._resolve) { const r = this._resolve; this._resolve = null; r({ error: 'reset' }); }
    // Retry timer yeniden oluşmuş olabilir — tekrar temizle
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    for (const { resolve } of stale) resolve({ error: 'reset' });
    this._retryCount = 0;
    this._loglistaCooldownUntil = 0;

    // Auth state
    if (this._authTimeoutId) { clearTimeout(this._authTimeoutId); this._authTimeoutId = null; }
    if (this._authSettleId)  { clearTimeout(this._authSettleId);  this._authSettleId  = null; }
    this._authRunning = false;
    this._authBuffer  = [];
    if (this._authResolve) { const r = this._authResolve; this._authResolve = null; r({}); }

    // UBX phase-2 state
    if (this._ubxTimeoutId) { clearTimeout(this._ubxTimeoutId); this._ubxTimeoutId = null; }
    this._ubxRunning = false;
    if (this._ubxResolve) { const r = this._ubxResolve; this._ubxResolve = null; r({ ubxVersion: null }); }

    // CFG-VALGET state
    if (this._cfgGetTimeoutId) { clearTimeout(this._cfgGetTimeoutId); this._cfgGetTimeoutId = null; }
    this._cfgGetRunning = false;
    if (this._cfgGetResolve) { const r = this._cfgGetResolve; this._cfgGetResolve = null; r({}); }
  }

  destroy() {
    this._serial.removeListener('line',   this._lineHandler);
    this._serial.removeListener('binary', this._binaryHandler);
    this.reset();
  }

  // ─── Queue (COMCONFIG / ICOMCONFIG / LOGLISTA) ─────────────────────────────

  _enqueue(type) {
    return new Promise((resolve) => {
      if (type === 'LOGLISTA') {
        const now = Date.now();
        if (now < this._loglistaCooldownUntil && this._lastLoglistaResult) {
          resolve(this._lastLoglistaResult);
          return;
        }
      }

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
      const isEmpty = type === 'LOGLISTA'
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

    const cmd = type === 'COMCONFIG'  ? 'LOG COMCONFIG ONCE'
              : type === 'ICOMCONFIG' ? 'LOG ICOMCONFIG ONCE'
              :                         'LOG LOGLISTA ONCE';
    this._serial.sendCommand(cmd);

    this._timeoutId = setTimeout(() => {
      this._finish(this._parseCurrentBuffer(type));
    }, TIMEOUT_MS);
  }

  // ─── Line handler ──────────────────────────────────────────────────────────

  _onLine(text) {
    const line    = typeof text === 'string' ? text : String(text);
    const trimmed = line.trim();

    // <OK → ana queue isteğini bitir.
    // AUTH da <OK gönderir ama data'dan ÖNCE — eğer auth çalışıyorsa bu <OK
    // AUTH'a aittir, COMCONFIG/LOGLISTA'yı boş buffer'la bitirmemeli.
    // buffer.length > 0 guard: AUTH'un geç gelen <OK'ı yeni başlayan COMCONFIG'i
    // boş buffer'la bitirmesini önler (stale <OK race condition).
    if (trimmed === '<OK' || trimmed === '[OK]') {
      if (this._mode && !this._authRunning && this._buffer.length > 0) {
        this._finish(this._parseCurrentBuffer(this._mode));
      }
      return;
    }

    // AUTHORIZATION paralel çalışır — her satırı işle
    if (this._authRunning) this._onAuthorizationLine(line);

    // Ana queue
    if      (this._mode === 'COMCONFIG')  this._onComconfigLine(line);
    else if (this._mode === 'ICOMCONFIG') this._onIcomconfigLine(line);
    else if (this._mode === 'LOGLISTA')   this._onLoglistaLine(line);
  }

  // ─── Per-type line handlers ────────────────────────────────────────────────

  _onComconfigLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('<') || trimmed.startsWith('>')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (this._isNoise(upper)) return;
    if (upper.includes('LOGLISTA') || upper.includes('ICOMCONFIG')) return;

    // Strip optional [PORT] prefix (e.g. "[COM4]COM2 9600 ..." or "[COM4]#COMCONFIGA,...;COM2,...")
    // for token analysis only — raw line is kept for parser's own stripping logic.
    const clean      = trimmed.replace(/^\[[^\]]*\]/, '').trim();
    const tokens     = clean.split(/\s+/);
    const hasHeader  = upper.includes('COMCONFIG');
    const isPortLine = tokens.length > 0
                    && PORT_REGEX.test(tokens[0])
                    && !ICOM_REGEX.test(tokens[0]);

    if (hasHeader || isPortLine) {
      this._buffer.push(trimmed);
      this._resetSettle(SETTLE_MS, () => {
        this._finish({ ports: this._parseComconfig(this._buffer) });
      });
    }
  }

  _onIcomconfigLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('<') || trimmed.startsWith('>')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (this._isNoise(upper)) return;
    if (upper.includes('LOGLISTA')) return;
    if (upper.includes('COMCONFIG') && !upper.includes('ICOMCONFIG')) return;

    // Strip optional [PORT] prefix for token analysis
    const clean      = trimmed.replace(/^\[[^\]]*\]/, '').trim();
    const tokens     = clean.split(/\s+/);
    const hasHeader  = upper.includes('ICOMCONFIG');
    const isIcomLine = tokens.length > 0 && ICOM_REGEX.test(tokens[0]);

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
      this._finish({ entries: this._parseLoglista(this._buffer) });
    }
  }

  _onAuthorizationLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('>') || trimmed.startsWith('<')) return;
    if (trimmed.startsWith('$')) return;

    const upper = trimmed.toUpperCase();
    if (this._isNoise(upper)) return;

    // Buffer lines with ':' — handles all BYNAV response formats:
    //   "AuthMode:      M2-0D;"              (one field per line)
    //   "[COM4]AuthMode:      M2-0D;"        ([PORT] prefix on same line)
    //   "[COM4]AuthStr:;AuthMode:M2-0D;..."  (all fields on one line)
    if (trimmed.includes(':')) {
      this._authBuffer.push(trimmed);
      if (this._authSettleId) clearTimeout(this._authSettleId);
      this._authSettleId = setTimeout(() => {
        this._authSettleId = null;
        this._finishAuth({ authorization: this._parseAuthorization(this._authBuffer) });
      }, AUTH_SETTLE_MS);
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
    if (type === 'COMCONFIG')  return { ports:   this._parseComconfig(this._buffer)  };
    if (type === 'ICOMCONFIG') return { ports:   this._parseIcomconfig(this._buffer) };
    if (type === 'LOGLISTA')   return { entries: this._parseLoglista(this._buffer)   };
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

  _finishAuth(result) {
    if (this._authTimeoutId) { clearTimeout(this._authTimeoutId); this._authTimeoutId = null; }
    if (this._authSettleId)  { clearTimeout(this._authSettleId);  this._authSettleId  = null; }
    this._authRunning = false;
    this._authBuffer  = [];
    const resolve = this._authResolve;
    this._authResolve = null;
    if (resolve) resolve(result);
  }

  // ─── UBX binary frame handler ──────────────────────────────────────────────

  _onBinaryFrame(frame) {
    if (!frame.ok) return;

    // Phase-2 detection: MON-VER response
    if (this._ubxRunning && frame.id === UBX_MON_VER_ID) {
      const parsed = this._parseMonVer(frame.payload);
      console.log('[DeviceQuery] UBX MON-VER parsed:', parsed);
      this._finishUbx({ ubxVersion: parsed });
      return;
    }

    // CFG-VALGET response
    if (this._cfgGetRunning && frame.id === UBX_CFG_VALGET_ID) {
      const result = this._parseCfgGetResponse(frame.payload);
      console.log('[DeviceQuery] CFG-VALGET parsed:', Object.keys(result).length, 'keys');
      this._finishCfgGet(result);
      return;
    }

    // CFG-VALGET may return ACK-NAK when one or more keys are unsupported.
    if (this._cfgGetRunning && frame.id === UBX_ACK_NAK_ID && frame.payload?.length >= 2) {
      const ackClass = frame.payload.readUInt8(0);
      const ackId = frame.payload.readUInt8(1);
      if (ackClass === 0x06 && ackId === 0x8B) {
        console.log('[DeviceQuery] CFG-VALGET NAK received');
        this._finishCfgGet({});
        return;
      }
    }

    // ACK-ACK for VALGET is unusual but harmless: do nothing and wait for VALGET body.
    if (this._cfgGetRunning && frame.id === UBX_ACK_ACK_ID && frame.payload?.length >= 2) {
      const ackClass = frame.payload.readUInt8(0);
      const ackId = frame.payload.readUInt8(1);
      if (ackClass === 0x06 && ackId === 0x8B) return;
    }
  }

  _finishUbx(result) {
    if (this._ubxTimeoutId) { clearTimeout(this._ubxTimeoutId); this._ubxTimeoutId = null; }
    this._ubxRunning = false;
    const resolve = this._ubxResolve;
    this._ubxResolve = null;
    if (resolve) resolve(result);
  }

  _finishCfgGet(result) {
    if (this._cfgGetTimeoutId) { clearTimeout(this._cfgGetTimeoutId); this._cfgGetTimeoutId = null; }
    this._cfgGetRunning = false;
    const resolve = this._cfgGetResolve;
    this._cfgGetResolve = null;
    if (resolve) resolve(result);
  }

  // Parse CFG-VALGET response payload → { numericKey: value, ... }
  // Key bits [31:28] encode value size: 0x1=1bit(1B), 0x2=1B, 0x3=2B, 0x4=4B, 0x5=8B
  _parseCfgGetResponse(payload) {
    if (!payload || payload.length < 4) return {};
    const result = {};
    let offset = 4; // skip version(1) + layer(1) + position(2)
    while (offset + 4 <= payload.length) {
      const key = payload.readUInt32LE(offset);
      const sizeType = (key >>> 28) & 0xF;
      offset += 4;
      let valueSize;
      switch (sizeType) {
        case 0x1: valueSize = 1; break; // L  (1-bit bool stored as 1 byte)
        case 0x2: valueSize = 1; break; // U1
        case 0x3: valueSize = 2; break; // U2
        case 0x4: valueSize = 4; break; // U4
        case 0x5: valueSize = 8; break; // U8
        default:  valueSize = 1;
      }
      if (offset + valueSize > payload.length) break;
      let value;
      switch (valueSize) {
        case 1: value = payload.readUInt8(offset);    break;
        case 2: value = payload.readUInt16LE(offset); break;
        case 4: value = payload.readUInt32LE(offset); break;
        default: value = payload.readUInt8(offset);
      }
      result[key] = value;
      offset += valueSize;
    }
    return result;
  }

  // MON-VER payload parser
  // Payload: swVersion CH[30] + hwVersion CH[10] + extensions CH[30] × N
  _parseMonVer(payload) {
    if (!payload || payload.length < 40) return null;

    const readStr = (buf, start, len) =>
      buf.slice(start, start + len).toString('ascii').replace(/\0/g, '').trim();

    const swVersion = readStr(payload, 0,  30);
    const hwVersion = readStr(payload, 30, 10);

    const extensions = [];
    for (let i = 40; i + 30 <= payload.length; i += 30) {
      const ext = readStr(payload, i, 30);
      if (ext) extensions.push(ext);
    }

    // Parse key=value extension fields + collect GNSS constellations
    const result = { swVersion, hwVersion, extensions };

    // Known GNSS system identifiers (standalone or semicolon-separated)
    // e.g. extension 'GPS;GLO;GAL;BDS' or standalone 'QZSS'
    const GNSS_IDS = new Set(['GPS', 'GLO', 'GAL', 'BDS', 'QZSS', 'SBAS', 'IMES', 'NAVIC']);
    const gnssCollected = [];

    for (const ext of extensions) {
      const eqIdx = ext.indexOf('=');
      if (eqIdx !== -1) {
        // key=value format
        const key = ext.substring(0, eqIdx).trim();
        const val = ext.substring(eqIdx + 1).trim();
        if      (key === 'MOD')     result.model       = val;   // e.g. "ZED-F9P"
        else if (key === 'FWVER')   result.fwVersion   = val;   // e.g. "HPG 1.12"
        else if (key === 'PROTVER') result.protVersion = val;   // e.g. "27.11"
        else if (key === 'GNSS')    result.gnss        = val;   // if present as key=value
      } else {
        // No '=' — could be semicolon-separated GNSS list ('GPS;GLO;GAL;BDS')
        // or standalone identifier ('QZSS', 'ROM BASE 0x...' etc.)
        const parts = ext.split(';').map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
          if (GNSS_IDS.has(part)) gnssCollected.push(part);
        }
      }
    }

    // Populate gnss from collected constellations if not set by key=value
    if (gnssCollected.length > 0 && !result.gnss) {
      result.gnss = gnssCollected.join(' ');
    }

    return result;
  }

  _clearTimers() {
    if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    if (this._settleId)  { clearTimeout(this._settleId);  this._settleId  = null; }
  }

  // ─── Parsers ───────────────────────────────────────────────────────────────

  _parseAuthorization(lines) {
    // Handles multiple formats from BYNAV devices:
    //   1. One field per line:  "AuthMode:      M2-0D;"
    //   2. [PORT] prefix:       "[COM4]AuthMode:      M2-0D;"
    //   3. All on one line:     "[COM4]AuthStr:;AuthMode:M2-0D;InsEnable:FALSE;..."
    const kv = {};

    for (const rawLine of lines) {
      const segments = rawLine.split(';');
      for (let seg of segments) {
        seg = seg.replace(/^\[[^\]]*\]/, '').trim();
        const colonIdx = seg.indexOf(':');
        if (colonIdx === -1) continue;
        const key = seg.substring(0, colonIdx).trim().toUpperCase();
        const val = seg.substring(colonIdx + 1).trim();
        if (key && /^[A-Z][A-Z0-9]*$/.test(key)) kv[key] = val;
      }
    }

    if (Object.keys(kv).length === 0) {
      console.log('[DeviceQuery] AUTHORIZATION: no fields parsed (device may not support this command)');
      return null;
    }

    const result = {
      authMode:     kv['AUTHMODE']      || null,
      insEnable:    kv['INSENABLE']?.toUpperCase()     === 'TRUE',
      dualAntEnable:kv['DUALANTENABLE']?.toUpperCase() === 'TRUE',
      navSys:       kv['NAVSYS']        || '',
      frqMask:      kv['FRQMASK']       || '',
      maxRtkFreq:   parseInt(kv['MAXRTKFREQ']) || 0,
      maxInsFreq:   parseInt(kv['MAXINSFREQ']) || 0,
    };
    console.log('[DeviceQuery] AUTHORIZATION parsed:', result);
    return result;
  }

  _parseComconfig(lines) {
    const ports = [];
    const seen  = new Set();

    for (const line of lines) {
      let data = line.trim();
      data = data.replace(/^\[[^\]]*\]/, '').trim(); // strip [PORT] prefix
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
      data = data.replace(/^\[[^\]]*\]/, '').trim(); // strip [PORT] prefix
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
