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

    // DOM refs
    this.connDot = document.getElementById('dm-conn-dot');
    this.connLabel = document.getElementById('dm-conn-label');
    this.connUptime = document.getElementById('dm-conn-uptime');
    this.portCount = document.getElementById('dm-port-count');
    this.portList = document.getElementById('dm-port-list');
    this.logCount = document.getElementById('dm-log-count');
    this.logList = document.getElementById('dm-log-list');
    this.refreshBtn = document.getElementById('dm-refresh');

    this.init();
  }

  init() {
    // Refresh button
    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => this._refresh());
    }

    // Connection status listener
    this.api.onConnection((connected) => {
      this._connected = connected;
      if (connected) {
        this._connectedAt = Date.now();
        this._startUptime();
        this._updateConnUI();

        // Auto-query with backoff to catch logs set by other cards
        console.log('[DeviceMonitor] Connected. Starting refresh sequence...');
        setTimeout(() => this._refresh(), 500);  // Slight delay for serial settle
        setTimeout(() => this._refresh(), 2000); // Retry 1
        setTimeout(() => this._refresh(), 5000); // Retry 2
      } else {
        this._connectedAt = null;
        this._stopUptime();
        this._clearAll();
        this._updateConnUI();
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

    // Spin animation
    if (this.refreshBtn) {
      this.refreshBtn.classList.add('spinning');
      setTimeout(() => this.refreshBtn.classList.remove('spinning'), 700);
    }

    try {
      console.log('[DeviceMonitor] Requesting status...');
      const comResult = await this.api.requestComconfig();
      const icomResult = await this.api.requestIcomconfig();
      const logResult = await this.api.requestLoglista();

      console.log('[DeviceMonitor] Logs received:', logResult);
      if (logResult && logResult.entries) {
        console.log('[DeviceMonitor] Entry count:', logResult.entries.length);
      }

      this._renderPorts(comResult.ports || [], icomResult.ports || []);
      this._logEntries = logResult.entries || [];
      this._renderLogs(this._logEntries);
    } catch (e) {
      console.error('[DeviceMonitor] Refresh error:', e);
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
        ? '<svg class="dm-port-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.035M9 20a6.001 6.001 0 006-6M3 20a6 6 0 0110-6m0 0a6 6 0 006 6" /></svg>'
        : '<svg class="dm-port-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>';

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
      const rate = e.period > 0 ? `${e.period}` : (e.mode === 'ONCHANGED' ? 'CHG' : e.mode);
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

  // --- Clear ---

  _clearAll() {
    this._logEntries = [];
    if (this.portCount) this.portCount.textContent = '0';
    if (this.logCount) this.logCount.textContent = '0';
    if (this.portList) this.portList.innerHTML = '<div class="dm-empty-hint">Connect to query</div>';
    if (this.logList) this.logList.innerHTML = '<div class="dm-empty-hint">Connect to query</div>';
  }
}
