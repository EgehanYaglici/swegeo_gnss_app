class UpdatePanel {
    constructor() {
        this.panel = document.getElementById('sidebar-update-panel');
        this.versionText = document.getElementById('update-version');
        this.checkLink = document.getElementById('update-check-link');
        this.notification = document.getElementById('update-notification');
        this.statusText = document.getElementById('update-status-text');
        this.progressBar = document.getElementById('update-progress-bar');
        this.progressFill = document.getElementById('update-progress-fill');
        this.actions = document.getElementById('update-actions');
        this.btnDownload = document.getElementById('update-btn-download');
        this.btnInstall = document.getElementById('update-btn-install');

        this._checking = false;
        this.init();
    }

    async init() {
        try {
            const ver = await api.getAppVersion();
            if (ver) this.versionText.textContent = `v${ver}`;
        } catch { }

        this._unsub = api.onUpdaterStatus((data) => this._onStatus(data));

        this.checkLink.addEventListener('click', () => this._manualCheck());
        this.btnDownload.addEventListener('click', () => this._download());
        this.btnInstall.addEventListener('click', () => this._install());
    }

    async _manualCheck() {
        if (this._checking) return;
        this._checking = true;
        this.checkLink.classList.add('spinning');
        this.notification.style.display = '';
        this.statusText.textContent = 'Checking...';
        this.statusText.className = 'update-status-text update-status-checking';
        this.actions.style.display = 'none';
        this.progressBar.style.display = 'none';

        try {
            const result = await api.checkForUpdate();
            // If no update found after check, show "up to date" briefly
            if (!result || !result.ok) {
                this.statusText.textContent = 'Up to date';
                this.statusText.className = 'update-status-text update-status-uptodate';
                setTimeout(() => {
                    if (this.statusText.textContent === 'Up to date') {
                        this.notification.style.display = 'none';
                        this.panel.classList.remove('has-update');
                    }
                }, 3000);
            }
        } catch {
            this.notification.style.display = 'none';
        }

        this.checkLink.classList.remove('spinning');
        this._checking = false;
    }

    _onStatus(data) {
        switch (data.status) {
            case 'available':
                this.panel.classList.add('has-update');
                this.notification.style.display = '';
                this.statusText.textContent = `v${data.version} available`;
                this.statusText.className = 'update-status-text update-status-available';
                this.actions.style.display = '';
                this.btnDownload.style.display = '';
                this.btnDownload.disabled = false;
                this.btnDownload.textContent = 'Download';
                this.btnInstall.style.display = 'none';
                this.progressBar.style.display = 'none';
                break;

            case 'downloading': {
                const pct = data.percent || 0;
                this.statusText.textContent = `Downloading... ${pct}%`;
                this.statusText.className = 'update-status-text update-status-downloading';
                this.actions.style.display = 'none';
                this.progressBar.style.display = '';
                this.progressFill.style.width = `${pct}%`;
                break;
            }

            case 'ready':
                this.panel.classList.add('has-update');
                this.statusText.textContent = `v${data.version} ready`;
                this.statusText.className = 'update-status-text update-status-ready';
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
    }
}
