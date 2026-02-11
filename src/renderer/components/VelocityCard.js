class VelocityCard {
    constructor(api) {
        this.api = api;
        this.cardId = 'velocity-card';
        this.cardElement = document.getElementById(this.cardId);
        this.currentSource = null;
        this.lastUpdate = 0;

        this.init();
    }

    async init() {
        // Inject Source Select if missing (basic header structure assumed)
        let header = this.cardElement.querySelector('.card-header');
        if (!header.querySelector('select')) {
            const select = document.createElement('select');
            select.className = 'source-select';
            select.innerHTML = '<option value="">Select source...</option>';
            header.appendChild(select);
            this.sourceSelect = select;
        } else {
            this.sourceSelect = header.querySelector('select');
        }

        // Replace placeholder body
        const body = this.cardElement.querySelector('.card-body');
        body.innerHTML = `
      <div class="velocity-fields">
        <div class="field-row"><span class="field-label">North</span><span class="field-value" id="vel-north">--</span></div>
        <div class="field-row"><span class="field-label">East</span><span class="field-value" id="vel-east">--</span></div>
        <div class="field-row"><span class="field-label">Up</span><span class="field-value" id="vel-up">--</span></div>
        <div class="field-row"><span class="field-label">Speed 3D</span><span class="field-value" id="vel-3d">--</span></div>
        <div class="field-row"><span class="field-label">Latency</span><span class="field-value" id="vel-latency">--</span></div>
      </div>
    `;
        body.classList.remove('placeholder-body');

        // Load available sources
        const messages = await this.api.getMessages('velocity');
        for (const msg of messages) {
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ id: msg.id, name: msg.name });
            opt.textContent = `${msg.name} (${msg.type})`;
            this.sourceSelect.appendChild(opt);
        }

        // Auto-select
        if (messages.length > 0) {
            this.sourceSelect.selectedIndex = 1;
            this.sourceSelect.dispatchEvent(new Event('change'));
        }

        // Event Listeners
        this.sourceSelect.addEventListener('change', async () => {
            if (this.currentSource) {
                await this.api.unsubscribe('velocity', this.currentSource.id, this.currentSource.name);
            }
            const val = this.sourceSelect.value;
            if (!val) { this.currentSource = null; return; }
            this.currentSource = JSON.parse(val);
            await this.api.subscribe('velocity', this.currentSource.id, this.currentSource.name);
        });

        this.api.onData('velocity', (data) => this.update(data));
    }

    update(data) {
        const now = performance.now();
        if (now - this.lastUpdate < 100) return;
        this.lastUpdate = now;

        const vn = data.north_velocity;
        const ve = data.east_velocity;
        const vu = data.up_velocity;
        const v3d = (vn != null && ve != null && vu != null)
            ? Math.sqrt(vn * vn + ve * ve + vu * vu)
            : null;
        const lat = data.latency;

        document.getElementById('vel-north').textContent = vn != null ? Number(vn).toFixed(3) + ' m/s' : '--';
        document.getElementById('vel-east').textContent = ve != null ? Number(ve).toFixed(3) + ' m/s' : '--';
        document.getElementById('vel-up').textContent = vu != null ? Number(vu).toFixed(3) + ' m/s' : '--';
        document.getElementById('vel-3d').textContent = v3d != null ? Number(v3d).toFixed(3) + ' m/s' : '--';
        document.getElementById('vel-latency').textContent = lat != null ? Number(lat).toFixed(3) + ' s' : '--';
    }
}

// End VelocityCard class

