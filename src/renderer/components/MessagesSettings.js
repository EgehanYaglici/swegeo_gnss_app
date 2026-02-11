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

    // DOM refs
    this.tableBody = document.getElementById('messages-table-body');
    this.searchInput = document.getElementById('msg-search');
    this.filterBtns = document.querySelectorAll('.msg-filter-btn');
    this.serialPortContainer = document.getElementById('msg-port-serial');
    this.ethernetPortContainer = document.getElementById('msg-port-ethernet');
    this.serialCountLabel = document.getElementById('port-count-serial');
    this.ethernetCountLabel = document.getElementById('port-count-ethernet');
    this.statusLabel = document.getElementById('msg-status');

    // Action buttons
    this.btnRefresh = document.getElementById('btn-msg-refresh');
    this.btnStopAll = document.getElementById('btn-msg-stop-all');
    this.btnApply = document.getElementById('btn-msg-apply');
    this.btnSave = document.getElementById('btn-msg-save');

    // Info panel
    this.infoPanel = document.getElementById('msg-info-panel');
    this.infoTitle = document.getElementById('msg-info-title');
    this.infoDesc = document.getElementById('msg-info-desc');
    this.infoFields = document.getElementById('msg-info-fields');
    this.btnInfoClose = document.getElementById('btn-msg-info-close');

    // Live value tracking for info panel
    this._infoOpenMsg = null;       // Currently open message def
    this._infoSchema = null;        // Currently open schema
    this._terminalUnsub = null;     // Terminal line listener unsubscribe
    this._binaryUnsub = null;       // Binary parsed listener unsubscribe

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

    // Info panel close
    this.btnInfoClose?.addEventListener('click', () => this.closeMessageInfo());

    // Port tab switching (Serial / Ethernet)
    document.querySelectorAll('.port-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.portTab;
        document.querySelectorAll('.port-tab').forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.port-slide').forEach(s => s.classList.toggle('active', s.id === `port-slide-${target}`));
      });
    });
  }

  // Called from app.js when connection status changes
  async onConnectionChanged(connected) {
    if (connected) {
      // Ensure message table is loaded first
      if (!this._loaded) {
        await this._loadMessageDefinitions();
        this._renderTable();
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
      this._renderTable();
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

  // --- Table Rendering ---

  _renderTable() {
    if (!this.tableBody) return;
    this.tableBody.innerHTML = '';

    const categories = [
      { key: 'nmea', label: 'NMEA Messages' },
      { key: 'ascii', label: 'ASCII Messages' },
      { key: 'binary', label: 'Binary Messages' }
    ];

    for (const cat of categories) {
      const catMessages = this.messages.filter(m => m.category === cat.key);
      if (catMessages.length === 0) continue;

      // Section header
      const headerRow = document.createElement('tr');
      headerRow.className = 'msg-section-header';
      headerRow.dataset.category = cat.key;
      headerRow.innerHTML = `<td colspan="5">
        ${cat.label}
        <span class="section-count">(${catMessages.length})</span>
      </td>`;
      this.tableBody.appendChild(headerRow);

      // Message rows
      for (const msg of catMessages) {
        const tr = document.createElement('tr');
        tr.className = 'msg-row';
        tr.dataset.msg = msg.name;
        tr.dataset.category = msg.category;
        tr.dataset.command = msg.command;
        tr.dataset.familyKey = msg.familyKey;
        tr.dataset.variant = msg.variant;

        // Enable checkbox
        const tdEnable = document.createElement('td');
        tdEnable.style.textAlign = 'center';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'msg-checkbox';
        cb.dataset.msg = msg.name;
        cb.addEventListener('change', () => this._onCheckboxChanged(msg, cb.checked));
        tdEnable.appendChild(cb);

        // Message name + info button
        const tdName = document.createElement('td');
        const nameCell = document.createElement('div');
        nameCell.className = 'msg-name-cell';
        const infoBtn = document.createElement('button');
        infoBtn.className = 'msg-info-btn';
        infoBtn.textContent = 'i';
        infoBtn.title = `Show ${msg.name} field details`;
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showMessageInfo(msg);
        });
        const nameSpan = document.createElement('span');
        nameSpan.className = 'msg-name';
        nameSpan.textContent = msg.name;
        nameCell.appendChild(infoBtn);
        nameCell.appendChild(nameSpan);
        tdName.appendChild(nameCell);

        // Description
        const tdDesc = document.createElement('td');
        const descSpan = document.createElement('span');
        descSpan.className = 'msg-description';
        descSpan.textContent = msg.description;
        descSpan.title = msg.description;
        tdDesc.appendChild(descSpan);

        // Hz
        const tdHz = document.createElement('td');
        tdHz.style.textAlign = 'center';
        if (msg.isOnnew) {
          const label = document.createElement('span');
          label.className = 'msg-onnew-label';
          label.textContent = 'ONNEW';
          tdHz.appendChild(label);
        } else {
          const hzInput = document.createElement('input');
          hzInput.type = 'number';
          hzInput.className = 'msg-hz-input';
          hzInput.value = msg.defaultHz;
          hzInput.min = 1;
          hzInput.max = 100;
          hzInput.step = 1;
          hzInput.dataset.msg = msg.name;
          tdHz.appendChild(hzInput);
        }

        // Active On
        const tdActive = document.createElement('td');
        const activeSpan = document.createElement('span');
        activeSpan.className = 'msg-active-on';
        activeSpan.dataset.msg = msg.name;
        tdActive.appendChild(activeSpan);

        tr.appendChild(tdEnable);
        tr.appendChild(tdName);
        tr.appendChild(tdDesc);
        tr.appendChild(tdHz);
        tr.appendChild(tdActive);

        this.tableBody.appendChild(tr);
      }
    }
  }

  // --- Filtering ---

  _applyFilters() {
    const rows = this.tableBody?.querySelectorAll('.msg-row, .msg-section-header');
    if (!rows) return;

    const sectionVisibility = {};

    rows.forEach(row => {
      if (row.classList.contains('msg-section-header')) return;

      const cat = row.dataset.category;
      const name = row.dataset.msg?.toLowerCase() || '';
      const desc = row.querySelector('.msg-description')?.textContent?.toLowerCase() || '';

      const matchCategory = (this.categoryFilter === 'all' || cat === this.categoryFilter);
      const matchSearch = (!this.searchFilter ||
        name.includes(this.searchFilter) ||
        desc.includes(this.searchFilter));

      const visible = matchCategory && matchSearch;
      row.classList.toggle('msg-row-hidden', !visible);

      if (visible) {
        sectionVisibility[cat] = true;
      }
    });

    // Show/hide section headers
    rows.forEach(row => {
      if (!row.classList.contains('msg-section-header')) return;
      const cat = row.dataset.category;
      row.classList.toggle('msg-row-hidden', !sectionVisibility[cat]);
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

  _renderPortChips() {
    const serialPorts = this.ports.filter(p => p.type !== 'ethernet');
    const ethernetPorts = this.ports.filter(p => p.type === 'ethernet');

    // Render Serial Ports
    this._renderGroupChips(this.serialPortContainer, serialPorts, 'No serial ports');
    if (this.serialCountLabel) this.serialCountLabel.textContent = serialPorts.length;

    // Render Ethernet (ICOM) Ports
    this._renderGroupChips(this.ethernetPortContainer, ethernetPorts, 'No ICOM ports');
    if (this.ethernetCountLabel) this.ethernetCountLabel.textContent = ethernetPorts.length;
  }

  _renderGroupChips(container, ports, emptyText) {
    if (!container) return;
    container.innerHTML = '';

    if (ports.length === 0) {
      container.innerHTML = `<span class="port-placeholder">${emptyText}</span>`;
      return;
    }

    for (const port of ports) {
      const chip = document.createElement('label');
      chip.className = 'port-chip';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = port.name;
      // Restore selection state
      if (this.selectedPorts.has(port.name)) cb.checked = true;
      cb.addEventListener('change', () => {
        if (cb.checked) this.selectedPorts.add(port.name);
        else this.selectedPorts.delete(port.name);
      });

      const label = document.createElement('span');
      label.className = 'port-chip-label';
      if (port.type === 'ethernet') label.classList.add('port-ethernet');

      let text = port.name;
      if (port.baud && port.type !== 'ethernet') text += ` (${port.baud})`;
      label.textContent = text;

      chip.appendChild(cb);
      chip.appendChild(label);
      container.appendChild(chip);
    }
  }

  // --- LOGLISTA Sync ---

  _syncFromLoglista() {
    // Clear all checkboxes and active-on labels
    const checkboxes = this.tableBody?.querySelectorAll('.msg-checkbox');
    checkboxes?.forEach(cb => { cb.checked = false; });

    const activeLabels = this.tableBody?.querySelectorAll('.msg-active-on');
    activeLabels?.forEach(l => { l.textContent = ''; });

    // Build a map: msgName -> [{port, hz/onnew}]
    const msgPorts = {};

    for (const entry of this.activeEntries) {
      const entryMsg = entry.msg.toUpperCase();

      // Find matching row by name or command
      const row = this._findMatchingRow(entryMsg);
      if (!row) continue;

      const name = row.dataset.msg;
      if (!msgPorts[name]) msgPorts[name] = [];

      let display;
      if (entry.mode === 'ONNEW') {
        display = `${entry.port}@ONNEW`;
      } else {
        const hz = entry.period > 0 ? Math.round(1.0 / entry.period) : 0;
        display = `${entry.port}@${hz}Hz`;
      }
      msgPorts[name].push({ port: entry.port, display });

      // Update Hz input if not ONNEW
      if (entry.mode !== 'ONNEW' && entry.period > 0) {
        const hzInput = row.querySelector('.msg-hz-input');
        if (hzInput) {
          hzInput.value = Math.round(1.0 / entry.period);
        }
      }
    }

    // Set checkboxes and active-on labels
    for (const [name, ports] of Object.entries(msgPorts)) {
      const cb = this.tableBody?.querySelector(`.msg-checkbox[data-msg="${name}"]`);
      if (cb) cb.checked = true;

      const activeLabel = this.tableBody?.querySelector(`.msg-active-on[data-msg="${name}"]`);
      if (activeLabel) {
        activeLabel.textContent = ports.map(p => p.display).join(', ');
      }
    }
  }

  _findMatchingRow(msgName) {
    const upper = msgName.toUpperCase();
    const rows = this.tableBody?.querySelectorAll('.msg-row');
    if (!rows) return null;

    for (const row of rows) {
      const rowName = (row.dataset.msg || '').toUpperCase();
      const rowCmd = (row.dataset.command || '').toUpperCase();
      if (rowName === upper || rowCmd === upper) return row;
    }
    return null;
  }

  // --- Actions ---

  async applyChanges() {
    const rows = this.tableBody?.querySelectorAll('.msg-row');
    if (!rows) return;

    const commands = [];
    let errors = 0;

    rows.forEach(row => {
      const cb = row.querySelector('.msg-checkbox');
      if (!cb?.checked) return;

      const name = row.dataset.msg;
      const command = row.dataset.command;
      const isOnnew = row.querySelector('.msg-onnew-label') !== null;
      const hzInput = row.querySelector('.msg-hz-input');

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
    const checkboxes = this.tableBody?.querySelectorAll('.msg-checkbox');
    checkboxes?.forEach(cb => { cb.checked = false; });
    const activeLabels = this.tableBody?.querySelectorAll('.msg-active-on');
    activeLabels?.forEach(l => { l.textContent = ''; });

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
    const activeLabel = this.tableBody?.querySelector(`.msg-active-on[data-msg="${msg.name}"]`);
    if (!activeLabel?.textContent) return;

    if (this.selectedPorts.size > 0) {
      for (const port of this.selectedPorts) {
        await this.api.sendCommand(`UNLOG ${port} ${msg.command}`);
      }
    } else {
      await this.api.sendCommand(`UNLOG ${msg.command}`);
    }

    activeLabel.textContent = '';
    setTimeout(() => this.refreshPortsAndState(), 300);
  }

  // --- Message Info Panel ---

  async showMessageInfo(msg) {
    try {
      // Close previous listener if any
      this._stopInfoListener();

      const schema = await this.api.getMessageSchema(msg.familyKey, msg.variant);
      if (!schema) {
        this._setStatus(`No schema found for ${msg.name}`);
        return;
      }

      this._infoOpenMsg = msg;
      this._infoSchema = schema;

      // Set header
      this.infoTitle.textContent = schema.name || msg.name;
      this.infoDesc.textContent = schema.description || msg.description;

      // Build fields table
      this.infoFields.innerHTML = '';

      if (schema.fields && schema.fields.length > 0) {
        for (const field of schema.fields) {
          const tr = document.createElement('tr');

          // Field name
          const tdName = document.createElement('td');
          tdName.className = 'msg-field-name';
          tdName.textContent = field.name || `field_${field.index || ''}`;
          tr.appendChild(tdName);

          // Value (live updated)
          const tdValue = document.createElement('td');
          tdValue.className = 'msg-field-value';
          tdValue.dataset.fieldName = field.name || `field_${field.index || ''}`;
          tdValue.textContent = '--';
          tr.appendChild(tdValue);

          // Type
          const tdType = document.createElement('td');
          tdType.className = 'msg-field-type';
          tdType.textContent = field.type || '';
          tr.appendChild(tdType);

          // Unit
          const tdUnit = document.createElement('td');
          tdUnit.className = 'msg-field-unit';
          tdUnit.textContent = field.unit || '';
          tr.appendChild(tdUnit);

          // Note
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

          this.infoFields.appendChild(tr);
        }
      }

      // Derived fields section
      if (schema.derived && schema.derived.length > 0) {
        const divider = document.createElement('tr');
        divider.innerHTML = `<td colspan="5" style="padding: 8px 10px; font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; background: var(--bg-secondary);">Derived Fields</td>`;
        this.infoFields.appendChild(divider);

        for (const d of schema.derived) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td class="msg-field-name">${d.name || ''}</td>
            <td class="msg-field-value" data-field-name="${d.name || ''}">--</td>
            <td class="msg-field-type">derived</td>
            <td class="msg-field-unit">${d.unit || ''}</td>
            <td class="msg-field-note" title="${d.expr || ''}">${d.expr || ''}</td>
          `;
          this.infoFields.appendChild(tr);
        }
      }

      // Start listening to terminal lines for live values
      this._startInfoListener();

      // Open panel
      this.infoPanel?.classList.add('open');
    } catch (e) {
      console.error('Failed to show message info:', e);
      this._setStatus(`Error loading info for ${msg.name}`);
    }
  }

  closeMessageInfo() {
    this._stopInfoListener();
    this._infoOpenMsg = null;
    this._infoSchema = null;
    this.infoPanel?.classList.remove('open');
  }

  // --- Live Value Listener ---

  _startInfoListener() {
    if (this._terminalUnsub) return;
    // Listen for ASCII/NMEA lines
    this._terminalUnsub = this.api.onTerminalLine((data) => {
      if (!this._infoOpenMsg || !this._infoSchema) return;
      const line = typeof data === 'string' ? data : data?.text || '';
      this._tryParseInfoLine(line);
    });
    // Listen for parsed binary frames
    if (this.api.onBinaryParsed) {
      this._binaryUnsub = this.api.onBinaryParsed((data) => {
        if (!this._infoOpenMsg || !this._infoSchema) return;
        if (this._infoOpenMsg.variant !== 'binary') return;
        this._onBinaryParsed(data);
      });
    }
  }

  _stopInfoListener() {
    if (this._terminalUnsub) {
      this._terminalUnsub();
      this._terminalUnsub = null;
    }
    if (this._binaryUnsub) {
      this._binaryUnsub();
      this._binaryUnsub = null;
    }
  }

  _tryParseInfoLine(line) {
    if (!line || !this._infoOpenMsg || !this._infoSchema) return;
    const msg = this._infoOpenMsg;
    const schema = this._infoSchema;
    const trimmed = line.trim();

    if (msg.variant === 'nmea') {
      // NMEA: $GPGGA,... or $GNGGA,...
      // Match if the sentence type matches msg.name (e.g. GGA)
      if (!trimmed.startsWith('$')) return;
      const tag = trimmed.substring(1).split(',')[0];
      const sentenceType = tag.length > 3 ? tag.slice(-3) : tag;
      if (sentenceType.toUpperCase() !== msg.name.toUpperCase() &&
          sentenceType.toUpperCase() !== msg.familyKey.toUpperCase()) return;

      // Parse NMEA fields
      const [body] = trimmed.split('*');
      const tokens = body.split(',');
      this._updateFieldValues(schema.fields, tokens, 'nmea');

    } else if (msg.variant === 'ascii') {
      // ASCII: #HEADERA,... or with header; data
      if (!trimmed.startsWith('#') && !trimmed.includes(msg.name)) return;

      let tag;
      if (trimmed.includes(';')) {
        tag = trimmed.split(';')[0].split(',')[0].replace(/^#/, '').toUpperCase();
      } else {
        tag = trimmed.split(',')[0].replace(/^#/, '').toUpperCase();
      }

      if (tag !== msg.name.toUpperCase()) return;

      // Parse ASCII fields: data is after ;
      let dataSection;
      if (trimmed.includes(';')) {
        dataSection = trimmed.split(';').slice(1).join(';');
      } else {
        dataSection = trimmed;
      }
      const [body] = dataSection.split('*');
      const tokens = body.split(',');
      this._updateFieldValues(schema.fields, tokens, 'ascii');
    }
    // Binary is handled by _onBinaryParsed via binary:parsed IPC channel
  }

  _onBinaryParsed(data) {
    if (!data || !this._infoOpenMsg || !this._infoSchema) return;
    const msg = this._infoOpenMsg;

    // Match by familyKey (schema key like BESTPOS) or by message name/tag
    const dataKey = (data.schemaKey || '').toUpperCase();
    const msgFamily = (msg.familyKey || '').toUpperCase();
    const msgName = (msg.name || '').toUpperCase();

    if (dataKey !== msgFamily && dataKey !== msgName &&
        (data.name || '').toUpperCase() !== msgName) return;

    // data.fields is already flat: { fieldName: value, ... }
    const fields = data.fields || {};
    const schema = this._infoSchema;

    for (const field of (schema.fields || [])) {
      const fieldName = field.name;
      if (!fieldName) continue;

      const td = this.infoFields?.querySelector(`td.msg-field-value[data-field-name="${fieldName}"]`);
      if (!td) continue;

      const value = fields[fieldName];
      if (value == null) continue;

      let display;
      if (typeof value === 'number') {
        const type = field.type || '';
        if (type === 'float64' || type === 'double') {
          display = value.toFixed(8).replace(/\.?0+$/, '');
        } else if (type === 'float32' || type === 'float') {
          display = value.toFixed(4).replace(/\.?0+$/, '');
        } else {
          display = String(value);
        }
      } else if (typeof value === 'string') {
        display = value;
      } else if (Array.isArray(value)) {
        display = `[${value.length} items]`;
      } else if (typeof value === 'object') {
        display = JSON.stringify(value);
      } else {
        display = String(value);
      }

      td.textContent = display;
      td.classList.add('has-value');
    }

    // Also update derived fields
    for (const d of (schema.derived || [])) {
      if (!d.name) continue;
      const td = this.infoFields?.querySelector(`td.msg-field-value[data-field-name="${d.name}"]`);
      if (!td) continue;
      const value = fields[d.name];
      if (value == null) continue;
      td.textContent = typeof value === 'number' ? value.toFixed(4).replace(/\.?0+$/, '') : String(value);
      td.classList.add('has-value');
    }
  }

  _updateFieldValues(fields, tokens, variant) {
    if (!fields || !tokens) return;

    for (const field of fields) {
      const idx = field.index || 0;
      // For ASCII, field index is 1-based from data section
      // For NMEA, field index is 1-based from full sentence
      const tokenIdx = variant === 'ascii' ? idx - 1 : idx;

      const raw = (tokenIdx >= 0 && tokenIdx < tokens.length) ? tokens[tokenIdx]?.trim() : '';
      const fieldName = field.name || `field_${idx}`;

      const td = this.infoFields?.querySelector(`td.msg-field-value[data-field-name="${fieldName}"]`);
      if (!td) continue;

      if (raw !== '' && raw !== undefined) {
        // Format based on type
        let display = raw;
        const type = field.type || 'str';
        if (type === 'float' && !isNaN(parseFloat(raw))) {
          display = parseFloat(raw).toFixed(6).replace(/\.?0+$/, '');
        } else if (type === 'int' && !isNaN(parseInt(raw))) {
          display = parseInt(raw, 10).toString();
        } else if (type === 'lat_dm' || type === 'lon_dm') {
          const val = parseFloat(raw);
          if (!isNaN(val)) {
            const deg = Math.floor(val / 100);
            const min = val % 100;
            display = (deg + min / 60).toFixed(8);
          }
        }
        td.textContent = display;
        td.classList.add('has-value');
      }
    }
  }

  async showReferenceTable(tableKey, fieldName) {
    try {
      const table = await this.api.getReferenceTable(tableKey);
      if (!table) {
        this._setStatus(`Reference table not found: ${tableKey}`);
        return;
      }

      // Create popup overlay
      const overlay = document.createElement('div');
      overlay.className = 'msg-ref-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });

      const popup = document.createElement('div');
      popup.className = 'msg-ref-popup';

      // Header
      const header = document.createElement('div');
      header.className = 'msg-ref-header';
      header.innerHTML = `<h4>${tableKey}</h4>`;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'msg-ref-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', () => overlay.remove());
      header.appendChild(closeBtn);
      popup.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'msg-ref-body';

      const refTable = document.createElement('table');
      refTable.className = 'msg-ref-table';

      // Use title if available
      if (table.title) {
        header.querySelector('h4').textContent = table.title;
      }

      // Determine table structure
      if (table.columns && table.rows) {
        // Columnar table with object rows (e.g. {value, ascii, description})
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
            // Object row: use column names as keys
            for (const col of cols) {
              const td = document.createElement('td');
              const val = row[col];
              td.textContent = (val != null && typeof val !== 'object') ? val : '';
              tr.appendChild(td);
            }
          } else if (Array.isArray(row)) {
            // Array row: use index
            for (let i = 0; i < cols.length; i++) {
              const td = document.createElement('td');
              td.textContent = row[i] ?? '';
              tr.appendChild(td);
            }
          } else {
            // Simple value
            const td = document.createElement('td');
            td.colSpan = cols.length;
            td.textContent = String(row ?? '');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        refTable.appendChild(tbody);
      } else if (Array.isArray(table)) {
        // Simple array of objects
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
          if (key === 'columns' || key === 'rows' || key === 'title' || key === '_meta') continue;
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
    }
  }

  // --- Helpers ---

  _setStatus(text, type) {
    if (!this.statusLabel) return;
    this.statusLabel.textContent = text;
    this.statusLabel.style.color = type === 'danger' ? 'var(--danger)' : 'var(--text-muted)';
  }
}
