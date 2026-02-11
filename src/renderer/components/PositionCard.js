// SourceSelector loaded globally


class PositionCard {
    constructor(api) {
        this.api = api;
        this.toggleBtn = document.getElementById('pos-toggle'); // New Toggle
        this.sourceContainer = document.getElementById('pos-source-container'); // Animation container
        this.currentSource = null;
        this.map = null;
        this.marker = null;
        this.lastUpdate = 0;
        this.sourceSelector = null;
        this.isActive = false;

        // SVG Constants
        this.SVG_CHECK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>`;
        this.SVG_CROSS = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>`;

        // NMEA Messages that require GP prefix
        this.NMEA_MESSAGES = new Set(['GGA', 'RMC', 'GLL', 'GNS', 'FPD', 'HPD', 'VTG', 'GSA', 'GSV', 'ZDA']);

        this.init();
    }

    async init() {
        // Load available sources
        const messages = await this.api.getMessages('position');
        const formattedMessages = messages.map(msg => ({
            id: msg.id,
            name: msg.name,
            type: msg.type,
            log_command: msg.log_command
        }));

        // Create SourceSelector
        this.sourceSelector = new SourceSelector('pos-source-selector', formattedMessages);

        // Bind Toggle Click
        this.toggleBtn.onclick = () => this.toggleActive();

        // Default: Select first source but stay INACTIVE
        if (messages.length > 0) {
            const first = messages[0];
            this.sourceSelector.setCurrentSource(first.id, first.name);
            this.currentSource = { id: first.id, name: first.name, log_command: first.log_command };
            // Do NOT subscribe yet
        }

        // Source change handler
        this.sourceSelector.onSourceChanged = async (msgId, msgName) => {
            console.log(`[PositionCard] Source change requested: ${msgName} (${msgId})`);

            // 1. Unsubscribe from previous source and conditionally UNLOG
            if (this.isActive && this.currentSource) {
                try {
                    // Always unsubscribe from UI data flow
                    await this.api.unsubscribe('position', this.currentSource.id, this.currentSource.name);

                    const oldCmdName = this._getCommandName(this.currentSource);

                    // Check if NTRIP is connected - if so, don't UNLOG GGA as it's needed for NTRIP
                    const ntripStatus = await this.api.getNtripStatus();
                    const isGGA = oldCmdName && oldCmdName.toUpperCase().includes('GGA');
                    const shouldKeepGGA = ntripStatus && ntripStatus.connected && isGGA;

                    if (shouldKeepGGA) {
                        console.log(`[PositionCard] Keeping ${oldCmdName} device command active for NTRIP`);
                    } else {
                        const unlogCmd = `UNLOG ${oldCmdName}`;
                        console.log(`[PositionCard] Sending UNLOG: ${unlogCmd}`);
                        await this.api.sendCommand(unlogCmd);
                    }
                } catch (e) {
                    console.error('[PositionCard] Error unlogging old source:', e);
                }
            }

            // 2. Update current source state
            const msgObj = this.sourceSelector.availableMessages.find(m => m.id == msgId);
            this.currentSource = { id: msgId, name: msgName, log_command: msgObj?.log_command };

            // 3. Clear UI (Safe Mode)
            try {
                this.clearData();
            } catch (e) {
                console.warn('[PositionCard] Error clearing data:', e);
            }

            // 4. Activate new source
            if (this.isActive) {
                // Subscribe (Data Flow) — shimmer keeps running until data arrives
                try {
                    await this.api.subscribe('position', msgId, msgName);
                    console.log(`[PositionCard] Subscribed to ${msgName}`);
                } catch (e) {
                    console.error('[PositionCard] Error subscribing:', e);
                }

                // LOG Command (Device Control)
                try {
                    const cmdName = this._getCommandName(this.currentSource);
                    if (cmdName) {
                        const rateHz = this.sourceSelector.getCurrentRate() || 1;
                        const period = 1.0 / Number(rateHz);
                        const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;

                        console.log(`[PositionCard] Sending LOG: ${logCmd}`);
                        await this.api.sendCommand(logCmd);
                    } else {
                        console.error('[PositionCard] Could not determine command name for:', this.currentSource);
                    }
                } catch (e) {
                    console.error('[PositionCard] Error sending LOG command:', e);
                }
            }
        };

        // Rate change handler
        this.sourceSelector.onRateChanged = async (rate) => {
            try {
                if (this.currentSource) {
                    // Use centralized command name logic
                    const cmdName = this._getCommandName(this.currentSource);
                    const period = 1.0 / Number(rate);

                    // User requested UPPERCASE
                    const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;
                    console.log(`Sending rate command: ${logCmd}`);
                    await this.api.sendCommand(logCmd);
                }
            } catch (err) {
                console.error('[PositionCard] Error changing rate:', err);
            }
        };

        // Init Map
        this.initMap();

        // Data Listener
        this.api.onData('position', (data) => this.update(data));
    }

