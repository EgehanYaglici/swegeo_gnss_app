// RfHealthCard.js - u-blox RF frontend monitor (UBX-MON-RF)

class RfHealthCard {
  constructor(api) {
    this.api = api;

    this.toggleBtn = document.getElementById('rf-toggle');
    this.sourceContainer = document.getElementById('rf-source-container');
    this.currentSource = null;
    this.sourceSelector = null;
    this.isActive = false;
    this.isUblox = false;
    this._lastUpdateTs = 0;

    this.elJamState = document.getElementById('rf-jam-state');
    this.elAntStatus = document.getElementById('rf-ant-status');
    this.elAntPower = document.getElementById('rf-ant-power');
    this.elUpdateAge = document.getElementById('rf-update-age');

    this.elL1Noise = document.getElementById('rf-l1-noise');
    this.elL1Agc = document.getElementById('rf-l1-agc');
    this.elL1Jam = document.getElementById('rf-l1-jam');
    this.elL1Iq = document.getElementById('rf-l1-iq');

    this.elL2Noise = document.getElementById('rf-l2-noise');
    this.elL2Agc = document.getElementById('rf-l2-agc');
    this.elL2Jam = document.getElementById('rf-l2-jam');
    this.elL2Iq = document.getElementById('rf-l2-iq');

    this.SVG_CHECK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    this.SVG_CROSS = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

    this._ageTimer = setInterval(() => this._renderAge(), 1000);
    this.init();
  }

