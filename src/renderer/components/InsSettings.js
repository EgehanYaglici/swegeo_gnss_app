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
      r.addEventListener('change', () => {
        this._dirX = r.value;
        this._updateDirYConstraints();
        this._recompute();
      }));
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

  _updateDirYConstraints() {
    // X and Y axes must be orthogonal — disable Y options that share the same axis as X
    // e.g. if X is '+X', disable '+X' and '-X' for Y (dot product != 0 means parallel/anti-parallel)
    const xVec = INS_DIR_MAP[this._dirX];
    const yRadios = document.querySelectorAll('input[name="ins-dir-y"]');
    let currentYValid = false;

    yRadios.forEach(r => {
      const yVec = INS_DIR_MAP[r.value];
      // dot product: if abs(dot) > 0.5, they are parallel/anti-parallel — incompatible
      const dot = Math.abs(xVec[0]*yVec[0] + xVec[1]*yVec[1] + xVec[2]*yVec[2]);
      const incompatible = dot > 0.5;
      r.disabled = incompatible;
      const label = r.closest('label');
      if (label) label.classList.toggle('ins-radio-disabled', incompatible);
      if (r.checked && !incompatible) currentYValid = true;
    });

    // If current Y is now disabled, pick first valid option
    if (!currentYValid) {
      for (const r of yRadios) {
        if (!r.disabled) {
          r.checked = true;
          this._dirY = r.value;
          break;
        }
      }
    }
  }

  onPageActivated() {
    this._loaded = true;
    this._startListener();
    this._resizeCanvas();
    this._updateDirYConstraints();
    this._recompute();
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
    // Compute RBV raw angles from chosen IMU directions
    const [rx, ry, rz] = this._rbvFromDirs(this._dirX, this._dirY);

    // Build rotation matrix R = Rz(rz) @ Rx(rx) @ Ry(ry) for 3D visualization
    this._R_body_to_vehicle = this._mat3Mul(this._Rz(rz), this._mat3Mul(this._Rx(rx), this._Ry(ry)));

    // Hardware command convention: Y is negated (matches Python _finalize_rbv_angles)
    const y_cmd = Math.abs(-ry + 180) < 1e-4 ? 180 : -ry;
    this._cmdXYZ = [this._clean(rx), this._clean(y_cmd), this._clean(rz)];

    if (this.rbvLabel) {
      this.rbvLabel.textContent = `RBV: X=${this._cmdXYZ[0].toFixed(1)}° Y=${this._cmdXYZ[1].toFixed(1)}° Z=${this._cmdXYZ[2].toFixed(1)}°`;
    }
    this._drawScene();
    this._updatePreview();
  }

  _clean(v) {
    // Round near-zero and near-180 values
    if (Math.abs(v) < 1e-4) return 0;
    if (Math.abs(Math.abs(v) - 180) < 1e-4) return v < 0 ? -180 : 180;
    return Math.round(v * 1000) / 1000;
  }

  _rbvFromDirs(xCode, yCode) {
    // Hardcoded special cases from Python reference (before Y negate)
    // These are raw (rx, ry, rz) angles — Y negate applied in _recompute
    if (xCode === '-X' && yCode === '+Y') return [0,  180, 0];   // Leftward, Forward
    if (xCode === '-Z' && yCode === '+X') return [-90, 0,  90];  // Downward, Rightward
    if (xCode === '+Z' && yCode === '-Y') return [-90, 0, -90];  // Upward, Backward
    if (xCode === '-Z' && yCode === '-Y') return [ 90, 0, -90];  // Downward, Backward

    // Brute force search: R = Rz(rz) @ Rx(rx) @ Ry(ry)  (intrinsic Z→X→Y, matching Python)
    const xV = INS_DIR_MAP[xCode];
    const yV = INS_DIR_MAP[yCode];
    if (!xV || !yV) return [0, 0, 0];

    // Search order matches Python reference: rx first [-90,90,0], ry [0,90,-90,180,-180], rz [90,-90,180,-180,0]
    const rxAngles = [-90, 90, 0];
    const ryAngles = [0, 90, -90, 180, -180];
    const rzAngles = [90, -90, 180, -180, 0];

    for (const rz of rzAngles) {
      for (const rx of rxAngles) {
        for (const ry of ryAngles) {
          const R = this._mat3Mul(this._Rz(rz), this._mat3Mul(this._Rx(rx), this._Ry(ry)));
          // R columns: R*[1,0,0] should be xV, R*[0,1,0] should be yV
          const ex = this._mat3Vec(R, [1, 0, 0]);
          const ey = this._mat3Vec(R, [0, 1, 0]);
          if (this._vecClose(ex, xV) && this._vecClose(ey, yV)) {
            return [rx, ry, rz];
          }
        }
      }
    }
    return [0, 0, 0];
  }

  _vecClose(a, b) {
    return Math.abs(a[0]-b[0]) < 1e-4 && Math.abs(a[1]-b[1]) < 1e-4 && Math.abs(a[2]-b[2]) < 1e-4;
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

  _drawArrowHead(ctx, from3d, to3d, color) {
    const a = this._project(from3d);
    const b = this._project(to3d);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    const size = 7;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux*size - uy*size*0.4, b.y - uy*size + ux*size*0.4);
    ctx.lineTo(b.x - ux*size + uy*size*0.4, b.y - uy*size - ux*size*0.4);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  _drawScene() {
    const ctx = this.ctx;
    if (!ctx || !this._cw) return;

    ctx.clearRect(0, 0, this._cw, this._ch);
    ctx.fillStyle = '#1A1D23';
    ctx.fillRect(0, 0, this._cw, this._ch);

    // Vehicle dimensions: Y=Forward, X=Right, Z=Up
    // Scene origin (0,0,0) = Rear Axle Center (matches vehicle frame for lever arm spinboxes)
    const vl = 3.0, vw = 1.6, vh = 0.6;
    const hx = vw/2, hz = vh;
    // o = rear-axle-center offset: vehicle spans Y from 0 to vl in world
    const oy = 0; // rear axle at Y=0, front at Y=vl

    // Ground grid centered on rear axle
    const N = 4;
    const step = 0.5;
    ctx.setLineDash([]);
    for (let i = -N; i <= N; i++) {
      this._drawLine3D(ctx, [i*step, -N*step, 0], [i*step, N*step, 0], 'rgba(255,255,255,0.08)', 1);
      this._drawLine3D(ctx, [-N*step, i*step, 0], [N*step, i*step, 0], 'rgba(255,255,255,0.08)', 1);
    }

    // Vehicle box: rear axle at Y=0, front at Y=vl
    const verts = [
      [-hx, oy,    0], [ hx, oy,    0], [ hx, oy+vl, 0], [-hx, oy+vl, 0],
      [-hx, oy,   hz], [ hx, oy,   hz], [ hx, oy+vl,hz], [-hx, oy+vl,hz],
    ];
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [a, b] of edges) {
      this._drawLine3D(ctx, verts[a], verts[b], 'rgba(255,255,255,0.25)', 1.5);
    }

    // Vehicle frame axes at front-center (for reference, small)
    const front = [0, oy+vl, hz/2];
    const axLen = 0.5;
    this._drawLine3D(ctx, front, [front[0]+axLen, front[1], front[2]], '#EF4444', 1.5);
    this._drawLine3D(ctx, front, [front[0], front[1]+axLen, front[2]], '#10B981', 1.5);
    this._drawLine3D(ctx, front, [front[0], front[1], front[2]+axLen], '#3B82F6', 1.5);
    const px = this._project([front[0]+axLen+0.1, front[1], front[2]]);
    const py = this._project([front[0], front[1]+axLen+0.1, front[2]]);
    const pz = this._project([front[0], front[1], front[2]+axLen+0.1]);
    ctx.font = '10px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#EF4444'; ctx.fillText('X', px.x, px.y);
    ctx.fillStyle = '#10B981'; ctx.fillText('Y', py.x, py.y);
    ctx.fillStyle = '#3B82F6'; ctx.fillText('Z', pz.x, pz.y);

    // IMU chip — rotated using R_body_to_vehicle = Rz(rz) @ Rx(rx) @ Ry(ry)
    // R maps IMU body axes to vehicle frame axes
    const R = this._R_body_to_vehicle || [[1,0,0],[0,1,0],[0,0,1]];
    const rotIMU = (v) => this._mat3Vec(R, v);
    // Extract vehicle-frame directions of IMU body axes
    const xDir = rotIMU([1, 0, 0]);  // IMU X in vehicle frame
    const yDir = rotIMU([0, 1, 0]);  // IMU Y in vehicle frame
    const zDir = rotIMU([0, 0, 1]);  // IMU Z in vehicle frame

    const imuSize = 0.28;
    const imuH = 0.08;
    const imuZ = hz + 0.01;
    // Place IMU chip at center of vehicle (Y = vl/2 from rear axle)
    const chipCenter = [0, oy + vl/2, imuZ + imuH / 2];

    // 8 local corners of IMU box (before rotation): half-extents imuSize x imuSize x imuH/2
    const localCorners = [
      [-imuSize, -imuSize, -imuH/2], [ imuSize, -imuSize, -imuH/2],
      [ imuSize,  imuSize, -imuH/2], [-imuSize,  imuSize, -imuH/2],
      [-imuSize, -imuSize,  imuH/2], [ imuSize, -imuSize,  imuH/2],
      [ imuSize,  imuSize,  imuH/2], [-imuSize,  imuSize,  imuH/2],
    ];
    // Transform corners: rotate then offset to chipCenter
    const iv = localCorners.map(c => {
      const r = rotIMU(c);
      return [chipCenter[0]+r[0], chipCenter[1]+r[1], chipCenter[2]+r[2]];
    });

    // Draw IMU box top face filled
    const imuFace = [4,5,6,7];
    ctx.beginPath();
    const topPts = imuFace.map(i => this._project(iv[i]));
    ctx.moveTo(topPts[0].x, topPts[0].y);
    topPts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(245,158,11,0.2)';
    ctx.fill();
    // Draw all 12 edges
    const imuEdges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [a, b] of imuEdges) {
      this._drawLine3D(ctx, iv[a], iv[b], '#F59E0B', 1.5);
    }

    // Direction arrows from chip center — IMU body frame X/Y/Z axes in vehicle frame
    // Arrow origin at chip center (center of mass)
    const arrowOrigin = chipCenter;
    const arrowLen = 0.5;
    const imuXTip = [arrowOrigin[0]+xDir[0]*arrowLen, arrowOrigin[1]+xDir[1]*arrowLen, arrowOrigin[2]+xDir[2]*arrowLen];
    const imuYTip = [arrowOrigin[0]+yDir[0]*arrowLen, arrowOrigin[1]+yDir[1]*arrowLen, arrowOrigin[2]+yDir[2]*arrowLen];
    const imuZTip = [arrowOrigin[0]+zDir[0]*arrowLen, arrowOrigin[1]+zDir[1]*arrowLen, arrowOrigin[2]+zDir[2]*arrowLen];

    // Direction label lookup: code → human label
    const DIR_LABELS = {'+X':'Rightward','-X':'Leftward','+Y':'Forward','-Y':'Backward','+Z':'Upward','-Z':'Downward'};

    // Draw IMU X arrow (red)
    this._drawLine3D(ctx, arrowOrigin, imuXTip, '#EF4444', 2.5);
    this._drawArrowHead(ctx, arrowOrigin, imuXTip, '#EF4444');
    // Draw IMU Y arrow (green)
    this._drawLine3D(ctx, arrowOrigin, imuYTip, '#10B981', 2.5);
    this._drawArrowHead(ctx, arrowOrigin, imuYTip, '#10B981');
    // Draw IMU Z arrow (blue) — derived automatically from cross(X,Y)
    this._drawLine3D(ctx, arrowOrigin, imuZTip, '#3B82F6', 2.5);
    this._drawArrowHead(ctx, arrowOrigin, imuZTip, '#3B82F6');

    // Labels
    const ext = arrowLen + 0.16;
    const imuXLabelPt = this._project([arrowOrigin[0]+xDir[0]*ext, arrowOrigin[1]+xDir[1]*ext, arrowOrigin[2]+xDir[2]*ext]);
    const imuYLabelPt = this._project([arrowOrigin[0]+yDir[0]*ext, arrowOrigin[1]+yDir[1]*ext, arrowOrigin[2]+yDir[2]*ext]);
    const imuZLabelPt = this._project([arrowOrigin[0]+zDir[0]*ext, arrowOrigin[1]+zDir[1]*ext, arrowOrigin[2]+zDir[2]*ext]);
    ctx.font = 'bold 9px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#EF4444';
    ctx.fillText(`X → ${DIR_LABELS[this._dirX] || this._dirX}`, imuXLabelPt.x, imuXLabelPt.y - 2);
    ctx.fillStyle = '#10B981';
    ctx.fillText(`Y → ${DIR_LABELS[this._dirY] || this._dirY}`, imuYLabelPt.x, imuYLabelPt.y - 2);
    ctx.fillStyle = '#3B82F6';
    ctx.fillText('Z (auto)', imuZLabelPt.x, imuZLabelPt.y - 2);

    // Rear axle marker — origin (0,0,0) = rear axle center
    const rearP = this._project([0, oy, 0]);
    ctx.beginPath();
    ctx.arc(rearP.x, rearP.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#FFBE00';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,190,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Rear axle line across vehicle width
    this._drawLine3D(ctx, [-hx, oy, 0], [hx, oy, 0], '#FFBE00', 2);
    // Label
    const rearLabelP = this._project([0, oy - 0.18, 0]);
    ctx.font = '9px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFBE00';
    ctx.fillText('Rear Axle Origin (0,0,0)', rearLabelP.x, rearLabelP.y);

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
    // pos = [X, Y, Z] in vehicle frame (origin = rear axle center)
    // Draw a vertical antenna mast from pos[2] upward
    const antZ = pos[2] > 0 ? pos[2] : 0.65; // fallback to roof height
    const base = [pos[0], pos[1], antZ];
    const top = [pos[0], pos[1], antZ + 0.35];
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
