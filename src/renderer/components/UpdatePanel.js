class UpdatePanel {
    constructor() {
        this.panel = document.getElementById('sidebar-update-panel');
        this.versionText = document.getElementById('update-version');
        this.btn = document.getElementById('update-check-btn');
        this.label = document.getElementById('update-check-label');
        this.expand = document.getElementById('update-expand');
        this.progressBar = document.getElementById('update-progress-bar');
        this.progressFill = document.getElementById('update-progress-fill');
        this.actions = document.getElementById('update-actions');
        this.btnDownload = document.getElementById('update-btn-download');
        this.btnInstall = document.getElementById('update-btn-install');

        this._checking = false;
        this._revertTimer = null;
        this._state = 'idle'; // idle | checking | uptodate | available | downloading | ready
        this.init();
    }

    async init() {
        try {
            const ver = await api.getAppVersion();
            if (ver) this.versionText.textContent = `v${ver}`;
        } catch { }

        this._unsub = api.onUpdaterStatus((data) => this._onStatus(data));

        this.btn.addEventListener('click', () => this._manualCheck());
        this.btnDownload.addEventListener('click', () => this._download());
        this.btnInstall.addEventListener('click', () => this._install());
    }

    // Animate button label text change with crossfade
    _setLabel(text, btnClass) {
        this.label.classList.add('fade');
        setTimeout(() => {
            this.label.textContent = text;
            this.btn.className = 'update-check-btn' + (btnClass ? ' ' + btnClass : '');
            this.label.classList.remove('fade');
        }, 250);
    }

    // Revert button to default state after delay
    _scheduleRevert(delay) {
        if (this._revertTimer) clearTimeout(this._revertTimer);
        this._revertTimer = setTimeout(() => {
            this._setLabel('Check for Updates', '');
            this.btn.disabled = false;
            this._state = 'idle';
            this._revertTimer = null;
        }, delay);
    }

    async _manualCheck() {
        if (this._checking || this._state === 'available' || this._state === 'downloading' || this._state === 'ready') return;
        this._checking = true;
        if (this._revertTimer) { clearTimeout(this._revertTimer); this._revertTimer = null; }

        this._state = 'checking';
        this._setLabel('Checking...', 'checking');
        this.btn.disabled = true;

        // Timeout: 15 saniye içinde cevap gelmezse idle'a dön
        const checkTimeout = setTimeout(() => {
            if (this._state === 'checking') {
                this._setLabel('Check for Updates', '');
                this.btn.disabled = false;
                this._state = 'idle';
                this._checking = false;
            }
        }, 15000);

        try {
            const result = await api.checkForUpdate();
            // result.ok false ise (dev mode, hata vs) idle'a dön
            if (result && !result.ok) {
                if (this._state === 'checking') {
                    this._setLabel('Check for Updates', '');
                    this._state = 'idle';
                }
            } else {
                // Güncelleme varsa _onStatus('available') event'i gelir, state değişir
                // Yoksa burada "up to date" göster
                if (this._state === 'checking') {
                    this._state = 'uptodate';
                    this._setLabel('Up to date ✓', 'uptodate');
                    this._scheduleRevert(3000);
                }
            }
        } catch {
            if (this._state === 'checking') {
                this._setLabel('Check for Updates', '');
                this._state = 'idle';
            }
        } finally {
            clearTimeout(checkTimeout);
            this.btn.disabled = (this._state === 'available' || this._state === 'downloading' || this._state === 'ready');
            this._checking = false;
        }
    }

    _onStatus(data) {
        if (this._revertTimer) { clearTimeout(this._revertTimer); this._revertTimer = null; }

        switch (data.status) {
            case 'available':
                this._state = 'available';
                this._setLabel(`New version available — v${data.version}`, 'available');
                this.btn.disabled = true;
                this.expand.classList.add('visible');
                this.actions.style.display = '';
                this.btnDownload.style.display = '';
                this.btnDownload.disabled = false;
                this.btnDownload.textContent = 'Download';
                this.btnInstall.style.display = 'none';
                this.progressBar.style.display = 'none';
                break;

            case 'downloading': {
                const pct = data.percent || 0;
                this._state = 'downloading';
                this.label.textContent = `Downloading... ${pct}%`;
                this.btn.className = 'update-check-btn downloading';
                this.btn.disabled = true;
                this.actions.style.display = 'none';
                this.progressBar.style.display = '';
                this.progressFill.style.width = `${pct}%`;
                break;
            }

            case 'ready':
                this._state = 'ready';
                this._setLabel(`v${data.version} ready to install`, 'ready');
                this.btn.disabled = true;
                this.progressBar.style.display = 'none';
                this.actions.style.display = '';
                this.btnDownload.style.display = 'none';
                this.btnInstall.style.display = '';
                this.btnInstall.disabled = false;
                this.btnInstall.textContent = 'Restart & Update';
                break;
        }
    }

    async _download() {
        this.btnDownload.disabled = true;
        this.btnDownload.textContent = 'Starting...';
        try { await api.downloadUpdate(); } catch { }
    }

    async _install() {
        this.btnInstall.disabled = true;
        this.btnInstall.textContent = 'Restarting...';
        try { await api.installUpdate(); } catch { }
    }

    destroy() {
        if (this._unsub) this._unsub();
        if (this._revertTimer) clearTimeout(this._revertTimer);
    }
}
