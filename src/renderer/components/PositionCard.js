// SourceSelector loaded globally

class PositionCard {
    constructor(api) {
        this.api = api;
        this.toggleBtn = document.getElementById('pos-toggle');
        this.sourceContainer = document.getElementById('pos-source-container');
        this.hdgSourceContainer = document.getElementById('hdg-source-container');

        this.currentPosSource = null;
        this.currentHdgSource = null;
        this.currentHeading = null; // Store latest heading for map rotation

        this.map = null;
        this.marker = null;
        this.lastUpdate = 0;

        this.posSourceSelector = null;
        this.hdgSourceSelector = null;
        this.isActive = false;

        // SVG Constants
        this.SVG_CHECK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>`;
        this.SVG_CROSS = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>`;

        // NMEA Messages that require GP prefix
        this.NMEA_MESSAGES = new Set(['GGA', 'RMC', 'GLL', 'GNS', 'FPD', 'HPD', 'VTG', 'GSA', 'GSV', 'ZDA', 'HDT']);

        this.init();
    }

    async init() {
        // Load available position sources
        const posMessages = await this.api.getMessages('position');
        const formattedPosMessages = posMessages.map(msg => ({
            id: msg.id,
            name: msg.name,
            type: msg.type,
            log_command: msg.log_command
        }));

        // Load available heading sources
        const hdgMessages = await this.api.getMessages('heading');
        const formattedHdgMessages = [
            { id: 'NONE', name: 'No Heading', type: 'ascii', log_command: null },
            ...hdgMessages.map(msg => ({
                id: msg.id,
                name: msg.name,
                type: msg.type,
                log_command: msg.log_command
            }))
        ];

        // Create SourceSelectors
        this.posSourceSelector = new SourceSelector('pos-source-selector', formattedPosMessages);
        this.hdgSourceSelector = new SourceSelector('hdg-source-selector', formattedHdgMessages);

        // Bind Toggle Click
        this.toggleBtn.onclick = () => this.toggleActive();

        // Default: Select first pos source but stay INACTIVE
        if (posMessages.length > 0) {
            const first = posMessages[0];
            this.posSourceSelector.setCurrentSource(first.id, first.name);
            this.currentPosSource = { id: first.id, name: first.name, log_command: first.log_command };
        }

        // Default: Select first hdg source but stay INACTIVE
        if (formattedHdgMessages.length > 0) {
            const first = formattedHdgMessages[0];
            this.hdgSourceSelector.setCurrentSource(first.id, first.name);
            this.currentHdgSource = { id: first.id, name: first.name, log_command: first.log_command };
        }

        // Position Source change handler
        this.posSourceSelector.onSourceChanged = async (msgId, msgName) => {
            console.log(`[PositionCard] Pos Source change requested: ${msgName} (${msgId})`);
            await this._handleSourceChange('position', this.currentPosSource, msgId, msgName, this.posSourceSelector, (newSrc) => this.currentPosSource = newSrc);
        };

        // Heading Source change handler
        this.hdgSourceSelector.onSourceChanged = async (msgId, msgName) => {
            console.log(`[PositionCard] Hdg Source change requested: ${msgName} (${msgId})`);
            // Reset heading data when source changes
            this.currentHeading = null;
            if (this.marker) {
                this.marker.setIcon(this._createMarkerIcon());
            }
            await this._handleSourceChange('heading', this.currentHdgSource, msgId, msgName, this.hdgSourceSelector, (newSrc) => this.currentHdgSource = newSrc);
        };

        // Rate change handlers
        this.posSourceSelector.onRateChanged = async (rate) => this._handleRateChange(this.currentPosSource, rate);
        this.hdgSourceSelector.onRateChanged = async (rate) => this._handleRateChange(this.currentHdgSource, rate);

        // Init Map
        this.initMap();
        this.hdgStatsGrid = document.getElementById('hdg-stats-grid');
        this.hdgVal = document.getElementById('hdg-val');
        this.hdgPitch = document.getElementById('hdg-pitch');
        this.hdgBaseline = document.getElementById('hdg-baseline');

        // Data Listeners
        this.api.onData('position', (data) => this.updatePosition(data));
        this.api.onData('heading', (data) => this.updateHeading(data));
    }

