class UpdatePanel {
    constructor() {
        this.panel = document.getElementById('sidebar-update-panel');
        this.versionText = document.getElementById('update-version');
        this.statusArea = document.getElementById('update-status-area');
        this.statusText = document.getElementById('update-status-text');
        this.progressBar = document.getElementById('update-progress-bar');
        this.progressFill = document.getElementById('update-progress-fill');
        this.actions = document.getElementById('update-actions');
        this.btnDownload = document.getElementById('update-btn-download');
        this.btnInstall = document.getElementById('update-btn-install');
        this.changelogToggle = document.getElementById('update-changelog-toggle');
        this.changelogContent = document.getElementById('update-changelog-content');
        this.changelogText = document.getElementById('update-changelog-text');

        this._state = 'idle'; // idle | checking | available | downloading | ready | error | up-to-date
        this._newVersion = null;

        this.init();
    }

    async init() {
        // Show current version
        try {
            const ver = await api.getAppVersion();
            if (ver) this.versionText.textContent = `v${ver}`;
        } catch { }

        // Listen for updater events from main process
        this._unsub = api.onUpdaterStatus((data) => this._onStatus(data));

        // Button handlers
        this.btnDownload.addEventListener('click', () => this._download());
        this.btnInstall.addEventListener('click', () => this._install());

        // Changelog toggle
        this.changelogToggle.addEventListener('click', () => this._toggleChangelog());
    }

    _onStatus(data) {
        this._state = data.status;

        switch (data.status) {
            case 'checking':
                this._showStatus('Checking for updates...', 'checking');
                this._hideActions();
                this._hideProgress();
                break;

            case 'available':
                this._newVersion = data.version;
                this._showStatus(`Update available: v${data.version}`, 'available');
                this._showActions('download');
                this._hideProgress();
                this.panel.classList.add('has-update');
                // Show changelog toggle
                this.changelogToggle.style.display = '';
                if (data.releaseDate) {
                    const date = new Date(data.releaseDate);
                    const formatted = date.toLocaleDateString('en-US', {
                        year: 'numeric', month: 'short', day: 'numeric'
                    });
                    this.changelogText.textContent = `Version ${data.version} - ${formatted}`;
                }
                break;

            case 'up-to-date':
                this._showStatus('Up to date', 'up-to-date');
                this._hideActions();
                this._hideProgress();
                // Auto-hide after 4 seconds
                setTimeout(() => {
                    if (this._state === 'up-to-date') {
                        this.statusArea.style.display = 'none';
                        this.panel.classList.remove('has-update');
                    }
                }, 4000);
                break;

            case 'downloading':
                const pct = data.percent || 0;
                this._showStatus(`Downloading... ${pct}%`, 'downloading');
                this._hideActions();
                this._showProgress(pct);
                break;

            case 'ready':
                this._showStatus(`v${data.version} ready to install`, 'ready');
                this._showActions('install');
                this._hideProgress();
                this.panel.classList.add('has-update');
                break;

            case 'error':
                this._showStatus(`Update error`, 'error');
                this._hideActions();
                this._hideProgress();
                // Auto-hide error after 6 seconds
                setTimeout(() => {
                    if (this._state === 'error') {
                        this.statusArea.style.display = 'none';
                    }
                }, 6000);
                break;
        }
    }

    _showStatus(text, cls) {
        this.statusArea.style.display = '';
        this.statusText.textContent = text;
        // Update CSS class for color coding
        this.statusText.className = 'update-status-text';
        if (cls) this.statusText.classList.add(`update-status-${cls}`);
    }

    _showActions(mode) {
        this.actions.style.display = '';
        if (mode === 'download') {
            this.btnDownload.style.display = '';
            this.btnInstall.style.display = 'none';
        } else if (mode === 'install') {
            this.btnDownload.style.display = 'none';
            this.btnInstall.style.display = '';
        }
    }

    _hideActions() {
        this.actions.style.display = 'none';
    }

    _showProgress(percent) {
        this.progressBar.style.display = '';
        this.progressFill.style.width = `${percent}%`;
    }

    _hideProgress() {
        this.progressBar.style.display = 'none';
        this.progressFill.style.width = '0%';
    }

    async _download() {
        this.btnDownload.disabled = true;
        this.btnDownload.textContent = 'Starting...';
        try {
            await api.downloadUpdate();
        } catch { }
        this.btnDownload.disabled = false;
        this.btnDownload.textContent = 'Download';
    }

    async _install() {
        this.btnInstall.textContent = 'Restarting...';
        this.btnInstall.disabled = true;
        try {
            await api.installUpdate();
        } catch { }
    }

    _toggleChangelog() {
        const isOpen = this.changelogContent.style.display !== 'none';
        this.changelogContent.style.display = isOpen ? 'none' : '';
        this.changelogToggle.classList.toggle('open', !isOpen);
    }

    destroy() {
        if (this._unsub) this._unsub();
    }
}
