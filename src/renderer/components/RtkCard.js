// RtkCard.js — Dashboard RTK Correction quick-access card
// Shows NTRIP status, data rate, RTCM types. Quick connect profiles.

class RtkCard {
  constructor(ntripPage) {
    console.log('[RtkCard] Constructor called');
    this._ntripPage = ntripPage;

    // Elements - Disconnected State
    this._elDisconnected = document.getElementById('rtk-disconnected');
    this._elProfileList = document.getElementById('rtk-profile-list');
    this._elBtnConnect = document.getElementById('rtk-btn-connect');

    // Elements - Connected State
    this._elDot = document.getElementById('rtk-status-dot');
    this._elConnected = document.getElementById('rtk-connected');
    this._elMount = document.getElementById('rtk-mount');
    this._elHost = document.getElementById('rtk-host');
    this._elRate = document.getElementById('rtk-rate');
    this._elProgressFill = document.getElementById('rtk-progress-fill');
    this._elMsgs = document.getElementById('rtk-msgs');
    this._elDuration = document.getElementById('rtk-duration');
    this._elTypes = document.getElementById('rtk-types');
    this._elBtnDisconnect = document.getElementById('rtk-btn-disconnect');

    this._connected = false;
    this._profiles = [];

    // Check critical elements exist
    console.log('[RtkCard] Elements found:', {
      disconnected: !!this._elDisconnected,
      profileList: !!this._elProfileList,
      btnConnect: !!this._elBtnConnect,
      dot: !!this._elDot,
      connected: !!this._elConnected,
      btnDisconnect: !!this._elBtnDisconnect
    });

    this._bindEvents();
    this._listenNtripEvents();
    this._loadProfiles();
    console.log('[RtkCard] Constructor complete');
  }

  _bindEvents() {
    // "Configure & Connect" button -> navigate to NTRIP page
    if (this._elBtnConnect) {
      this._elBtnConnect.addEventListener('click', () => {
        console.log('[RtkCard] Configure & Connect clicked');
        const ntripBtn = document.querySelector('.nav-btn[data-page="ntrip"]');
        if (ntripBtn) ntripBtn.click();
      });
    }

    // Disconnect button
    if (this._elBtnDisconnect) {
      this._elBtnDisconnect.addEventListener('click', () => {
        console.log('[RtkCard] Disconnect clicked');
        window.api.disconnectNtrip();
      });
    }
  }

  _listenNtripEvents() {
    window.api.onNtripStatus((data) => {
      this._connected = data.connected;
      this._updateView(data);
    });

    window.api.onNtripStats((data) => {
      if (data.connected) {
        this._updateStats(data);
      }
    });
  }

  async _loadProfiles() {
    // Load from saved NTRIP profiles (same source as NTRIP page)
    // These include username & password
    try {
      const allProfiles = await window.api.getNtripProfiles();
      // Show up to 2 most recent profiles for quick connect
      this._profiles = (allProfiles || []).slice(0, 2);
      console.log('[RtkCard] Loaded profiles from NTRIP settings:', this._profiles);
    } catch (err) {
      console.warn('[RtkCard] Failed to load profiles:', err);
      this._profiles = [];
    }
    this._renderProfiles();
  }

  _renderProfiles() {
    if (!this._elProfileList) return;

    console.log('[RtkCard] Rendering profiles, count:', this._profiles.length);

    if (this._profiles.length === 0) {
      this._elProfileList.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:11px;padding:12px">No recent connections</div>';
      return;
    }

    let html = '';
    for (let i = 0; i < this._profiles.length; i++) {
      const profile = this._profiles[i];
      html += `
        <div class="rtk-profile-item" data-index="${i}">
          <div class="rtk-profile-info">
            <div class="rtk-profile-name">${profile.name || profile.mountpoint}</div>
            <div class="rtk-profile-host">${profile.mountpoint} · ${profile.host}:${profile.port}</div>
          </div>
          <div class="rtk-profile-action">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            Connect
          </div>
        </div>
      `;
    }

    this._elProfileList.innerHTML = html;

    // Bind click events to quick connect profile items
    const items = this._elProfileList.querySelectorAll('.rtk-profile-item');
    console.log('[RtkCard] Binding click events to', items.length, 'items');

    items.forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        const profile = this._profiles[index];
        console.log('[RtkCard] Quick connect clicked, profile:', profile);
        if (profile) {
          // Direct connect with this profile's saved credentials
          console.log('[RtkCard] Calling connectNtrip with:', profile);
          window.api.connectNtrip(profile);
        }
      });
    });
  }

  _updateView(data) {
    const connected = data.connected;

    if (this._elDot) {
      this._elDot.className = 'rtk-dot ' + (connected ? 'connected' : 'disconnected');
    }

    if (connected) {
      if (this._elDisconnected) this._elDisconnected.style.display = 'none';
      if (this._elConnected) this._elConnected.style.display = '';
      if (this._elMount) this._elMount.textContent = data.mountpoint || '—';
      if (this._elHost) this._elHost.textContent = data.host || '—';
    } else {
      if (this._elDisconnected) this._elDisconnected.style.display = '';
      if (this._elConnected) this._elConnected.style.display = 'none';
      if (this._elTypes) this._elTypes.innerHTML = '';
      if (this._elProgressFill) this._elProgressFill.style.width = '0%';
    }
  }

  _updateStats(data) {
    const rate = data.dataRate || 0;
    if (this._elRate) {
      this._elRate.textContent = rate > 1024
        ? `${(rate / 1024).toFixed(1)} KB/s`
        : `${rate} B/s`;
    }

    // Update progress bar (0-5KB/s range)
    if (this._elProgressFill) {
      const maxRate = 5120;
      const percentage = Math.min((rate / maxRate) * 100, 100);
      this._elProgressFill.style.width = `${percentage}%`;
    }

    if (this._elMsgs) {
      this._elMsgs.textContent = (data.rtcmMessages || 0).toLocaleString();
    }

    // Duration
    if (this._elDuration) {
      const dur = data.duration || 0;
      const h = Math.floor(dur / 3600);
      const m = Math.floor((dur % 3600) / 60);
      const s = dur % 60;

      if (h > 0) {
        this._elDuration.textContent = `${h}h ${m}m`;
      } else if (m > 0) {
        this._elDuration.textContent = `${m}m ${s}s`;
      } else {
        this._elDuration.textContent = `${s}s`;
      }
    }

    // RTCM type badges
    if (this._elTypes) {
      const types = data.rtcmTypes || {};
      const ids = Object.keys(types).sort((a, b) => parseInt(a) - parseInt(b));
      let html = '';
      for (const id of ids) {
        html += `<span class="rtk-type-badge"><span class="rtk-type-id">${id}</span></span>`;
      }
      this._elTypes.innerHTML = html;
    }
  }
}
