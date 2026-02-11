class ConnectionDialog {
    constructor(api) {
        this.api = api;
        this.isConnected = false;

        // UI Elements - Updated for title bar button
        this.connectBtn = document.getElementById('btn-connect-titlebar');
        this.dialog = document.getElementById('connect-dialog');
        this.connTabs = document.querySelectorAll('.conn-tab');
        this.connPanels = document.querySelectorAll('.conn-panel');

        this.init();
    }

    init() {
        // Open/Close/Disconnect logic
        this.connectBtn.addEventListener('click', () => {
            if (this.isConnected) {
                this.api.disconnect();
            } else {
                this.show();
                this.refreshPorts();
            }
        });

        // Close on overlay click (click on the dark backdrop, not the modal itself)
        this.dialog.addEventListener('click', (e) => {
            if (e.target === this.dialog) this.hide();
        });

        // Close button (X) and Cancel button
        this.dialog.querySelector('.modal-close')?.addEventListener('click', () => this.hide());
        document.getElementById('btn-cancel-connect')?.addEventListener('click', () => this.hide());

        // Tab switching
        this.connTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this.connTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.connPanels.forEach(p => {
                    p.classList.toggle('active', p.id === `panel-${tab.dataset.conn}`);
                });
            });
        });

        // Refresh ports button
        document.getElementById('btn-refresh-ports')?.addEventListener('click', () => this.refreshPorts());

        // Connect Action
        document.getElementById('btn-do-connect')?.addEventListener('click', () => this.doConnect());

        // Status Listener
        this.api.onConnection((connected) => {
            this.isConnected = connected;
            this.connectBtn.className = `titlebar-connection-btn ${connected ? 'connected' : 'disconnected'}`;
            this.connectBtn.title = connected ? 'Disconnect' : 'Connect';

            // Update status text
            const statusText = this.connectBtn.querySelector('.connection-status-text');
            if (statusText) {
                statusText.textContent = connected ? 'Connected' : 'Disconnected';
            }

            if (connected) this.hide();
        });
    }

    show() {
        this.dialog.style.display = 'flex';
        // Apply blur to app container
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.classList.add('modal-blur');
        }
    }

    hide() {
        this.dialog.style.display = 'none';
        // Remove blur from app container
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.classList.remove('modal-blur');
        }
    }

    async refreshPorts() {
        const portSelect = document.getElementById('serial-port');
        portSelect.innerHTML = '<option value="">Scanning...</option>';
        const ports = await this.api.listPorts();

        if (ports.length === 0) {
            portSelect.innerHTML = '<option value="">No ports found</option>';
        } else {
            portSelect.innerHTML = ports.map(p =>
                `<option value="${p.path}">${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}</option>`
            ).join('');
        }
    }

    async doConnect() {
        const activeTab = document.querySelector('.conn-tab.active')?.dataset.conn || 'serial';
        let params = { type: activeTab };

        if (activeTab === 'serial') {
            params.port = document.getElementById('serial-port').value;
            params.baudrate = parseInt(document.getElementById('serial-baud').value);
            if (!params.port) return;
        } else if (activeTab === 'tcp') {
            params.host = document.getElementById('tcp-host').value;
            params.tcpPort = parseInt(document.getElementById('tcp-port').value);
        } else if (activeTab === 'udp') {
            params.udpPort = parseInt(document.getElementById('udp-listen-port').value);
            params.remoteHost = document.getElementById('udp-remote-host').value;
            params.remotePort = parseInt(document.getElementById('udp-remote-port').value) || undefined;
        }

        const result = await this.api.connect(params);
        if (!result.ok) {
            alert(result.msg);
        }
    }
}

// End ConnectionDialog class