    async _handleSourceChange(capability, currentSrc, newMsgId, newMsgName, selectorInstance, setSourceCallback) {
        // 1. Unsubscribe from previous source and conditionally UNLOG
        if (this.isActive && currentSrc && currentSrc.id !== 'NONE') {
            try {
                await this.api.unsubscribe(capability, currentSrc.id, currentSrc.name);
                const oldCmdName = this._getCommandName(currentSrc);

                // NTRIP handling only for position (GGA)
                const shouldKeepGGA = await this._shouldKeepGGA(oldCmdName);

                if (shouldKeepGGA) {
                    console.log(`[PositionCard] Keeping ${oldCmdName} device command active for NTRIP`);
                } else if (oldCmdName) {
                    const unlogCmd = `UNLOG ${oldCmdName}`;
                    console.log(`[PositionCard] Sending UNLOG: ${unlogCmd}`);
                    await this.api.sendCommand(unlogCmd);
                }
            } catch (e) {
                console.error(`[PositionCard] Error unlogging old ${capability} source:`, e);
            }
        }

        // 2. Resolve the new source object
        const msgObj = selectorInstance.availableMessages.find(m => m.id == newMsgId);
        const newSrcResolved = { id: newMsgId, name: newMsgName, log_command: msgObj?.log_command };

        // 3. Update current source state via callback
        setSourceCallback(newSrcResolved);

        // 4. Clear UI for position explicitly (Safe Mode)
        if (capability === 'position') {
            try {
                this.clearData();
            } catch (e) {
                console.warn('[PositionCard] Error clearing data:', e);
            }
        }

        // 5. Subscribe and LOG new source if active
        if (this.isActive && newMsgId !== 'NONE') {
            try {
                await this.api.subscribe(capability, newMsgId, newMsgName);
                selectorInstance.startShimmer();
            } catch (e) {
                console.error(`[PositionCard] Error subscribing to ${capability}:`, e);
            }

            try {
                // Must use the freshly resolved source variable to avoid race conditions!
                const cmdName = this._getCommandName(newSrcResolved);
                if (cmdName) {
                    const rateHz = selectorInstance.getCurrentRate() || 1;
                    const period = 1.0 / Number(rateHz);
                    const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;

                    console.log(`[PositionCard] Sending LOG: ${logCmd}`);
                    await this.api.sendCommand(logCmd);
                } else {
                    console.error(`[PositionCard] Could not determine command name for ${capability}:`, newSrcResolved);
                }
            } catch (e) {
                console.error(`[PositionCard] Error sending LOG command for ${capability}:`, e);
            }
        } else if (newMsgId === 'NONE') {
            selectorInstance.stopShimmer();
            if (capability === 'heading' && this.hdgStatsGrid) {
                this.hdgStatsGrid.style.display = 'none';
            }
        }

        window.dispatchEvent(new Event('log-changed'));
    }

    async _handleRateChange(currentSrc, rate) {
        try {
            if (currentSrc) {
                const cmdName = this._getCommandName(currentSrc);
                const period = 1.0 / Number(rate);
                const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;
                console.log(`Sending rate command: ${logCmd}`);
                await this.api.sendCommand(logCmd);
                window.dispatchEvent(new Event('log-changed'));
            }
        } catch (err) {
            console.error('[PositionCard] Error changing rate:', err);
        }
    }

    async _shouldKeepGGA(cmdName) {
        const ntripStatus = await this.api.getNtripStatus();
        const isGGA = cmdName && String(cmdName).toUpperCase().includes('GGA');
        return ntripStatus && ntripStatus.connected && isGGA;
    }

