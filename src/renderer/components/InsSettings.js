// InsSettings - INS configuration with 3D isometric visualization
// IMU direction, antenna positions, lever arms, INS behavior, 3D canvas

const INS_DIR_MAP = {
  '+X': [1,0,0], '-X': [-1,0,0],
  '+Y': [0,1,0], '-Y': [0,-1,0],
  '+Z': [0,0,1], '-Z': [0,0,-1],
};

const INS_PROFILES = ['LAND','BASIC','MARINE','FIXEDWING','FOOT','RAIL','AGRICULTURE'];

class InsSettings {
  constructor(api) {
    this.api = api;

    // State
    this._dirX = '+X';
    this._dirY = '+Y';
    this._useAnt2 = true;
    this._profile = 'LAND';
    this._alignVel = 2.0;
    this._special = { STATICYAW: false, ALIGN_TRIAL: false, VIBRATE: false, TRUST: false };
    this._ant1 = [0, 0, 0];
    this._ant2 = [0, 0, 0];
    this._cmdXYZ = [0, 0, 0];
    this._loaded = false;
    this._termUnsub = null;
    this._inscfgListen = false;

    // Camera
    this._camAz = 35;
    this._camEl = 25;
    this._camScale = 80;
    this._camDragging = false;
    this._lastMouse = null;

    // DOM refs
    this.canvas = document.getElementById('ins-3d-canvas');
    this.ctx = this.canvas?.getContext('2d');
    this.rbvLabel = document.getElementById('ins-rbv-label');
    this.profileSelect = document.getElementById('ins-profile');
    this.alignVelInput = document.getElementById('ins-align-vel');
    this.ckAnt2 = document.getElementById('ins-ck-ant2');
    this.preview = document.getElementById('ins-preview');
    this.statusLabel = document.getElementById('ins-status');

    // ANT spinboxes
    this._ant1Inputs = [
      document.getElementById('ins-ant1-x'),
      document.getElementById('ins-ant1-y'),
      document.getElementById('ins-ant1-z'),
    ];
    this._ant2Inputs = [
      document.getElementById('ins-ant2-x'),
      document.getElementById('ins-ant2-y'),
      document.getElementById('ins-ant2-z'),
    ];

    this._bindEvents();
  }

  _bindEvents() {
    // Direction radios
    document.querySelectorAll('input[name="ins-dir-x"]').forEach(r =>
      r.addEventListener('change', () => { this._dirX = r.value; this._recompute(); }));
    document.querySelectorAll('input[name="ins-dir-y"]').forEach(r =>
      r.addEventListener('change', () => { this._dirY = r.value; this._recompute(); }));

    // ANT spinboxes
    this._ant1Inputs.forEach((inp, i) => inp?.addEventListener('input', () => {
      this._ant1[i] = parseFloat(inp.value) || 0;
      this._drawScene();
      this._updatePreview();
    }));
    this._ant2Inputs.forEach((inp, i) => inp?.addEventListener('input', () => {
      this._ant2[i] = parseFloat(inp.value) || 0;
      this._drawScene();
      this._updatePreview();
    }));

    // Use ANT2
    this.ckAnt2?.addEventListener('change', () => {
      this._useAnt2 = this.ckAnt2.checked;
      document.getElementById('ins-ant2-section')?.classList.toggle('hidden', !this._useAnt2);
      this._drawScene();
      this._updatePreview();
    });

    // Swap
    document.getElementById('ins-btn-swap')?.addEventListener('click', () => {
      const tmp = [...this._ant1];
      this._ant1 = [...this._ant2];
      this._ant2 = tmp;
      this._syncSpinboxes();
      this._drawScene();
      this._updatePreview();
    });

    // Profile & behavior
    this.profileSelect?.addEventListener('change', () => {
      this._profile = this.profileSelect.value;
      this._updatePreview();
    });
    this.alignVelInput?.addEventListener('input', () => {
      this._alignVel = parseFloat(this.alignVelInput.value) || 2.0;
      this._updatePreview();
    });
    ['STATICYAW','ALIGN_TRIAL','VIBRATE','TRUST'].forEach(key => {
      const ck = document.getElementById(`ins-ck-${key.toLowerCase()}`);
      ck?.addEventListener('change', () => {
        this._special[key] = ck.checked;
        this._updatePreview();
      });
    });

    // Actions
    document.getElementById('ins-btn-pull')?.addEventListener('click', () => this._pullInsConfig());
    document.getElementById('ins-btn-send')?.addEventListener('click', () => this._sendAll());

    // Canvas mouse for camera rotation
    this.canvas?.addEventListener('mousedown', (e) => {
      this._camDragging = true;
      this._lastMouse = { x: e.offsetX, y: e.offsetY };
    });
    this.canvas?.addEventListener('mousemove', (e) => {
      if (!this._camDragging || !this._lastMouse) return;
      this._camAz += (e.offsetX - this._lastMouse.x) * 0.5;
      this._camEl = Math.max(-89, Math.min(89, this._camEl + (e.offsetY - this._lastMouse.y) * 0.5));
      this._lastMouse = { x: e.offsetX, y: e.offsetY };
      this._drawScene();
    });
    this.canvas?.addEventListener('mouseup', () => this._camDragging = false);
    this.canvas?.addEventListener('mouseleave', () => this._camDragging = false);

    window.addEventListener('resize', () => { if (this._loaded) this._resizeCanvas(); });
  }

