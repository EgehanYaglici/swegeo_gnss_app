// MessagesSettings - Messages configuration tab
// Handles message enable/disable, port selection, COMCONFIG/LOGLISTA sync, info panel

class MessagesSettings {
  constructor(api) {
    this.api = api;

    // State
    this.messages = [];         // MessageDef[] from schema
    this.ports = [];            // PortInfo[] from COMCONFIG
    this.activeEntries = [];    // LogEntry[] from LOGLISTA
    this.selectedPorts = new Set();
    this.searchFilter = '';
    this.categoryFilter = 'all';
    this._loaded = false;
    this._refreshing = false;
    this._deviceCaps = null;    // null = unknown/show all, else { ins, dual_ant, ... }

    // DOM refs - Columns
    this.colNmea = document.getElementById('msg-col-nmea');
    this.colAscii = document.getElementById('msg-col-ascii');
    this.colBinary = document.getElementById('msg-col-binary');

    // DOM refs - Counts
    this.countNmea = document.getElementById('msg-count-nmea');
    this.countAscii = document.getElementById('msg-count-ascii');
    this.countBinary = document.getElementById('msg-count-binary');

    // DOM refs - Toolbar
    this.searchInput = document.getElementById('msg-search');
    this.filterBtns = document.querySelectorAll('.msg-filter-btn');

    // DOM refs - Ports (Floating Bottom)
    // DOM refs - Ports (Tray)
    this.serialPortContainer = document.getElementById('tray-port-serial');
    this.ethernetPortContainer = document.getElementById('tray-port-ethernet');
    this.serialCountLabel = document.getElementById('tray-total-count');
    this.statusLabel = document.getElementById('msg-status');

    // Dock & Tray Refs
    this.dockSummary = document.getElementById('dock-port-summary');
    this.tray = document.getElementById('port-selection-tray');
    this.dockTrigger = document.getElementById('btn-port-trigger');

    // Action buttons
    this.btnRefresh = document.getElementById('btn-msg-refresh');
    this.btnStopAll = document.getElementById('btn-msg-stop-all');
    this.btnApply = document.getElementById('btn-msg-apply');
    this.btnSave = document.getElementById('btn-msg-save');

    // Floating info panels: Map of msgName -> { el, fieldsBody, msg, schema }
    this._panels = new Map();
    this._panelZBase = 200;
    this._panelTopZ = 200;

    // Live-value subscriptions for info panels
    this._terminalUnsub = null;    // log:data (parsed stream)
    this._terminalLineSub = null;  // terminal:line (raw fallback)
    this._binaryUnsub = null;      // binary:parsed (legacy, unused)

    this._bindEvents();
  }

