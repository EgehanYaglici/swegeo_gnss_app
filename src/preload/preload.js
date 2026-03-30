// Preload script - secure IPC bridge between main and renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Serial connection
  listPorts: () => ipcRenderer.invoke('serial:list'),
  connect: (params) => ipcRenderer.invoke('serial:connect', params),
  disconnect: () => ipcRenderer.invoke('serial:disconnect'),
  sendCommand: (cmd) => ipcRenderer.invoke('serial:send', cmd),
  applyUbxRates: (operations) => ipcRenderer.invoke('ubx:applyRates', { operations }),
  sendUbxRate: (cfgKeyUart1, rateDiv) => ipcRenderer.invoke('ubx:setRate', { cfgKeyUart1, rateDiv }),

  // Message router
  subscribe: (capability, msgId, sourceName) =>
    ipcRenderer.invoke('router:subscribe', { capability, msgId, sourceName }),
  unsubscribe: (capability, msgId, sourceName) =>
    ipcRenderer.invoke('router:unsubscribe', { capability, msgId, sourceName }),

  // Config
  getMessages: (capability) => ipcRenderer.invoke('config:messages', capability),
  getAllMessages: () => ipcRenderer.invoke('config:allMessages'),
  getMessageSchema: (familyKey, variant) => ipcRenderer.invoke('config:messageSchema', { familyKey, variant }),
  getReferenceTable: (key) => ipcRenderer.invoke('config:referenceTable', key),

  // Device query — BYNAV
  requestComconfig: () => ipcRenderer.invoke('device:comconfig'),
  requestIcomconfig: () => ipcRenderer.invoke('device:icomconfig'),
  requestLoglista: () => ipcRenderer.invoke('device:loglista'),
  requestUbxPorts: () => ipcRenderer.invoke('device:ubxPorts'),
  // Device query — u-blox (CFG-VALGET for port config + active MSGOUT keys)
  requestUbxStatus: () => ipcRenderer.invoke('device:ubxStatus'),

  // Device capabilities (emitted after connection + AUTHORIZATION query)
  onDeviceCapabilities: (cb) => {
    const listener = (_, caps) => cb(caps);
    ipcRenderer.on('device:capabilities', listener);
    return () => ipcRenderer.removeListener('device:capabilities', listener);
  },

  // System network (for Ethernet settings)
  getNetworkInfo: () => ipcRenderer.invoke('system:networkInfo'),
  getArpTable: () => ipcRenderer.invoke('system:arpTable'),

  // Event listeners
  onTerminalLine: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('terminal:line', listener);
    return () => ipcRenderer.removeListener('terminal:line', listener);
  },
  onConnection: (cb) => {
    const listener = (_, connected) => cb(connected);
    ipcRenderer.on('connection:status', listener);
    return () => ipcRenderer.removeListener('connection:status', listener);
  },
  onData: (capability, cb) => {
    const channel = `data:${capability}`;
    const listener = (_, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onBinaryParsed: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('binary:parsed', listener);
    return () => ipcRenderer.removeListener('binary:parsed', listener);
  },
  onLogData: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('log:data', listener);
    return () => ipcRenderer.removeListener('log:data', listener);
  },

  // NTRIP Client
  connectNtrip: (config) => ipcRenderer.invoke('ntrip:connect', config),
  disconnectNtrip: () => ipcRenderer.invoke('ntrip:disconnect'),
  getNtripStatus: () => ipcRenderer.invoke('ntrip:status'),
  getNtripSourceTable: (config) => ipcRenderer.invoke('ntrip:sourcetable', config),
  getNtripProfiles: () => ipcRenderer.invoke('ntrip:profiles:get'),
  saveNtripProfiles: (profiles) => ipcRenderer.invoke('ntrip:profiles:save', profiles),

  onNtripStatus: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('ntrip:status', listener);
    return () => ipcRenderer.removeListener('ntrip:status', listener);
  },
  onNtripStats: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('ntrip:stats', listener);
    return () => ipcRenderer.removeListener('ntrip:stats', listener);
  },
  onNtripError: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('ntrip:error', listener);
    return () => ipcRenderer.removeListener('ntrip:error', listener);
  },

  // Auto-Updater
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getAppVersion: () => ipcRenderer.invoke('updater:getVersion'),
  onUpdaterStatus: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  }
});
