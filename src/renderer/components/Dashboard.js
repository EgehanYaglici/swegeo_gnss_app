// Dashboard Component
// Depends on global card classes

class Dashboard {
    constructor(api) {
        this.api = api;
        this.cards = [];

        // Card registry: name → card instance (for DeviceMonitor cross-reference)
        this.cardRegistry = {};
        this._deviceMonitor = null;
        this._notifyTimer = null;

        this.init();
    }

    init() {
        const pos = new PositionCard(this.api);
        const sat = new SatelliteCard(this.api);
        const vel = new VelocityCard(this.api);
        const imu = new ImuCard(this.api);
        const dm  = new SolutionStatusCard(this.api, this);

        this.cards.push(pos, sat, vel, imu, dm);
        this._deviceMonitor = dm;

        // Register cards with display names
        this.cardRegistry['Position'] = pos;
        this.cardRegistry['Satellites'] = sat;
        this.cardRegistry['Velocity'] = vel;
        this.cardRegistry['Attitude'] = imu;
    }

    /**
     * Strip NMEA talker ID prefix (GP, GN, GL, GA, GB, GQ, GI) to get base message name.
     * e.g. GPGGA → GGA, GNGGA → GGA, GLGSV → GSV
     */
    _stripTalker(name) {
        const upper = String(name).toUpperCase();
        const prefixes = ['GP', 'GN', 'GL', 'GA', 'GB', 'GQ', 'GI'];
        for (const p of prefixes) {
            if (upper.startsWith(p) && upper.length > p.length) {
                return upper.slice(p.length);
            }
        }
        return upper;
    }

    /**
     * Check if two message names match, accounting for NMEA talker prefixes.
     * e.g. GPGGA matches GGA, GNGGA matches GGA, BESTPOSB matches BESTPOSB
     */
    _msgMatch(loglistaName, sourceName) {
        const a = String(loglistaName).toUpperCase();
        const b = String(sourceName).toUpperCase();
        if (a === b) return true;
        // Strip talker from both and compare
        return this._stripTalker(a) === this._stripTalker(b);
    }

    /**
     * Find which card is actively using a given message name.
     * Returns { cardName, card } or null.
     * Handles: NMEA talker prefixes (GPGGA↔GGA), multi-source cards (SatelliteCard)
     */
    findCardByMessage(msgName) {
        for (const [name, card] of Object.entries(this.cardRegistry)) {
            if (!card.isActive) continue;

            // Multi-source card (SatelliteCard) — check all active sources
            if (card.sourceSelector && card.sourceSelector.activeSources && card.sourceSelector.activeSources.size > 0) {
                const msgs = card.sourceSelector.availableMessages || [];
                for (const activeId of card.sourceSelector.activeSources) {
                    const msg = msgs.find(m => m.id === activeId || String(m.id) === String(activeId));
                    if (!msg) continue;
                    const srcName = msg.name || '';
                    const srcCmd = msg.log_command || '';
                    if (this._msgMatch(msgName, srcName) || this._msgMatch(msgName, srcCmd)) {
                        return { cardName: name, card };
                    }
                }
            }

            // Single-source card — check currentSource
            if (card.currentSource) {
                const srcName = card.currentSource.name || '';
                const srcId = String(card.currentSource.id || '');
                const srcCmd = card.currentSource.log_command || '';
                if (this._msgMatch(msgName, srcName) || this._msgMatch(msgName, srcId) || this._msgMatch(msgName, srcCmd)) {
                    return { cardName: name, card };
                }
            }
        }
        return null;
    }

    /**
     * Deactivate a card (or a specific source within a multi-source card).
     * @param {object} card - The card instance
     * @param {string} [msgName] - Optional LOGLISTA message name to deactivate a specific source
     */
    deactivateCard(card, msgName) {
        if (!card || !card.isActive) return;

        // Multi-source card (SatelliteCard) — deactivate only the matching source
        if (msgName && card.sourceSelector && card.sourceSelector.activeSources && card.sourceSelector.activeSources.size > 0) {
            const msgs = card.sourceSelector.availableMessages || [];
            for (const activeId of [...card.sourceSelector.activeSources]) {
                const msg = msgs.find(m => m.id === activeId || String(m.id) === String(activeId));
                if (!msg) continue;
                if (this._msgMatch(msgName, msg.name) || this._msgMatch(msgName, msg.log_command || '')) {
                    // Use _deactivateSource if available (SatelliteCard), else toggle via selector
                    if (typeof card._deactivateSource === 'function') {
                        card._deactivateSource(msg.id, msg.name);
                        card.sourceSelector.activeSources.delete(activeId);
                        card.sourceSelector.updateMultiLabel();
                        card._syncToggleState();
                    } else {
                        card.sourceSelector.toggleSource(activeId, msg.name);
                    }
                    return;
                }
            }
        }

        // Single-source card — toggle the whole card off
        if (typeof card.toggleActive === 'function') {
            card.toggleActive();
        }
    }

    /**
     * Called by cards after LOG/UNLOG — debounced refresh of DeviceMonitor
     */
    notifyLogChanged() {
        if (this._notifyTimer) clearTimeout(this._notifyTimer);
        this._notifyTimer = setTimeout(() => {
            if (this._deviceMonitor && this._deviceMonitor._connected) {
                this._deviceMonitor._refresh();
            }
        }, 1200); // Wait 1.2s for device to process LOG/UNLOG
    }
}

// End Dashboard class
