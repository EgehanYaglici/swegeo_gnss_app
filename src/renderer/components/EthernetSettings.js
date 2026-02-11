// EthernetSettings - IP and ICOM port configuration
// PC network info, device IP config, ICOM TCP config

class EthernetSettings {
  constructor(api) {
    this.api = api;

    // State
    this._adapters = [];
    this._listenActive = false;
    this._listenBuffer = [];
    this._loaded = false;
    this._termUnsub = null;
    this._firstActivation = false;

    // Device-pulled state
    this._deviceIpRows = [];
    this._deviceIcomRows = [];
    this._deviceBestIp = '';
    this._deviceBestMask = '';
    this._deviceBestGw = '';
    this._deviceBestMode = '';

    // DOM refs — Left (config)
    this.devIp = document.getElementById('eth-dev-ip');
    this.devMask = document.getElementById('eth-dev-mask');
    this.devGw = document.getElementById('eth-dev-gw');
    this.ifaceSelect = document.getElementById('eth-iface');
    this.modeSelect = document.getElementById('eth-mode');
    this.icomSelect = document.getElementById('eth-icom');
    this.portInput = document.getElementById('eth-tcp-port');
    this.statusLabel = document.getElementById('eth-status');

    // DOM refs — Left (device status)
    this.ovMode = document.getElementById('eth-ov-mode');
    this.ovIp = document.getElementById('eth-ov-ip');
    this.ovMask = document.getElementById('eth-ov-mask');
    this.ovGw = document.getElementById('eth-ov-gw');
    this.ovIcom = document.getElementById('eth-ov-icom');

    // DOM refs — Right (PC network)
    this.adapterSelect = document.getElementById('eth-adapter');
    this.pcIp = document.getElementById('eth-pc-ip');
    this.pcMask = document.getElementById('eth-pc-mask');
    this.pcGw = document.getElementById('eth-pc-gw');
    this.arpBody = document.getElementById('eth-arp-body');

    // DOM refs — Right (device tables)
    this.ipconfigBody = document.getElementById('eth-ipconfig-body');
    this.icomBody = document.getElementById('eth-icom-body');

    this._bindEvents();
  }

  _bindEvents() {
    this.adapterSelect?.addEventListener('change', () => this._onAdapterChanged());
    document.getElementById('eth-btn-refresh-pc')?.addEventListener('click', () => this._refreshPcInfo());
    document.getElementById('eth-btn-refresh-arp')?.addEventListener('click', () => this._refreshArp());

    // Bottom bar buttons
    document.getElementById('eth-btn-pull')?.addEventListener('click', () => this._pullCurrentStatus());
    document.getElementById('eth-btn-send')?.addEventListener('click', () => this._applyConfig());
    document.getElementById('eth-btn-save')?.addEventListener('click', () => this._saveConfig());
  }

  async onPageActivated() {
    if (!this._loaded) {
      this._loaded = true;
    }
    this._startListener();
    this._refreshPcInfo();
    this._refreshArp();
    // Auto-pull device status on first activation
    if (!this._firstActivation) {
      this._firstActivation = true;
      this._autoPull();
    }
  }

  async _autoPull() {
    // Small delay to let connection stabilize after page activation
    await new Promise(r => setTimeout(r, 600));
    try {
      await this._pullCurrentStatus();
    } catch (e) {
      // Not connected — silent
    }
  }

  _startListener() {
    if (this._termUnsub) return;
    this._termUnsub = this.api.onTerminalLine((data) => {
      const line = typeof data === 'string' ? data : data?.text || '';
      if (this._listenActive) this._listenBuffer.push(line);
    });
  }

  // --- PC Network Info ---

  async _refreshPcInfo() {
    if (!this.api.getNetworkInfo) return;
    try {
      const result = await this.api.getNetworkInfo();
      if (!result?.ok) return;
      this._parseIpconfig(result.text);
    } catch (e) {
      this._setStatus('Failed to get network info', 'danger');
    }
  }

  _parseIpconfig(text) {
    this._adapters = [];
    const blocks = text.split(/\r?\n\r?\n/);
    let current = null;

    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      for (const line of lines) {
        if (/adapter/i.test(line) && line.endsWith(':')) {
          if (current) this._adapters.push(current);
          // Clean adapter name — remove non-ASCII chars for display
          const rawName = line.replace(/:$/, '').trim();
          current = { name: rawName, cleanName: this._cleanAdapterName(rawName), ip: '', mask: '', gw: '' };
          continue;
        }
        if (!current) continue;
        const kvMatch = line.match(/^\s+(.+?)\s*[\.\:]+\s*:\s*(.+)$/);
        if (!kvMatch) continue;
        const [, key, val] = kvMatch;
        if (/IPv4.*Address/i.test(key) || /IPv4.*Adres/i.test(key)) current.ip = val.replace(/[()]/g, '').trim();
        else if (/Subnet Mask/i.test(key) || /Alt A/i.test(key)) current.mask = val.trim();
        else if (/Default Gateway/i.test(key) || /Varsay/i.test(key)) {
          if (val.trim()) current.gw = val.trim();
        }
      }
    }
    if (current) this._adapters.push(current);