    async toggleActive() {
        this.isActive = !this.isActive;

        if (this.isActive) {
            // Activate
            this.toggleBtn.classList.remove('inactive');
            this.toggleBtn.classList.add('active');
            this.toggleBtn.innerHTML = this.SVG_CHECK;

            if (this.sourceContainer) this.sourceContainer.classList.add('active');
            if (this.hdgSourceContainer) this.hdgSourceContainer.classList.add('active');

            // Activate Position
            if (this.currentPosSource) {
                await this.api.subscribe('position', this.currentPosSource.id, this.currentPosSource.name);
                this.posSourceSelector.startShimmer();

                const cmdName = this._getCommandName(this.currentPosSource);
                const rateHz = this.posSourceSelector.getCurrentRate() || 1;
                const period = 1.0 / Number(rateHz);
                const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;
                console.log(`[PositionCard] Sending LOG command on activate: ${logCmd}`);
                await this.api.sendCommand(logCmd);
            }

            // Activate Heading
            if (this.currentHdgSource && this.currentHdgSource.id !== 'NONE') {
                await this.api.subscribe('heading', this.currentHdgSource.id, this.currentHdgSource.name);
                this.hdgSourceSelector.startShimmer();

                const cmdName = this._getCommandName(this.currentHdgSource);
                const rateHz = this.hdgSourceSelector.getCurrentRate() || 1;
                const period = 1.0 / Number(rateHz);
                const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;
                console.log(`[PositionCard] Sending LOG command on activate: ${logCmd}`);
                await this.api.sendCommand(logCmd);
            }

        } else {
            // Deactivate
            this.toggleBtn.classList.remove('active');
            this.toggleBtn.classList.add('inactive');
            this.toggleBtn.innerHTML = this.SVG_CROSS;

            if (this.sourceContainer) this.sourceContainer.classList.remove('active');
            if (this.hdgSourceContainer) this.hdgSourceContainer.classList.remove('active');

            // Deactivate Position
            if (this.currentPosSource && this.currentPosSource.id !== 'NONE') {
                await this.api.unsubscribe('position', this.currentPosSource.id, this.currentPosSource.name);
                this.posSourceSelector.stopShimmer();

                const cmdName = this._getCommandName(this.currentPosSource);
                const shouldKeepGGA = await this._shouldKeepGGA(cmdName);

                if (shouldKeepGGA) {
                    console.log(`[PositionCard] Keeping ${cmdName} active for NTRIP connection (deactivate)`);
                } else if (cmdName) {
                    const unlogCmd = `UNLOG ${cmdName}`;
                    console.log(`[PositionCard] Sending UNLOG on deactivate: ${unlogCmd}`);
                    await this.api.sendCommand(unlogCmd);
                }
            }

            // Deactivate Heading
            if (this.currentHdgSource && this.currentHdgSource.id !== 'NONE') {
                await this.api.unsubscribe('heading', this.currentHdgSource.id, this.currentHdgSource.name);
                this.hdgSourceSelector.stopShimmer();

                const cmdName = this._getCommandName(this.currentHdgSource);
                if (cmdName) {
                    const unlogCmd = `UNLOG ${cmdName}`;
                    console.log(`[PositionCard] Sending UNLOG on deactivate: ${unlogCmd}`);
                    await this.api.sendCommand(unlogCmd);
                }
            }
        }

        window.dispatchEvent(new Event('log-changed'));
    }

    initMap() {
        try {
            this.map = L.map('pos-map', {
                zoomControl: false,
                attributionControl: false,
                dragging: true,
                scrollWheelZoom: true,
            }).setView([39.9, 32.8], 6);

            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                subdomains: 'abcd',
                maxZoom: 20
            }).addTo(this.map);

            setTimeout(() => this.map.invalidateSize(), 500);