  onPageActivated() {
    this._loaded = true;
    this._startListener();
    this._resizeCanvas();
    this._updatePreview();
  }

  _startListener() {
    if (this._termUnsub) return;
    this._termUnsub = this.api.onTerminalLine((data) => {
      const line = typeof data === 'string' ? data : data?.text || '';
      if (this._inscfgListen && /INSCONFIGA/i.test(line)) {
        this._parseInsConfig(line);
        this._inscfgListen = false;
      }
    });
  }

  // --- 3D Math ---

  _deg2rad(d) { return d * Math.PI / 180; }

  _Rx(deg) {
    const c = Math.cos(this._deg2rad(deg)), s = Math.sin(this._deg2rad(deg));
    return [[1,0,0],[0,c,-s],[0,s,c]];
  }
  _Ry(deg) {
    const c = Math.cos(this._deg2rad(deg)), s = Math.sin(this._deg2rad(deg));
    return [[c,0,s],[0,1,0],[-s,0,c]];
  }
  _Rz(deg) {
    const c = Math.cos(this._deg2rad(deg)), s = Math.sin(this._deg2rad(deg));
    return [[c,-s,0],[s,c,0],[0,0,1]];
  }

  _mat3Mul(A, B) {
    const R = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
          R[i][j] += A[i][k] * B[k][j];
    return R;
  }

  _mat3Vec(M, v) {
    return [
      M[0][0]*v[0]+M[0][1]*v[1]+M[0][2]*v[2],
      M[1][0]*v[0]+M[1][1]*v[1]+M[1][2]*v[2],
      M[2][0]*v[0]+M[2][1]*v[1]+M[2][2]*v[2],
    ];
  }

  _recompute() {
    // Compute RBV angles from chosen directions
    // Simple lookup for common combos
    const x = this._dirX;
    const y = this._dirY;
    const rbv = this._rbvFromDirs(x, y);
    this._cmdXYZ = rbv;
    if (this.rbvLabel) {
      this.rbvLabel.textContent = `RBV: X=${rbv[0].toFixed(1)}° Y=${rbv[1].toFixed(1)}° Z=${rbv[2].toFixed(1)}°`;
    }
    this._drawScene();
    this._updatePreview();
  }

  _rbvFromDirs(xCode, yCode) {
    // Common direction combinations → known RBV angles
    const key = `${xCode},${yCode}`;
    const table = {
      '+X,+Y': [0,0,0],    '-X,+Y': [0,0,180],  '+X,-Y': [0,0,0],
      '+Y,+X': [0,0,-90],  '+Y,-X': [0,0,90],   '-Y,+X': [0,0,90],
      '+X,+Z': [0,90,0],   '+X,-Z': [0,-90,0],
      '+Z,+Y': [90,0,0],   '-Z,+Y': [-90,0,0],
      '+Y,+Z': [0,0,-90],  '+Z,+X': [0,0,90],
      '+X,+Y': [0,0,0],    '-X,-Y': [0,0,180],
    };
    if (table[key]) return table[key];

    // Brute force search
    const target_x = INS_DIR_MAP[xCode];
    const target_y = INS_DIR_MAP[yCode];
    if (!target_x || !target_y) return [0, 0, 0];

    const angles = [-180, -90, 0, 90, 180];
    for (const rz of angles) {
      for (const rx of angles) {
        for (const ry of angles) {
          const R = this._mat3Mul(this._Rz(rz), this._mat3Mul(this._Rx(rx), this._Ry(ry)));
          const ex = this._mat3Vec(R, [1, 0, 0]);
          const ey = this._mat3Vec(R, [0, 1, 0]);
          if (this._vecClose(ex, target_x) && this._vecClose(ey, target_y)) {
            return [rx, ry, rz];
          }
        }
      }
    }
    return [0, 0, 0];
  }

  _vecClose(a, b) {
    return Math.abs(a[0]-b[0]) < 0.01 && Math.abs(a[1]-b[1]) < 0.01 && Math.abs(a[2]-b[2]) < 0.01;
  }

