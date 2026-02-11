// HeadingSettings - Heading offset & baseline configuration with 2D canvas
// Dual-antenna heading offset visualization and device command generation

class HeadingSettings {
  constructor(api) {
    this.api = api;

    // State
    this._angle = 90;           // UI degrees: 0=right, CCW+, 90=forward
    this._dragging = false;
    this._baselineCm = 0;
    this._marginCm = 0;
    this._useFixed = false;
    this._loaded = false;

    // DOM refs
    this.canvas = document.getElementById('heading-canvas');
    this.ctx = this.canvas?.getContext('2d');
    this.spinOffset = document.getElementById('hdg-spin-offset');
    this.offsetBig = document.getElementById('hdg-offset-big');
    this.btnRotLeft = document.getElementById('hdg-btn-rot-left');
    this.btnRotRight = document.getElementById('hdg-btn-rot-right');
    this.presetBtns = document.querySelectorAll('.hdg-preset-btn');
    this.ckFixed = document.getElementById('hdg-ck-fixed');
    this.spinBaseline = document.getElementById('hdg-spin-baseline');
    this.spinMargin = document.getElementById('hdg-spin-margin');
    this.baselineInputs = document.getElementById('hdg-baseline-inputs');
    this.preview = document.getElementById('hdg-preview');
    this.btnApply = document.getElementById('hdg-btn-apply');
    this.statusLabel = document.getElementById('hdg-status');

    this._bindEvents();
  }

  _bindEvents() {
    // Canvas mouse
    this.canvas?.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas?.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas?.addEventListener('mouseup', () => this._onMouseUp());
    this.canvas?.addEventListener('mouseleave', () => this._onMouseUp());

    // Spin offset
    this.spinOffset?.addEventListener('input', () => {
      const devDeg = parseFloat(this.spinOffset.value) || 0;
      this._setAngle(devDeg + 90, true);
    });

    // Quick rotation buttons
    this.btnRotLeft?.addEventListener('click', () => this._setAngle(this._angle + 90));
    this.btnRotRight?.addEventListener('click', () => this._setAngle(this._angle - 90));

    // Preset angle buttons (0°, 90°, 180°, −90°)
    this.presetBtns?.forEach(btn => {
      btn.addEventListener('click', () => {
        const devDeg = parseFloat(btn.dataset.angle) || 0;
        this._setAngle(devDeg + 90);
      });
    });

    // Fixed baseline
    this.ckFixed?.addEventListener('change', () => {
      this._useFixed = this.ckFixed.checked;
      this.baselineInputs?.classList.toggle('hidden', !this._useFixed);
      this._updatePreview();
    });
    this.spinBaseline?.addEventListener('input', () => {
      this._baselineCm = parseFloat(this.spinBaseline.value) || 0;
      this._drawCanvas();
      this._updatePreview();
    });
    this.spinMargin?.addEventListener('input', () => {
      this._marginCm = parseFloat(this.spinMargin.value) || 0;
      this._updatePreview();
    });

    // Apply
    this.btnApply?.addEventListener('click', () => this._applyAll());

    // Window resize → redraw
    window.addEventListener('resize', () => {
      if (this._loaded) this._resizeCanvas();
    });
  }

  onPageActivated() {
    this._loaded = true;
    this._resizeCanvas();
  }

  // --- Canvas sizing ---

  _resizeCanvas() {
    if (!this.canvas) return;
    const wrapper = this.canvas.parentElement;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx?.scale(dpr, dpr);
    this._cw = rect.width;
    this._ch = rect.height;
    this._cx = rect.width / 2;
    this._cy = rect.height / 2;
    this._radius = Math.min(rect.width, rect.height) * 0.32;
    this._drawCanvas();
  }

  // --- Angle helpers ---

  _normalize(deg) {
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  }

