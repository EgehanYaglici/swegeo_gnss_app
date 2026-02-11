// NtripClient.js — NTRIP Client sidebar page component
// Manages connection form, profiles, live status, RTCM types display

// Known RTCM v3 message type descriptions
const RTCM_DESCRIPTIONS = {
  1001: 'GPS L1 Obs',
  1002: 'GPS L1 Obs (Extended)',
  1003: 'GPS L1/L2 Obs',
  1004: 'GPS L1/L2 Obs (Extended)',
  1005: 'Station ARP',
  1006: 'Station ARP + Height',
  1007: 'Antenna Descriptor',
  1008: 'Antenna Serial',
  1009: 'GLONASS L1 Obs',
  1010: 'GLONASS L1 Obs (Extended)',
  1011: 'GLONASS L1/L2 Obs',
  1012: 'GLONASS L1/L2 Obs (Extended)',
  1013: 'System Parameters',
  1019: 'GPS Ephemeris',
  1020: 'GLONASS Ephemeris',
  1033: 'Receiver/Antenna Info',
  1042: 'BeiDou Ephemeris',
  1044: 'QZSS Ephemeris',
  1045: 'Galileo F/NAV Ephemeris',
  1046: 'Galileo I/NAV Ephemeris',
  1071: 'GPS MSM1',
  1072: 'GPS MSM2',
  1073: 'GPS MSM3',
  1074: 'GPS MSM4',
  1075: 'GPS MSM5',
  1076: 'GPS MSM6',
  1077: 'GPS MSM7',
  1081: 'GLONASS MSM1',
  1082: 'GLONASS MSM2',
  1083: 'GLONASS MSM3',
  1084: 'GLONASS MSM4',
  1085: 'GLONASS MSM5',
  1086: 'GLONASS MSM6',
  1087: 'GLONASS MSM7',
  1091: 'Galileo MSM1',
  1092: 'Galileo MSM2',
  1093: 'Galileo MSM3',
  1094: 'Galileo MSM4',
  1095: 'Galileo MSM5',
  1096: 'Galileo MSM6',
  1097: 'Galileo MSM7',
  1101: 'SBAS MSM1',
  1102: 'SBAS MSM2',
  1103: 'SBAS MSM3',
  1104: 'SBAS MSM4',
  1105: 'SBAS MSM5',
  1106: 'SBAS MSM6',
  1107: 'SBAS MSM7',
  1111: 'QZSS MSM1',
  1112: 'QZSS MSM2',
  1113: 'QZSS MSM3',
  1114: 'QZSS MSM4',
  1115: 'QZSS MSM5',
  1116: 'QZSS MSM6',
  1117: 'QZSS MSM7',
  1121: 'BeiDou MSM1',
  1122: 'BeiDou MSM2',
  1123: 'BeiDou MSM3',
  1124: 'BeiDou MSM4',
  1125: 'BeiDou MSM5',
  1126: 'BeiDou MSM6',
  1127: 'BeiDou MSM7',
  1230: 'GLONASS Code-Phase Bias',
  4072: 'Reference Station (u-blox)',
};

