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
    icon: path.join(__dirname, '..', '..', 'assets', 'swegeo_logo.png'),
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
  const onConnection = (connected) => safeSend('connection:status', connected);

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
  for (const cap of ['position', 'velocity', 'heading', 'satellites', 'imu', 'time']) {
    capabilityHandlers[cap] = (data) => safeSend(`data:${cap}`, data);
    messageRouter.on(cap, capabilityHandlers[cap]);
  }

  // Clean up listeners when window closes
  mainWindow.on('closed', () => {
    serialManager.removeListener('line', onLine);
    serialManager.removeListener('line', onGgaLine);
    serialManager.removeListener('connection', onConnection);
    serialManager.removeListener('binary', onBinaryFrame);
    for (const cap of Object.keys(capabilityHandlers)) {
      messageRouter.removeListener(cap, capabilityHandlers[cap]);
    }
    ntripClient.disconnect();
    ntripClient.removeAllListeners();
    mainWindow = null;
  });

  // Open DevTools in development
  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools();
  }
}

function setupIPC() {
  const SerialManager = require('../backend/serial-manager');
  const { getMessagesForCapability, getAllMessageDefinitions, getMessageSchema, getReferenceTable } = require('../backend/schema-loader');

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
    return await deviceQuery.requestComconfig();
  });

  ipcMain.handle('device:icomconfig', async () => {
    if (!deviceQuery) return { ports: [], error: 'Not initialized' };
    return await deviceQuery.requestIcomconfig();
  });

  ipcMain.handle('device:loglista', async () => {
    if (!deviceQuery) return { entries: [], error: 'Not initialized' };
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
  // Only run in packaged builds (not during npm start / dev)
  if (!app.isPackaged) {
    console.log('[Updater] Skipping — app is not packaged');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    safeSend('updater:status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    safeSend('updater:status', {
      status: 'available',
      version: info.version,
      releaseDate: info.releaseDate
    });
  });

  autoUpdater.on('update-not-available', () => {
    safeSend('updater:status', { status: 'up-to-date' });
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

  autoUpdater.on('error', (err) => {
    safeSend('updater:status', {
      status: 'error',
      message: err?.message || 'Unknown update error'
    });
  });

  // Check for updates 3 seconds after launch
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { });
  }, 3000);
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
