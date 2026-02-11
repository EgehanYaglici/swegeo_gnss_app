// Serial / TCP / UDP connection manager
const { EventEmitter } = require('events');
const net = require('net');
const dgram = require('dgram');
const { calcBlockCrc32, crc24q } = require('./crc');

const BYNAV_PREAMBLE = Buffer.from([0xAA, 0x44, 0x12]);

// RTCM MSM ranges
const MSM_RANGES = [[1071, 1077], [1081, 1087], [1091, 1097], [1111, 1117], [1121, 1127]];
function isMSM(id) {
  return MSM_RANGES.some(([lo, hi]) => id >= lo && id <= hi);
}

class BitReader {
  constructor(data) {
    this.data = data;
    this.bitLen = data.length * 8;
    this.pos = 0;
  }
  read(n) {
    if (this.pos + n > this.bitLen) throw new Error('EOFError');
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = this.pos >> 3;
      const bitIdx = 7 - (this.pos & 7);
      v = (v << 1) | ((this.data[byteIdx] >> bitIdx) & 1);
      this.pos++;
    }
    return v;
  }
}

class SerialManager extends EventEmitter {
  constructor() {
    super();
    this.mode = null;       // 'serial' | 'tcp' | 'udp'
    this.connection = null;  // serialport / socket
    this.udpRemote = null;
    this._running = false;
    this._buffer = Buffer.alloc(0);
    this._desc = '';
    this._SerialPort = null;
  }

  // --- Connect methods ---

  async connectSerial(portPath, baudRate) {
    try {
      if (!this._SerialPort) {
        const { SerialPort } = require('serialport');
        this._SerialPort = SerialPort;
      }
      this.mode = 'serial';
      this._desc = `${portPath}@${baudRate}`;
      this.connection = new this._SerialPort({ path: portPath, baudRate, autoOpen: false });

      return new Promise((resolve) => {
        this.connection.open((err) => {
          if (err) {
            this._cleanup();
            resolve({ ok: false, msg: `[Serial] ${err.message}` });
            return;
          }
          this._running = true;
          this.connection.on('data', (chunk) => this._onData(chunk));
          this.connection.on('error', (err) => {
            this.emit('line', `[SERIAL ERROR] ${err.message}`, 'red');
          });
          this.connection.on('close', () => {
            this._running = false;
            this.emit('connection', false);
          });
          this.emit('connection', true);
          resolve({ ok: true, msg: `Connected (Serial) ${this._desc}` });
        });
      });
    } catch (e) {
      this._cleanup();
      return { ok: false, msg: `[Serial] ${e.message}` };
    }
  }

  connectTcp(host, port) {
    return new Promise((resolve) => {
      try {
        this.mode = 'tcp';
        this._desc = `tcp://${host}:${port}`;
        this.connection = new net.Socket();
        this.connection.setTimeout(3000);

        this.connection.connect(port, host, () => {
          this._running = true;
          this.connection.setTimeout(0);
          this.emit('connection', true);
          resolve({ ok: true, msg: `Connected (TCP) ${this._desc}` });
        });

        this.connection.on('data', (chunk) => this._onData(chunk));
        this.connection.on('error', (err) => {
          if (!this._running) {
            resolve({ ok: false, msg: `[TCP] ${err.message}` });
          } else {
            this.emit('line', `[TCP ERROR] ${err.message}`, 'red');
          }
        });
        this.connection.on('close', () => {
          this._running = false;
          this.emit('connection', false);
        });
        this.connection.on('timeout', () => {
          if (!this._running) {
            this._cleanup();
            resolve({ ok: false, msg: '[TCP] Connection timeout' });
          }
        });
      } catch (e) {
        this._cleanup();
        resolve({ ok: false, msg: `[TCP] ${e.message}` });
      }
    });
  }

  connectUdp(listenPort, remoteHost, remotePort) {
    return new Promise((resolve) => {
      try {
        this.mode = 'udp';
        this._desc = `udp://0.0.0.0:${listenPort}`;
        this.connection = dgram.createSocket('udp4');
        this.udpRemote = (remoteHost && remotePort) ? { host: remoteHost, port: remotePort } : null;

        this.connection.on('message', (msg) => this._onData(msg));
        this.connection.on('error', (err) => {
          this.emit('line', `[UDP ERROR] ${err.message}`, 'red');
        });

        this.connection.bind(listenPort, () => {
          this._running = true;
          this.emit('connection', true);
          resolve({ ok: true, msg: `Connected (UDP) ${this._desc}` });
        });
      } catch (e) {
        this._cleanup();
        resolve({ ok: false, msg: `[UDP] ${e.message}` });
      }
    });
  }

  disconnect() {
    this._running = false;
    this._cleanup();
    this.emit('connection', false);
  }

  _cleanup() {
    try {
      if (this.connection) {
        if (this.mode === 'serial') {
          if (this.connection.isOpen) this.connection.close();
        } else if (this.mode === 'tcp') {
          this.connection.destroy?.();
        } else if (this.mode === 'udp') {
          try { this.connection.close?.(); } catch { }
        }
      }
    } catch { }
    this.connection = null;
    this.mode = null;
    this.udpRemote = null;
    this._buffer = Buffer.alloc(0);
  }

