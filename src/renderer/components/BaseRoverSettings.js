// BaseRoverSettings - Base/Rover RTCM correction configuration
// Port config, role, fix mode, RTCM message management

const BR_CATEGORIES = [
  { name: 'GPS',   ids: [1003,1004,1019,1074,1075,1076,1077] },
  { name: 'GLO',   ids: [1011,1012,1020,1084,1085,1086,1087,1230] },
  { name: 'GAL',   ids: [1046,1094,1095,1096,1097] },
  { name: 'SBAS',  ids: [1104,1105,1106,1107] },
  { name: 'QZSS',  ids: [1044,1114,1115,1116,1117] },
  { name: 'BDS',   ids: [1042,1124,1125,1126,1127] },
  { name: 'IRNSS', ids: [1048,1134,1135,1136,1137] },
  { name: 'Info',  ids: [1005,1006,1033] },
];

const BR_MSG_NAMES = {
  1003:'GPS L1/L2 code+phase', 1004:'GPS L1/L2 full', 1019:'GPS Ephemeris',
  1074:'GPS MSM4', 1075:'GPS MSM5', 1076:'GPS MSM6', 1077:'GPS MSM7',
  1011:'GLO L1/L2 code+phase', 1012:'GLO L1/L2 full', 1020:'GLO Ephemeris',
  1084:'GLO MSM4', 1085:'GLO MSM5', 1086:'GLO MSM6', 1087:'GLO MSM7', 1230:'GLO Bias',
  1046:'GAL F/NAV', 1094:'GAL MSM4', 1095:'GAL MSM5', 1096:'GAL MSM6', 1097:'GAL MSM7',
  1104:'SBAS MSM4', 1105:'SBAS MSM5', 1106:'SBAS MSM6', 1107:'SBAS MSM7',
  1044:'QZSS Ephemeris', 1114:'QZSS MSM4', 1115:'QZSS MSM5', 1116:'QZSS MSM6', 1117:'QZSS MSM7',
  1042:'BDS Ephemeris', 1124:'BDS MSM4', 1125:'BDS MSM5', 1126:'BDS MSM6', 1127:'BDS MSM7',
  1048:'IRNSS Ephemeris', 1134:'IRNSS MSM4', 1135:'IRNSS MSM5', 1136:'IRNSS MSM6', 1137:'IRNSS MSM7',
  1005:'ARP XYZ', 1006:'ARP+Height', 1033:'Antenna Descriptor',
};

// MSM messages default 1s, others 10s
const BR_MSM_IDS = new Set([
  1074,1075,1076,1077,1084,1085,1086,1087,1094,1095,1096,1097,
  1104,1105,1106,1107,1114,1115,1116,1117,1124,1125,1126,1127,
  1134,1135,1136,1137
]);

class BaseRoverSettings {
  constructor(api) {
    this.api = api;

    // State (form/UI)
    this._role = 'BASE';
    this._stationId = '';
    this._fixMode = 'auto';
    this._loaded = false;
    this._firstActivation = false;
    this._rtcmRows = {};   // { id: { ck, intInput, extraInput } }
    this._portsInfo = {};  // { COM2: { baud, inMode, outMode }, ... }
    this._loglistaPorts = {}; // { COM2: [{ msg, name, period, extra, mode }], ... }
    this._termUnsub = null;

    // Device-reported state (from pull/responses only)
    this._deviceRole = '';
    this._deviceStationId = '';

    // DOM refs
    this.portInput = document.getElementById('br-port');
    this.baudSelect = document.getElementById('br-baud');
    this.inModeSelect = document.getElementById('br-in-mode');
    this.outModeSelect = document.getElementById('br-out-mode');
    this.roleSelect = document.getElementById('br-role');
    this.stationInput = document.getElementById('br-station-id');
    this.fixSection = document.getElementById('br-fix-section');
    this.rtcmSection = document.getElementById('br-rtcm-section');
    this.rtcmList = document.getElementById('br-rtcm-list');
    this.fixRadios = document.querySelectorAll('input[name="br-fix"]');
    this.fixPosInputs = document.getElementById('br-fix-pos-inputs');
    this.fixBaseInputs = document.getElementById('br-fix-base-inputs');
    this.latInput = document.getElementById('br-lat');
    this.lonInput = document.getElementById('br-lon');
    this.heightInput = document.getElementById('br-height');
    this.avgSecsInput = document.getElementById('br-avg-secs');
    this.avgMetersInput = document.getElementById('br-avg-meters');
    this.statusLabel = document.getElementById('br-status');
    this.rightCol = document.getElementById('br-right-col');

    // Device Status overview elements
    this.ovRole = document.getElementById('br-ov-role');
    this.ovStation = document.getElementById('br-ov-station');
    this.ovPort = document.getElementById('br-ov-port');
    this.ovBaud = document.getElementById('br-ov-baud');
    this.ovModes = document.getElementById('br-ov-modes');
    this.ovRtcm = document.getElementById('br-ov-rtcm');

    // Info panel tabs
    this.overviewPanel = document.getElementById('br-info-overview');
    this.portsPanel = document.getElementById('br-info-ports');
    this.logsPanel = document.getElementById('br-info-logs');

    this._bindEvents();
  }