  async init() {
    const messages = await this.api.getMessages('rf_health');
    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      name: msg.name,
      type: msg.type,
      cfg_keys: msg.cfg_keys || null
    }));

    this.sourceSelector = new SourceSelector('rf-source-selector', formattedMessages);
    if (formattedMessages.length > 0) {
      const first = formattedMessages[0];
      this.currentSource = first;
      this.sourceSelector.setCurrentSource(first.id, first.name);
    }

    if (this.toggleBtn) {
      this.toggleBtn.onclick = () => this.toggleActive();
    }

    if (this.sourceSelector) {
      this.sourceSelector.onSourceChanged = async (msgId, msgName) => {
        const next = this.sourceSelector.availableMessages.find((m) => String(m.id) === String(msgId));
        if (!next) return;

        const wasActive = this.isActive;
        try {
          if (wasActive && this.currentSource) {
            await this.api.unsubscribe('rf_health', this.currentSource.id, this.currentSource.name);
            await this._applyRateForSource(this.currentSource, 0);
          }

          this.currentSource = { ...next, name: msgName };
          this._clearData();

          if (wasActive) {
            await this.api.subscribe('rf_health', this.currentSource.id, this.currentSource.name);
            await this._applyRateForSource(this.currentSource, this._rateToDiv(this.sourceSelector.getCurrentRate()));
            this.sourceSelector.startShimmer();
          }
        } catch (e) {
          console.error('[RfHealthCard] source switch failed:', e);
        }

        window.dispatchEvent(new Event('log-changed'));
      };

      this.sourceSelector.onRateChanged = async (rate) => {
        if (!this.isActive || !this.currentSource) return;
        try {
          await this._applyRateForSource(this.currentSource, this._rateToDiv(rate));
        } catch (e) {
          console.error('[RfHealthCard] rate update failed:', e);
        }
        window.dispatchEvent(new Event('log-changed'));
      };
    }

    this.api.onData('rf_health', (data) => this._update(data));
    this._clearData();
  }

  async toggleActive() {
    if (!this.currentSource) return;
    if (!this.isActive && !this.isUblox) return;

    this.isActive = !this.isActive;
    try {
      if (this.isActive) {
        this._setToggleState(true);
        await this.api.subscribe('rf_health', this.currentSource.id, this.currentSource.name);
        await this._applyRateForSource(this.currentSource, this._rateToDiv(this.sourceSelector.getCurrentRate()));
        this.sourceSelector.startShimmer();
      } else {
        this._setToggleState(false);
        await this.api.unsubscribe('rf_health', this.currentSource.id, this.currentSource.name);
        await this._applyRateForSource(this.currentSource, 0);
        this.sourceSelector.stopShimmer();
        this._clearData();
      }
    } catch (e) {
      console.error('[RfHealthCard] toggleActive failed:', e);
    }

    window.dispatchEvent(new Event('log-changed'));
  }

  applyCapabilities(caps) {
    const ubxRf = caps?.detected === true &&
      caps?.family === 'ublox' &&
      caps?.rf_monitor === true &&
      caps?.ins !== true;
    this.isUblox = ubxRf;

    if (!this.isUblox && this.isActive) {
      this.toggleActive().catch(() => {});
    }
  }

  _rateToDiv(rate) {
    const n = Number(rate);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.max(1, Math.min(255, Math.round(n)));
  }

  async _applyRateForSource(source, rateDiv) {
    if (!source?.cfg_keys) return { ok: false, msg: 'No cfg_keys' };
    const ops = [];
    for (const [port, key] of Object.entries(source.cfg_keys)) {
      const keyNum = Number(key);
      if (!Number.isFinite(keyNum) || keyNum <= 0) continue;
      ops.push({
        msg: source.name,
        port: String(port).toUpperCase(),
        key: keyNum,
        rateDiv: Number(rateDiv) || 0
      });
    }
    if (ops.length === 0) return { ok: false, msg: 'No valid cfg keys' };
    return this.api.applyUbxRates(ops);
  }

  _jamStateLabel(flagsValue) {
    const jamState = Number(flagsValue || 0) & 0x03;
    if (jamState === 1) return { text: 'OK', cls: 'ok' };
    if (jamState === 2) return { text: 'Warning', cls: 'warn' };
    if (jamState === 3) return { text: 'Critical', cls: 'crit' };
    return { text: 'Unknown', cls: 'unknown' };
  }

  _antStatusLabel(v) {
    const map = {
      0: 'INIT',
      1: 'DONTKNOW',
      2: 'OK',
      3: 'SHORT',
      4: 'OPEN'
    };
    return map[Number(v)] || 'UNKNOWN';
  }

  _antPowerLabel(v) {
    const map = {
      0: 'OFF',
      1: 'ON',
      2: 'DONTKNOW'
    };
    return map[Number(v)] || 'UNKNOWN';
  }

  _setChip(el, text, stateClass) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('rf-chip-ok', 'rf-chip-warn', 'rf-chip-crit', 'rf-chip-unknown');
    el.classList.add(`rf-chip-${stateClass || 'unknown'}`);
  }

  _fmt(v, suffix = '') {
    if (v == null || !Number.isFinite(Number(v))) return '--';
    return `${Number(v)}${suffix}`;
  }

  _update(data) {
    if (!data || !this.isActive) return;

    const raw = data.raw_fields || {};
    const jam = this._jamStateLabel(raw.block0_flags);
    this._setChip(this.elJamState, jam.text, jam.cls);
    this._setChip(this.elAntStatus, this._antStatusLabel(raw.block0_antStatus), 'unknown');
    this._setChip(this.elAntPower, this._antPowerLabel(raw.block0_antPower), 'unknown');

    if (this.elL1Noise) this.elL1Noise.textContent = this._fmt(raw.block0_noisePerMS);
    if (this.elL1Agc) this.elL1Agc.textContent = this._fmt(raw.block0_agcCnt);
    if (this.elL1Jam) this.elL1Jam.textContent = this._fmt(raw.block0_jamInd);
    if (this.elL1Iq) this.elL1Iq.textContent = `${this._fmt(raw.block0_ofsI)}/${this._fmt(raw.block0_ofsQ)}`;

    const hasSecond = Number(raw.nBlocks || 0) > 1;
    if (this.elL2Noise) this.elL2Noise.textContent = hasSecond ? this._fmt(raw.block1_noisePerMS) : '--';
    if (this.elL2Agc) this.elL2Agc.textContent = hasSecond ? this._fmt(raw.block1_agcCnt) : '--';
    if (this.elL2Jam) this.elL2Jam.textContent = hasSecond ? this._fmt(raw.block1_jamInd) : '--';
    if (this.elL2Iq) this.elL2Iq.textContent = hasSecond
      ? `${this._fmt(raw.block1_ofsI)}/${this._fmt(raw.block1_ofsQ)}`
      : '--';

    this._lastUpdateTs = Date.now();
    this._renderAge();
  }

  _renderAge() {
    if (!this.elUpdateAge) return;
    if (!this._lastUpdateTs) {
      this.elUpdateAge.textContent = '--';
      return;
    }
    const deltaSec = Math.max(0, Math.floor((Date.now() - this._lastUpdateTs) / 1000));
    this.elUpdateAge.textContent = `${deltaSec}s`;
  }

  _setToggleState(active) {
    if (!this.toggleBtn) return;
    this.toggleBtn.classList.toggle('active', active);
    this.toggleBtn.classList.toggle('inactive', !active);
    this.toggleBtn.innerHTML = active ? this.SVG_CHECK : this.SVG_CROSS;
    if (this.sourceContainer) {
      this.sourceContainer.classList.toggle('active', active);
    }
  }

  _clearData() {
    this._setChip(this.elJamState, '--', 'unknown');
    this._setChip(this.elAntStatus, '--', 'unknown');
    this._setChip(this.elAntPower, '--', 'unknown');
    if (this.elL1Noise) this.elL1Noise.textContent = '--';
    if (this.elL1Agc) this.elL1Agc.textContent = '--';
    if (this.elL1Jam) this.elL1Jam.textContent = '--';
    if (this.elL1Iq) this.elL1Iq.textContent = '--';
    if (this.elL2Noise) this.elL2Noise.textContent = '--';
    if (this.elL2Agc) this.elL2Agc.textContent = '--';
    if (this.elL2Jam) this.elL2Jam.textContent = '--';
    if (this.elL2Iq) this.elL2Iq.textContent = '--';
    this._lastUpdateTs = 0;
    this._renderAge();
  }
}

// End RfHealthCard class