  // --- Data processing ---

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._processBuffer();
  }

  _processBuffer() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const buf = this._buffer;

      // 1) BYNAV binary (AA 44 12)
      if (buf.length >= 3 && buf[0] === 0xAA && buf[1] === 0x44 && buf[2] === 0x12) {
        if (buf.length < 28) return;
        const headerLen = buf[3];
        if (buf.length < Math.max(12, headerLen + 4)) return;
        const payloadLen = buf.readUInt16LE(8);
        const totalLen = headerLen + payloadLen + 4;
        if (buf.length < totalLen) return;

        const msg = buf.slice(0, totalLen);
        const payloadWithHeader = msg.slice(0, -4);
        const crcRx = msg.readUInt32LE(msg.length - 4);
        const crcOk = crcRx === calcBlockCrc32(payloadWithHeader);

        const msgId = payloadWithHeader.readUInt16LE(4);
        const pLen = payloadWithHeader.readUInt16LE(8);
        const pStart = payloadWithHeader[3]; // headerLen
        const pEnd = pStart + pLen;
        const payload = (pEnd <= payloadWithHeader.length)
          ? payloadWithHeader.slice(pStart, pEnd) : Buffer.alloc(0);

        const hexStr = [...msg].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        this.emit('line', crcOk ? hexStr : `[CRC ERROR] ${hexStr}`, crcOk ? '#888' : 'red');
        this.emit('binary', { ok: crcOk, id: msgId, payload, raw: msg, crc: crcRx });

        this._buffer = buf.slice(totalLen);
        progressed = true;
        continue;
      }

      // 2) RTCM v3 (0xD3)
      const rtcmIdx = buf.indexOf(0xD3);
      if (rtcmIdx === -1) {
        // 3) ASCII (\n)
        const lfIdx = buf.indexOf(0x0A);
        if (lfIdx >= 0) {
          const line = buf.slice(0, lfIdx + 1).toString('utf-8').trim();
          this.emit('line', line, '#000');
          this._buffer = buf.slice(lfIdx + 1);
          progressed = true;
          continue;
        }
        if (buf.length > 4096) {
          this._buffer = buf.slice(-3);
        }
        return;
      }

      // Check for ASCII before RTCM preamble
      const lfBefore = buf.indexOf(0x0A, 0);
      if (lfBefore >= 0 && lfBefore < rtcmIdx) {
        const line = buf.slice(0, lfBefore + 1).toString('utf-8').trim();
        this.emit('line', line, '#000');
        this._buffer = buf.slice(lfBefore + 1);
        progressed = true;
        continue;
      }

      if (rtcmIdx > 0) {
        this._buffer = buf.slice(rtcmIdx);
        if (this._buffer.length < 3) return;
        progressed = true;
        continue;
      }

      if (buf.length < 3) return;
      const length = ((buf[1] & 0x03) << 8) | buf[2];
      if (length === 0 || length > 1023) {
        this._buffer = buf.slice(1);
        progressed = true;
        continue;
      }
      const total = 1 + 2 + length + 3;
      if (buf.length < total) return;

      const frame = buf.slice(0, total);
      this._buffer = buf.slice(total);
      progressed = true;

      const crcRx = (frame[frame.length - 3] << 16) | (frame[frame.length - 2] << 8) | frame[frame.length - 1];
      const crcOk = crcRx === crc24q(frame.slice(0, -3));
      const rtcmPayload = frame.slice(3, -3);

      let msgId = null, sid = null;
      try {
        const br = new BitReader(rtcmPayload);
        msgId = br.read(12);
        if ([1005, 1006, 1007, 1008, 1033, 1019, 1020, 1230].includes(msgId) || isMSM(msgId)) {
          sid = br.read(12);
        }
      } catch { }

      const color = crcOk ? '#6a1b9a' : 'red';
      let txt = `[RTCM${crcOk ? ' OK' : ' BAD-CRC'}] id=${msgId ?? '?'}`;
      if (sid != null) txt += ` sid=${sid}`;
      txt += ` len=${length}`;
      this.emit('line', txt, color);
      this.emit('rtcm', { ok: crcOk, id: msgId, sid, length, total });
    }
  }

  // --- Send command ---

  sendCommand(cmd) {
    const data = Buffer.from(cmd + '\r\n', 'utf-8');
    try {
      if (this.mode === 'serial' && this.connection) {
        this.connection.write(data);
        // Echo command to terminal
        this.emit('line', `> ${cmd}`, '#0055FF'); // Blue for TX
        return { ok: true, msg: `Command sent: ${cmd}` };
      }
      if (this.mode === 'tcp' && this.connection) {
        this.connection.write(data);
        this.emit('line', `> ${cmd} (TCP)`, '#0055FF');
        return { ok: true, msg: `Command sent (TCP): ${cmd}` };
      }
      if (this.mode === 'udp' && this.connection && this.udpRemote) {
        this.connection.send(data, this.udpRemote.port, this.udpRemote.host);
        this.emit('line', `> ${cmd} (UDP)`, '#0055FF');
        return { ok: true, msg: `Command sent (UDP): ${cmd}` };
      }
      return { ok: false, msg: 'Connection not open.' };
    } catch (e) {
      return { ok: false, msg: `[SEND ERROR] ${e.message}` };
    }
  }

  // --- List serial ports ---
  static async listPorts() {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return ports.map(p => ({ path: p.path, manufacturer: p.manufacturer || '' }));
    } catch {
      return [];
    }
  }
}

module.exports = SerialManager;