class NtripClientPage {
  constructor() {
    // Form elements
    this._elHost = document.getElementById('ntrip-host');
    this._elPort = document.getElementById('ntrip-port');
    this._elMount = document.getElementById('ntrip-mountpoint');
    this._elUser = document.getElementById('ntrip-username');
    this._elPass = document.getElementById('ntrip-password');

    // Profile elements
    this._elProfileSelect = document.getElementById('ntrip-profile-select');
    this._elBtnSaveProfile = document.getElementById('ntrip-btn-save-profile');
    this._elBtnDeleteProfile = document.getElementById('ntrip-btn-delete-profile');

    // Status elements
    this._elLiveDot = document.getElementById('ntrip-live-dot');
    this._elConnStatus = document.getElementById('ntrip-conn-status');
    this._elConnHost = document.getElementById('ntrip-conn-host');
    this._elConnMount = document.getElementById('ntrip-conn-mount');
    this._elConnDuration = document.getElementById('ntrip-conn-duration');
    this._elConnRate = document.getElementById('ntrip-conn-rate');
    this._elConnBytes = document.getElementById('ntrip-conn-bytes');
    this._elConnMsgs = document.getElementById('ntrip-conn-msgs');
    this._elRtcmBody = document.getElementById('ntrip-rtcm-body');
    this._elErrorLog = document.getElementById('ntrip-error-log');
    this._elStatusText = document.getElementById('ntrip-status-text');
    this._elLastGga = document.getElementById('ntrip-last-gga');
    this._elGgaSource = document.getElementById('ntrip-gga-source');

    // Source table elements
    this._elBtnFetchMounts = document.getElementById('ntrip-btn-fetch-mounts');
    this._elSourceSection = document.getElementById('ntrip-sourcetable-section');
    this._elSourceCount = document.getElementById('ntrip-source-count');
    this._elSourceBody = document.getElementById('ntrip-sourcetable-body');

    // Action buttons
    this._elBtnConnect = document.getElementById('ntrip-btn-connect');
    this._elBtnDisconnect = document.getElementById('ntrip-btn-disconnect');

    // State
    this._profiles = [];
    this._connected = false;
    this._lastStats = null;
    this._sources = [];

    this._bindEvents();
    this._loadProfiles();
    this._listenNtripEvents();

    // Listen for GGA updates from terminal lines
    this._unsubLine = window.api.onTerminalLine(({ text }) => {
      if (typeof text === 'string') {
        const t = text.trim();
        if (t.startsWith('$GPGGA') || t.startsWith('$GNGGA')) {
          this._elLastGga.textContent = t.length > 60 ? t.substring(0, 60) + '...' : t;
          this._elGgaSource.textContent = t.startsWith('$GNGGA') ? 'GNGGA' : 'GPGGA';
        }
      }
    });
  }

  _bindEvents() {
    // Connect / Disconnect
    this._elBtnConnect.addEventListener('click', () => this._doConnect());
    this._elBtnDisconnect.addEventListener('click', () => this._doDisconnect());

    // Fetch mountpoints
    this._elBtnFetchMounts.addEventListener('click', () => this._fetchSourceTable());

    // Profiles
    this._elProfileSelect.addEventListener('change', () => this._onProfileSelected());
    this._elBtnSaveProfile.addEventListener('click', () => this._saveProfile());
    this._elBtnDeleteProfile.addEventListener('click', () => this._deleteProfile());
  }

  _listenNtripEvents() {
    window.api.onNtripStatus((data) => {
      this._connected = data.connected;
      this._updateConnectionUI(data);
    });

    window.api.onNtripStats((data) => {
      this._lastStats = data;
      this._updateStatsUI(data);
    });

    window.api.onNtripError((data) => {
      this._addLogEntry(data.message, 'error');
    });
  }

  // --- Connection ---

  async _doConnect() {
    const config = {
      host: this._elHost.value.trim(),
      port: parseInt(this._elPort.value) || 2101,
      mountpoint: this._elMount.value.trim(),
      username: this._elUser.value.trim(),
      password: this._elPass.value
    };

    if (!config.host) {
      this._setStatus('Host is required');
      return;
    }
    if (!config.mountpoint) {
      this._setStatus('Mountpoint is required');
      return;
    }

    this._setStatus('Connecting...');
    this._addLogEntry(`Connecting to ${config.host}:${config.port}/${config.mountpoint}...`, 'info');

    const result = await window.api.connectNtrip(config);
    if (result.ok) {
      this._setStatus('Connected');
      this._addLogEntry('Connected successfully', 'info');
      this._setBtnState(true);
    } else {
      this._setStatus(`Failed: ${result.error}`);
      this._addLogEntry(`Connection failed: ${result.error}`, 'error');
      this._setBtnState(false);
    }
  }

  async _doDisconnect() {
    await window.api.disconnectNtrip();
    this._setStatus('Disconnected');
    this._addLogEntry('Disconnected', 'info');
    this._setBtnState(false);
    this._resetStatusUI();
  }

  _setBtnState(connected) {
    this._elBtnConnect.disabled = connected;
    this._elBtnDisconnect.disabled = !connected;
  }

  // --- UI Updates ---

  _updateConnectionUI(data) {
    const connected = data.connected;
    this._elLiveDot.className = 'ntrip-live-dot ' + (connected ? 'connected' : 'disconnected');
    this._elConnStatus.textContent = connected ? 'Connected' : 'Disconnected';
    this._elConnStatus.style.color = connected ? 'var(--success)' : 'var(--text-secondary)';

    if (connected) {
      this._elConnHost.textContent = data.host || '—';
      this._elConnMount.textContent = data.mountpoint || '—';
    }
    this._setBtnState(connected);
  }