  // --- Canvas ---

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
    this._drawScene();
  }

  _project(p) {
    const az = this._deg2rad(this._camAz);
    const el = this._deg2rad(this._camEl);
    // Rotate by azimuth around Z
    const x1 = p[0] * Math.cos(az) - p[1] * Math.sin(az);
    const y1 = p[0] * Math.sin(az) + p[1] * Math.cos(az);
    const z1 = p[2];
    // Tilt by elevation
    const y2 = y1 * Math.cos(el) - z1 * Math.sin(el);
    const z2 = y1 * Math.sin(el) + z1 * Math.cos(el);
    return {
      x: this._cx + x1 * this._camScale,
      y: this._cy - z2 * this._camScale,
      depth: y2
    };
  }

  _drawLine3D(ctx, p1, p2, color, width) {
    const a = this._project(p1);
    const b = this._project(p2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  _drawScene() {
    const ctx = this.ctx;
    if (!ctx || !this._cw) return;

    ctx.clearRect(0, 0, this._cw, this._ch);
    ctx.fillStyle = '#1A1D23';
    ctx.fillRect(0, 0, this._cw, this._ch);

    // Ground grid
    const N = 4;
    const step = 0.5;
    ctx.setLineDash([]);
    for (let i = -N; i <= N; i++) {
      this._drawLine3D(ctx, [i*step, -N*step, 0], [i*step, N*step, 0], 'rgba(255,255,255,0.08)', 1);
      this._drawLine3D(ctx, [-N*step, i*step, 0], [N*step, i*step, 0], 'rgba(255,255,255,0.08)', 1);
    }

    // Vehicle box: 3.0 x 1.6 x 0.6 (Y forward, X right, Z up)
    const vl = 3.0, vw = 1.6, vh = 0.6;
    const hx = vw/2, hy = vl/2, hz = vh;
    const verts = [
      [-hx,-hy,0],[ hx,-hy,0],[ hx, hy,0],[-hx, hy,0],
      [-hx,-hy,hz],[hx,-hy,hz],[hx, hy,hz],[-hx, hy,hz],
    ];
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [a, b] of edges) {
      this._drawLine3D(ctx, verts[a], verts[b], 'rgba(255,255,255,0.25)', 1.5);
    }

    // Vehicle axes at front center
    const front = [0, hy, hz/2];
    const axLen = 0.6;
    this._drawLine3D(ctx, front, [front[0]+axLen, front[1], front[2]], '#EF4444', 2);
    this._drawLine3D(ctx, front, [front[0], front[1]+axLen, front[2]], '#10B981', 2);
    this._drawLine3D(ctx, front, [front[0], front[1], front[2]+axLen], '#3B82F6', 2);

    // Axis labels
    const px = this._project([front[0]+axLen+0.1, front[1], front[2]]);
    const py = this._project([front[0], front[1]+axLen+0.1, front[2]]);
    const pz = this._project([front[0], front[1], front[2]+axLen+0.1]);
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#EF4444'; ctx.fillText('X', px.x, px.y);
    ctx.fillStyle = '#10B981'; ctx.fillText('Y', py.x, py.y);
    ctx.fillStyle = '#3B82F6'; ctx.fillText('Z', pz.x, pz.y);

    // IMU chip (small box at center)
    const imuSize = 0.25;
    const imuH = 0.03;
    const iv = [
      [-imuSize,-imuSize,hz], [imuSize,-imuSize,hz],
      [imuSize,imuSize,hz], [-imuSize,imuSize,hz],
      [-imuSize,-imuSize,hz+imuH], [imuSize,-imuSize,hz+imuH],
      [imuSize,imuSize,hz+imuH], [-imuSize,imuSize,hz+imuH],
    ];
    for (const [a, b] of edges) {
      this._drawLine3D(ctx, iv[a], iv[b], '#F59E0B', 1);
    }

    // ANT1 (yellow)
    this._drawAntenna(ctx, this._ant1, '#FFBE00', 'P');
    // ANT2 (cyan)
    if (this._useAnt2) {
      this._drawAntenna(ctx, this._ant2, '#06B6D4', 'S');
    }

    // Title
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Drag to rotate view', 10, this._ch - 10);
  }

  _drawAntenna(ctx, pos, color, label) {
    // Draw antenna as circle + vertical line
    const base = [pos[0], pos[1], 0.6];
    const top = [pos[0], pos[1], 0.6 + 0.35];
    this._drawLine3D(ctx, base, top, color, 2);

    const tp = this._project(top);
    ctx.beginPath();
    ctx.arc(tp.x, tp.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tp.x, tp.y);
    ctx.textBaseline = 'alphabetic';
  }

  _syncSpinboxes() {
    this._ant1Inputs.forEach((inp, i) => { if (inp) inp.value = this._ant1[i].toFixed(3); });
    this._ant2Inputs.forEach((inp, i) => { if (inp) inp.value = this._ant2[i].toFixed(3); });
  }

  // --- Commands ---

  _buildCommands() {
    const cmds = [];
    cmds.push(`SETINSPROFILE ${this._profile}`);
    cmds.push(`SETINSROTATION RBV ${this._cmdXYZ[0].toFixed(1)} ${this._cmdXYZ[1].toFixed(1)} ${this._cmdXYZ[2].toFixed(1)} 0.5 0.5 0.5 VEHICLE`);
    cmds.push(`SETINSTRANSLATION ANT1 ${this._ant1[0].toFixed(3)} ${this._ant1[1].toFixed(3)} ${this._ant1[2].toFixed(3)} 0.05 0.05 0.05 VEHICLE`);
    if (this._useAnt2) {
      cmds.push(`SETINSTRANSLATION ANT2 ${this._ant2[0].toFixed(3)} ${this._ant2[1].toFixed(3)} ${this._ant2[2].toFixed(3)} 0.05 0.05 0.05 VEHICLE`);
      const bl = Math.sqrt((this._ant2[0]-this._ant1[0])**2 + (this._ant2[1]-this._ant1[1])**2 + (this._ant2[2]-this._ant1[2])**2);
      if (bl > 0.05) {
        cmds.push(`SETBASELINE ON ${bl.toFixed(3)} ${(bl*0.1).toFixed(3)}`);
      }
    }
    cmds.push(`SETALIGNMENTVEL ${this._alignVel.toFixed(2)}`);
    for (const [key, val] of Object.entries(this._special)) {
      cmds.push(`SETINSSPECIAL ${key} ${val ? 'ON' : 'OFF'}`);
    }
    return cmds;
  }

  _updatePreview() {
    if (this.preview) this.preview.value = this._buildCommands().join('\n');
  }

  async _pullInsConfig() {
    this._inscfgListen = true;
    this._setStatus('Pulling INS config...');
    try {
      await this.api.sendCommand('LOG INSCONFIGA ONCE');
      setTimeout(() => {
        if (this._inscfgListen) {
          this._inscfgListen = false;
          this._setStatus('No INSCONFIGA response', 'danger');
        }
      }, 5000);
    } catch (e) {
      this._setStatus(`Pull failed: ${e.message}`, 'danger');
    }
  }

  _parseInsConfig(line) {
    try {
      const dataPart = line.split(';').slice(1).join(';');
      if (!dataPart) return;
      const clean = dataPart.split('*')[0];
      const tokens = clean.split(',').map(t => t.trim());

      // Format: profile, rbv_x, rbv_y, rbv_z, ..., ant1_x, ant1_y, ant1_z, ..., ant2_x, ant2_y, ant2_z, ...
      if (tokens.length >= 1) {
        const profile = tokens[0]?.toUpperCase();
        if (INS_PROFILES.includes(profile)) {
          this._profile = profile;
          if (this.profileSelect) this.profileSelect.value = profile;
        }
      }
      // RBV at tokens[1-3], ANT1 at tokens[7-9], ANT2 at tokens[13-15] (typical layout)
      if (tokens.length >= 4) {
        this._cmdXYZ = [parseFloat(tokens[1])||0, parseFloat(tokens[2])||0, parseFloat(tokens[3])||0];
        if (this.rbvLabel) {
          this.rbvLabel.textContent = `RBV: X=${this._cmdXYZ[0].toFixed(1)}° Y=${this._cmdXYZ[1].toFixed(1)}° Z=${this._cmdXYZ[2].toFixed(1)}°`;
        }
      }
      if (tokens.length >= 10) {
        this._ant1 = [parseFloat(tokens[7])||0, parseFloat(tokens[8])||0, parseFloat(tokens[9])||0];
      }
      if (tokens.length >= 16) {
        this._ant2 = [parseFloat(tokens[13])||0, parseFloat(tokens[14])||0, parseFloat(tokens[15])||0];
      }

      this._syncSpinboxes();
      this._drawScene();
      this._updatePreview();
      this._setStatus('INS config loaded', 'success');
    } catch (e) {
      this._setStatus(`Parse error: ${e.message}`, 'danger');
    }
  }

  async _sendAll() {
    const cmds = this._buildCommands();
    this._setStatus('Sending INS commands...');
    try {
      for (const cmd of cmds) {
        await this.api.sendCommand(cmd);
        await new Promise(r => setTimeout(r, 200));
      }
      this._setStatus(`${cmds.length} commands sent`, 'success');
    } catch (e) {
      this._setStatus(`Send failed: ${e.message}`, 'danger');
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
