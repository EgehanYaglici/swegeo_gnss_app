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
        // Auto-query immediately on connect
        this._refresh();
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
      this.connLabel.textContent = this._connected ? 'Connected' : 'Not connected';
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
      this.connUptime.textContent = h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
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
      const comResult = await this.api.requestComconfig();
      const icomResult = await this.api.requestIcomconfig();
      const logResult = await this.api.requestLoglista();

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

      const inMode = p.inMode || 'N/A';
      const outMode = p.outMode || 'N/A';

      return `<div class="dm-port-row">
        <span class="dm-port-name">${p.name}</span>
        <span class="dm-port-baud">${detail}</span>
        <div class="dm-port-modes">
          <span class="dm-port-mode-tag in">IN:${inMode}</span>
          <span class="dm-port-mode-tag out">OUT:${outMode}</span>
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
      const rate = e.period > 0 ? `${e.period}Hz` : e.mode;

      // Check if any dashboard card is using this message
      let cardTag = '';
      if (this.dashboard) {
        const match = this.dashboard.findCardByMessage(e.msg);
        if (match) {
          cardTag = `<span class="dm-card-tag">${match.cardName}</span>`;
        }
      }

      return `<div class="dm-log-row" data-idx="${i}">
        <span class="dm-log-msg">${e.msg}</span>
        ${cardTag}
        <span class="dm-log-rate">${rate}</span>
        <span class="dm-log-port">${e.port}</span>
        <button class="dm-unlog-btn" data-msg="${e.msg}" title="UNLOG ${e.msg}">✕</button>
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