  _updateStatsUI(data) {
    // Duration
    const dur = data.duration || 0;
    const m = Math.floor(dur / 60);
    const s = dur % 60;
    this._elConnDuration.textContent = `${m}m ${s}s`;

    // Data rate
    const rate = data.dataRate || 0;
    if (rate > 1024) {
      this._elConnRate.textContent = `${(rate / 1024).toFixed(1)} KB/s`;
    } else {
      this._elConnRate.textContent = `${rate} B/s`;
    }

    // Bytes
    const bytes = data.bytesReceived || 0;
    if (bytes > 1048576) {
      this._elConnBytes.textContent = `${(bytes / 1048576).toFixed(2)} MB`;
    } else if (bytes > 1024) {
      this._elConnBytes.textContent = `${(bytes / 1024).toFixed(1)} KB`;
    } else {
      this._elConnBytes.textContent = `${bytes} B`;
    }

    // Messages
    this._elConnMsgs.textContent = (data.rtcmMessages || 0).toLocaleString();

    // RTCM Types table
    this._updateRtcmTable(data.rtcmTypes || {});
  }

  _updateRtcmTable(types) {
    const entries = Object.entries(types).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    if (entries.length === 0) {
      this._elRtcmBody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:12px">No RTCM data yet</td></tr>';
      return;
    }

    let html = '';
    for (const [id, count] of entries) {
      const desc = RTCM_DESCRIPTIONS[parseInt(id)] || '—';
      html += `<tr><td style="font-weight:600">${id}</td><td>${count.toLocaleString()}</td><td style="color:var(--text-secondary)">${desc}</td></tr>`;
    }
    this._elRtcmBody.innerHTML = html;
  }

  _resetStatusUI() {
    this._elLiveDot.className = 'ntrip-live-dot disconnected';
    this._elConnStatus.textContent = 'Disconnected';
    this._elConnStatus.style.color = 'var(--text-secondary)';
    this._elConnHost.textContent = '—';
    this._elConnMount.textContent = '—';
    this._elConnDuration.textContent = '—';
    this._elConnRate.textContent = '—';
    this._elConnBytes.textContent = '—';
    this._elConnMsgs.textContent = '—';
    this._elRtcmBody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:12px">No RTCM data yet</td></tr>';
  }

  _setStatus(msg) {
    this._elStatusText.textContent = msg;
  }

  _addLogEntry(message, type = 'info') {
    const now = new Date();
    const time = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const div = document.createElement('div');
    div.className = 'ntrip-log-entry';
    div.innerHTML = `<span class="ntrip-log-time">${time}</span><span class="ntrip-log-${type}">${message}</span>`;
    this._elErrorLog.appendChild(div);
    this._elErrorLog.scrollTop = this._elErrorLog.scrollHeight;

    // Limit to 50 entries
    while (this._elErrorLog.children.length > 50) {
      this._elErrorLog.removeChild(this._elErrorLog.firstChild);
    }
  }

  // --- Source Table ---

