// DeviceMonitorCard — Shows device ports, active logs, connection status
// Has cross-card awareness: shows which card uses each log, UNLOG button deactivates card

class SolutionStatusCard {
  constructor(api, dashboard) {
    this.api = api;
    this.dashboard = dashboard || null; // Dashboard reference for card registry
    this.card = document.getElementById('device-monitor-card');
    this._connected = false;
    this._connectedAt = null;
    this._uptimeTimer = null;
    this._logEntries = []; // cached for re-render
    this._deviceCaps = null;
    this._refreshing = false;

    // DOM refs
    this.connDot    = document.getElementById('dm-conn-dot');
    this.connLabel  = document.getElementById('dm-conn-label');
    this.connUptime = document.getElementById('dm-conn-uptime');
    this.deviceInfo = document.getElementById('dm-device-info');
    this.portCount  = document.getElementById('dm-port-count');
    this.portList   = document.getElementById('dm-port-list');
    this.logCount   = document.getElementById('dm-log-count');
    this.logList    = document.getElementById('dm-log-list');
    this.refreshBtn = document.getElementById('dm-refresh');

    this.init();
  }

  init() {
    // Refresh button
    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => this._refresh());
    }

    // Connection status listener
    this._refreshTimers = [];
    this.api.onConnection((connected) => {
      this._connected = connected;
      if (connected) {
        this._connectedAt = Date.now();
        this._startUptime();
        this._updateConnUI();

        // Auto-query once settled — onDeviceCapabilities triggers its own refresh
        // so we only need one late-fire timer as a safety net for BYNAV devices.
        console.log('[DeviceMonitor] Connected. Queuing post-detection refresh...');
        this._refreshTimers.push(setTimeout(() => this._refresh(), 4000));  // Safety net
      } else {
        // Önceki bağlantıdan bekleyen refresh timer'larını iptal et
        this._refreshTimers.forEach(t => clearTimeout(t));
        this._refreshTimers = [];
        this._refreshing = false;
        this._connectedAt = null;
        this._stopUptime();
        this._clearAll();
        this._updateConnUI();
      }
    });

    // Device capabilities — show model & feature flags in connection column.
    // Also trigger an immediate refresh now that we know the device family.
    this.api.onDeviceCapabilities((caps) => {
      this._deviceCaps = caps;
      this._updateDeviceInfo();
      if (this._connected) {
        // Small delay to let any in-flight refresh finish and logs settle
        setTimeout(() => this._refresh(), 300);
      }
    });

    this._updateConnUI();

    // Listen for card LOG/UNLOG changes — debounced auto-refresh
    this._logChangedTimer = null;
    window.addEventListener('log-changed', () => {
      if (!this._connected) return;
      if (this._logChangedTimer) clearTimeout(this._logChangedTimer);
      this._logChangedTimer = setTimeout(() => this._refresh(), 1200);
    });
  }

  // --- Connection UI ---

  _updateConnUI() {
    if (this.connDot) {
      this.connDot.classList.toggle('connected', this._connected);
      this.connDot.classList.toggle('disconnected', !this._connected);
    }
    if (this.connLabel) {
      if (this._connected) {
        // Try to find the connected port name if possible. 
        // For now, simple textual update.
        this.connLabel.innerHTML = `<span style="display:block; font-size:14px; color:var(--success);">Connected</span>`;
      } else {
        this.connLabel.textContent = 'Not connected';
      }
    }
    if (!this._connected && this.connUptime) {
      this.connUptime.textContent = '';
    }
  }

  _startUptime() {
    this._stopUptime();
    this._uptimeTimer = setInterval(() => {
      if (!this._connectedAt || !this.connUptime) return;
      const elapsed = Math.floor((Date.now() - this._connectedAt) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      const timeStr = h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;

      this.connUptime.innerHTML = `<span style="font-size:11px; color:var(--text-secondary); opacity:0.8;">${timeStr}</span>`;
    }, 1000);
  }

  _stopUptime() {
    if (this._uptimeTimer) {
      clearInterval(this._uptimeTimer);
      this._uptimeTimer = null;
    }
  }

  // --- Refresh ---

  async _refresh() {
    if (!this._connected) return;
    if (this._refreshing) return;  // Eş zamanlı refresh'i önle
    this._refreshing = true;

    // Device family not yet known (detection still in progress) — defer.
    // onDeviceCapabilities will trigger a fresh _refresh() once detection completes.
    if (this._deviceCaps === null) {
      this._refreshing = false;
      return;
    }

    // u-blox devices don't support ASCII queries (COMCONFIG / ICOMCONFIG / LOGLISTA).
    // Use CFG-VALGET instead — handled by _renderUbloxStatus().
    if (this._deviceCaps.family === 'ublox') {
      this._refreshing = false;
      this._renderUbloxStatus();
      return;
    }

    // Spin animation
    if (this.refreshBtn) {
      this.refreshBtn.classList.add('spinning');
      setTimeout(() => this.refreshBtn.classList.remove('spinning'), 700);
    }

    try {
      console.log('[DeviceMonitor] Requesting status...');
      const comResult  = await this.api.requestComconfig();
      if (!this._connected) return;  // Await sırasında disconnect olduysa çık

      const icomResult = await this.api.requestIcomconfig();
      if (!this._connected) return;  // Await sırasında disconnect olduysa çık

      const logResult  = await this.api.requestLoglista();
      if (!this._connected) return;  // Await sırasında disconnect olduysa çık

      console.log('[DeviceMonitor] COM:', (comResult.ports || []).length, 'ports |',
                  'ICOM:', (icomResult.ports || []).length, 'ports |',
                  'Logs:', (logResult.entries || []).length, 'entries');

      this._renderPorts(comResult.ports || [], icomResult.ports || []);
      this._logEntries = logResult.entries || [];
      this._renderLogs(this._logEntries);
    } catch (e) {
      console.error('[DeviceMonitor] Refresh error:', e);
    } finally {
      this._refreshing = false;
    }
  }

  // Query u-blox port config and active MSGOUT keys via CFG-VALGET, then render.
  async _renderUbloxStatus() {
    // Show loading state while querying device
    if (this.portCount) this.portCount.textContent = '…';
    if (this.logCount)  this.logCount.textContent  = '…';
    if (this.portList)  this.portList.innerHTML = '<div class="dm-empty-hint">Querying u-blox…</div>';
    if (this.logList)   this.logList.innerHTML  = '<div class="dm-empty-hint">Querying u-blox…</div>';

    try {
      const result = await this.api.requestUbxStatus();
      this._renderPorts(result.ports || [], []);
      this._logEntries = result.activeMsgs || [];
      this._renderLogs(this._logEntries);
    } catch (e) {
      console.error('[DeviceMonitor] u-blox status query error:', e);
      if (this.portList) this.portList.innerHTML = '<div class="dm-empty-hint">Query failed</div>';
      if (this.logList)  this.logList.innerHTML  = '<div class="dm-empty-hint">Query failed</div>';
    }
  }

  // --- Render Ports ---

  _renderPorts(comPorts, icomPorts) {
    const allPorts = [...comPorts, ...icomPorts];
    if (this.portCount) this.portCount.textContent = allPorts.length;

    if (!this.portList) return;

    if (allPorts.length === 0) {
      this.portList.innerHTML = '<div class="dm-empty-hint">No ports found</div>';
      return;
    }

    this.portList.innerHTML = allPorts.map(p => {
      const isEthernet = p.type === 'ethernet';
      const detail = isEthernet
        ? (p.protocol ? `${p.protocol}${p.tcpPort ? ':' + p.tcpPort : ''}` : '')
        : (p.baud || '');

      const icon = isEthernet
        ? '<svg class="dm-port-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9; width: 18px; height: 18px;"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>'
        : '<svg class="dm-port-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9; width: 18px; height: 18px;"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>';

      return `<div class="dm-port-item">
        ${icon}
        <div style="flex:1; min-width:0;">
          <div class="dm-port-name">${p.name}</div>
          <div style="font-size:10px; color:var(--text-muted);">${detail}</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
           <span class="dm-port-mode-tag in">${p.inMode || '-'}</span>
           <span class="dm-port-mode-tag out">${p.outMode || '-'}</span>
        </div>
      </div>`;
    }).join('');
  }

  // --- Render Logs ---

  _renderLogs(entries) {
    if (this.logCount) this.logCount.textContent = entries.length;

    if (!this.logList) return;

    if (entries.length === 0) {
      this.logList.innerHTML = '<div class="dm-empty-hint">No active logs</div>';
      return;
    }

    // Sort: by port then alphabetically by message name
    const sorted = [...entries].sort((a, b) => {
      if (a.port !== b.port) return a.port.localeCompare(b.port);
      return a.msg.localeCompare(b.msg);
    });

    this.logList.innerHTML = sorted.map((e, i) => {
      const rate = e.period > 0 ? `${parseFloat((1.0 / e.period).toFixed(4)).toString()}` : (e.mode === 'ONCHANGED' ? 'CHG' : e.mode);
      const isHz = e.period > 0;

      let cardTags = '';
      if (this.dashboard) {
        const matches = this.dashboard.findAllCardsByMessage(e.msg);
        cardTags = matches.map(m => {
          // Color-code based on card type/name if possible, or just use a nice generic badge
          return `<span class="dm-log-badge" title="Used by ${m.cardName}">${m.cardName.substring(0, 3).toUpperCase()}</span>`;
        }).join('');
      }

      return `<div class="dm-log-item" data-idx="${i}">
        <div class="dm-log-main">
          <span class="dm-log-name">${e.msg}</span>
          <div class="dm-log-tags">${cardTags}</div>
        </div>
        <div class="dm-log-meta">
          <span class="dm-log-info ${isHz ? 'is-hz' : ''}">${rate}${isHz ? '<small>Hz</small>' : ''}</span>
          <span class="dm-log-port">${e.port}</span>
          <button class="dm-unlog-btn" data-msg="${e.msg}" title="Stop Logging (UNLOG)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    // Bind UNLOG buttons
    this.logList.querySelectorAll('.dm-unlog-btn').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const msgName = btn.dataset.msg;
        this._unlogMessage(msgName);
      });
    });
  }

  // --- UNLOG Quick Action ---

  async _unlogMessage(msgName) {
    if (!this._connected || !msgName) return;

    try {
      // 1. Send UNLOG command
      await this.api.sendCommand(`UNLOG ${msgName}`);
      console.log(`[DeviceMonitor] UNLOG ${msgName}`);

      // 2. Deactivate the card that uses this message
      if (this.dashboard) {
        const match = this.dashboard.findCardByMessage(msgName);
        if (match) {
          console.log(`[DeviceMonitor] Deactivating ${match.cardName} card (source: ${msgName})`);
          this.dashboard.deactivateCard(match.card, msgName);
        }
      }

      // 3. Remove from local cache and re-render
      this._logEntries = this._logEntries.filter(e => e.msg !== msgName);
      this._renderLogs(this._logEntries);

    } catch (e) {
      console.error(`[DeviceMonitor] Error UNLOG ${msgName}:`, e);
    }
  }

  // --- Device Info ---

  _modelDisplayName(authMode) {
    if (!authMode) return '—';
    const m = authMode.toUpperCase();
    if (m.includes('1D')) return 'SS100D INS';
    if (m.includes('0D')) return 'SS100D / RTD100';
    return authMode;
  }

  _updateDeviceInfo() {
    if (!this.deviceInfo) return;
    const caps = this._deviceCaps;

    if (!caps || !caps.detected) {
      this.deviceInfo.innerHTML = '';
      return;
    }

    // ── u-blox family ──────────────────────────────────────────────────────
    if (caps.family === 'ublox') {
      const modelName = caps.model || 'u-blox';
      const fwText    = caps.fwVersion   ? caps.fwVersion   : '';
      const protText  = caps.protVersion ? `PROT ${caps.protVersion}` : '';
      const subtitle  = [fwText, protText].filter(Boolean).join(' · ');

      const insOk = caps.ins        === true;
      const rfOk  = caps.rf_monitor === true;

      // navSys may be space-separated ('GPS GLO GAL BDS QZSS')
      const systems = caps.navSys ? caps.navSys.split(/[\s;,+]+/).filter(Boolean) : [];

      const insHtml  = insOk ? `<span class="dm-cap-flag on">INS</span>` : '';
      const rfHtml   = rfOk  ? `<span class="dm-cap-flag on">RF MON</span>` : '';
      const flagsHtml = (insHtml || rfHtml)
        ? `<div class="dm-cap-flags">${insHtml}${rfHtml}</div>` : '';

      const sysHtml = systems.map(s => `<span class="dm-sys-chip">${s}</span>`).join('');
      const navSection = sysHtml ? `
        <div class="dm-info-section">
          <span class="dm-info-label">Navigation Systems</span>
          <div class="dm-sys-row">${sysHtml}</div>
        </div>` : '';

      this.deviceInfo.innerHTML = `
        <div class="dm-model-name">${modelName}</div>
        ${subtitle ? `<div class="dm-model-sub">${subtitle}</div>` : ''}
        ${flagsHtml}
        ${navSection}`;
      return;
    }

    // ── BYNAV family (default) ─────────────────────────────────────────────
    const modelName = this._modelDisplayName(caps.authMode);
    const insOk     = caps.ins      === true;
    const dualOk    = caps.dual_ant === true;

    // Constellation chips: "GPS GLONASS GALILEO ..." → split by space
    const systems = caps.navSys ? caps.navSys.split(' ').filter(Boolean) : [];

    // Signal chips: "B1IB2IB1CB2AB2BL1L1CL2..." → non-greedy regex prevents greedy merging
    // /[A-Z]\d[A-Z]*?(?=[A-Z]\d|$)/g  e.g. B1IB2I → [B1I, B2I], L1L1C → [L1, L1C]
    const signals = caps.frqMask
      ? (caps.frqMask.match(/[A-Z]\d[A-Z]*?(?=[A-Z]\d|$)/g) || [])
      : [];

    // INS sadece varsa göster, yoksa hiç yazma
    const insHtml  = insOk ? `<span class="dm-cap-flag on">INS</span>` : '';
    const dualHtml = `<span class="dm-cap-flag ${dualOk ? 'on' : 'off'}">DUAL ANT</span>`;

    const sysHtml = systems.map(s => `<span class="dm-sys-chip">${s}</span>`).join('');
    const sigHtml = signals.map(s => `<span class="dm-sig-chip">${s}</span>`).join('');

    const flagsHtml = (insHtml || dualHtml)
      ? `<div class="dm-cap-flags">${insHtml}${dualHtml}</div>` : '';

    const navSection = sysHtml ? `
      <div class="dm-info-section">
        <span class="dm-info-label">Navigation Systems</span>
        <div class="dm-sys-row">${sysHtml}</div>
      </div>` : '';

    const freqSection = sigHtml ? `
      <div class="dm-info-section">
        <span class="dm-info-label">Satellite Freq.</span>
        <div class="dm-sig-row">${sigHtml}</div>
      </div>` : '';

    this.deviceInfo.innerHTML = `
      <div class="dm-model-name">${modelName}</div>
      ${flagsHtml}
      ${navSection}
      ${freqSection}`;
  }

  // --- Clear ---

  _clearAll() {
    console.warn('[DeviceMonitor] _clearAll() called — ports cleared!');
    console.trace('[DeviceMonitor] _clearAll trace');
    this._logEntries = [];
    if (this.portCount) this.portCount.textContent = '0';
    if (this.logCount) this.logCount.textContent = '0';
    if (this.portList) this.portList.innerHTML = '<div class="dm-empty-hint">Connect to query</div>';
    if (this.logList) this.logList.innerHTML = '<div class="dm-empty-hint">Connect to query</div>';
  }
}
