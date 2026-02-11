class SatelliteCard {
    constructor(api) {
        this.api = api;
        this.toggleBtn = document.getElementById('sat-toggle');
        this.sourceContainer = document.getElementById('sat-source-container');
        this.canvas = document.getElementById('skyplot');
        this.ctx = this.canvas.getContext('2d');
        this.statsDiv = document.getElementById('sat-stats');

        this.currentSources = [];
        this.satellites = {};

        // Active Satellite Cache (for GSA aggregation)
        // { "CONST_PRN": timestamp }
        this.activeSatellitesCache = new Map();

        this.lastDraw = 0;
        this.sourceSelector = null;
        this.isActive = false;

        this.hiddenConstellations = new Set();
        this.hoveredSat = null;
        this.tooltip = null;

        this.CONSTELLATION_COLORS = {
            'GPS': '#10B981',      // Green
            'GLONASS': '#EF4444',  // Red
            'Galileo': '#FFBE00',  // Yellow
            'BeiDou': '#3B82F6',   // Blue
            'QZSS': '#8B5CF6',     // Purple
            'IRNSS': '#EC4899',    // Pink
            'SBAS': '#6B7280',     // Gray
            'Unknown': '#9CA3AF'   // Light Gray
        };

        this.DEFAULT_CONSTELLATIONS = ['GPS', 'GLONASS', 'Galileo', 'BeiDou', 'QZSS', 'IRNSS', 'SBAS'];

        this.SVG_CHECK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>`;
        this.SVG_CROSS = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>`;

        // Modern Satellite Icon (same as skyplot satellite_modern.svg)
        this.SVG_MODERN_SAT_FILLED = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g transform="rotate(-45 12 12)"><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/><path d="M2 10H8V14H2C1.44772 14 1 13.5523 1 13V11C1 10.4477 1.44772 10 2 10Z" fill="currentColor"/><path d="M16 10H22C22.5523 10 23 10.4477 23 11V13C23 13.5523 22.5523 14 22 14H16V10Z" fill="currentColor"/><rect x="3" y="11" width="2" height="2" rx="0.5" fill="white" fill-opacity="0.4"/><rect x="5.5" y="11" width="2" height="2" rx="0.5" fill="white" fill-opacity="0.4"/><rect x="16.5" y="11" width="2" height="2" rx="0.5" fill="white" fill-opacity="0.4"/><rect x="19" y="11" width="2" height="2" rx="0.5" fill="white" fill-opacity="0.4"/><rect x="11" y="15" width="2" height="2" fill="currentColor"/><path d="M8.5 17C8.5 17 9.5 19.5 12 19.5C14.5 19.5 15.5 17 15.5 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18" r="1" fill="currentColor"/></g></svg>`;

        // Icon Cache: color -> Image
        this.iconCache = new Map();
        this.baseSvgContent = null;
        this.loadIcons();

        this.init();
    }

    async loadIcons() {
        try {
            const response = await fetch('../../assets/icons/satellite_modern.svg');
            if (response.ok) {
                this.baseSvgContent = await response.text();
            } else {
                console.error("Failed to load satellite icon assets");
            }
        } catch (e) {
            console.error("Error loading satellite icon:", e);
        }
    }

    getTintedIcon(color) {
        if (!this.baseSvgContent) return null;
        // Check cache
        if (this.iconCache.has(color)) return this.iconCache.get(color);

        // Replace currentColor with the hex color
        const tintedSvg = this.baseSvgContent.split('currentColor').join(color);

        const blob = new Blob([tintedSvg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;

        // Cache it immediately
        this.iconCache.set(color, img);
        return img;
    }

    async init() {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'sat-tooltip';
        document.body.appendChild(this.tooltip);

        const messages = await this.api.getMessages('satellites');
        const formattedMessages = messages.map(msg => ({
            id: msg.id,
            name: msg.name,
            type: msg.type
        }));

        this.sourceSelector = new SourceSelector('sat-source-selector', formattedMessages, { multiSelect: true });
        this.toggleBtn.onclick = () => this.toggleActive();

        // Default label
        if (messages.length > 0) {
            this.sourceSelector.label.textContent = 'Select Source';
        }

        // Multi-select: individual source toggle from dropdown
        this.sourceSelector.onSourceToggled = async (msgId, msgName, isNowActive) => {
            if (isNowActive) {
                await this._activateSource(msgId, msgName);
            } else {
                await this._deactivateSource(msgId, msgName);
            }
            // Update main toggle state based on active sources
            this._syncToggleState();
        };

        this.api.onData('satellites', (data) => this.onData(data));

        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseleave', () => {
            this.hoveredSat = null;
            this.tooltip.classList.remove('visible');
            this.drawSkyplot();
        });

        // Initialize empty stats grid immediately for layout stability
        this.updateStats();
        this.drawSkyplot();
    }

    async toggleActive() {
        const availableMessages = this.sourceSelector.availableMessages;
        const hasAnySources = this.sourceSelector.activeSources.size > 0;

        if (!hasAnySources) {
            // Nothing active → activate ALL
            this.isActive = true;

            // Clear old data
            this.satellites = {};
            this.activeSatellitesCache.clear();
            this.updateStats();
            this.drawSkyplot();

            this.toggleBtn.classList.remove('inactive');
            this.toggleBtn.classList.add('active');
            this.toggleBtn.innerHTML = this.SVG_CHECK;
            this.sourceContainer.classList.add('active');

            // Activate all sources
            this.sourceSelector.activateAll();
            this.sourceSelector.startShimmer();

            for (const msg of availableMessages) {
                await this._activateSource(msg.id, msg.name);
            }
        } else {
            // Has active sources → deactivate ALL
            this.isActive = false;

            // Deactivate all active sources
            const activeCopy = [...this.sourceSelector.activeSources];
            for (const msgId of activeCopy) {
                const msg = availableMessages.find(m => m.id === msgId);
                if (msg) await this._deactivateSource(msg.id, msg.name);
            }

            this.sourceSelector.deactivateAll();
            this.sourceSelector.stopShimmer();

            this.toggleBtn.classList.remove('active');
            this.toggleBtn.classList.add('inactive');
            this.toggleBtn.innerHTML = this.SVG_CROSS;
            this.sourceContainer.classList.remove('active');

            // Clear data
            this.satellites = {};
            this.activeSatellitesCache.clear();
            this.updateStats();
            this.drawSkyplot();
        }

        // Notify DeviceMonitor of log change
        window.dispatchEvent(new Event('log-changed'));
    }

    async _activateSource(msgId, msgName) {
        await this.api.subscribe('satellites', msgId, msgName);
        const isNmea = ['GGA', 'RMC', 'GLL', 'GNS', 'VTG', 'GSA', 'GSV', 'ZDA'].includes(msgName);
        const cmdName = isNmea ? `GP${msgName}` : msgName;
        console.log(`[SatelliteCard] Activating ${msgName}`);
        await this.api.sendCommand(`LOG ${cmdName} ONTIME 1`);
    }

    async _deactivateSource(msgId, msgName) {
        await this.api.unsubscribe('satellites', msgId, msgName);
        const isNmea = ['GGA', 'RMC', 'GLL', 'GNS', 'VTG', 'GSA', 'GSV', 'ZDA'].includes(msgName);
        const cmdName = isNmea ? `GP${msgName}` : msgName;
        console.log(`[SatelliteCard] Deactivating ${msgName}`);
        await this.api.sendCommand(`UNLOG ${cmdName}`);
    }

    _syncToggleState() {
        const hasActive = this.sourceSelector.activeSources.size > 0;
        this.isActive = hasActive;

        if (hasActive) {
            this.toggleBtn.classList.remove('inactive');
            this.toggleBtn.classList.add('active');
            this.toggleBtn.innerHTML = this.SVG_CHECK;
            this.sourceContainer.classList.add('active');
            this.sourceSelector.startShimmer();
        } else {
            this.toggleBtn.classList.remove('active');
            this.toggleBtn.classList.add('inactive');
            this.toggleBtn.innerHTML = this.SVG_CROSS;
            this.sourceContainer.classList.remove('active');
            this.sourceSelector.stopShimmer();

            // Clear data when no sources active
            this.satellites = {};
            this.activeSatellitesCache.clear();
            this.updateStats();
            this.drawSkyplot();
        }
    }

    onData(data) {
        if (!this.isActive) return;

        const rawFields = data.raw_fields || {};
        const sourceName = data.source_name || '';

        if (sourceName.includes('GSV') || rawFields.msg_type === 'GSV') {
            this.processGSV(rawFields, data);
        }
        if (sourceName.includes('GSA') || rawFields.msg_type === 'GSA') {
            this.processGSA(rawFields, sourceName);
        }

        const now = performance.now();
        if (now - this.lastDraw > 150) {
            this.lastDraw = now;
            requestAnimationFrame(() => {
                this._cleanupCache();
                this._syncActiveStatus();
                this.drawSkyplot();
                this.updateStats();
            });
        }
    }

    _cleanupCache() {
        const now = Date.now();
        const TTL = 3000; // 3 seconds TTL

        for (const [key, sat] of Object.entries(this.satellites)) {
            if (now - sat.lastSeen > TTL) delete this.satellites[key];
        }
        for (const [key, ts] of this.activeSatellitesCache.entries()) {
            if (now - ts > TTL) this.activeSatellitesCache.delete(key);
        }
    }

    _syncActiveStatus() {
        for (const sat of Object.values(this.satellites)) {
            const uniqueKey = `${sat.constellation}_${sat.prn}`;
            sat.active = this.activeSatellitesCache.has(uniqueKey);
        }
    }

    processGSV(fields, data) {
        const sourceName = data.source_name || '';
        let talker = fields.talker;

        if (!talker && sourceName.length >= 2) {
            talker = sourceName.substring(0, 2);
        }
        if (!talker) talker = 'GN';

        const constMap = {
            'GP': 'GPS', 'GL': 'GLONASS', 'GA': 'Galileo',
            'GB': 'BeiDou', 'BD': 'BeiDou', 'GQ': 'QZSS', 'GI': 'IRNSS'
        };

        for (let i = 1; i <= 4; i++) {
            const prnStr = fields[`prn_${i}`] || fields[`sv_prn_${i}`] || fields[`satellite_prn_${i}`];
            if (!prnStr) continue;

            const prn = parseInt(prnStr);
            if (isNaN(prn) || prn === 0) continue;

            const el = parseFloat(fields[`elevation_${i}`] || fields[`elev_${i}`] || 0);
            const az = parseFloat(fields[`azimuth_${i}`] || fields[`az_${i}`] || 0);
            const snr = parseFloat(fields[`snr_${i}`] || fields[`cn0_${i}`] || 0);

            // Skip satellites with no signal at all
            if (snr === 0 && el === 0 && az === 0) continue;

            let constellation = constMap[talker];
            if (!constellation || talker === 'GN') {
                constellation = this.getConstellationFromPRN(prn);
            }

            const uniqueKey = `${constellation}_${prn}`;
            // Satellites with SNR but no position (el=0, az=0) are tracked for counts
            // but flagged so skyplot can skip drawing them
            const hasPosition = !(el === 0 && az === 0);

            this.satellites[uniqueKey] = {
                prn: prn,
                az: az,
                el: el,
                snr: snr,
                constellation: constellation,
                active: false,
                hasPosition: hasPosition,
                lastSeen: Date.now()
            };
        }
    }

    processGSA(fields, sourceName = '') {
        let targetConstellation = null;

        const sysId = fields.gnss_id || fields.system_id;
        if (sysId) {
            const map = { '1': 'GPS', '2': 'GLONASS', '3': 'Galileo', '4': 'BeiDou', '5': 'QZSS', '6': 'IRNSS' };
            targetConstellation = map[sysId];
        }

        if (!targetConstellation) {
            let talker = fields.talker;
            if (!talker && sourceName.length >= 2) talker = sourceName.substring(0, 2);

            if (talker === 'GL') targetConstellation = "GLONASS";
            else if (talker === 'GA') targetConstellation = "Galileo";
            else if (talker === 'GB' || talker === 'BD') targetConstellation = "BeiDou";
            else if (talker === 'GQ') targetConstellation = "QZSS";
            else if (talker === 'GI') targetConstellation = "IRNSS";
            else if (talker === 'GP') targetConstellation = "GPS";
        }

        if (!targetConstellation) {
            if (sourceName.startsWith('GL')) targetConstellation = "GLONASS";
            else if (sourceName.startsWith('GA')) targetConstellation = "Galileo";
            else if (sourceName.startsWith('GB') || sourceName.startsWith('BD')) targetConstellation = "BeiDou";
            else if (sourceName.startsWith('GP')) targetConstellation = "GPS";
            else if (sourceName.includes('_GLO')) targetConstellation = "GLONASS";
            else if (sourceName.includes('_GAL')) targetConstellation = "Galileo";
            else if (sourceName.includes('_BDS')) targetConstellation = "BeiDou";
        }

        if (!targetConstellation) targetConstellation = "GPS";

        const now = Date.now();
        for (let i = 1; i <= 12; i++) {
            const prnStr = fields[`sv_id_${i}`] || fields[`prn_${i}`] || fields[`sv${i}`];
            if (!prnStr) continue;

            const prn = parseInt(prnStr);
            if (isNaN(prn) || prn === 0) continue;

            let prnConst = targetConstellation;
            if (sourceName.startsWith('GN') && !sysId) {
                prnConst = this.getConstellationFromPRN(prn);
            }

            const uniqueKey = `${prnConst}_${prn}`;
            this.activeSatellitesCache.set(uniqueKey, now);
        }
    }

    getConstellationFromPRN(prn) {
        if (prn >= 1 && prn <= 32) return 'GPS';
        if (prn >= 65 && prn <= 96) return 'GLONASS';
        if ((prn >= 120 && prn <= 158) || (prn >= 183 && prn <= 192)) return 'SBAS';
        if (prn >= 193 && prn <= 202) return 'QZSS';
        if (prn >= 201 && prn <= 236) return 'Galileo';
        if (prn >= 401 && prn <= 437) return 'BeiDou';
        return 'Unknown';
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const logicalMouseX = e.clientX - rect.left;
        const logicalMouseY = e.clientY - rect.top;

        const w = this.canvas.width;
        const h = this.canvas.height;
        const dpr = window.devicePixelRatio || 1;

        const cx = (w / dpr) / 2;
        const cy = (h / dpr) / 2;
        const r = Math.min(cx, cy) - 25;

        let found = null;
        const sortedSats = Object.values(this.satellites)
            .filter(s => !this.hiddenConstellations.has(s.constellation) && s.hasPosition !== false)
            .sort((a, b) => (a.active === b.active) ? b.snr - a.snr : (a.active ? -1 : 1));

        for (const sat of sortedSats) {
            const elRad = (90 - sat.el) / 90 * r;
            const azRad = (sat.az - 90) * Math.PI / 180;
            const sx = cx + elRad * Math.cos(azRad);
            const sy = cy + elRad * Math.sin(azRad);

            // Approximate hit test for the icon
            let scale = sat.snr > 30 ? 0.8 : (sat.snr > 20 ? 0.7 : 0.6);
            if (this.hoveredSat && this.hoveredSat.prn === sat.prn) scale *= 1.2;
            const hitRadius = (12 * scale); // Half of 24x24 icon scaled

            const dist = Math.sqrt((logicalMouseX - sx) ** 2 + (logicalMouseY - sy) ** 2);
            if (dist < hitRadius) {
                found = sat;
                break;
            }
        }

        if (found !== this.hoveredSat) {
            this.hoveredSat = found;
            this.drawSkyplot();
            if (found) {
                this.showTooltip(found, e.clientX, e.clientY);
            } else {
                this.tooltip.classList.remove('visible');
            }
        } else if (found) {
            this.showTooltip(found, e.clientX, e.clientY);
        }
    }

    showTooltip(sat, x, y) {
        const color = this.CONSTELLATION_COLORS[sat.constellation] || '#9CA3AF';
        this.tooltip.innerHTML = `
            <div class="tooltip-header">
                <div class="tooltip-dot" style="background:${color}"></div>
                <div class="tooltip-title">${sat.constellation} #${sat.prn}</div>
            </div>
            <div class="tooltip-row"><span>Azimuth:</span> <span class="tooltip-val">${sat.az.toFixed(0)}°</span></div>
            <div class="tooltip-row"><span>Elevation:</span> <span class="tooltip-val">${sat.el.toFixed(0)}°</span></div>
            <div class="tooltip-row"><span>SNR:</span> <span class="tooltip-val" style="color:${this.getSnrColor(sat.snr)}">${sat.snr.toFixed(1)} dBHz</span></div>
        `;

        let left = x + 15;
        let top = y + 15;
        if (left + 200 > window.innerWidth) left = x - 160;
        if (top + 100 > window.innerHeight) top = y - 100;

        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = `${top}px`;
        this.tooltip.classList.add('visible');
    }

    getSnrColor(snr) {
        if (snr > 30) return '#10B981';
        if (snr > 20) return '#F59E0B';
        return '#EF4444';
    }

    drawSkyplot() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(cx, cy) - 25;
        if (r <= 0) return;

        this.ctx.clearRect(0, 0, w, h);

        // Draw Skyplot Grid
        this.ctx.lineWidth = 1;
        this.ctx.strokeStyle = '#E5E7EB';
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
        this.ctx.stroke();

        this.ctx.strokeStyle = '#F3F4F6';
        for (const elev of [30, 60]) {
            const ringR = r * (1 - elev / 90);
            this.ctx.beginPath();
            this.ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
            this.ctx.stroke();
        }

        this.ctx.strokeStyle = '#E5E7EB';
        this.ctx.beginPath();
        this.ctx.moveTo(cx, cy - r); this.ctx.lineTo(cx, cy + r);
        this.ctx.moveTo(cx - r, cy); this.ctx.lineTo(cx + r, cy);
        this.ctx.stroke();

        this.ctx.fillStyle = '#9CA3AF';
        this.ctx.font = '500 10px Roboto, sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        const labelOffset = 15;
        this.ctx.fillText('N', cx, cy - r - labelOffset);
        this.ctx.fillText('S', cx, cy + r + labelOffset);
        this.ctx.fillText('E', cx + r + labelOffset, cy);
        this.ctx.fillText('W', cx - r - labelOffset, cy);

        // Draw Satellites (only those with known position)
        const sortedSats = Object.values(this.satellites)
            .filter(s => !this.hiddenConstellations.has(s.constellation) && s.hasPosition !== false)
            .sort((a, b) => (a.active === b.active) ? a.snr - b.snr : (a.active ? 1 : -1));

        for (const sat of sortedSats) {

            const elRad = (90 - sat.el) / 90 * r;
            const azRad = (sat.az - 90) * Math.PI / 180;
            const sx = cx + elRad * Math.cos(azRad);
            const sy = cy + elRad * Math.sin(azRad);

            const color = this.CONSTELLATION_COLORS[sat.constellation] || '#9CA3AF';

            // Get tinted icon
            const iconImg = this.getTintedIcon(color);

            // Scale icon based on SNR
            let scale = sat.snr > 30 ? 1.0 : (sat.snr > 20 ? 0.85 : 0.7);
            if (this.hoveredSat && this.hoveredSat.prn === sat.prn) scale *= 1.3;

            this.ctx.save();
            this.ctx.translate(sx, sy);
            this.ctx.scale(scale, scale);
            // Center is 12x12 for a 24x24 icon
            this.ctx.translate(-12, -12);

            this.ctx.globalAlpha = sat.active ? 1.0 : 0.6;

            if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
                this.ctx.drawImage(iconImg, 0, 0, 24, 24);
            } else {
                // Fallback while loading
                this.ctx.beginPath();
                this.ctx.arc(12, 12, 4, 0, Math.PI * 2);
                this.ctx.fillStyle = color;
                this.ctx.fill();
            }

            this.ctx.restore();

            // Draw PRN Label
            // Check label offset logic
            const distToCenter = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
            let offX = 0, offY = 0;
            const labelDist = (12 * scale) + 8; // Offset from icon center

            if (distToCenter > 0) {
                const vecX = (sx - cx) / distToCenter;
                const vecY = (sy - cy) / distToCenter;
                offX = vecX * labelDist;
                offY = vecY * labelDist;
            } else {
                offX = 0; offY = -labelDist;
            }

            const lx = sx + offX;
            const ly = sy + offY;

            this.ctx.globalAlpha = 1.0;
            this.ctx.font = '700 9px Roboto, sans-serif';
            const tm = this.ctx.measureText(sat.prn);
            const th = 10;
            const tw = tm.width;

            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
            this.ctx.fillRect(lx - tw / 2 - 2, ly - th / 2 - 1, tw + 4, th + 2);

            this.ctx.fillStyle = '#374151';
            this.ctx.fillText(sat.prn, lx, ly);
        }
    }


    updateStats() {
        // Calculate stats
        const counts = {};

        // Ensure all default constellations exist in counts to force rendering
        for (const constName of this.DEFAULT_CONSTELLATIONS) {
            counts[constName] = { total: 0, active: 0 };
        }

        for (const sat of Object.values(this.satellites)) {
            const c = sat.constellation;
            if (!counts[c]) counts[c] = { total: 0, active: 0 };

            counts[c].total++;
            if (sat.active) counts[c].active++;
        }

        this.statsDiv.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'sat-grid';

        // Iterate over default constellations to ensure fixed order and presence
        for (const name of this.DEFAULT_CONSTELLATIONS) {
            const data = counts[name];

            const color = this.CONSTELLATION_COLORS[name] || this.CONSTELLATION_COLORS['Unknown'];
            const isHidden = this.hiddenConstellations.has(name);

            // Dynamic color modern icon — replace all currentColor occurrences
            const iconSvg = this.SVG_MODERN_SAT_FILLED.split('currentColor').join(color);
            const pct = data.total > 0 ? (data.active / data.total) * 100 : 0;
            const animClass = data.active > 0 ? 'sat-icon-anim' : '';

            const item = document.createElement('div');
            item.className = `sat-stat-item ${isHidden ? 'dimmed' : ''}`;
            item.title = "Click to toggle visibility";
            item.onclick = () => {
                if (this.hiddenConstellations.has(name)) {
                    this.hiddenConstellations.delete(name);
                } else {
                    this.hiddenConstellations.add(name);
                }
                this.updateStats();
                this.drawSkyplot();
            };

            // Compact layout: Icon - Name - Active/Total - Progress (Integrated or small)
            item.innerHTML = `
                <div class="sat-icon-wrapper ${animClass}">${iconSvg}</div>
                <div class="sat-info">
                    <div class="sat-row-top">
                        <span class="sat-name">${name}</span>
                        <div class="sat-counter">
                            <span class="val-used" style="color:${color}">${data.active}</span>/${data.total}
                        </div>
                    </div>
                     <div class="sat-progress-bg">
                        <div class="sat-progress-fill" style="width:${pct}%; background-color:${color}"></div>
                    </div>
                </div>
            `;
            grid.appendChild(item);
        }

        this.statsDiv.appendChild(grid);
    }
}
