class Terminal {
    constructor(api) {
        this.api = api;
        this.output = document.getElementById('terminal-output');
        this.input = document.getElementById('terminal-input');
        this.showTimestamps = false;
        this.autoScroll = true;

        // Performance: line limit & batching
        this.MAX_LINES = 2000;
        this.lineCount = 0;
        this._pendingLines = [];    // Buffer for batched DOM writes
        this._flushQueued = false;  // rAF guard

        // Toolbar Buttons
        this.btnTime = document.getElementById('btn-term-time');
        this.btnScroll = document.getElementById('btn-term-scroll');
        this.btnClear = document.getElementById('btn-term-clear');
        this.btnSave = document.getElementById('btn-term-save');

        // SVG Icons
        this.SVG_CLOCK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
        this.SVG_SCROLL = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect><path d="M12 7v10"></path><path d="M8 13l4 4 4-4"></path></svg>`;
        this.SVG_TRASH = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
        this.SVG_SAVE = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;

        this.init();
    }

    init() {
        // Inject Icons
        this.injectIcon(this.btnTime, this.SVG_CLOCK);
        this.injectIcon(this.btnScroll, this.SVG_SCROLL);
        this.injectIcon(this.btnClear, this.SVG_TRASH);
        this.injectIcon(this.btnSave, this.SVG_SAVE);

        // Listen for lines from backend
        this.api.onTerminalLine(({ text, color }) => this.appendLine(text, color));

        // Input handling
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendCommand();
        });

        document.getElementById('btn-send-cmd')?.addEventListener('click', () => this.sendCommand());

        // Toolbar Actions
        this.btnTime.onclick = () => this.toggleTimestamps();
        this.btnScroll.onclick = () => this.toggleAutoScroll();
        this.btnClear.onclick = () => this.clear();
        this.btnSave.onclick = () => this.saveLog();
    }

    injectIcon(btn, svgString) {
        if (!btn) return;
        if (!btn.querySelector('svg')) {
            btn.insertAdjacentHTML('afterbegin', svgString);
        }
    }

    toggleTimestamps() {
        this.showTimestamps = !this.showTimestamps;
        this.btnTime.classList.toggle('active', this.showTimestamps);
    }

    toggleAutoScroll() {
        this.autoScroll = !this.autoScroll;
        this.btnScroll.classList.toggle('active', this.autoScroll);
    }

    saveLog() {
        const text = this.output.innerText;
        if (!text) {
            alert('Log is empty');
            return;
        }
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gnss_log_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Buffer a line and schedule a batched flush via rAF.
     * This prevents per-line DOM reflows when data arrives at high rates.
     */
    appendLine(text, color) {
        let content = text;
        if (this.showTimestamps) {
            const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
            content = `[${timeStr}] ${text}`;
        }

        // Classify line type for CSS coloring
        let cls = '';
        if (text.startsWith('[RTCM')) cls = 'rtcm';
        else if (text.includes('ERROR') || text.includes('BAD-CRC')) cls = 'error';
        else if (/^[0-9A-F ]+$/.test(text)) cls = 'binary';

        this._pendingLines.push({ content, color, cls });

        // Schedule flush on next animation frame (coalesces rapid bursts)
        if (!this._flushQueued) {
            this._flushQueued = true;
            requestAnimationFrame(() => this._flush());
        }
    }

    /**
     * Batch-append all pending lines to DOM in a single DocumentFragment.
     * Single reflow per frame, regardless of how many lines arrived.
     */
    _flush() {
        this._flushQueued = false;
        const lines = this._pendingLines;
        if (lines.length === 0) return;
        this._pendingLines = [];

        const frag = document.createDocumentFragment();

        for (const { content, color, cls } of lines) {
            const el = document.createElement('div');
            el.className = cls ? `terminal-line ${cls}` : 'terminal-line';
            if (color) el.style.color = color;
            el.textContent = content;
            frag.appendChild(el);
        }

        this.output.appendChild(frag);
        this.lineCount += lines.length;

        // Prune excess lines in bulk
        if (this.lineCount > this.MAX_LINES) {
            const excess = this.lineCount - this.MAX_LINES;
            // Remove excess children from the top (oldest)
            for (let i = 0; i < excess; i++) {
                if (this.output.firstChild) this.output.firstChild.remove();
            }
            this.lineCount = this.MAX_LINES;
        }

        if (this.autoScroll) {
            this.output.scrollTop = this.output.scrollHeight;
        }
    }

    sendCommand() {
        const cmd = this.input.value.trim();
        if (!cmd) return;

        this.api.sendCommand(cmd);

        // Local echo with blue arrow
        this.appendLine(`-> ${cmd}`, '#3B82F6');
        this.input.value = '';

        // Notify device monitor if a log-related command was sent
        const upper = cmd.trim().toUpperCase();
        if (upper.startsWith('LOG ') || upper.startsWith('UNLOG') || upper === 'UNLOGALL') {
            window.dispatchEvent(new Event('log-changed'));
        }
    }

    clear() {
        this.output.innerHTML = '';
        this.lineCount = 0;
        this._pendingLines = [];
    }
}

// End Terminal class
