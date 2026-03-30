const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

console.log('Main.js loaded');



let mainWindow;
let serialManager;
let messageRouter;
let deviceQuery;
let ntripClient;
let currentDeviceCaps = null;

// Prevent EPIPE crashes on stdout/stderr when pipe is broken
process.stdout?.on('error', () => { });
process.stderr?.on('error', () => { });

// Safe IPC send - checks if window exists and is not destroyed
function safeSend(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false, // Custom title bar
    icon: path.join(__dirname, '..', '..', 'assets', 'swegeo_logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Initialize backend
  const SerialManager = require('../backend/serial-manager');
  const MessageRouter = require('../backend/message-router');
  const DeviceQuery = require('../backend/device-query');
  const NtripClient = require('../backend/ntrip-client');

  serialManager = new SerialManager();
  messageRouter = new MessageRouter(serialManager);
  deviceQuery = new DeviceQuery(serialManager);
  ntripClient = new NtripClient(serialManager);

  // Forward NTRIP events to renderer
  ntripClient.on('status', (data) => safeSend('ntrip:status', data));
  ntripClient.on('stats', (data) => safeSend('ntrip:stats', data));
  ntripClient.on('error', (data) => safeSend('ntrip:error', data));

  // GGA feed: capture GPGGA/GNGGA from serial and forward to NTRIP caster
  const onGgaLine = (text) => {
    if (typeof text === 'string') {
      const trimmed = text.trim();
      if (trimmed.startsWith('$GPGGA') || trimmed.startsWith('$GNGGA')) {
        ntripClient.setGga(trimmed);
      }
    }
  };
  serialManager.on('line', onGgaLine);

  // Forward events to renderer (using safeSend to prevent errors on close)
  const onLine = (text, color) => safeSend('terminal:line', { text, color });

  let _lastConnStatus = null; // Duplicate connection event dedupe
  const onConnection = async (connected) => {
    // Aynı state'i tekrar işleme — serialport bazen çift 'close' event gönderir
    if (_lastConnStatus === connected) {
      console.log(`[Main] onConnection(${connected}) skipped — duplicate`);
      return;
    }
    _lastConnStatus = connected;
    safeSend('connection:status', connected);
    if (connected) {
      // ── Two-Phase Device Detection ─────────────────────────────────────────
      // Phase 1: BYNAV — LOG AUTHORIZATION ONCE → AUTH response
      // Phase 2: Ublox — UBX MON-VER poll (B5 62 0A 04) → binary response
      try {
        // Serial port açıldıktan hemen sonra cihaz DTR toggle + startup burst yapıyor.
        // Komut göndermeden önce 500ms bekleyerek cihazın hazır olmasını sağla.
        await new Promise(r => setTimeout(r, 500));

        // ── Phase 1: BYNAV AUTHORIZATION ──────────────────────────────────
        const authResult = await deviceQuery.requestAuthorization();
        const auth = authResult?.authorization ?? null;

        let caps;
        if (auth) {
          // BYNAV/SS100D — AUTH response geldi, InsEnable + DualAnt durumunu al
          console.log('[Main] Device detected: BYNAV/SS100D family');
          caps = {
            family:     'bynav',
            ins:        auth.insEnable     === true,
            dual_ant:   auth.dualAntEnable === true,
            authMode:   auth.authMode      || null,
            navSys:     auth.navSys        || '',
            frqMask:    auth.frqMask       || '',
            rf_monitor: false,
            model:      null,
            fwVersion:  null,
            detected:   true
          };
        } else {
          // ── Phase 2: Ublox MON-VER poll ───────────────────────────────
          console.log('[Main] No BYNAV AUTH response — trying Ublox MON-VER...');
          const ubxResult = await deviceQuery.requestUbxVersion();
          const ubxVer = ubxResult?.ubxVersion ?? null;

          if (ubxVer) {
            // u-blox device confirmed via MON-VER response
            // F9R modeli dead reckoning (IMU) içerir → ins: true
            const isF9R = !!(ubxVer.model && ubxVer.model.includes('F9R'));
            console.log(`[Main] Device detected: u-blox ${ubxVer.model || 'unknown'} (F9R=${isF9R})`);
            caps = {
              family:     'ublox',
              ins:        isF9R,
              dual_ant:   false,
              authMode:   null,
              navSys:     ubxVer.gnss     || '',
              frqMask:    '',
              rf_monitor: true,             // Tüm F9 modelleri MON-RF destekler
              model:      ubxVer.model     || null,
              fwVersion:  ubxVer.fwVersion || null,
              protVersion:ubxVer.protVersion || null,
              detected:   true
            };
          } else {
            // Hiçbir family tanımlanamadı — generic fallback
            console.log('[Main] Device family unknown — using generic defaults');
            caps = {
              family: 'generic',
              ins: false, dual_ant: false, authMode: null,
              navSys: '', frqMask: '', rf_monitor: false,
              model: null, fwVersion: null,
              detected: false
            };
          }
        }

        currentDeviceCaps = caps;
        safeSend('device:capabilities', caps);
      } catch {
        currentDeviceCaps = {
          family: 'generic',
          ins: false, dual_ant: false, authMode: null,
          navSys: '', frqMask: '', rf_monitor: false,
          model: null, fwVersion: null, detected: false
        };
        safeSend('device:capabilities', currentDeviceCaps);
      }
    } else {
      deviceQuery.reset();  // Eski bağlantıdan kalma stale istekleri temizle
      currentDeviceCaps = null;
      safeSend('device:capabilities', null);
    }
  };

  serialManager.on('line', onLine);
  serialManager.on('connection', onConnection);

  // Forward parsed binary frames to renderer (for info panel live values)
  const onBinaryFrame = (frame) => {
    if (!frame.ok) return;
    const { parseBinaryPayload } = require('../backend/binary-parser');
    try {
      const parsed = parseBinaryPayload(frame.id, frame.payload, frame.crc);
      if (parsed) {
        // Flatten fields for the renderer: { fieldName: value, ... }
        const flat = {};
        for (const [name, data] of Object.entries(parsed.fields || {})) {
          flat[name] = (typeof data === 'object' && data !== null && 'value' in data)
            ? data.value : data;
        }
        safeSend('binary:parsed', {
          msgId: frame.id,
          schemaKey: parsed.schema_key,
          name: parsed.message_type,
          fields: flat
        });
      }
    } catch { }
  };
  serialManager.on('binary', onBinaryFrame);

  // Forward capability data to renderer
  const capabilityHandlers = {};
  for (const cap of ['position', 'velocity', 'heading', 'satellites', 'imu', 'rf_health', 'time']) {
    capabilityHandlers[cap] = (data) => safeSend(`data:${cap}`, data);
    messageRouter.on(cap, capabilityHandlers[cap]);
  }

  // Forward parsed message stream to renderer (for info panel live values)
  const onLogData = (data) => safeSend('log:data', data);
  messageRouter.on('log', onLogData);

  // Clean up listeners when window closes
  mainWindow.on('closed', () => {
    serialManager.removeListener('line', onLine);
    serialManager.removeListener('line', onGgaLine);
    serialManager.removeListener('connection', onConnection);
    serialManager.removeListener('binary', onBinaryFrame);
    messageRouter.removeListener('log', onLogData);
    for (const cap of Object.keys(capabilityHandlers)) {
      messageRouter.removeListener(cap, capabilityHandlers[cap]);
    }
    ntripClient.disconnect();
    ntripClient.removeAllListeners();
    mainWindow = null;
  });

  // DevTools only in dev mode, blocked in packaged builds
  if (!app.isPackaged && process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools();
  }
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (e, input) => {
      if (input.key === 'I' && input.control && input.shift) e.preventDefault();
      if (input.key === 'F12') e.preventDefault();
    });
  }
}