    async toggleActive() {
        this.isActive = !this.isActive;

        if (this.isActive) {
            // Activate
            this.toggleBtn.classList.remove('inactive');
            this.toggleBtn.classList.add('active');
            this.toggleBtn.innerHTML = this.SVG_CHECK;
            this.sourceContainer.classList.add('active'); // Expand selector

            if (this.currentSource) {
                await this.api.subscribe('position', this.currentSource.id, this.currentSource.name);
                this.sourceSelector.startShimmer();

                // Send LOG command to enable this message
                const cmdName = this._getCommandName(this.currentSource);
                const rateHz = this.sourceSelector.getCurrentRate() || 1;
                const period = 1.0 / Number(rateHz);

                // User requested UPPERCASE
                const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;
                console.log(`[PositionCard] Sending LOG command on activate: ${logCmd}`);
                await this.api.sendCommand(logCmd);
            }
        } else {
            // Deactivate
            this.toggleBtn.classList.remove('active');
            this.toggleBtn.classList.add('inactive');
            this.toggleBtn.innerHTML = this.SVG_CROSS;
            this.sourceContainer.classList.remove('active'); // Collapse selector

            if (this.currentSource) {
                await this.api.unsubscribe('position', this.currentSource.id, this.currentSource.name);
                this.sourceSelector.stopShimmer();

                // Explicit UNLOG on deactivate (unless GGA is needed for NTRIP)
                const cmdName = this._getCommandName(this.currentSource);
                const ntripStatus = await this.api.getNtripStatus();
                const isGGA = cmdName && cmdName.toUpperCase().includes('GGA');
                const shouldKeepGGA = ntripStatus && ntripStatus.connected && isGGA;

                if (shouldKeepGGA) {
                    console.log(`[PositionCard] Keeping ${cmdName} active for NTRIP connection (deactivate)`);
                } else {
                    const unlogCmd = `UNLOG ${cmdName}`;
                    console.log(`[PositionCard] Sending UNLOG on deactivate: ${unlogCmd}`);
                    await this.api.sendCommand(unlogCmd);
                }
            }
        }

        // Notify DeviceMonitor of log change
        window.dispatchEvent(new Event('log-changed'));
    }

    async selectSource(msgId, msgName) {
        this.currentSource = { id: msgId, name: msgName };
        await this.api.subscribe('position', msgId, msgName);
    }

    initMap() {
        try {
            this.map = L.map('pos-map', {
                zoomControl: false,
                attributionControl: false,
                dragging: true,
                scrollWheelZoom: true,
            }).setView([39.9, 32.8], 6);

            L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                subdomains: 'abcd',
                maxZoom: 20
            }).addTo(this.map);