  _bindEvents() {
    // Role change
    this.roleSelect?.addEventListener('change', () => {
      this._role = this.roleSelect.value;
      this._toggleBaseSections();
      this._updatePreview();
    });
    this.stationInput?.addEventListener('input', () => {
      this._stationId = this.stationInput.value.trim();
      this._updatePreview();
    });

    // Fix radio buttons
    this.fixRadios.forEach(r => r.addEventListener('change', () => {
      this._fixMode = r.value;
      this._toggleFixInputs();
      this._updatePreview();
    }));

    // Port change → sync checkboxes
    this.portInput?.addEventListener('change', () => {
      this._syncChecksForCurrentPort();
      this._updatePreview();
    });

    // Port change also refreshes overview to show that port's pulled data
    this.portInput?.addEventListener('input', () => this._refreshOverview());

    // Sub-tab switching
    document.querySelectorAll('#settings-panel-base-rover .settings-sub-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.brTab;
        document.querySelectorAll('#settings-panel-base-rover .settings-sub-tab')
          .forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('#settings-panel-base-rover .settings-sub-panel')
          .forEach(p => p.classList.toggle('active', p.id === `br-info-${target}`));
      });
    });

    // Action buttons (bottom bar)
    document.getElementById('br-btn-pull')?.addEventListener('click', () => this._pullAll());
    document.getElementById('br-btn-send')?.addEventListener('click', () => this._applyConfig());
    document.getElementById('br-btn-save')?.addEventListener('click', () => this._saveConfig());

    // RTCM inline buttons
    document.getElementById('br-btn-disable-sel')?.addEventListener('click', () => this._disableSelected());
    document.getElementById('br-btn-disable-all')?.addEventListener('click', () => this._disableAll());
  }

  async onPageActivated() {
    if (!this._loaded) {
      this._buildRtcmList();
      this._toggleBaseSections();
      this._loaded = true;
    }
    this._startListener();
    this._updatePreview();
    // Auto-pull on first activation
    if (!this._firstActivation) {
      this._firstActivation = true;
      this._autoPull();
    }
  }

  async _autoPull() {
    // Small delay to let connection stabilize after page activation
    await new Promise(r => setTimeout(r, 600));
    this._setStatus('Auto-pulling configuration...');
    try {
      await this._pullAll();
    } catch (e) {
      this._setStatus('Auto-pull skipped (not connected)', 'danger');
    }
  }

  _startListener() {
    if (this._termUnsub) return;
    this._termUnsub = this.api.onTerminalLine((data) => {
      const line = typeof data === 'string' ? data : data?.text || '';
      this._onSerialLine(line);
    });
  }

  _toggleBaseSections() {
    const isBase = this._role === 'BASE';
    this.fixSection?.classList.toggle('hidden', !isBase);
    this.rightCol?.classList.toggle('hidden', !isBase);
    this._refreshOverview();
  }

  _toggleFixInputs() {
    this.fixPosInputs?.classList.toggle('hidden', this._fixMode !== 'position');
    this.fixBaseInputs?.classList.toggle('hidden', this._fixMode !== 'base');
  }

  // --- RTCM List ---

  _buildRtcmList() {
    if (!this.rtcmList) return;
    this.rtcmList.innerHTML = '';
    this._rtcmRows = {};

    for (const cat of BR_CATEGORIES) {
      const group = document.createElement('div');
      group.className = 'br-rtcm-group';

      const header = document.createElement('div');
      header.className = 'br-rtcm-group-header';
      header.innerHTML = `<span class="br-rtcm-chevron">&#9656;</span> ${cat.name} <span class="br-rtcm-group-count">(${cat.ids.length})</span>`;
      header.addEventListener('click', () => {
        group.classList.toggle('collapsed');
      });
      group.appendChild(header);

      const body = document.createElement('div');
      body.className = 'br-rtcm-group-body';

      for (const id of cat.ids) {
        const row = document.createElement('div');
        row.className = 'br-rtcm-row';

        const ck = document.createElement('input');
        ck.type = 'checkbox';
        ck.className = 'br-rtcm-ck';
        // All unchecked by default — will be set from device LOGLISTA on pull
        ck.addEventListener('change', () => this._updatePreview());

        const label = document.createElement('span');
        label.className = 'br-rtcm-label';
        label.textContent = `RTCM${id}`;

        const desc = document.createElement('span');
        desc.className = 'br-rtcm-desc';
        desc.textContent = BR_MSG_NAMES[id] || '';

        const intInput = document.createElement('input');
        intInput.type = 'number';
        intInput.className = 'settings-spin-input br-rtcm-interval';
        intInput.value = BR_MSM_IDS.has(id) ? '1.0' : '10.0';
        intInput.min = '0.1';
        intInput.max = '3600';
        intInput.step = '0.1';
        intInput.addEventListener('input', () => this._updatePreview());

        const unitSpan = document.createElement('span');
        unitSpan.className = 'br-rtcm-unit';
        unitSpan.textContent = 's';

        const extraInput = document.createElement('input');
        extraInput.type = 'text';
        extraInput.className = 'br-rtcm-extra';
        extraInput.placeholder = 'extra';
        extraInput.addEventListener('input', () => this._updatePreview());

        row.appendChild(ck);
        row.appendChild(label);
        row.appendChild(desc);
        row.appendChild(intInput);
        row.appendChild(unitSpan);
        row.appendChild(extraInput);
        body.appendChild(row);

        this._rtcmRows[id] = { ck, intInput, extraInput };
      }

      group.appendChild(body);
      this.rtcmList.appendChild(group);
    }
  }

  // --- Commands ---

  _buildCommands() {
    const cmds = [];
    const port = this.portInput?.value.trim() || '';
    const baud = this.baudSelect?.value || '115200';
    const inMode = this.inModeSelect?.value || 'BYNAV';
    const outMode = this.outModeSelect?.value || 'RTCM';

    if (port) {
      cmds.push(`SERIALCONFIG ${port} ${baud}`);
      cmds.push(`INTERFACEMODE ${port} ${inMode} ${outMode}`);
    }

    cmds.push(`RTKTYPE ${this._role}`);

    if (this._stationId) {
      cmds.push(`DGPSTXID RTCMV3 ${this._stationId}`);
    }

    // FIX command
    if (this._role === 'BASE') {
      switch (this._fixMode) {
        case 'auto':
          cmds.push('FIX AUTO');
          break;
        case 'position': {
          const lat = parseFloat(this.latInput?.value) || 0;
          const lon = parseFloat(this.lonInput?.value) || 0;
          const h = parseFloat(this.heightInput?.value) || 0;
          cmds.push(`FIX POSITION ${lat.toFixed(8)} ${lon.toFixed(8)} ${h.toFixed(3)}`);
          break;
        }
        case 'none':
          cmds.push('FIX NONE');
          break;
        case 'base': {
          const secs = parseFloat(this.avgSecsInput?.value) || 60;
          const meters = parseFloat(this.avgMetersInput?.value) || 3.0;
          cmds.push(`FIX BASE ${secs.toFixed(0)} ${meters.toFixed(1)}`);
          break;
        }
      }

      // RTCM log commands
      for (const [id, row] of Object.entries(this._rtcmRows)) {
        if (row.ck.checked) {
          const interval = parseFloat(row.intInput.value) || 1.0;
          const extra = row.extraInput.value.trim();
          const logPort = port || '';
          let cmd = `LOG ${logPort} RTCM${id} ONTIME ${interval.toFixed(1)}`;
          if (extra) cmd += ` ${extra}`;
          cmds.push(cmd.trim());
        }
      }
    }

    return cmds;
  }

  _updatePreview() {
    // No-op: preview removed, commands built on-demand
  }

  // --- Device interaction ---

  async _pullAll() {
    this._setStatus('Pulling configuration...');
    this._portsInfo = {};
    this._loglistaPorts = {};
    try {
      // Use structured API for COMCONFIG
      const comResult = await this.api.requestComconfig();
      if (comResult && comResult.ports) {
        for (const p of comResult.ports) {
          this._portsInfo[p.name] = {
            baud: p.baud || '—',
            inMode: p.inMode || '—',
            outMode: p.outMode || '—'
          };
        }
        this._refreshPortsTable();
      }

      // Send RTKTYPE and DGPSTXID via raw command (no DeviceQuery conflict)
      await this.api.sendCommand('RTKTYPE');
      await this.api.sendCommand('DGPSTXID RTCMV3');
      await new Promise(r => setTimeout(r, 800));

      // Use structured API for LOGLISTA
      const logResult = await this.api.requestLoglista();
      if (logResult && logResult.entries) {
        this._loglistaPorts = {};
        for (const e of logResult.entries) {
          const pKey = e.port.toUpperCase();
          if (!this._loglistaPorts[pKey]) this._loglistaPorts[pKey] = [];
          const msgId = parseInt((e.msg || '').replace(/^RTCM/i, ''));
          this._loglistaPorts[pKey].push({
            msg: e.msg,
            name: BR_MSG_NAMES[msgId] || e.msg,
            period: String(e.period || ''),
            extra: String(e.extra || ''),
            mode: e.mode || '',
            hold: e.hold || ''
          });
        }
        this._syncChecksForCurrentPort();
        this._refreshLogsTable();
      }

      this._refreshOverview();
      this._updatePreview();
      this._setStatus('Configuration pulled', 'success');
    } catch (e) {
      this._setStatus(`Pull failed: ${e.message}`, 'danger');
    }
  }

  async _applyConfig() {
    const cmds = this._buildCommands();
    this._setStatus('Applying configuration...');
    try {
      for (const cmd of cmds) {
        await this.api.sendCommand(cmd);
        await new Promise(r => setTimeout(r, 150));
      }
      this._setStatus(`${cmds.length} commands applied — pulling new state...`, 'success');
      // Auto-pull to refresh Current Device Status with actual device data
      await new Promise(r => setTimeout(r, 500));
      await this._pullAll();
    } catch (e) {
      this._setStatus(`Apply failed: ${e.message}`, 'danger');
    }
  }

  async _saveConfig() {
    this._setStatus('Saving configuration...');
    try {
      await this.api.sendCommand('SAVECONFIG');
      this._setStatus('Configuration saved to device', 'success');
    } catch (e) {
      this._setStatus(`Save failed: ${e.message}`, 'danger');
    }
  }

  async _disableSelected() {
    const port = this.portInput?.value.trim() || '';
    let count = 0;
    for (const [id, row] of Object.entries(this._rtcmRows)) {
      if (row.ck.checked) {
        const cmd = port ? `UNLOG ${port} RTCM${id}` : `UNLOG RTCM${id}`;
        await this.api.sendCommand(cmd);
        row.ck.checked = false;
        count++;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    this._setStatus(`Disabled ${count} RTCM messages`, 'success');
    this._updatePreview();
  }

  async _disableAll() {
    const port = this.portInput?.value.trim() || '';
    const cmd = port ? `UNLOG ${port} ALL` : 'UNLOGALL';
    await this.api.sendCommand(cmd);
    for (const row of Object.values(this._rtcmRows)) {
      row.ck.checked = false;
    }
    this._setStatus('All messages disabled on port', 'success');
    this._updatePreview();
  }

  // --- Serial line parsing ---

  _onSerialLine(line) {
    const trimmed = line.trim();

    // RTKTYPE response — only update device status, don't change form/UI role
    if (/RTKTYPE/i.test(trimmed)) {
      const m = trimmed.match(/\b(BASE|ROVER)\b/i);
      if (m) {
        this._deviceRole = m[1].toUpperCase();
        this._refreshOverview();
      }
    }

    // DGPSTXID response — only update device status
    if (/DGPSTXID/i.test(trimmed)) {
      const m = trimmed.match(/RTCMV3\s+(\d+)/i);
      if (m) {
        this._deviceStationId = m[1];
        this._refreshOverview();
      }
    }
  }

  // COMCONFIG and LOGLISTA are now fetched via structured API in _pullAll()

  _syncChecksForCurrentPort() {
    const currentPort = (this.portInput?.value.trim() || '').toUpperCase();
    const portLogs = this._loglistaPorts[currentPort] || [];

    // Don't uncheck everything — only update if we have data
    if (Object.keys(this._loglistaPorts).length === 0) return;

    // Uncheck all first
    for (const row of Object.values(this._rtcmRows)) {
      row.ck.checked = false;
    }

    // Check the ones from LOGLISTA for this port
    for (const entry of portLogs) {
      const rm = entry.msg.match(/^RTCM(\d+)$/i);
      if (!rm) continue;
      const rtcmId = parseInt(rm[1]);
      if (this._rtcmRows[rtcmId]) {
        this._rtcmRows[rtcmId].ck.checked = true;
        if (entry.period && !isNaN(parseFloat(entry.period))) {
          this._rtcmRows[rtcmId].intInput.value = parseFloat(entry.period).toFixed(1);
        }
        if (entry.extra && entry.extra !== '0.0' && entry.extra !== '0') {
          this._rtcmRows[rtcmId].extraInput.value = entry.extra;
        }
      }
    }
    this._updatePreview();
  }

  _refreshPortsTable() {
    const tbody = this.portsPanel?.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (const [portName, info] of Object.entries(this._portsInfo)) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${portName}</td><td>${info.baud}</td><td>${info.inMode}</td><td>${info.outMode}</td>`;
      tbody.appendChild(tr);
    }
  }

  _refreshLogsTable() {
    const tbody = this.logsPanel?.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (const [portName, entries] of Object.entries(this._loglistaPorts)) {
      for (const entry of entries) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${portName}</td><td>${entry.msg}</td><td>${entry.period}</td><td>${entry.mode}</td>`;
        tbody.appendChild(tr);
      }
    }
  }

  _refreshOverview() {
    // Only show device-pulled data — not user form inputs
    if (this.ovRole) this.ovRole.textContent = this._deviceRole || '—';
    if (this.ovStation) this.ovStation.textContent = this._deviceStationId || '—';

    // Find port info from pulled COMCONFIG data
    const currentPort = (this.portInput?.value.trim() || '').toUpperCase();
    const portInfo = this._portsInfo[currentPort];

    if (portInfo) {
      if (this.ovPort) this.ovPort.textContent = currentPort;
      if (this.ovBaud) this.ovBaud.textContent = portInfo.baud || '—';
      if (this.ovModes) this.ovModes.textContent = `${portInfo.inMode || '—'} / ${portInfo.outMode || '—'}`;
    } else {
      if (this.ovPort) this.ovPort.textContent = '—';
      if (this.ovBaud) this.ovBaud.textContent = '—';
      if (this.ovModes) this.ovModes.textContent = '—';
    }

    // Active RTCM count from pulled LOGLISTA
    const portLogs = this._loglistaPorts[currentPort] || [];
    const rtcmCount = portLogs.filter(e => /^RTCM/i.test(e.msg)).length;
    if (this.ovRtcm) this.ovRtcm.textContent = rtcmCount > 0 ? rtcmCount : '—';
  }

  _setStatus(text, type) {
    if (!this.statusLabel) return;
    this.statusLabel.textContent = text;
    if (type === 'danger') this.statusLabel.style.color = 'var(--danger)';
    else if (type === 'success') this.statusLabel.style.color = 'var(--success)';
    else this.statusLabel.style.color = 'var(--text-muted)';
  }
}