  _deviceOffsetFromUI(uiDeg) {
    let d = (uiDeg - 90) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  _setAngle(deg, fromSpin) {
    this._angle = this._normalize(deg);
    const devOff = this._deviceOffsetFromUI(this._angle);
    if (!fromSpin) {
      if (this.spinOffset) this.spinOffset.value = devOff.toFixed(2);
    }
    // Update big offset display
    if (this.offsetBig) {
      const sign = devOff >= 0 ? '+' : '';
      this.offsetBig.textContent = `${sign}${devOff.toFixed(2)}°`;
    }
    // Update preset button active states
    this.presetBtns?.forEach(btn => {
      const btnAngle = parseFloat(btn.dataset.angle) || 0;
      btn.classList.toggle('active', Math.abs(devOff - btnAngle) < 0.5);
    });
    this._drawCanvas();
    this._updatePreview();
  }

  _getSecondaryPos() {
    const rad = this._angle * Math.PI / 180;
    return {
      x: this._cx + this._radius * Math.cos(rad),
      y: this._cy - this._radius * Math.sin(rad)
    };
  }

  // --- Mouse interaction ---

  _onMouseDown(e) {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const sec = this._getSecondaryPos();
    const dist = Math.hypot(mx - sec.x, my - sec.y);

    if (dist <= 18) {
      this._dragging = true;
      return;
    }

    // Snap to axis
    const SNAP = 12;
    if (Math.abs(my - this._cy) <= SNAP) {
      this._setAngle(mx >= this._cx ? 0 : 180);
      return;
    }
    if (Math.abs(mx - this._cx) <= SNAP) {
      this._setAngle(my <= this._cy ? 90 : 270);
      return;
    }

    // Free angle
    const dx = mx - this._cx;
    const dy = -(my - this._cy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    this._setAngle(angle);
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dx = mx - this._cx;
    const dy = -(my - this._cy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    this._setAngle(angle);
  }

  _onMouseUp() {
    this._dragging = false;
  }

  // --- Canvas drawing ---

  _drawCanvas() {
    const ctx = this.ctx;
    if (!ctx || !this._cw) return;
    const W = this._cw;
    const H = this._ch;
    const cx = this._cx;
    const cy = this._cy;
    const r = this._radius;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#F9FAFB';
    ctx.fillRect(0, 0, W, H);

    // Grid (dotted)
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    for (let x = 40; x < W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 40; y < H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Forward direction text
    ctx.fillStyle = '#3B82F6';
    ctx.font = 'bold 13px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('\u2B06 YOUR FORWARD DIRECTION \u2B06', cx, 22);

    // Main axes
    ctx.strokeStyle = '#6B7280';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(40, cy); ctx.lineTo(W - 40, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, 36); ctx.lineTo(cx, H - 20); ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#6B7280';
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('180°', 36, cy - 6);
    ctx.textAlign = 'left';
    ctx.fillText('0°', W - 36, cy - 6);
    ctx.textAlign = 'center';
    ctx.fillText('90°', cx + 16, 48);
    ctx.fillText('270°', cx + 20, H - 8);

    // Get secondary position
    const sec = this._getSecondaryPos();

    // Baseline line
    if (this._baselineCm > 0 && this._useFixed) {
      ctx.strokeStyle = '#06B6D4';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sec.x, sec.y);
      ctx.stroke();

      // Baseline length label
      const midX = (cx + sec.x) / 2;
      const midY = (cy + sec.y) / 2;
      ctx.fillStyle = '#06B6D4';
      ctx.font = 'bold 10px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${this._baselineCm.toFixed(0)} cm`, midX, midY - 8);
    }

    // Arc from forward (90°) to secondary
    const forwardRad = 90 * Math.PI / 180;
    const secRad = this._angle * Math.PI / 180;
    let sweep = this._angle - 90;
    if (sweep <= 0) sweep += 360;
    const arcRadius = 50;

    if (Math.abs(sweep) > 1 && Math.abs(sweep) < 359) {
      ctx.strokeStyle = '#10B981';
      ctx.lineWidth = 2;
      ctx.beginPath();
      // Canvas arc: startAngle=0 is right, clockwise
      // We need to convert: UI 90° (up) → canvas angle -π/2
      const canvasStart = -forwardRad;
      const canvasEnd = -secRad;
      ctx.arc(cx, cy, arcRadius, canvasStart, canvasEnd, true);
      ctx.stroke();

      // Angle value label
      const devOff = this._deviceOffsetFromUI(this._angle);
      const labelAngle = (this._angle + 90) / 2;
      const labelRad = labelAngle * Math.PI / 180;
      const lx = cx + (arcRadius + 18) * Math.cos(labelRad);
      const ly = cy - (arcRadius + 18) * Math.sin(labelRad);
      ctx.fillStyle = '#10B981';
      ctx.font = 'bold 11px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      const sign = devOff >= 0 ? '+' : '';
      ctx.fillText(`${sign}${devOff.toFixed(1)}°`, lx, ly);
    }

    // PRIMARY antenna (center) — blue
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
    ctx.fill();
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#3B82F6';
    ctx.font = 'bold 12px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('1', cx, cy);
    ctx.textBaseline = 'alphabetic';

    // SECONDARY antenna — amber
    ctx.beginPath();
    ctx.arc(sec.x, sec.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#92400E';
    ctx.font = 'bold 12px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('2', sec.x, sec.y);
    ctx.textBaseline = 'alphabetic';

    // Legend (top-right)
    const lx0 = W - 150;
    const ly0 = 44;
    ctx.font = '10px Segoe UI, sans-serif';
    // ANT1
    ctx.beginPath();
    ctx.arc(lx0, ly0, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#3B82F6';
    ctx.font = 'bold 8px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('1', lx0, ly0);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#6B7280';
    ctx.font = '10px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('ANT1 (PRIMARY)', lx0 + 14, ly0 + 3);

    // ANT2
    const ly1 = ly0 + 22;
    ctx.beginPath();
    ctx.arc(lx0, ly1, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#92400E';
    ctx.font = 'bold 8px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('2', lx0, ly1);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#6B7280';
    ctx.font = '10px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('ANT2 (SECONDARY)', lx0 + 14, ly1 + 3);
  }

  // --- Commands ---

  _buildCommands() {
    const cmds = [];
    const devOff = this._deviceOffsetFromUI(this._angle);
    cmds.push(`HEADINGOFFSET ${devOff.toFixed(2)} 0`);

    if (this._useFixed) {
      if (this._baselineCm > 0) {
        const lm = (this._baselineCm / 100).toFixed(2);
        const mm = (this._marginCm / 100).toFixed(2);
        cmds.push(`SETBASELINE ON ${lm} ${mm}`);
      }
    } else {
      cmds.push('SETBASELINE OFF');
    }

    cmds.push('SAVECONFIG');
    return cmds;
  }

  _updatePreview() {
    if (this.preview) {
      this.preview.value = this._buildCommands().join('\n');
    }
  }

  async _applyAll() {
    const cmds = this._buildCommands();
    if (this._useFixed && this._baselineCm <= 0) {
      this._setStatus('Baseline must be > 0 when fixed baseline enabled', 'danger');
      return;
    }

    this._setStatus('Sending commands...', '');
    try {
      for (const cmd of cmds) {
        await this.api.sendCommand(cmd);
        await new Promise(r => setTimeout(r, 200));
      }
      this._setStatus('Commands sent successfully', 'success');
    } catch (e) {
      this._setStatus(`Error: ${e.message}`, 'danger');
    }
  }

  _setStatus(text, type) {
    if (!this.statusLabel) return;
    this.statusLabel.textContent = text;
    if (type === 'danger') this.statusLabel.style.color = 'var(--danger)';
    else if (type === 'success') this.statusLabel.style.color = 'var(--success)';
    else this.statusLabel.style.color = 'var(--text-muted)';
  }
}