            const mapEl = document.getElementById('pos-map');
            if (mapEl) {
                this._mapResizeObs = new ResizeObserver(() => {
                    if (this.map) this.map.invalidateSize();
                });
                this._mapResizeObs.observe(mapEl);
            }
        } catch (e) {
            console.warn('Leaflet init failed:', e);
        }
    }

    _createMarkerIcon() {
        if (this.currentHeading !== null) {
            // Real physical vehicle standard heading arrow (pointing UP/North by default, rotating)
            const rot = this.currentHeading;
            const iconHtml = `<div class="pos-map-arrow" style="width: 100%; height: 100%; transform: rotate(${rot}deg); transition: transform 0.2s linear; display: flex; align-items: center; justify-content: center;">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="#3B82F6" stroke="#1D4ED8" stroke-width="2" style="transform: translateY(-2px)">
                                    <path d="M12 2L4 20l8-4 8 4L12 2z" stroke-linejoin="round"/>
                                </svg>
                              </div>`;
            return L.divIcon({
                html: iconHtml,
                className: '',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });
        } else {
            // Standard dot
            const iconHtml = `<div style="width: 14px; height: 14px; background: #3B82F6; border: 2px solid #1D4ED8; border-radius: 50%;"></div>`;
            return L.divIcon({
                html: iconHtml,
                className: '',
                iconSize: [14, 14],
                iconAnchor: [7, 7]
            });
        }
    }

    updatePosition(data) {
        const now = performance.now();
        if (now - this.lastUpdate < 100) return;
        this.lastUpdate = now;

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
        this.updateMapMarker(lat, lon);
    }

    updateHeading(data) {
        if (!data) return;

        // Populate Left Panel Heading Stats Grid
        if (this.hdgStatsGrid && data.heading !== undefined) {
            this.hdgStatsGrid.style.display = 'grid'; // display it alongside the position grid

            if (this.hdgVal) {
                this.hdgVal.textContent = data.heading !== null && data.heading !== undefined ? `${data.heading.toFixed(2)}°` : '--';
            }
            if (this.hdgPitch) {
                this.hdgPitch.textContent = data.pitch !== null && data.pitch !== undefined ? `${data.pitch.toFixed(2)}°` : '--';
            }
            if (this.hdgBaseline) {
                this.hdgBaseline.textContent = data.baseline !== null && data.baseline !== undefined ? `${data.baseline.toFixed(3)} m` : '--';
            }
        }

        if (data.heading !== undefined && data.heading !== null) {
            this.currentHeading = data.heading;

            if (this.marker) {
                const el = this.marker.getElement();
                const arrow = el ? el.querySelector('.pos-map-arrow') : null;
                if (arrow) {
                    // Fast CSS update without rebuilding leaflet icon
                    arrow.style.transform = `rotate(${this.currentHeading}deg)`;
                } else {
                    // Need to switch from circle to arrow
                    this.marker.setIcon(this._createMarkerIcon());
                }
            }
        }
    }

    updateMapMarker(lat, lon) {
        if (!this.map || lat == null || lon == null || isNaN(lat) || isNaN(lon)) return;
        const latlng = [lat, lon];

        if (!this.marker) {
            this.marker = L.marker(latlng, { icon: this._createMarkerIcon() }).addTo(this.map);
            this.map.setView(latlng, 16);
        } else {
            this.marker.setLatLng(latlng);
        }
    }

    clearData() {
        document.getElementById('pos-lat').textContent = '--';
        document.getElementById('pos-lon').textContent = '--';
        document.getElementById('pos-alt').textContent = '--';
        document.getElementById('pos-hacc').textContent = '--';
        document.getElementById('pos-vacc').textContent = '--';
        document.getElementById('pos-extra-fields').innerHTML = '';
        if (this.marker) {
            this.marker.remove();
            this.marker = null;
        }
        if (this.hdgStatsGrid) {
            this.hdgStatsGrid.style.display = 'none';
        }
        this.currentHeading = null;
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
        if (!source || source.id === 'NONE') return null;

        if (source.log_command) return source.log_command;

        const lookupName = String(source.name || source.id || '').toUpperCase();
        if (this.NMEA_MESSAGES.has(lookupName)) {
            return `GP${lookupName}`;
        }

        return source.name || source.id;
    }
}