            // Fix Leaflet rendering in hidden containers
            setTimeout(() => this.map.invalidateSize(), 500);
        } catch (e) {
            console.warn('Leaflet init failed:', e);
        }
    }

    update(data) {
        const now = performance.now();
        if (now - this.lastUpdate < 100) return; // Throttle to 10 FPS
        this.lastUpdate = now;

        // Extract from normalized object (from message-router)
        const lat = data.latitude;
        const lon = data.longitude;
        const height = data.height || data.altitude;
        const lat_sigma = data.lat_sigma;
        const lon_sigma = data.lon_sigma;
        const hgt_sigma = data.hgt_sigma;

        // Calculate horizontal accuracy (RMS) like legacy app
        let h_accuracy = null;
        if (lat_sigma != null && lon_sigma != null) {
            h_accuracy = Math.sqrt(lat_sigma * lat_sigma + lon_sigma * lon_sigma);
        }

        // Primary Rows (Lat/Lon)
        document.getElementById('pos-lat').textContent = lat != null ? Number(lat).toFixed(8) + '°' : '--';
        document.getElementById('pos-lon').textContent = lon != null ? Number(lon).toFixed(8) + '°' : '--';

        // Secondary Grid (Alt, Accuracies)
        document.getElementById('pos-alt').textContent = height != null ? Number(height).toFixed(2) + ' m' : '--';
        document.getElementById('pos-hacc').textContent = h_accuracy != null ? '±' + Number(h_accuracy).toFixed(3) + ' m' : '--';
        document.getElementById('pos-vacc').textContent = hgt_sigma != null ? '±' + Number(hgt_sigma).toFixed(3) + ' m' : '--';

        // Extra fields (Dynamic Grid)
        const extraDiv = document.getElementById('pos-extra-fields');
        extraDiv.innerHTML = '';
        for (const ef of (data.extra_fields || [])) {
            if (ef.value == null) continue;

            // New Grid Item Structure
            const gridItem = document.createElement('div');
            gridItem.className = 'pos-grid-item';

            const label = document.createElement('span');
            label.className = 'pos-label';
            label.textContent = ef.label;

            const value = document.createElement('span');
            value.className = 'pos-value-secondary';
            value.textContent = this.formatFieldValue(ef);

            gridItem.appendChild(label);
            gridItem.appendChild(value);
            extraDiv.appendChild(gridItem);
        }

        // Update map
        if (this.map && lat != null && lon != null && !isNaN(lat) && !isNaN(lon)) {
            const latlng = [lat, lon];
            if (!this.marker) {
                this.marker = L.circleMarker(latlng, {
                    radius: 6,
                    fillColor: '#3B82F6',
                    fillOpacity: 1,
                    color: '#1D4ED8',
                    weight: 2
                }).addTo(this.map);
                this.map.setView(latlng, 16);
            } else {
                this.marker.setLatLng(latlng);
            }
        }
    }

    clearData() {
        document.getElementById('pos-lat').textContent = '--';
        document.getElementById('pos-lon').textContent = '--';
        document.getElementById('pos-alt').textContent = '--';
        document.getElementById('pos-hacc').textContent = '--';
        document.getElementById('pos-vacc').textContent = '--';
        document.getElementById('pos-grid').innerHTML = '';
        if (this.marker) {
            this.marker.remove();
            this.marker = null;
        }
    }

    formatFieldValue(ef) {
        const val = ef.value;
        if (val == null) return '--';
        const fmt = ef.format || 'str';
        const dec = ef.decimals || 2;
        const unit = ef.unit || '';

        let result;
        switch (fmt) {
            case 'int': result = String(Math.round(Number(val))); break;
            case 'float': case 'coord': result = Number(val).toFixed(dec); break;
            case 'sigma': result = `±${Number(val).toFixed(dec)}`; break;
            default: result = String(val);
        }
        return unit ? `${result} ${unit}` : result;
    }

    _getCommandName(source) {
        if (!source) return null;

        // 1. Explicit log_command from schema
        if (source.log_command) return source.log_command;



        // 2. NMEA Check (Add GP prefix)
        // Check both ID and Name as sometimes they differ
        // SAFETY: Convert to string before upper case to avoid error on numbers
        const lookupName = String(source.name || source.id || '').toUpperCase();
        if (this.NMEA_MESSAGES.has(lookupName)) {
            return `GP${lookupName}`;
        }

        // 3. Fallback to name/id
        return source.name || source.id;
    }
}

// No export needed