  _bindEvents() {
    // Search
    this.searchInput?.addEventListener('input', (e) => {
      this.searchFilter = e.target.value.trim().toLowerCase();
      this._applyFilters();
    });

    // Category filter tabs
    this.filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.categoryFilter = btn.dataset.filter;
        this._applyFilters();
      });
    });

    // Action buttons
    this.btnRefresh?.addEventListener('click', () => this.refreshPortsAndState());
    this.btnStopAll?.addEventListener('click', () => this.stopAll());
    this.btnApply?.addEventListener('click', () => this.applyChanges());
    this.btnSave?.addEventListener('click', () => this.saveConfig());

    this._initTrayEvents();
  }

  // Called from app.js when connection status changes
  async onConnectionChanged(connected) {
    if (connected) {
      // Ensure message table is loaded first
      if (!this._loaded) {
        await this._loadMessageDefinitions();
        this._renderMessages();
        this._loaded = true;
      }
      // Auto-scan ports on connection
      setTimeout(() => this.refreshPortsAndState(), 500);
    }
  }

  // --- Lifecycle ---

  async onPageActivated() {
    if (!this._loaded) {
      await this._loadMessageDefinitions();
      this._renderMessages();
      this._loaded = true;
    }
    this.refreshPortsAndState();
  }

  // --- Data Loading ---

  async _loadMessageDefinitions() {
    try {
      this._setStatus('Loading message definitions...');
      this.messages = await this.api.getAllMessages();
      this._setStatus(`Loaded ${this.messages.length} messages`);
    } catch (e) {
      console.error('Failed to load messages:', e);
      this._setStatus('Error loading messages', 'danger');
    }
  }

  /**
   * Apply device capability profile — filters message list accordingly.
   * Called by app.js when device is identified or on disconnect.
   * @param {object|null} caps  e.g. { ins: false, dual_ant: true }
   *                            null = unknown device, show everything
   */
  applyCapabilities(caps) {
    this._deviceCaps = caps;
    if (this._loaded) this._renderMessages();
  }

  /**
   * Returns true if a message should be visible for the current device caps.
   */
  _isMessageVisible(msg) {
    if (!this._deviceCaps || !msg.requires) return true;
    return this._deviceCaps[msg.requires] !== false;
  }

  // --- Message Rendering (3 Columns) ---

  _renderMessages() {
    if (!this.colNmea || !this.colAscii || !this.colBinary) return;

    // Clear columns
    this.colNmea.innerHTML = '';
    this.colAscii.innerHTML = '';
    this.colBinary.innerHTML = '';

    const categories = {
      nmea: { col: this.colNmea, countEl: this.countNmea, count: 0 },
      ascii: { col: this.colAscii, countEl: this.countAscii, count: 0 },
      binary: { col: this.colBinary, countEl: this.countBinary, count: 0 }
    };

    for (const msg of this.messages) {
      // Cihaz capability'sine göre filtrele
      if (!this._isMessageVisible(msg)) continue;

      const catKey = msg.category || 'ascii'; // default fallback
      const target = categories[catKey];
      if (!target) continue;

      const item = this._createMessageItem(msg);
      target.col.appendChild(item);
      target.count++;
    }

    // Update counts
    Object.values(categories).forEach(c => {
      if (c.countEl) c.countEl.textContent = c.count;
    });
  }

  _createMessageItem(msg) {
    const item = document.createElement('div');
    item.className = 'msg-item';
    item.dataset.msg = msg.name;
    item.dataset.category = msg.category;
    item.dataset.command = msg.command;
    item.dataset.familyKey = msg.familyKey;
    item.dataset.variant = msg.variant;

    // Content container
    const content = document.createElement('div');
    content.className = 'msg-item-content';

    // Top Row: Name + Hz Input + Dot
    const topRow = document.createElement('div');
    topRow.className = 'msg-item-row-top';

    // Left Group: Checkbox + Info + Name
    const leftGroup = document.createElement('div');
    leftGroup.className = 'msg-item-left-group';

    // Checkbox
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'msg-item-check';
    cb.dataset.msg = msg.name;
    cb.addEventListener('change', () => this._onCheckboxChanged(msg, cb.checked));

    // Info Icon Button (NEW)
    const infoBtn = document.createElement('div');
    infoBtn.className = 'msg-item-info-btn';
    infoBtn.title = 'Message Details';
    infoBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>`;
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showMessageInfo(msg);
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'msg-item-name';
    nameSpan.textContent = msg.name;

    leftGroup.appendChild(cb);
    leftGroup.appendChild(infoBtn);
    leftGroup.appendChild(nameSpan);

    // Right Group: Hz + Dot
    const rightGroup = document.createElement('div');
    rightGroup.className = 'msg-item-right-group';

    // Hz / Warning
    if (msg.isOnnew) {
      const lbl = document.createElement('span');
      lbl.className = 'msg-item-hz-label';
      lbl.textContent = 'ONNEW';
      rightGroup.appendChild(lbl);
    } else {
      const hzInput = document.createElement('input');
      hzInput.type = 'number';
      hzInput.className = 'msg-item-hz-input';
      hzInput.value = msg.defaultHz;
      hzInput.min = 1;
      hzInput.max = 100;
      hzInput.step = 1;
      hzInput.dataset.msg = msg.name;
      // Prevent click propagation
      hzInput.addEventListener('click', e => e.stopPropagation());
      rightGroup.appendChild(hzInput);
    }

    // Active Dot
    const dot = document.createElement('div');
    dot.className = 'msg-item-active-dot';
    dot.dataset.msg = msg.name;
    rightGroup.appendChild(dot);

    // Assembly
    topRow.appendChild(leftGroup);
    topRow.appendChild(rightGroup);

    // Description
    const desc = document.createElement('div');
    desc.className = 'msg-item-desc';
    desc.textContent = msg.description;
    desc.title = msg.description;

    content.appendChild(topRow);
    content.appendChild(desc);

    item.appendChild(content);

    return item;
  }

  // --- Filtering ---

  _applyFilters() {
    const selector = '.msg-item';
    const items = document.querySelectorAll(selector);

    items.forEach(item => {
      const cat = item.dataset.category;
      const name = item.dataset.msg?.toLowerCase() || '';
      const desc = item.querySelector('.msg-item-desc')?.textContent?.toLowerCase() || '';

      const matchCategory = (this.categoryFilter === 'all' || cat === this.categoryFilter);
      const matchSearch = (!this.searchFilter ||
        name.includes(this.searchFilter) ||
        desc.includes(this.searchFilter));

      const visible = matchCategory && matchSearch;
      item.classList.toggle('hidden', !visible);
    });
  }

  // --- Port Discovery ---

  async refreshPortsAndState() {
    if (this._refreshing) return;
    this._refreshing = true;

    try {
      // 1. Fetch serial ports (COMCONFIG)
      this._setStatus('Requesting COMCONFIG...');
      const comResult = await this.api.requestComconfig();
      const serialPorts = (comResult.ports || []).filter(p => p.type !== 'ethernet');

      // 2. Fetch ICOM ports (ICOMCONFIG)
      await new Promise(r => setTimeout(r, 300));
      this._setStatus('Requesting ICOMCONFIG...');
      const icomResult = await this.api.requestIcomconfig();
      const icomPorts = icomResult.ports || [];

      // 3. Merge: serial + ICOM
      this.ports = [...serialPorts, ...icomPorts];
      this._renderPortChips();

      const totalPorts = this.ports.length;
      if (totalPorts > 0) {
        this._setStatus(`Found ${serialPorts.length} serial + ${icomPorts.length} ICOM port(s). Requesting LOGLISTA...`);
      } else {
        this._setStatus('No ports found');
      }

      // 4. Fetch LOGLISTA
      await new Promise(r => setTimeout(r, 300));
      const logResult = await this.api.requestLoglista();
      if (logResult.entries) {
        this.activeEntries = logResult.entries;
        this._syncFromLoglista();
        this._setStatus(`Ready \u2014 ${this.activeEntries.length} active log(s)`);
      } else {
        this._setStatus(logResult.error || 'No active logs');
      }
    } catch (e) {
      console.error('Refresh error:', e);
      this._setStatus('Refresh failed');
    }

    this._refreshing = false;
  }

  _initTrayEvents() {
    console.log('Initializing Tray Events. Trigger:', this.dockTrigger, 'Tray:', this.tray);

    // Toggle Tray
    this.dockTrigger?.addEventListener('click', (e) => {
      console.log('Dock trigger clicked');
      e.stopPropagation();
      this._toggleTray();
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (this.tray?.classList.contains('visible') &&
        !this.tray.contains(e.target) &&
        !this.dockTrigger.contains(e.target)) {
        this._closeTray();
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.tray?.classList.contains('visible')) {
        this._closeTray();
      }
    });
  }

  _toggleTray() {
    if (!this.tray) {
      console.error('Tray element not found!');
      return;
    }
    const isVisible = this.tray.classList.contains('visible');
    console.log('Toggling tray. Current visible:', isVisible);
    if (isVisible) this._closeTray();
    else this._openTray();
  }

  _openTray() {
    if (!this.tray) return;
    this.tray.classList.add('visible');
    this.dockTrigger?.classList.add('active');
    this._updateDockSummary();
  }

  _closeTray() {
    if (!this.tray) return;
    this.tray.classList.remove('visible');
    this.dockTrigger?.classList.remove('active');
    this._updateDockSummary();
  }

  _renderPortChips() {
    const serialPorts = this.ports.filter(p => p.type !== 'ethernet');
    const ethernetPorts = this.ports.filter(p => p.type === 'ethernet');

    // Update total count badge
    if (this.serialCountLabel) {
      this.serialCountLabel.textContent = this.ports.length;
    }

    // Render Serial Ports
    this._renderGroupChips(this.serialPortContainer, serialPorts, 'No serial ports found');

    // Render Ethernet (ICOM) Ports
    this._renderGroupChips(this.ethernetPortContainer, ethernetPorts, 'No ethernet ports found');

    this._updateDockSummary();
  }

  _renderGroupChips(container, ports, emptyText) {
    if (!container) return;
    container.innerHTML = '';

    if (ports.length === 0) {
      container.innerHTML = `<div class="tray-empty">${emptyText}</div>`;
      return;
    }

    for (const port of ports) {
      const chip = document.createElement('div');
      chip.className = 'tray-chip';
      if (this.selectedPorts.has(port.name)) {
        chip.classList.add('selected');
      }

      chip.addEventListener('click', () => {
        if (this.selectedPorts.has(port.name)) {
          this.selectedPorts.delete(port.name);
          chip.classList.remove('selected');
        } else {
          this.selectedPorts.add(port.name);
          chip.classList.add('selected');
        }
        this.selectedPorts = new Set(this.selectedPorts); // trigger reactivity if any (none here but good practice)
        this._updateDockSummary();
      });

      // Checkbox visual
      const check = document.createElement('div');
      check.className = 'tray-chip-check';

      // Label
      const label = document.createElement('span');
      label.className = 'tray-chip-label';

      let text = port.name;
      if (port.baud && port.type !== 'ethernet') text += ` (${port.baud})`;
      label.textContent = text;

      chip.appendChild(check);
      chip.appendChild(label);
      container.appendChild(chip);
    }
  }

  _updateDockSummary() {
    if (!this.dockSummary) return;
    const count = this.selectedPorts.size;
    if (count === 0) {
      this.dockSummary.textContent = 'Click for Port Selection';
      this.dockSummary.style.color = '#9CA3AF';
    } else {
      const ports = Array.from(this.selectedPorts).join(', ');
      // Truncate if too long
      if (ports.length > 30) {
        this.dockSummary.textContent = `${count} ports selected`;
      } else {
        this.dockSummary.textContent = ports;
      }
      this.dockSummary.style.color = '#1F2937';
    }

    // Attention Glow Logic: Ports exist but none selected -> Glow
    // Note: this.ports might be empty initially, make sure to check availability
    const totalPorts = this.ports ? this.ports.length : 0;
    const selectedCount = this.selectedPorts.size;

    if (this.dockTrigger) {
      if (totalPorts > 0 && selectedCount === 0 && !this.tray?.classList.contains('visible')) {
        this.dockTrigger.classList.add('attention-glow');
      } else {
        this.dockTrigger.classList.remove('attention-glow');
      }
    }
  }

  // --- LOGLISTA Sync ---

  _syncFromLoglista() {
    // Clear all checkboxes and active states
    const checkboxes = document.querySelectorAll('.msg-item-check');
    checkboxes.forEach(cb => { cb.checked = false; });

    const items = document.querySelectorAll('.msg-item');
    items.forEach(item => {
      item.classList.remove('active-log');
      const dot = item.querySelector('.msg-item-active-dot');
      if (dot) dot.title = 'Not logging';
      // Reset Hz input if needed? nah let's keep user value or update from log
    });

    // Build a map: msgName -> [{port, hz/onnew}]
    const msgPorts = {};

    for (const entry of this.activeEntries) {
      const entryMsg = entry.msg.toUpperCase();

      // Find matching item by name or command
      const item = this._findMatchingItem(entryMsg);
      if (!item) continue;

      const name = item.dataset.msg;
      if (!msgPorts[name]) msgPorts[name] = [];

      let display;
      if (entry.mode === 'ONNEW') {
        display = `${entry.port}@ONNEW`;
      } else {
        const hz = entry.period > 0 ? Math.round(1.0 / entry.period) : 0;
        display = `${entry.port}@${hz}Hz`;
      }
      msgPorts[name].push({ port: entry.port, display, mode: entry.mode, period: entry.period });

      // Update Hz input if not ONNEW
      if (entry.mode !== 'ONNEW' && entry.period > 0) {
        const hzInput = item.querySelector('.msg-item-hz-input');
        if (hzInput) {
          hzInput.value = Math.round(1.0 / entry.period);
        }
      }
    }

    // Set checkboxes and active styles
    for (const [name, infos] of Object.entries(msgPorts)) {
      const item = document.querySelector(`.msg-item[data-msg="${name}"]`);
      if (!item) continue;

      const cb = item.querySelector('.msg-item-check');
      if (cb) cb.checked = true;

      item.classList.add('active-log');
      const dot = item.querySelector('.msg-item-active-dot');
      if (dot) {
        dot.title = 'Active on: ' + infos.map(i => i.display).join(', ');
      }
    }
  }

  _findMatchingItem(msgName) {
    const upper = msgName.toUpperCase();
    const items = document.querySelectorAll('.msg-item');

    for (const item of items) {
      const rowName = (item.dataset.msg || '').toUpperCase();
      const rowCmd = (item.dataset.command || '').toUpperCase();
      if (rowName === upper || rowCmd === upper) return item;
    }
    return null;
  }

  // --- Actions ---

  async applyChanges() {
    const items = document.querySelectorAll('.msg-item');
    if (!items) return;

    const commands = [];
    let errors = 0;

    items.forEach(item => {
      const cb = item.querySelector('.msg-item-check');
      if (!cb?.checked) return;

      const name = item.dataset.msg;
      const command = item.dataset.command;
      const isOnnew = item.querySelector('.msg-item-hz-label') !== null;
      const hzInput = item.querySelector('.msg-item-hz-input');

      if (isOnnew) {
        if (this.selectedPorts.size > 0) {
          for (const port of this.selectedPorts) {
            commands.push({ name, cmd: `LOG ${port} ${command} ONNEW` });
          }
        } else {
          commands.push({ name, cmd: `LOG ${command} ONNEW` });
        }
      } else {
        const hz = parseInt(hzInput?.value) || 1;
        if (hz < 1 || hz > 100) {
          this._setStatus(`Invalid Hz for ${name}: must be 1-100`, 'danger');
          errors++;
          return;
        }
        const period = (1.0 / hz).toFixed(2).replace(/\.?0+$/, '');
        if (this.selectedPorts.size > 0) {
          for (const port of this.selectedPorts) {
            commands.push({ name, cmd: `LOG ${port} ${command} ONTIME ${period}` });
          }
        } else {
          commands.push({ name, cmd: `LOG ${command} ONTIME ${period}` });
        }
      }
    });

    if (errors > 0) return;

    if (commands.length === 0) {
      this._setStatus('No messages checked');
      return;
    }

    this._setStatus(`Sending ${commands.length} command(s)...`);
    let sent = 0;
    for (const { cmd } of commands) {
      const result = await this.api.sendCommand(cmd);
      if (result?.ok) sent++;
    }

    this._setStatus(`Applied: ${sent}/${commands.length} command(s) sent`);

    // Refresh LOGLISTA after delay
    setTimeout(() => this.refreshPortsAndState(), 500);
  }

  async stopAll() {
    if (this.selectedPorts.size === 0) {
      // Send general UNLOGALL
      this._setStatus('Sending UNLOGALL...');
      await this.api.sendCommand('UNLOGALL');
    } else {
      const ports = [...this.selectedPorts];
      this._setStatus(`Stopping all on ${ports.join(', ')}...`);
      for (const port of ports) {
        await this.api.sendCommand(`UNLOGALL ${port}`);
      }
    }

    // Clear all checkboxes
    const checkboxes = document.querySelectorAll('.msg-item-check');
    checkboxes.forEach(cb => { cb.checked = false; });

    // Clear active states
    const items = document.querySelectorAll('.msg-item');
    items.forEach(i => i.classList.remove('active-log'));

    this._setStatus('All messages stopped');
    setTimeout(() => this.refreshPortsAndState(), 500);
  }

  async saveConfig() {
    this._setStatus('Saving configuration...');
    const result = await this.api.sendCommand('SAVECONFIG');
    this._setStatus(result?.ok ? 'Configuration saved' : 'Save failed');
  }

  async _onCheckboxChanged(msg, checked) {
    if (checked) return; // Only send UNLOG on uncheck

    // Check if the message is actually active
    const item = document.querySelector(`.msg-item[data-msg="${msg.name}"]`);
    if (!item?.classList.contains('active-log')) return;

    if (this.selectedPorts.size > 0) {
      for (const port of this.selectedPorts) {
        await this.api.sendCommand(`UNLOG ${port} ${msg.command}`);
      }
    } else {
      await this.api.sendCommand(`UNLOG ${msg.command}`);
    }

    // Visual feedback handled by refresh, but optimistically clear for now?
    // Nah, let refresh handle it.
    setTimeout(() => this.refreshPortsAndState(), 300);
  }

  _setStatus(text, type = 'normal') {
    if (this.statusLabel) {
      this.statusLabel.textContent = text;
      this.statusLabel.className = 'messages-status';
      if (type === 'danger') this.statusLabel.classList.add('text-danger');
    }
  }

  // --- Floating Info Panels (Preserved Logic) ---

  async showMessageInfo(msg) {
    // If already open, flash it to signal the user
    if (this._panels.has(msg.name)) {
      const existing = this._panels.get(msg.name);
      this._panelTopZ++;
      existing.el.style.zIndex = this._panelTopZ;
      existing.el.classList.remove('flash');
      void existing.el.offsetWidth; // reflow to restart animation
      existing.el.classList.add('flash');
      return;
    }

    try {
      const schema = await this.api.getMessageSchema(msg.familyKey, msg.variant);
      if (!schema) {
        this._setStatus(`No schema found for ${msg.name}`);
        return;
      }

      const panel = this._createFloatPanel(msg, schema);
      this._panels.set(msg.name, panel);

      // Trigger slide-in (next frame so transition fires)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => panel.el.classList.add('visible'));
      });

      // Reposition all panels side-by-side from the right
      this._repositionPanels();

      // Start shared listener if first panel
      if (this._panels.size === 1) this._startInfoListener();

    } catch (e) {
      console.error('Failed to show message info:', e);
      this._setStatus(`Error loading info for ${msg.name}`);
    }
  }

  // Grid-layout panels: fill row from right, wrap to row above when row is full
  _repositionPanels() {
    const panels = [...this._panels.values()];
    if (panels.length === 0) return;

    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const gapX = 8;
    const gapY = 8;
    const marginBottom = 20; // distance from bottom of viewport
    const marginRight = 0;

    // Use the size of the first panel as reference cell size
    const refEl = panels[0].el;
    const cellW = refEl.offsetWidth || 400;
    const cellH = refEl.offsetHeight || 360;

    // How many columns fit? Use actual sidebar width (collapsed = 80px)
    const sidebar = document.getElementById('sidebar');
    const sidebarW = sidebar ? sidebar.offsetWidth : 80;
    const availW = vw - sidebarW - 8; // 8px right margin
    const fitCols = Math.floor((availW + gapX) / (cellW + gapX));
    const maxCols = Math.min(3, Math.max(1, fitCols));

    // Assign each panel a column index (0 = rightmost) and row (0 = bottom)
    // Panels are ordered: oldest = index 0
    // Fill right-to-left, bottom-to-top
    // Only reposition panels that haven't been manually dragged
    const autopanels = panels.filter(p => !p.el._userMoved);
    let autoIdx = 0;

    panels.forEach((panel) => {
      if (panel.el._userMoved) return; // user moved it, leave it alone

      const i = autoIdx++;
      const col = i % maxCols;
      const row = Math.floor(i / maxCols);

      const el = panel.el;
      const w = el.offsetWidth || cellW;
      const h = el.offsetHeight || cellH;

      // right-to-left: col 0 = right edge
      const left = vw - marginRight - (col + 1) * w - col * gapX;
      const top = vh - marginBottom - (row + 1) * h - row * gapY;

      el.style.left = Math.max(sidebarW + 8, left) + 'px';
      el.style.top = Math.max(32, top) + 'px';
    });
  }

  _createFloatPanel(msg, schema) {
    const el = document.createElement('div');
    el.className = 'float-panel';
    this._panelTopZ++;
    el.style.zIndex = this._panelTopZ;

    // Position is set by _repositionPanels after DOM insert

    // --- Drag handle ---
    const dragBar = document.createElement('div');
    dragBar.className = 'float-panel-drag';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'float-panel-title-group';

    const title = document.createElement('div');
    title.className = 'float-panel-title';
    title.textContent = schema.name || msg.name;

    const desc = document.createElement('div');
    desc.className = 'float-panel-desc';
    desc.textContent = schema.description || msg.description || '';

    titleGroup.appendChild(title);
    titleGroup.appendChild(desc);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'float-panel-close';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="2" y1="2" x2="12" y2="12"/>
      <line x1="12" y1="2" x2="2" y2="12"/>
    </svg>`;
    closeBtn.addEventListener('click', () => this._closePanel(msg.name));

    dragBar.appendChild(titleGroup);
    dragBar.appendChild(closeBtn);

    // --- Body (scrollable) ---
    const body = document.createElement('div');
    body.className = 'float-panel-body';
    const bodyId = 'fpb-' + Date.now();
    body.id = bodyId;
    // Scrollbar styles are now handled in CSS

    const table = document.createElement('table');
    table.className = 'msg-fields-table';
    const colgroup = document.createElement('colgroup');
    [null, null, null, null, null].forEach(() => colgroup.appendChild(document.createElement('col')));
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    thead.innerHTML = `<tr><th>FIELD</th><th>VALUE</th><th>TYPE</th><th>UNIT</th><th>NOTE</th></tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    this._buildFieldRows(tbody, schema, msg);
    table.appendChild(tbody);
    body.appendChild(table);

    // --- Resize handle ---
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'float-panel-resize';
    resizeHandle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;

    el.appendChild(dragBar);
    el.appendChild(body);
    el.appendChild(resizeHandle);


    document.body.appendChild(el);

    // Bring to front on click
    el.addEventListener('mousedown', () => {
      this._panelTopZ++;
      el.style.zIndex = this._panelTopZ;
    });

    // Drag logic
    this._makeDraggable(el, dragBar);
    // Resize logic
    this._makeResizable(el, resizeHandle);

    return { el, tbody, msg, schema };
  }

  _buildFieldRows(tbody, schema, msg) {
    if (schema.fields && schema.fields.length > 0) {
      for (const field of schema.fields) {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.className = 'msg-field-name';
        tdName.textContent = field.name || `field_${field.index || ''}`;
        tr.appendChild(tdName);

        const tdValue = document.createElement('td');
        tdValue.className = 'msg-field-value';
        tdValue.dataset.fieldName = field.name || `field_${field.index || ''}`;
        tdValue.textContent = '--';
        tr.appendChild(tdValue);

        const tdType = document.createElement('td');
        tdType.className = 'msg-field-type';
        tdType.textContent = field.type || '';
        tr.appendChild(tdType);

        const tdUnit = document.createElement('td');
        tdUnit.className = 'msg-field-unit';
        tdUnit.textContent = field.unit || '';
        tr.appendChild(tdUnit);

        const tdNote = document.createElement('td');
        tdNote.className = 'msg-field-note';
        if (field.note_table) {
          const link = document.createElement('span');
          link.className = 'msg-field-note-link';
          link.textContent = field.note || field.note_table;
          link.title = `View ${field.note_table}`;
          link.addEventListener('click', () => this.showReferenceTable(field.note_table, field.name));
          tdNote.appendChild(link);
        } else if (field.note) {
          tdNote.textContent = field.note;
          tdNote.title = field.note;
        }
        tr.appendChild(tdNote);

        tbody.appendChild(tr);
      }
    }

    if (schema.derived && schema.derived.length > 0) {
      const divider = document.createElement('tr');
      divider.innerHTML = `<td colspan="5" style="padding:8px 10px;font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;background:var(--bg-secondary)">Derived Fields</td>`;
      tbody.appendChild(divider);

      for (const d of schema.derived) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="msg-field-name">${d.name || ''}</td>
          <td class="msg-field-value" data-field-name="${d.name || ''}">--</td>
          <td class="msg-field-type">derived</td>
          <td class="msg-field-unit">${d.unit || ''}</td>
          <td class="msg-field-note" title="${d.expr || ''}">${d.expr || ''}</td>
        `;
        tbody.appendChild(tr);
      }
    }
  }

  _closePanel(msgName) {
    const panel = this._panels.get(msgName);
    if (!panel) return;
    // Animate out, then remove
    panel.el.classList.remove('visible');
    panel.el.classList.add('hiding');
    setTimeout(() => {
      panel.el.remove();
      if (panel.styleEl) panel.styleEl.remove();
      this._panels.delete(msgName);
      this._repositionPanels();
      if (this._panels.size === 0) this._stopInfoListener();
    }, 240);
  }

  _makeDraggable(el, handle) {
    let startX, startY, startLeft, startTop;

    const onMouseDown = (e) => {
      // Ignore checks/buttons
      if (['BUTTON', 'INPUT', 'A'].includes(e.target.tagName)) return;

      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      el._userMoved = true; // Mark as manually moved

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      el.classList.add('dragging');
    };

    const onMouseMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = Math.max(0, startLeft + dx) + 'px';
      el.style.top = Math.max(0, startTop + dy) + 'px';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      el.classList.remove('dragging');
    };

    handle.addEventListener('mousedown', onMouseDown);
  }

  _makeResizable(el, handle) {
    let startX, startY, startW, startH;

    const onMouseDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startW = el.offsetWidth;
      startH = el.offsetHeight;

      el._userMoved = true; // Resize also counts as user customization

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.width = Math.max(300, startW + dx) + 'px';
      el.style.height = Math.max(200, startH + dy) + 'px';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', onMouseDown);
  }

  // --- Real-time Info Updates ---

  _startInfoListener() {
    if (this._terminalUnsub) return; // already running

    // Subscribe to the parsed message stream from the router (via log:data IPC channel)
    this._terminalUnsub = this.api.onLogData((data) => {
      if (!data || !data.fields || this._panels.size === 0) return;
      this._updatePanelsWithLogData(data);
    });

    // Also listen to raw terminal lines as fallback (NMEA/ASCII passthrough)
    this._terminalLineSub = this.api.onTerminalLine((lineData) => {
      if (this._panels.size === 0) return;
      const line = typeof lineData === 'string' ? lineData : (lineData?.text || '');
      if (!line) return;
      for (const panel of this._panels.values()) {
        this._tryParseInfoLine(line, panel);
      }
    });
  }

  _stopInfoListener() {
    if (this._terminalUnsub) { this._terminalUnsub(); this._terminalUnsub = null; }
    if (this._terminalLineSub) { this._terminalLineSub(); this._terminalLineSub = null; }
    if (this._binaryUnsub) { this._binaryUnsub(); this._binaryUnsub = null; }
  }

  _updatePanelsWithLogData(data) {
    // data = { type, schemaKey, fields: { fieldName: value }, source_name }
    const schemaKey = (data.schemaKey || data.source_name || '').toUpperCase();
    if (!schemaKey) return;

    for (const panel of this._panels.values()) {
      const msgFamilyKey = (panel.msg.familyKey || '').toUpperCase();
      const msgName = (panel.msg.name || '').toUpperCase();

      // Match by schemaKey against familyKey or name
      if (schemaKey !== msgFamilyKey && schemaKey !== msgName) continue;

      const fields = data.fields;
      const tbody = panel.tbody;

      for (const [fieldName, value] of Object.entries(fields)) {
        const td = tbody.querySelector(`td.msg-field-value[data-field-name="${fieldName}"]`);
        if (!td) continue;
        if (value == null) continue;

        let display;
        if (typeof value === 'number') {
          display = Number.isInteger(value) ? String(value) : value.toFixed(8).replace(/\.?0+$/, '');
        } else if (typeof value === 'object') {
          display = JSON.stringify(value);
        } else {
          display = String(value);
        }

        if (td.textContent !== display) {
          td.textContent = display;
          td.classList.add('has-value');
        }
      }
    }
  }

  // Fallback: parse raw terminal lines for panels (NMEA/ASCII)
  _tryParseInfoLine(line, panel) {
    const { msg, schema, tbody } = panel;
    const trimmed = line.trim();

    if (msg.variant === 'nmea') {
      if (!trimmed.startsWith('$')) return;
      const tag = trimmed.substring(1).split(',')[0];
      const sentenceType = tag.length > 3 ? tag.slice(-3) : tag;
      if (sentenceType.toUpperCase() !== msg.name.toUpperCase() &&
        sentenceType.toUpperCase() !== (msg.familyKey || '').toUpperCase()) return;
      const [body] = trimmed.split('*');
      const tokens = body.split(',');
      this._updateFieldValuesFromTokens(schema.fields, tokens, 'nmea', tbody);
    } else if (msg.variant === 'ascii') {
      if (!trimmed.startsWith('#') && !trimmed.includes(msg.name)) return;
      let tag;
      if (trimmed.includes(';')) {
        tag = trimmed.split(';')[0].split(',')[0].replace(/^#/, '').toUpperCase();
      } else {
        tag = trimmed.split(',')[0].replace(/^#/, '').toUpperCase();
      }
      if (tag !== msg.name.toUpperCase()) return;
      const dataSection = trimmed.includes(';') ? trimmed.split(';').slice(1).join(';') : trimmed;
      const [body] = dataSection.split('*');
      const tokens = body.split(',');
      this._updateFieldValuesFromTokens(schema.fields, tokens, 'ascii', tbody);
    }
  }

  _updateFieldValuesFromTokens(fields, tokens, variant, tbody) {
    if (!fields || !tokens) return;
    for (const field of fields) {
      const idx = field.index || 0;
      const tokenIdx = variant === 'ascii' ? idx - 1 : idx;
      const raw = (tokenIdx >= 0 && tokenIdx < tokens.length) ? tokens[tokenIdx]?.trim() : '';
      const fieldName = field.name || `field_${idx}`;
      const td = tbody.querySelector(`td.msg-field-value[data-field-name="${fieldName}"]`);
      if (!td || raw === '' || raw === undefined) continue;

      let display = raw;
      const type = field.type || 'str';
      if ((type === 'float' || type === 'double') && !isNaN(parseFloat(raw))) {
        display = parseFloat(raw).toFixed(6).replace(/\.?0+$/, '');
      } else if (type === 'int' && !isNaN(parseInt(raw))) {
        display = parseInt(raw, 10).toString();
      } else if ((type === 'lat_dm' || type === 'lon_dm') && !isNaN(parseFloat(raw))) {
        const val = parseFloat(raw);
        const deg = Math.floor(val / 100);
        const min = val % 100;
        display = (deg + min / 60).toFixed(8);
      }

      if (td.textContent !== display) {
        td.textContent = display;
        td.classList.add('has-value');
      }
    }
  }

  // --- Reference Table Popup ---

  async showReferenceTable(tableKey, fieldName) {
    try {
      const table = await this.api.getReferenceTable(tableKey);
      if (!table) {
        this._setStatus(`Reference table not found: ${tableKey}`);
        return;
      }

      // Overlay
      const overlay = document.createElement('div');
      overlay.className = 'msg-ref-overlay';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      // Popup
      const popup = document.createElement('div');
      popup.className = 'msg-ref-popup';

      // Header
      const header = document.createElement('div');
      header.className = 'msg-ref-header';
      const h4 = document.createElement('h4');
      h4.textContent = table.title || tableKey;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'msg-ref-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', () => overlay.remove());
      header.appendChild(h4);
      header.appendChild(closeBtn);
      popup.appendChild(header);

      // Body + table
      const body = document.createElement('div');
      body.className = 'msg-ref-body';
      const refTable = document.createElement('table');
      refTable.className = 'msg-ref-table';

      if (table.columns && table.rows) {
        // Columnar format: { columns: [...], rows: [...] }
        const cols = table.columns;
        const thead = document.createElement('thead');
        const headerTr = document.createElement('tr');
        for (const col of cols) {
          const th = document.createElement('th');
          th.textContent = col;
          headerTr.appendChild(th);
        }
        thead.appendChild(headerTr);
        refTable.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of table.rows) {
          const tr = document.createElement('tr');
          if (typeof row === 'object' && !Array.isArray(row)) {
            for (const col of cols) {
              const td = document.createElement('td');
              const val = row[col];
              td.textContent = (val != null && typeof val !== 'object') ? val : '';
              tr.appendChild(td);
            }
          } else if (Array.isArray(row)) {
            for (let i = 0; i < cols.length; i++) {
              const td = document.createElement('td');
              td.textContent = row[i] ?? '';
              tr.appendChild(td);
            }
          } else {
            const td = document.createElement('td');
            td.colSpan = cols.length;
            td.textContent = String(row ?? '');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        refTable.appendChild(tbody);

      } else if (Array.isArray(table)) {
        // Array of objects
        if (table.length > 0) {
          const keys = Object.keys(table[0]);
          const thead = document.createElement('thead');
          const headerTr = document.createElement('tr');
          for (const k of keys) {
            const th = document.createElement('th');
            th.textContent = k;
            headerTr.appendChild(th);
          }
          thead.appendChild(headerTr);
          refTable.appendChild(thead);

          const tbody = document.createElement('tbody');
          for (const item of table) {
            const tr = document.createElement('tr');
            for (const k of keys) {
              const td = document.createElement('td');
              const val = item[k];
              td.textContent = (val != null && typeof val !== 'object') ? val : '';
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          refTable.appendChild(tbody);
        }

      } else if (typeof table === 'object') {
        // Key-value object
        const tbody = document.createElement('tbody');
        for (const [key, val] of Object.entries(table)) {
          if (['columns', 'rows', 'title', '_meta'].includes(key)) continue;
          const tr = document.createElement('tr');
          const tdKey = document.createElement('td');
          tdKey.style.fontWeight = '600';
          tdKey.textContent = key;
          const tdVal = document.createElement('td');
          tdVal.textContent = (typeof val === 'object') ? JSON.stringify(val, null, 1) : String(val);
          tr.appendChild(tdKey);
          tr.appendChild(tdVal);
          tbody.appendChild(tr);
        }
        refTable.appendChild(tbody);
      }

      body.appendChild(refTable);
      popup.appendChild(body);
      overlay.appendChild(popup);
      document.body.appendChild(overlay);

    } catch (e) {
      console.error('Failed to show reference table:', e);
      this._setStatus(`Error loading reference table: ${tableKey}`);
    }
  }

}
