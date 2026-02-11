// NtripClient - NTRIP v1 client for RTK corrections
// Connects to caster, sends GGA, receives RTCM, forwards to serial port

const net = require('net');
const { EventEmitter } = require('events');

const GGA_INTERVAL_MS = 1000;   // Send GGA every 1 second
const RECONNECT_DELAY_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;
const STATS_INTERVAL_MS = 1000;

class NtripClient extends EventEmitter {
  constructor(serialManager) {
    super();
    this._serial = serialManager;
    this._socket = null;
    this._connected = false;
    this._handshakeDone = false;
    this._config = null;
    this._latestGga = null;
    this._ggaTimer = null;
    this._reconnectTimer = null;
    this._statsTimer = null;
    this._autoReconnect = false;
    this._headerBuf = '';

    // Stats
    this._stats = {
      bytesReceived: 0,
      rtcmMessages: 0,
      startTime: 0,
      lastRtcmTime: 0,
      bytesSinceLastStat: 0
    };
    this._rtcmTypes = new Map(); // msgId → count
    this._lastDataRate = 0;
  }

  // --- Public API ---

  async connect(config) {
    if (this._connected) {
      this.disconnect();
    }

    this._config = config;
    this._autoReconnect = true;
    this._stats = { bytesReceived: 0, rtcmMessages: 0, startTime: Date.now(), lastRtcmTime: 0, bytesSinceLastStat: 0 };
    this._rtcmTypes.clear();
    this._lastDataRate = 0;
    this._handshakeDone = false;
    this._headerBuf = '';

    return new Promise((resolve) => {
      try {
        const { host, port, mountpoint, username, password } = config;

        this._socket = new net.Socket();
        this._socket.setTimeout(CONNECT_TIMEOUT_MS);

        this._socket.on('connect', () => {
          // Send NTRIP v1 request
          const auth = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
          const request = [
            `GET /${mountpoint} HTTP/1.0`,
            `Host: ${host}`,
            'Ntrip-Version: Ntrip/1.0',
            'User-Agent: SWEGEO-NTRIP/1.0',
            `Authorization: Basic ${auth}`,
            '',
            ''
          ].join('\r\n');

          this._socket.write(request);
        });

        this._socket.on('data', (buf) => {
          if (!this._handshakeDone) {
            this._handleHandshake(buf, resolve);
          } else {
            this._onRtcmData(buf);
          }
        });

        this._socket.on('close', () => this._onClose());
        this._socket.on('error', (err) => this._onError(err, resolve));
        this._socket.on('timeout', () => {
          this._socket.destroy();
          resolve({ ok: false, error: 'Connection timeout' });
        });

        this._socket.connect(parseInt(port) || 2101, host);
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  disconnect() {
    this._autoReconnect = false;
    this._cleanup();
    this._connected = false;
    this._emitStatus();
  }

  setGga(sentence) {
    this._latestGga = sentence;
  }

  getStats() {
    const now = Date.now();
    const duration = this._stats.startTime ? Math.floor((now - this._stats.startTime) / 1000) : 0;
    return {
      connected: this._connected,
      host: this._config?.host || '',
      mountpoint: this._config?.mountpoint || '',
      bytesReceived: this._stats.bytesReceived,
      rtcmMessages: this._stats.rtcmMessages,
      duration: duration,
      dataRate: this._lastDataRate,
      rtcmTypes: Object.fromEntries(this._rtcmTypes),
      lastRtcmTime: this._stats.lastRtcmTime
    };
  }

  // --- Source Table ---

  async getSourceTable(config) {
    return new Promise((resolve) => {
      try {
        const { host, port, username, password } = config;
        const sock = new net.Socket();
        sock.setTimeout(CONNECT_TIMEOUT_MS);
        let buf = '';

        sock.on('connect', () => {
          const auth = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
          const request = [
            'GET / HTTP/1.0',
            `Host: ${host}`,
            'Ntrip-Version: Ntrip/1.0',
            'User-Agent: SWEGEO-NTRIP/1.0',
            `Authorization: Basic ${auth}`,
            '',
            ''
          ].join('\r\n');
          sock.write(request);
        });

        sock.on('data', (chunk) => {
          buf += chunk.toString('latin1');
        });

        sock.on('end', () => {
          sock.destroy();
          resolve(this._parseSourceTable(buf));
        });

        sock.on('close', () => {
          resolve(this._parseSourceTable(buf));
        });

        sock.on('error', (err) => {
          sock.destroy();
          resolve({ ok: false, sources: [], error: err.message });
        });

        sock.on('timeout', () => {
          sock.destroy();
          resolve({ ok: false, sources: [], error: 'Timeout' });
        });

        sock.connect(parseInt(port) || 2101, host);
      } catch (err) {
        resolve({ ok: false, sources: [], error: err.message });
      }
    });
  }

  _parseSourceTable(raw) {
    // Find body after HTTP header
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) return { ok: false, sources: [], error: 'Invalid response' };

    const header = raw.substring(0, headerEnd);
    if (!/200/i.test(header.split('\r\n')[0])) {
      return { ok: false, sources: [], error: `Server: ${header.split('\r\n')[0]}` };
    }

    const body = raw.substring(headerEnd + 4);
    const lines = body.split('\n');
    const sources = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('STR;')) continue;

      // STR;mountpoint;identifier;format;format-details;carrier;nav-system;network;country;lat;lon;...
      const parts = trimmed.split(';');
      if (parts.length < 10) continue;

      sources.push({
        mountpoint: parts[1] || '',
        identifier: parts[2] || '',
        format: parts[3] || '',
        formatDetails: parts[4] || '',
        carrier: parseInt(parts[5]) || 0,
        navSystem: parts[6] || '',
        network: parts[7] || '',
        country: parts[8] || '',
        lat: parseFloat(parts[9]) || 0,
        lon: parseFloat(parts[10]) || 0,
        nmea: parseInt(parts[11]) || 0,
        solution: parseInt(parts[12]) || 0,
        bitrate: parts[18] || ''
      });
    }

    return { ok: true, sources };
  }

  // --- Handshake ---

  _handleHandshake(buf, resolve) {
    this._headerBuf += buf.toString('latin1');

    // Check for end of HTTP header
    const headerEnd = this._headerBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // Wait for more data

    const header = this._headerBuf.substring(0, headerEnd);
    const remaining = buf.slice(buf.length - (this._headerBuf.length - headerEnd - 4));

    this._handshakeDone = true;
    this._headerBuf = '';

    // Check response
    if (/ICY 200 OK/i.test(header) || /HTTP\/1\.\d 200/i.test(header)) {
      this._connected = true;
      this._stats.startTime = Date.now();
      this._startGgaTimer();
      this._startStatsTimer();
      this._emitStatus();
      resolve({ ok: true });

      // Process any RTCM data that came after the header
      if (remaining.length > 0) {
        this._onRtcmData(remaining);
      }
    } else {
      // Auth failure or other error — stop auto-reconnect
      this._autoReconnect = false;
      const firstLine = header.split('\r\n')[0] || 'Unknown error';
      this._socket.destroy();
      resolve({ ok: false, error: `NTRIP rejected: ${firstLine}` });
    }
  }

  // --- RTCM Data Processing ---

  _onRtcmData(buf) {
    this._stats.bytesReceived += buf.length;
    this._stats.bytesSinceLastStat += buf.length;
    this._stats.lastRtcmTime = Date.now();

    // Extract RTCM message IDs from the stream
    this._extractRtcmIds(buf);

    // Forward raw data to serial port (direct to device)
    if (this._serial && this._serial.connection) {
      try {
        this._serial.connection.write(buf);
      } catch (e) {
        // Serial port write error — ignore silently
      }
    }
  }

  _extractRtcmIds(buf) {
    // Scan for RTCM v3 frames: 0xD3 + 2 bytes (6 reserved + 10-bit length) + payload
    // Message ID is first 12 bits of payload
    let i = 0;
    while (i < buf.length - 3) {
      if (buf[i] === 0xD3) {
        const len = ((buf[i + 1] & 0x03) << 8) | buf[i + 2];
        if (len > 0 && len < 1024 && (i + 3 + len) <= buf.length) {
          // Extract 12-bit message ID from first 2 bytes of payload
          const msgId = (buf[i + 3] << 4) | ((buf[i + 4] >> 4) & 0x0F);
          if (msgId > 0 && msgId < 4096) {
            this._rtcmTypes.set(msgId, (this._rtcmTypes.get(msgId) || 0) + 1);
            this._stats.rtcmMessages++;
          }
          i += 3 + len + 3; // header + payload + CRC
          continue;
        }
      }
      i++;
    }
  }

  // --- GGA Timer ---

  _startGgaTimer() {
    this._stopGgaTimer();
    this._ggaTimer = setInterval(() => {
      if (this._connected && this._socket && this._latestGga) {
        try {
          // Send GGA with \r\n
          let gga = this._latestGga.trim();
          if (!gga.endsWith('\r\n')) gga += '\r\n';
          this._socket.write(gga);
        } catch (e) {
          // Socket write error
        }
      }
    }, GGA_INTERVAL_MS);
  }

  _stopGgaTimer() {
    if (this._ggaTimer) {
      clearInterval(this._ggaTimer);
      this._ggaTimer = null;
    }
  }

  // --- Stats Timer ---

  _startStatsTimer() {
    this._stopStatsTimer();
    this._statsTimer = setInterval(() => {
      this._lastDataRate = this._stats.bytesSinceLastStat;
      this._stats.bytesSinceLastStat = 0;
      this.emit('stats', this.getStats());
    }, STATS_INTERVAL_MS);
  }

  _stopStatsTimer() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  // --- Connection Events ---

  _onClose() {
    const wasConnected = this._connected;
    this._cleanup();
    this._connected = false;

    if (wasConnected) {
      this._emitStatus();
      this.emit('error', { message: 'Connection closed' });
    }

    // Auto-reconnect
    if (this._autoReconnect && this._config) {
      this._reconnectTimer = setTimeout(() => {
        if (this._autoReconnect) {
          this.emit('error', { message: 'Reconnecting...' });
          this.connect(this._config);
        }
      }, RECONNECT_DELAY_MS);
    }
  }

  _onError(err, resolve) {
    this._cleanup();
    this._connected = false;
    this.emit('error', { message: err.message || 'Connection error' });
    this._emitStatus();
    if (resolve) resolve({ ok: false, error: err.message });
  }

  _cleanup() {
    this._stopGgaTimer();
    this._stopStatsTimer();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    this._handshakeDone = false;
    this._headerBuf = '';
  }

  _emitStatus() {
    this.emit('status', this.getStats());
  }
}

module.exports = NtripClient;