    if (this.adapterSelect) {
      this.adapterSelect.innerHTML = '';
      for (let i = 0; i < this._adapters.length; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = this._adapters[i].cleanName;
        this.adapterSelect.appendChild(opt);
      }
      this._onAdapterChanged();
    }
  }

  _cleanAdapterName(name) {
    // Replace common Turkish ipconfig prefixes and clean non-ASCII artifacts
    return name
      .replace(/Ethernet adapter\s*/i, '')
      .replace(/Kablosuz LAN adapt[oö]r[uü]?\s*/i, 'WiFi: ')
      .replace(/Wireless LAN adapter\s*/i, 'WiFi: ')
      .replace(/[^\x20-\x7E]/g, '') // Remove non-ASCII
      .replace(/\s+/g, ' ')
      .trim() || name;
  }

  _onAdapterChanged() {
    const idx = parseInt(this.adapterSelect?.value) || 0;
    const a = this._adapters[idx];
    if (!a) return;
    if (this.pcIp) this.pcIp.textContent = a.ip || '—';
    if (this.pcMask) this.pcMask.textContent = a.mask || '—';
    if (this.pcGw) this.pcGw.textContent = a.gw || '—';
  }

  // --- ARP Table ---

  async _refreshArp() {
    if (!this.api.getArpTable) return;
    try {
      const result = await this.api.getArpTable();
      if (!result?.ok || !this.arpBody) return;
      this.arpBody.innerHTML = '';
      const lines = result.text.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([\d.]+)\s+([\w-]+)\s+(dynamic|static)/i);
        if (!m) continue;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${m[1]}</td><td>${m[2]}</td><td>${m[3]}</td>`;
        this.arpBody.appendChild(tr);
      }
    } catch {
      this._setStatus('Failed to get ARP table', 'danger');
    }
  }

  // --- Device Status Pull ---

  async _pullCurrentStatus() {
    this._listenActive = true;
    this._listenBuffer = [];
    this._setStatus('Pulling device status...');

    try {
      await new Promise(r => setTimeout(r, 100));
      await this.api.sendCommand('LOG IPCONFIG ONCE');
      await new Promise(r => setTimeout(r, 500));
      await this.api.sendCommand('LOG ICOMCONFIG ONCE');
      // Wait for responses with early exit
      let waited = 0;
      const maxWait = 4000;
      while (waited < maxWait) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
        const hasIp = this._listenBuffer.some(l => /(STATIC|DHCP)/i.test(l));
        const hasIcom = this._listenBuffer.some(l => /ICOM\d+/i.test(l));
        if (hasIp && hasIcom) break;
      }
    } catch (e) {
      this._setStatus(`Pull failed: ${e.message}`, 'danger');
      this._listenActive = false;
      return;
    }

    this._listenActive = false;
    if (this._listenBuffer.length === 0) {
      this._setStatus('No response from device', 'danger');
      return;
    }
    this._parseDeviceLines(this._listenBuffer);
    this._refreshDeviceTables();
    this._refreshOverview();
    this._setStatus('Device status updated', 'success');
  }

  _parseDeviceLines(lines) {
    this._deviceIpRows = [];
    this._deviceIcomRows = [];
    this._deviceBestIp = '';
    this._deviceBestMask = '';
    this._deviceBestGw = '';
    this._deviceBestMode = '';

    for (const line of lines) {
      const trimmed = line.trim();

      // IPCONFIG parse
      const ipMatch = trimmed.match(/(ETHA?\w*)\s*,?\s*(STATIC|DHCP)/i);
      if (ipMatch) {
        const tokens = trimmed.split(/[\s,;]+/);
        const iface = ipMatch[1];
        const mode = ipMatch[2];
        let ip = '', mask = '', gw = '';
        for (const t of tokens) {
          if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) {
            if (!ip) ip = t;
            else if (!mask) mask = t;
            else if (!gw) gw = t;
          }
        }
        this._deviceIpRows.push({ iface, mode, ip, mask, gw });
        if (mode === 'STATIC' && ip) {
          this._deviceBestIp = ip;
          this._deviceBestMask = mask;
          this._deviceBestGw = gw;
          this._deviceBestMode = 'STATIC';
        }
        if (!this._deviceBestIp && ip) {
          this._deviceBestIp = ip;
          this._deviceBestMask = mask;
          this._deviceBestGw = gw;
          this._deviceBestMode = mode;
        }
      }

      // ICOM parse
      const icomMatch = trimmed.match(/(ICOM\d+)\s+TCP\s+:?(\d+)/i);
      if (icomMatch) {
        const afterStr = trimmed.substring(icomMatch.index);
        const inMatch = afterStr.match(/IN[:\s]+(\S+)/i);
        const outMatch = afterStr.match(/OUT[:\s]+(\S+)/i);
        this._deviceIcomRows.push({
          icom: icomMatch[1],
          protocol: 'TCP',
          port: icomMatch[2],
          inMode: inMatch ? inMatch[1].replace(/[,;]/g, '') : '—',
          outMode: outMatch ? outMatch[1].replace(/[,;]/g, '') : '—'
        });
      }
    }

    // Auto-fill device IP fields
    if (this._deviceBestIp && this.devIp) this.devIp.value = this._deviceBestIp;
    if (this._deviceBestMask && this.devMask) this.devMask.value = this._deviceBestMask;
    if (this._deviceBestGw && this.devGw) this.devGw.value = this._deviceBestGw;
  }

  _refreshDeviceTables() {
    // IP Config table
    if (this.ipconfigBody) {
      this.ipconfigBody.innerHTML = '';
      for (const r of this._deviceIpRows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${r.iface}</td><td>${r.mode}</td><td>${r.ip}</td><td>${r.mask}</td><td>${r.gw}</td>`;
        this.ipconfigBody.appendChild(tr);
      }
    }

    // ICOM table
    if (this.icomBody) {
      this.icomBody.innerHTML = '';
      for (const r of this._deviceIcomRows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${r.icom}</td><td>${r.protocol}</td><td>${r.port}</td><td>${r.inMode}</td><td>${r.outMode}</td>`;
        this.icomBody.appendChild(tr);
      }
    }
  }

  _refreshOverview() {
    // Only device-pulled data
    if (this.ovMode) this.ovMode.textContent = this._deviceBestMode || '—';
    if (this.ovIp) this.ovIp.textContent = this._deviceBestIp || '—';
    if (this.ovMask) this.ovMask.textContent = this._deviceBestMask || '—';
    if (this.ovGw) this.ovGw.textContent = this._deviceBestGw || '—';
    if (this.ovIcom) {
      if (this._deviceIcomRows.length > 0) {
        const summary = this._deviceIcomRows.map(r => `${r.icom}:${r.port}`).join(', ');
        this.ovIcom.textContent = summary;
      } else {
        this.ovIcom.textContent = '—';
      }
    }
  }

  // --- Commands ---

  _buildCommands() {
    const cmds = [];
    const iface = this.ifaceSelect?.value || 'ETHA';
    const mode = this.modeSelect?.value || 'STATIC';
    const icom = this.icomSelect?.value || 'ICOM1';
    const port = this.portInput?.value || '3001';
    const ip = this.devIp?.value.trim();
    const mask = this.devMask?.value.trim();
    const gw = this.devGw?.value.trim();

    if (mode === 'STATIC' && ip && mask && gw) {
      cmds.push(`IPCONFIG ${iface} STATIC ${ip} ${mask} ${gw}`);
    } else if (mode === 'DHCP') {
      cmds.push(`IPCONFIG ${iface} DHCP`);
    }

    cmds.push(`ICOMCONFIG ${icom} TCP :${port}`);
    cmds.push(`INTERFACEMODE ${icom} AUTO AUTO`);

    return cmds;
  }

  async _applyConfig() {
    const cmds = this._buildCommands();
    this._setStatus('Applying configuration...');
    try {
      for (const cmd of cmds) {
        await this.api.sendCommand(cmd);
        await new Promise(r => setTimeout(r, 200));
      }
      this._setStatus(`${cmds.length} commands applied — pulling new state...`, 'success');
      // Auto-pull to show updated device status
      await new Promise(r => setTimeout(r, 500));
      await this._pullCurrentStatus();
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

  _setStatus(text, type) {
    if (!this.statusLabel) return;
    this.statusLabel.textContent = text;
    if (type === 'danger') this.statusLabel.style.color = 'var(--danger)';
    else if (type === 'success') this.statusLabel.style.color = 'var(--success)';
    else this.statusLabel.style.color = 'var(--text-muted)';
  }
}