function setupIPC() {
  const SerialManager = require('../backend/serial-manager');
  const { getMessagesForCapability, getAllMessageDefinitions, getMessageSchema, getReferenceTable } = require('../backend/schema-loader');
  const { requestCfgValuesResilient } = require('../backend/ubx-cfg-query');

  // Window controls
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.restore();
    else mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());

  // Serial port management
  ipcMain.handle('serial:list', async () => {
    return await SerialManager.listPorts();
  });

  ipcMain.handle('serial:connect', async (_, params) => {
    const { type, port, baudrate, host, tcpPort, udpPort, remoteHost, remotePort } = params;
    switch (type) {
      case 'serial': return await serialManager.connectSerial(port, baudrate);
      case 'tcp': return await serialManager.connectTcp(host, tcpPort);
      case 'udp': return await serialManager.connectUdp(udpPort, remoteHost, remotePort);
      default: return { ok: false, msg: 'Unknown connection type' };
    }
  });

  ipcMain.handle('serial:disconnect', async () => {
    serialManager.disconnect();
    return { ok: true };
  });

  ipcMain.handle('serial:send', async (_, cmd) => {
    try {
      console.log(`[Main] Sending Command: ${cmd}`);
    } catch (_e) { /* EPIPE safe */ }
    return serialManager.sendCommand(cmd);
  });
  const UBX_ACK_ACK = (0x05 << 8) | 0x01;
  const UBX_ACK_NAK = (0x05 << 8) | 0x00;
  const UBX_CFG_VALSET_CLASS = 0x06;
  const UBX_CFG_VALSET_ID = 0x8A;

  const UBX_PORT_KEYS = {
    uart1: {
      name: 'UART1',
      type: 'serial',
      baud: 0x40520001,
      inUbx: 0x10730001,
      inNmea: 0x10730002,
      inRtcm: 0x10730004,
      outUbx: 0x10740001,
      outNmea: 0x10740002,
      outRtcm: 0x10740004
    },
    uart2: {
      name: 'UART2',
      type: 'serial',
      baud: 0x40530001,
      inUbx: 0x10750001,
      inNmea: 0x10750002,
      inRtcm: 0x10750004,
      outUbx: 0x10760001,
      outNmea: 0x10760002,
      outRtcm: 0x10760004
    },
    usb: {
      name: 'USB',
      type: 'usb',
      baud: null,
      inUbx: 0x10770001,
      inNmea: 0x10770002,
      inRtcm: 0x10770004,
      outUbx: 0x10780001,
      outNmea: 0x10780002,
      outRtcm: 0x10780004
    }
  };

  async function requestUbxCfgValues(keys, options = {}) {
    if (!deviceQuery) return {};
    return requestCfgValuesResilient(
      (queryKeys, queryOptions) => deviceQuery.requestUbxCfgGet(queryKeys, queryOptions),
      keys,
      {
        batchSize: options.batchSize ?? 20,
        timeoutMs: options.timeoutMs ?? 450,
        fallbackToSingle: options.fallbackToSingle ?? true,
        interRequestDelayMs: options.interRequestDelayMs ?? 0
      }
    );
  }

  function buildUbxPortsFromKv(kv = {}) {
    function buildPortEntry(portDef) {
      const inProtos = [];
      const outProtos = [];
      if (kv[portDef.inUbx]) inProtos.push('UBX');
      if (kv[portDef.inNmea]) inProtos.push('NMEA');
      if (kv[portDef.inRtcm]) inProtos.push('RTCM3');
      if (kv[portDef.outUbx]) outProtos.push('UBX');
      if (kv[portDef.outNmea]) outProtos.push('NMEA');
      if (kv[portDef.outRtcm]) outProtos.push('RTCM3');

      const entry = {
        name: portDef.name,
        type: portDef.type,
        inMode: inProtos.join('+') || '-',
        outMode: outProtos.join('+') || '-'
      };

      if (portDef.baud != null) {
        const baud = kv[portDef.baud] || 0;
        entry.baud = baud ? String(baud) : '-';
      }

      return entry;
    }

    return [
      buildPortEntry(UBX_PORT_KEYS.uart1),
      buildPortEntry(UBX_PORT_KEYS.uart2),
      buildPortEntry(UBX_PORT_KEYS.usb)
    ];
  }

  async function sendUbxValsetWithAck(cfgKey, rateDiv, timeoutMs = 700) {
    if (!serialManager) return { ok: false, ack: 'SEND_FAIL', msg: 'Not connected' };

    const payload = Buffer.alloc(9);
    payload.writeUInt8(0x00, 0);
    payload.writeUInt8(0x01, 1);
    payload.writeUInt16LE(0x0000, 2);
    payload.writeUInt32LE(cfgKey >>> 0, 4);
    payload.writeUInt8(rateDiv & 0xFF, 8);

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        serialManager.removeListener('binary', onBinary);
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onBinary = (frame) => {
        if (!frame || !frame.ok || !frame.payload || frame.payload.length < 2) return;
        if (frame.id !== UBX_ACK_ACK && frame.id !== UBX_ACK_NAK) return;
        const ackClass = frame.payload.readUInt8(0);
        const ackId = frame.payload.readUInt8(1);
        if (ackClass !== UBX_CFG_VALSET_CLASS || ackId !== UBX_CFG_VALSET_ID) return;
        finish({
          ok: frame.id === UBX_ACK_ACK,
          ack: frame.id === UBX_ACK_ACK ? 'ACK' : 'NAK',
          msg: frame.id === UBX_ACK_ACK ? 'ACK received' : 'NAK received'
        });
      };

      serialManager.on('binary', onBinary);
      const sent = serialManager.sendUbx(UBX_CFG_VALSET_CLASS, UBX_CFG_VALSET_ID, payload);
      if (!sent || !sent.ok) {
        finish({ ok: false, ack: 'SEND_FAIL', msg: sent?.msg || 'VALSET send failed' });
        return;
      }

      timer = setTimeout(() => {
        finish({ ok: false, ack: 'TIMEOUT', msg: 'ACK timeout' });
      }, timeoutMs);
    });
  }

  // Backward-compatible single-key endpoint
  ipcMain.handle('ubx:setRate', async (_, { cfgKeyUart1, rateDiv }) => {
    if (!deviceQuery) return { ok: false, msg: 'Not connected' };
    const keyNum = Number(cfgKeyUart1);
    const valueNum = Math.max(0, Math.min(255, Number(rateDiv) || 0));
    if (!Number.isFinite(keyNum) || keyNum <= 0) return { ok: false, msg: 'Invalid key' };

    const ack = await sendUbxValsetWithAck(keyNum, valueNum);
    const kv = await requestUbxCfgValues([keyNum], {
      batchSize: 1,
      timeoutMs: 450,
      fallbackToSingle: false
    });
    const actual = kv[keyNum];
    const confirmed = Number(actual) === valueNum;
    return {
      ok: confirmed,
      ack: ack.ack,
      expected: valueNum,
      actual: actual ?? null,
      confirmed,
      msg: confirmed ? 'device-confirmed' : (ack.msg || 'Verification failed')
    };
  });

  // Phase-1 endpoint: port-based apply with VALGET verification
  ipcMain.handle('ubx:applyRates', async (_, { operations }) => {
    if (!serialManager || !deviceQuery) return { ok: false, msg: 'Not connected', results: [] };
    if (!Array.isArray(operations) || operations.length === 0) {
      return { ok: false, msg: 'No operations', results: [] };
    }

    const sanitized = [];
    for (const op of operations) {
      const keyNum = Number(op?.key);
      const valueNum = Math.max(0, Math.min(255, Number(op?.rateDiv) || 0));
      if (!Number.isFinite(keyNum) || keyNum <= 0) continue;
      sanitized.push({
        msg: op?.msg || 'UNKNOWN',
        port: op?.port || 'UNKNOWN',
        key: keyNum >>> 0,
        rateDiv: valueNum
      });
    }

    if (sanitized.length === 0) {
      return { ok: false, msg: 'No valid operations', results: [] };
    }

    const ackByKey = new Map();
    for (const op of sanitized) {
      const ackResult = await sendUbxValsetWithAck(op.key, op.rateDiv);
      ackByKey.set(op.key, ackResult);
      await new Promise((r) => setTimeout(r, 15));
    }

    const uniqueKeys = [...new Set(sanitized.map((op) => op.key))];
    const kv = await requestUbxCfgValues(uniqueKeys, {
      batchSize: 16,
      timeoutMs: 450,
      fallbackToSingle: true
    });

    const results = sanitized.map((op) => {
      const ack = ackByKey.get(op.key) || { ok: false, ack: 'UNKNOWN', msg: 'No ACK state' };
      const actual = kv[op.key];
      const confirmed = Number(actual) === op.rateDiv;
      let status = confirmed ? 'device-confirmed' : 'verification-failed';
      if (!confirmed && ack.ack === 'NAK') status = 'nak';
      if (!confirmed && ack.ack === 'TIMEOUT') status = 'ack-timeout';

      return {
        msg: op.msg,
        port: op.port,
        key: op.key,
        expected: op.rateDiv,
        actual: actual ?? null,
        ack: ack.ack,
        confirmed,
        ok: confirmed,
        status
      };
    });

    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      applied: results.length - failed.length,
      failed: failed.length,
      results
    };
  });

  // Message router subscriptions
  ipcMain.handle('router:subscribe', async (_, { capability, msgId, sourceName }) => {
    messageRouter.subscribe(capability, msgId, sourceName);
    return { ok: true };
  });

  ipcMain.handle('router:unsubscribe', async (_, { capability, msgId, sourceName }) => {
    messageRouter.unsubscribe(capability, msgId, sourceName);
    return { ok: true };
  });

  // Get available messages for a capability
  ipcMain.handle('config:messages', async (_, capability) => {
    return getMessagesForCapability(capability);
  });

  // Device query - COMCONFIG/LOGLISTA
  ipcMain.handle('device:comconfig', async () => {
    if (!deviceQuery) return { ports: [], error: 'Not initialized' };
    const isBynav = currentDeviceCaps?.detected === true && currentDeviceCaps?.family === 'bynav';
    if (!isBynav) {
      return { ports: [], skipped: 'non-bynav-comconfig-blocked' };
    }
    return await deviceQuery.requestComconfig();
  });
  // UBX quick port status (CFG-VALGET only for port keys)
  ipcMain.handle('device:ubxPorts', async () => {
    const fallbackPorts = [
      { name: 'UART1', type: 'serial', baud: '-', inMode: '-', outMode: '-' },
      { name: 'UART2', type: 'serial', baud: '-', inMode: '-', outMode: '-' },
      { name: 'USB', type: 'usb', inMode: '-', outMode: '-' }
    ];
    if (!deviceQuery) return { ports: fallbackPorts };

    try {
      const portKeys = [
        ...Object.values(UBX_PORT_KEYS.uart1).filter((v) => typeof v === 'number'),
        ...Object.values(UBX_PORT_KEYS.uart2).filter((v) => typeof v === 'number'),
        ...Object.values(UBX_PORT_KEYS.usb).filter((v) => typeof v === 'number')
      ];
      const kv = await requestUbxCfgValues(portKeys, {
        batchSize: 12,
        timeoutMs: 300,
        fallbackToSingle: true
      });
      return { ports: buildUbxPortsFromKv(kv) };
    } catch (e) {
      console.error('[Main] device:ubxPorts failed:', e);
      return { ports: fallbackPorts };
    }
  });
  // UBX device status: port config + active MSGOUT keys via CFG-VALGET
  ipcMain.handle('device:ubxStatus', async () => {
    const fallbackPorts = [
      { name: 'UART1', type: 'serial', baud: '-', inMode: '-', outMode: '-' },
      { name: 'UART2', type: 'serial', baud: '-', inMode: '-', outMode: '-' },
      { name: 'USB', type: 'usb', inMode: '-', outMode: '-' }
    ];
    if (!deviceQuery) return { ports: fallbackPorts, activeMsgs: [] };

    try {
      const { getAllUbxCfgKeys } = require('../backend/schema-loader');

      const msgKeys = getAllUbxCfgKeys();
      const msgCfgKeys = msgKeys.flatMap((m) => Object.values(m.cfg_keys || {}));
      const portKeys = [
        ...Object.values(UBX_PORT_KEYS.uart1).filter((v) => typeof v === 'number'),
        ...Object.values(UBX_PORT_KEYS.uart2).filter((v) => typeof v === 'number'),
        ...Object.values(UBX_PORT_KEYS.usb).filter((v) => typeof v === 'number')
      ];
      const portKv = await requestUbxCfgValues(portKeys, {
        batchSize: 12,
        timeoutMs: 450,
        fallbackToSingle: true
      });
      const msgKv = await requestUbxCfgValues(msgCfgKeys, {
        batchSize: 24,
        timeoutMs: 250,
        fallbackToSingle: false
      });
      const kv = { ...portKv, ...msgKv };
      const ports = buildUbxPortsFromKv(kv);

      const activeMsgs = [];
      for (const msgKey of msgKeys) {
        for (const [portKey, cfgKey] of Object.entries(msgKey.cfg_keys || {})) {
          const rate = kv[cfgKey];
          if (rate != null && rate > 0) {
            activeMsgs.push({
              port: portKey.toUpperCase(),
              msg: msgKey.name,
              mode: 'ONTIME',
              period: 1.0 / Number(rate),
              extra: 0,
              hold: '0'
            });
          }
        }
      }

      return { ports, activeMsgs };
    } catch (e) {
      console.error('[Main] device:ubxStatus failed:', e);
      return { ports: fallbackPorts, activeMsgs: [] };
    }
  });

  ipcMain.handle('device:icomconfig', async () => {
    if (!deviceQuery) return { ports: [], error: 'Not initialized' };
    const isBynav = currentDeviceCaps?.detected === true && currentDeviceCaps?.family === 'bynav';
    if (!isBynav) {
      return { ports: [], skipped: 'non-bynav-icomconfig-blocked' };
    }
    return await deviceQuery.requestIcomconfig();
  });

  ipcMain.handle('device:loglista', async () => {
    if (!deviceQuery) return { entries: [], error: 'Not initialized' };
    const isBynav = currentDeviceCaps?.detected === true && currentDeviceCaps?.family === 'bynav';
    if (!isBynav) {
      return { entries: [], skipped: 'non-bynav-loglista-blocked' };
    }
    return await deviceQuery.requestLoglista();
  });

  // All message definitions for settings table
  ipcMain.handle('config:allMessages', async () => {
    return getAllMessageDefinitions();
  });

  // Message schema for info panel
  ipcMain.handle('config:messageSchema', async (_, { familyKey, variant }) => {
    return getMessageSchema(familyKey, variant);
  });

  // Reference table lookup
  ipcMain.handle('config:referenceTable', async (_, key) => {
    return getReferenceTable(key);
  });

  // System network info (for Ethernet settings tab)
  const { execSync } = require('child_process');
  ipcMain.handle('system:networkInfo', async () => {
    try {
      const output = execSync('ipconfig /all', { encoding: 'utf-8', timeout: 5000 });
      return { ok: true, text: output };
    } catch (e) {
      return { ok: false, text: '', error: e.message };
    }
  });
  ipcMain.handle('system:arpTable', async () => {
    try {
      const output = execSync('arp -a', { encoding: 'utf-8', timeout: 5000 });
      return { ok: true, text: output };
    } catch (e) {
      return { ok: false, text: '', error: e.message };
    }
  });

  // --- NTRIP Client ---
  const NTRIP_PROFILES_FILE = path.join(app.getPath('userData'), 'ntrip-profiles.json');

  ipcMain.handle('ntrip:connect', async (_, config) => {
    if (!ntripClient) return { ok: false, error: 'NTRIP not initialized' };
    return await ntripClient.connect(config);
  });

  ipcMain.handle('ntrip:disconnect', async () => {
    if (!ntripClient) return { ok: false };
    ntripClient.disconnect();
    return { ok: true };
  });

  ipcMain.handle('ntrip:status', async () => {
    if (!ntripClient) return { connected: false };
    return ntripClient.getStats();
  });

  ipcMain.handle('ntrip:sourcetable', async (_, config) => {
    if (!ntripClient) return { ok: false, sources: [], error: 'NTRIP not initialized' };
    return await ntripClient.getSourceTable(config);
  });

  ipcMain.handle('ntrip:profiles:get', async () => {
    try {
      if (fs.existsSync(NTRIP_PROFILES_FILE)) {
        const data = fs.readFileSync(NTRIP_PROFILES_FILE, 'utf-8');
        return JSON.parse(data);
      }
    } catch { }
    return [];
  });

  ipcMain.handle('ntrip:profiles:save', async (_, profiles) => {
    try {
      const dir = path.dirname(NTRIP_PROFILES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(NTRIP_PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // --- Auto-Updater IPC ---
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { ok: false, msg: 'Not packaged' };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  });

  ipcMain.handle('updater:install', async () => {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });

  ipcMain.handle('updater:getVersion', async () => {
    return app.getVersion();
  });
}

// --- Auto-Updater ---
function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[Updater] Skipping — app is not packaged');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Silent check — don't bother the user unless there's actually an update
  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    safeSend('updater:status', {
      status: 'available',
      version: info.version,
      releaseNotes: info.releaseNotes || null,
      releaseDate: info.releaseDate
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] App is up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    safeSend('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    safeSend('updater:status', {
      status: 'ready',
      version: info.version
    });
  });

  // Silent error — just log, don't show to user
  autoUpdater.on('error', (err) => {
    console.log('[Updater] Error:', err?.message || 'Unknown');
  });

  // Check for updates 5 seconds after launch
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { });
  }, 5000);
}

// App lifecycle
app.whenReady().then(() => {
  setupIPC();
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  ntripClient?.disconnect();
  serialManager?.disconnect();
  app.quit();
});