  async _fetchSourceTable() {
    const host = this._elHost.value.trim();
    const port = parseInt(this._elPort.value) || 2101;
    const username = this._elUser.value.trim();
    const password = this._elPass.value;

    if (!host) {
      this._setStatus('Enter host first to fetch mountpoints');
      return;
    }

    this._setStatus('Fetching mountpoints...');
    this._elBtnFetchMounts.disabled = true;
    this._addLogEntry(`Fetching source table from ${host}:${port}...`, 'info');

    const result = await window.api.getNtripSourceTable({ host, port, username, password });
    this._elBtnFetchMounts.disabled = false;

    if (!result.ok) {
      this._setStatus(`Fetch failed: ${result.error}`);
      this._addLogEntry(`Source table error: ${result.error}`, 'error');
      return;
    }

    this._sources = result.sources;
    this._setStatus(`Found ${result.sources.length} mountpoints`);
    this._addLogEntry(`Source table: ${result.sources.length} mountpoints`, 'info');

    // Show source table section
    this._elSourceSection.style.display = '';
    this._elSourceCount.textContent = `(${result.sources.length})`;

    // Render table
    let html = '';
    for (const src of result.sources) {
      html += `<tr data-mount="${src.mountpoint}">`;
      html += `<td style="font-weight:600">${src.mountpoint}</td>`;
      html += `<td>${src.format}</td>`;
      html += `<td>${src.navSystem || '—'}</td>`;
      html += `<td>${src.country || '—'}</td>`;
      html += `<td style="color:var(--text-secondary)">${src.network || '—'}</td>`;
      html += '</tr>';
    }
    this._elSourceBody.innerHTML = html;

    // Click rows to select mountpoint (just the name, no extra info)
    this._elSourceBody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        // Highlight selected row
        this._elSourceBody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');
        // Put mountpoint name into input
        this._elMount.value = tr.dataset.mount;
      });
    });
  }

  // --- Profiles ---

  async _loadProfiles() {
    this._profiles = await window.api.getNtripProfiles();
    this._renderProfileDropdown();
  }

  _renderProfileDropdown() {
    const sel = this._elProfileSelect;
    sel.innerHTML = '<option value="">— Select Profile —</option>';
    for (let i = 0; i < this._profiles.length; i++) {
      const p = this._profiles[i];
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }

  _onProfileSelected() {
    const idx = parseInt(this._elProfileSelect.value);
    if (isNaN(idx) || idx < 0 || idx >= this._profiles.length) return;

    const p = this._profiles[idx];
    this._elHost.value = p.host || '';
    this._elPort.value = p.port || 2101;
    this._elMount.value = p.mountpoint || '';
    this._elUser.value = p.username || '';
    this._elPass.value = p.password || '';
  }

  _saveProfile() {
    // Show inline save dialog instead of prompt() which doesn't work in Electron
    this._showSaveDialog();
  }

  _showSaveDialog() {
    // Remove any existing dialog
    const old = document.getElementById('ntrip-save-dialog');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ntrip-save-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card-bg);border-radius:12px;padding:20px;min-width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.2)';

    const title = document.createElement('div');
    title.textContent = 'Save Profile';
    title.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:12px;color:var(--text-primary)';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control';
    input.placeholder = 'Profile name...';
    input.style.cssText = 'width:100%;margin-bottom:12px';

    // Auto-suggest name from host+mount
    const host = this._elHost.value.trim();
    const mount = this._elMount.value.trim();
    if (host && mount) {
      input.value = `${mount} @ ${host}`;
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary btn-sm';
    btnCancel.textContent = 'Cancel';
    btnCancel.onclick = () => overlay.remove();

    const btnSave = document.createElement('button');
    btnSave.className = 'btn-primary btn-sm';
    btnSave.textContent = 'Save';
    btnSave.onclick = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      overlay.remove();
      this._doSaveProfile(name);
    };

    // Enter key to save
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnSave.click();
      if (e.key === 'Escape') overlay.remove();
    });

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnSave);
    box.appendChild(title);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);

    // Click overlay background to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  }

  async _doSaveProfile(name) {
    const profile = {
      name,
      host: this._elHost.value.trim(),
      port: parseInt(this._elPort.value) || 2101,
      mountpoint: this._elMount.value.trim(),
      username: this._elUser.value.trim(),
      password: this._elPass.value
    };

    // Check for duplicate name — overwrite
    const existing = this._profiles.findIndex(p => p.name === profile.name);
    if (existing >= 0) {
      this._profiles[existing] = profile;
    } else {
      this._profiles.push(profile);
    }

    const result = await window.api.saveNtripProfiles(this._profiles);
    if (result.ok) {
      this._renderProfileDropdown();
      this._setStatus(`Profile "${profile.name}" saved`);
      this._addLogEntry(`Profile "${profile.name}" saved`, 'info');
    } else {
      this._setStatus(`Save failed: ${result.error}`);
    }
  }

  async _deleteProfile() {
    const idx = parseInt(this._elProfileSelect.value);
    if (isNaN(idx) || idx < 0 || idx >= this._profiles.length) {
      this._setStatus('Select a profile to delete');
      return;
    }

    const name = this._profiles[idx].name;
    this._profiles.splice(idx, 1);

    const result = await window.api.saveNtripProfiles(this._profiles);
    if (result.ok) {
      this._renderProfileDropdown();
      this._setStatus(`Profile "${name}" deleted`);
      this._addLogEntry(`Profile "${name}" deleted`, 'info');
    }
  }

  // --- Public API (for RtkCard cross-reference) ---

  getFormConfig() {
    return {
      host: this._elHost.value.trim(),
      port: parseInt(this._elPort.value) || 2101,
      mountpoint: this._elMount.value.trim(),
      username: this._elUser.value.trim(),
      password: this._elPass.value
    };
  }

  getLastStats() {
    return this._lastStats;
  }

  isConnected() {
    return this._connected;
  }
}
