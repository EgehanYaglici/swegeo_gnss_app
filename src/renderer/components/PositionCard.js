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
        // Load ALL available position sources â€” cached for applyCapabilities() filtering
        const posMessages = await this.api.getMessages('position');
        this._allPosMessages = posMessages.map(msg => ({
            id: msg.id,
            name: msg.name,
            type: msg.type,
            log_command: msg.log_command,
            requires: msg.requires || null,
            device_family: msg.device_family || null,
            cfg_keys: msg.cfg_keys || null,
            cfg_key_uart1: msg.cfg_key_uart1 || msg.cfg_keys?.uart1 || null
        }));

        // Load ALL available heading sources â€” same pattern
        const hdgMessages = await this.api.getMessages('heading');
        this._allHdgMessages = [
            { id: 'NONE', name: 'No Heading', type: 'ascii', log_command: null, requires: null, device_family: null, cfg_keys: null, cfg_key_uart1: null },
            ...hdgMessages.map(msg => ({
                id: msg.id,
                name: msg.name,
                type: msg.type,
                log_command: msg.log_command,
                requires: msg.requires || null,
                device_family: msg.device_family || null,
                cfg_keys: msg.cfg_keys || null,
                cfg_key_uart1: msg.cfg_key_uart1 || msg.cfg_keys?.uart1 || null
            }))
        ];

        // Create SourceSelectors (start with full list; applyCapabilities will filter later)
        this.posSourceSelector = new SourceSelector('pos-source-selector', this._allPosMessages);
        this.hdgSourceSelector = new SourceSelector('hdg-source-selector', this._allHdgMessages);

        // Bind Toggle Click
        this.toggleBtn.onclick = () => this.toggleActive();

        // Default: Select first pos source but stay INACTIVE
        if (this._allPosMessages.length > 0) {
            const first = this._allPosMessages[0];
            this.posSourceSelector.setCurrentSource(first.id, first.name);
            this.currentPosSource = { ...first };
        }

        // Default: Select first hdg source but stay INACTIVE
        if (this._allHdgMessages.length > 0) {
            const first = this._allHdgMessages[0];
            this.hdgSourceSelector.setCurrentSource(first.id, first.name);
            this.currentHdgSource = { ...first };
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

    /**
     * Called by Dashboard when device capabilities are known (or reset on disconnect).
     * Filters source selectors to show only messages appropriate for the connected device family.
     */
    applyCapabilities(caps) {
        this._currentFamily = caps ? caps.family : null;
        const detected = !!(caps && caps.detected);

        // Helper: should a message source be shown for the current device?
        const shouldShow = (msg) => {
            const df = msg.device_family;
            if (!detected) return true;            // Unknown device â€” show all

            // Family filter (NMEA has null family and remains visible)
            if (df != null && df !== this._currentFamily) return false;

            // u-blox: hide NMEA sources without a concrete CFG-MSGOUT key mapping
            if (this._currentFamily === 'ublox' && msg.type === 'nmea' && msg.id !== 'NONE' && !msg.cfg_keys) {
                return false;
            }

            // Capability requirement filter (e.g. ins / dual_ant / rf_monitor)
            if (msg.requires && caps[msg.requires] === false) return false;

            return true;
        };

        // Filter position messages
        const filteredPos = this._allPosMessages.filter(shouldShow);
        this.posSourceSelector.setAvailableMessages(filteredPos);

        // If current selection was filtered out, switch to first available
        if (this.currentPosSource) {
            const still = filteredPos.find(m => String(m.id) === String(this.currentPosSource.id));
            if (!still && filteredPos.length > 0) {
                const first = filteredPos[0];
                this.posSourceSelector.setCurrentSource(first.id, first.name);
                this.currentPosSource = { ...first };
            }
        }

        // Filter heading messages
        const filteredHdg = this._allHdgMessages.filter(shouldShow);
        this.hdgSourceSelector.setAvailableMessages(filteredHdg);

        if (this.currentHdgSource && this.currentHdgSource.id !== 'NONE') {
            const still = filteredHdg.find(m => String(m.id) === String(this.currentHdgSource.id));
            if (!still && filteredHdg.length > 0) {
                const first = filteredHdg[0];
                this.hdgSourceSelector.setCurrentSource(first.id, first.name);
                this.currentHdgSource = { ...first };
            }
        }
    }

    async _handleSourceChange(capability, currentSrc, newMsgId, newMsgName, selectorInstance, setSourceCallback) {
        // 1. Unsubscribe from previous source and conditionally UNLOG / disable UBX
        if (this.isActive && currentSrc && currentSrc.id !== 'NONE') {
            try {
                await this.api.unsubscribe(capability, currentSrc.id, currentSrc.name);
                await this._deactivateSource(currentSrc, capability);
            } catch (e) {
                console.error(`[PositionCard] Error deactivating old ${capability} source:`, e);
            }
        }

        // 2. Resolve the new source object (carry full metadata: type, device_family, cfg_key_uart1)
        const msgObj = selectorInstance.availableMessages.find(m => String(m.id) === String(newMsgId));
        const newSrcResolved = {
            id: newMsgId,
            name: newMsgName,
            log_command: msgObj?.log_command || null,
            type: msgObj?.type || null,
            requires: msgObj?.requires || null,
            device_family: msgObj?.device_family || null,
            cfg_keys: msgObj?.cfg_keys || null,
            cfg_key_uart1: msgObj?.cfg_key_uart1 || null
        };

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

        // 5. Subscribe and activate new source if card is active
        if (this.isActive && newMsgId !== 'NONE') {
            try {
                await this.api.subscribe(capability, newMsgId, newMsgName);
                selectorInstance.startShimmer();
            } catch (e) {
                console.error(`[PositionCard] Error subscribing to ${capability}:`, e);
            }

            try {
                const rateHz = selectorInstance.getCurrentRate() || 1;
                await this._activateSource(newSrcResolved, rateHz);
            } catch (e) {
                console.error(`[PositionCard] Error activating ${capability} source:`, e);
            }
        } else if (newMsgId === 'NONE') {
            selectorInstance.stopShimmer();
            if (capability === 'heading' && this.hdgStatsGrid) {
                this.hdgStatsGrid.style.display = 'none';
            }
        }

        window.dispatchEvent(new Event('log-changed'));
    }

    /** Send the appropriate rate command for a source (UBX CFG-VALSET or BYNAV LOG). */
    async _activateSource(src, rateHz) {
        if (!src || src.id === 'NONE') return;

        const rateDiv = Math.max(1, Math.min(255, Number(rateHz) || 1));
        const isUbloxConfigurable = this._currentFamily === 'ublox' && (src.type === 'ubx' || (src.type === 'nmea' && src.cfg_keys));

        if (isUbloxConfigurable) {
            await this._applyUbxRateForSource(src, rateDiv, 'enable');
        } else if (src.type === 'nmea' && this._currentFamily === 'ublox') {
            // Fallback: keep subscription-only behavior if no cfg_keys exist.
            console.log(`[PositionCard] NMEA on u-blox (no CFG key): ${src.name}`);
        } else {
            // BYNAV ASCII / Binary / NMEA: send LOG command
            const cmdName = this._getCommandName(src);
            if (cmdName) {
                const period = 1.0 / Number(rateHz);
                const logCmd = `LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`;
                console.log(`[PositionCard] Sending LOG: ${logCmd}`);
                await this.api.sendCommand(logCmd);
            }
        }
    }

    /** Send UNLOG or UBX disable for a source. */
    async _deactivateSource(src, capability) {
        if (!src || src.id === 'NONE') return;

        const cmdName = this._getCommandName(src);
        const shouldKeepGGA = await this._shouldKeepGGA(cmdName);

        const isUbloxConfigurable = this._currentFamily === 'ublox' && (src.type === 'ubx' || (src.type === 'nmea' && src.cfg_keys));
        if (isUbloxConfigurable) {
            if (shouldKeepGGA) {
                console.log(`[PositionCard] Keeping ${cmdName} active for NTRIP`);
                return;
            }
            await this._applyUbxRateForSource(src, 0, 'disable');
        } else if (src.type === 'nmea' && this._currentFamily === 'ublox') {
            // Fallback path if a NMEA sentence has no key mapping.
        } else {
            // NTRIP handling â€” keep GGA alive if NTRIP is connected
            if (shouldKeepGGA) {
                console.log(`[PositionCard] Keeping ${cmdName} active for NTRIP`);
            } else if (cmdName) {
                console.log(`[PositionCard] Sending UNLOG: UNLOG ${cmdName}`);
                await this.api.sendCommand(`UNLOG ${cmdName}`);
            }
        }
    }

    async _handleRateChange(currentSrc, rate) {
        try {
            if (currentSrc && currentSrc.id !== 'NONE' && this.isActive) {
                await this._activateSource(currentSrc, rate);
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

    _buildUbxOpsForSource(src, rateDiv) {
        if (!src) return [];
        const cfgKeys = src.cfg_keys || (src.cfg_key_uart1 ? { uart1: src.cfg_key_uart1 } : null);
        if (!cfgKeys) return [];

        const ops = [];
        for (const [port, key] of Object.entries(cfgKeys)) {
            if (key == null) continue;
            ops.push({
                msg: src.name,
                port: String(port).toUpperCase(),
                key,
                rateDiv
            });
        }
        return ops;
    }

    async _applyUbxRateForSource(src, rateDiv, action) {
        const ops = this._buildUbxOpsForSource(src, rateDiv);
        if (ops.length === 0) return;

        try {
            const result = await this.api.applyUbxRates(ops);
            if (!result?.ok) {
                const failed = (result?.results || []).filter(r => !r.ok);
                const summary = failed.slice(0, 2).map(f => `${f.msg}/${f.port}:${f.status}`).join(', ');
                console.warn(`[PositionCard] UBX ${action} partial failure for ${src.name}: ${summary}`);
            } else {
                console.log(`[PositionCard] UBX ${action} confirmed: ${src.name} (${ops.length} port op)`);
            }
        } catch (e) {
            console.error(`[PositionCard] UBX ${action} failed for ${src.name}:`, e);
        }
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
            if (this.currentPosSource && this.currentPosSource.id !== 'NONE') {
                await this.api.subscribe('position', this.currentPosSource.id, this.currentPosSource.name);
                this.posSourceSelector.startShimmer();
                const rateHz = this.posSourceSelector.getCurrentRate() || 1;
                await this._activateSource(this.currentPosSource, rateHz);
            }

            // Activate Heading
            if (this.currentHdgSource && this.currentHdgSource.id !== 'NONE') {
                await this.api.subscribe('heading', this.currentHdgSource.id, this.currentHdgSource.name);
                this.hdgSourceSelector.startShimmer();
                const rateHz = this.hdgSourceSelector.getCurrentRate() || 1;
                await this._activateSource(this.currentHdgSource, rateHz);
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
                await this._deactivateSource(this.currentPosSource, 'position');
            }

            // Deactivate Heading
            if (this.currentHdgSource && this.currentHdgSource.id !== 'NONE') {
                await this.api.unsubscribe('heading', this.currentHdgSource.id, this.currentHdgSource.name);
                this.hdgSourceSelector.stopShimmer();
                await this._deactivateSource(this.currentHdgSource, 'heading');
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
