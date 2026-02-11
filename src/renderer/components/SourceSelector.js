/**
 * SourceSelector - Pill-shaped dropdown with shimmer animation
 * Matches Python PyQt5 source_selector.py exactly
 */

class SourceSelector {
    constructor(containerId, availableMessages = [], options = {}) {
        this.container = document.getElementById(containerId);
        this.availableMessages = availableMessages;
        this.currentSourceId = null;
        this.currentSourceName = '';
        this.currentRate = 1.0;
        this.shimmerActive = false;
        this.shimmerPhase = 0;
        this.shimmerTimer = null;

        // Multi-select mode
        this.multiSelect = options.multiSelect || false;
        this.activeSources = new Set(); // Set of msgId for multi-select

        this.onSourceChanged = null; // Callback: (msgId, msgName) => {}
        this.onSourceToggled = null; // Callback: (msgId, msgName, isActive) => {} (multi-select)
        this.onRateChanged = null;   // Callback: (rate) => {}

        this.init();
    }

    init() {
        // Create pill container
        const pill = document.createElement('div');
        pill.className = 'source-selector-pill';
        pill.innerHTML = `
      <span class="source-selector-label">Select Source</span>
      <span class="source-selector-arrow">▼</span>
    `;

        this.container.appendChild(pill);
        this.pill = pill;
        this.label = pill.querySelector('.source-selector-label');

        // Click handler
        pill.addEventListener('click', () => this.showMenu());
    }

    setCurrentSource(msgId, msgName) {
        this.currentSourceId = msgId;
        this.currentSourceName = msgName;
        this.label.textContent = msgName;
        this.startShimmer();
    }

    getCurrentRate() {
        return this.currentRate;
    }

    startShimmer() {
        // Always restart — reset state first if already active
        if (this.shimmerActive) {
            this.label.classList.remove('shimmering');
        }
        this.shimmerActive = true;

        // Keep current source name visible, just add shimmer animation
        const baseText = this.currentSourceName || this.label.textContent;
        this.label.textContent = baseText;

        // Use CSS class for animation
        this.label.classList.add('shimmering');
    }

    stopShimmer() {
        if (!this.shimmerActive) return;
        this.shimmerActive = false;

        this.label.classList.remove('shimmering');
        this.label.textContent = this.currentSourceName || this.label.textContent;
        this.label.style.opacity = '1';
    }

    // updateShimmer() removed (handled by CSS)

    showMenu() {
        if (!this.availableMessages || this.availableMessages.length === 0) return;

        // Create dropdown menu
        const menu = document.createElement('div');
        menu.className = 'source-selector-menu';

        // Rate selector at top
        const rateSection = document.createElement('div');
        rateSection.className = 'source-selector-rate';
        rateSection.innerHTML = `
      <label>Rate:</label>
      <select class="rate-select">
        <option value="1" ${this.currentRate === 1 ? 'selected' : ''}>1 Hz</option>
        <option value="5" ${this.currentRate === 5 ? 'selected' : ''}>5 Hz</option>
        <option value="10" ${this.currentRate === 10 ? 'selected' : ''}>10 Hz</option>
      </select>
    `;
        menu.appendChild(rateSection);

        // Separator
        const sep1 = document.createElement('div');
        sep1.className = 'source-selector-separator';
        menu.appendChild(sep1);

        // Group messages by type
        const grouped = this.groupMessages(this.availableMessages);

        for (const [groupName, messages] of Object.entries(grouped)) {
            // Group header
            const header = document.createElement('div');
            header.className = 'source-selector-group-header';
            header.textContent = groupName;
            menu.appendChild(header);

            // Messages
            messages.forEach(msg => {
                const item = document.createElement('div');
                item.className = 'source-selector-item';

                if (this.multiSelect) {
                    const isActive = this.activeSources.has(msg.id);
                    item.innerHTML = `<span class="source-check">${isActive ? '✓' : ''}</span><span>${msg.name}</span>`;
                    if (isActive) item.classList.add('source-active');
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.toggleSource(msg.id, msg.name);
                        // Update this item's visual
                        const nowActive = this.activeSources.has(msg.id);
                        item.querySelector('.source-check').textContent = nowActive ? '✓' : '';
                        item.classList.toggle('source-active', nowActive);
                    });
                } else {
                    item.textContent = msg.name;
                    item.addEventListener('click', () => {
                        this.selectSource(msg.id, msg.name);
                        if (menu.parentNode) menu.parentNode.removeChild(menu);
                    });
                }

                menu.appendChild(item);
            });

            // Separator between groups
            const sep = document.createElement('div');
            sep.className = 'source-selector-separator';
            menu.appendChild(sep);
        }

        // Rate change handler
        const rateSelect = rateSection.querySelector('.rate-select');
        rateSelect.addEventListener('change', (e) => {
            this.currentRate = parseFloat(e.target.value);
            if (this.onRateChanged) {
                this.onRateChanged(this.currentRate);
            }
        });

        // Position menu below pill
        const rect = this.pill.getBoundingClientRect();
        menu.style.position = 'absolute';
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${rect.left}px`;
        menu.style.minWidth = `${rect.width}px`;

        document.body.appendChild(menu);

        // Close on outside click
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !this.pill.contains(e.target)) {
                if (menu.parentNode) menu.parentNode.removeChild(menu);
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    groupMessages(messages) {
        const groups = {
            'NMEA': [],
            'ASCII': [],
            'Binary': []
        };

        messages.forEach(msg => {
            const typeLower = (msg.type || '').toLowerCase();
            const name = msg.name || '';

            if (name.startsWith('$') || typeLower === 'nmea') {
                groups['NMEA'].push(msg);
            } else if (typeLower === 'binary' || (typeof msg.id === 'number')) {
                groups['Binary'].push(msg);
            } else {
                // Default to ASCII for everything else (e.g. specialized ASCII logs)
                groups['ASCII'].push(msg);
            }
        });

        // Remove empty groups
        Object.keys(groups).forEach(key => {
            if (groups[key].length === 0) delete groups[key];
        });

        return groups;
    }

    selectSource(msgId, msgName) {
        this.currentSourceId = msgId;
        this.currentSourceName = msgName;
        this.label.textContent = msgName;

        // Start shimmer during transition to new source
        this.startShimmer();

        if (this.onSourceChanged) {
            this.onSourceChanged(msgId, msgName);
        }
    }

    setAvailableMessages(messages) {
        this.availableMessages = messages;
    }

    // Multi-select: toggle a source on/off
    toggleSource(msgId, msgName) {
        const wasActive = this.activeSources.has(msgId);
        if (wasActive) {
            this.activeSources.delete(msgId);
        } else {
            this.activeSources.add(msgId);
        }

        // Update label
        this.updateMultiLabel();

        if (this.onSourceToggled) {
            this.onSourceToggled(msgId, msgName, !wasActive);
        }
    }

    // Update pill label to show active source count
    updateMultiLabel() {
        const count = this.activeSources.size;
        if (count === 0) {
            this.currentSourceName = 'Select Source';
        } else {
            // Show names of active sources
            const names = [];
            for (const msg of this.availableMessages) {
                if (this.activeSources.has(msg.id)) names.push(msg.name);
            }
            this.currentSourceName = names.join(' + ');
        }
        this.label.textContent = this.currentSourceName;
    }

    // Activate all sources (for toggle button)
    activateAll() {
        for (const msg of this.availableMessages) {
            this.activeSources.add(msg.id);
        }
        this.updateMultiLabel();
    }

    // Deactivate all sources
    deactivateAll() {
        this.activeSources.clear();
        this.updateMultiLabel();
    }
}

// End SourceSelector class

