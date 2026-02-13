// ImuCard.js — Attitude dashboard card with PFD horizon display
// Aircraft-style Primary Flight Display + numeric roll/pitch/yaw + accel/gyro

class ImuCard {
  constructor(api) {
    this.api = api;

    // Toggle & source
    this.toggleBtn = document.getElementById('att-toggle');
    this.sourceContainer = document.getElementById('att-source-container');
    this.currentSource = null;
    this.sourceSelector = null;
    this.isActive = false;

    // Canvas
    this.canvas = document.getElementById('att-horizon');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;

    // Data elements
    this.elRoll = document.getElementById('att-roll');
    this.elPitch = document.getElementById('att-pitch');
    this.elYaw = document.getElementById('att-yaw');
    this.elInsStatus = document.getElementById('att-ins-status');
    this.elAx = document.getElementById('att-ax');
    this.elAy = document.getElementById('att-ay');
    this.elAz = document.getElementById('att-az');
    this.elGx = document.getElementById('att-gx');
    this.elGy = document.getElementById('att-gy');
    this.elGz = document.getElementById('att-gz');
    this.elNoAtt = document.getElementById('att-no-att');

    // SVGs
    this.SVG_CHECK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    this.SVG_CROSS = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

    // NMEA messages that need GP prefix
    this.NMEA_MESSAGES = new Set(['GGA', 'RMC', 'GLL', 'GNS', 'FPD', 'HPD', 'VTG', 'GSA', 'GSV', 'ZDA']);

    // Attitude state
    this._targetRoll = 0;
    this._targetPitch = 0;
    this._targetYaw = 0;
    this._displayRoll = 0;
    this._displayPitch = 0;
    this._displayYaw = 0;
    this._hasAttitude = false;
    this._isImuTilt = false;
    this._slipAccel = 0;
    this._turnRate = 0;
    this._animId = null;
    this._lastUpdate = 0;

    // Raw field values for 3D cube axis display
    this._rawAx = null; this._rawAy = null; this._rawAz = null;
    this._rawGx = null; this._rawGy = null; this._rawGz = null;
    this._rawFields = {};

    // High-rate IMU messages that should use ONNEW
    this.HIGH_RATE_IMU = new Set(['CORRIMUDATAB', 'CORRIMUDATASB', 'RAWIMUB', 'CORRIMUDATAA', 'RAWIMUA']);

    // Pure IMU messages (show 3D cube)
    this.PURE_IMU_MESSAGES = new Set(['CORRIMUDATAB', 'CORRIMUDATASB', 'RAWIMUB', 'CORRIMUDATAA', 'RAWIMUA']);

    // INS messages (show PFD)
    this.INS_MESSAGES = new Set(['INSATTB', 'INSATTA', 'INSPVAB', 'INSPVAA']);

    // Visualization mode: 'imu' or 'ins'
    this._visualMode = 'ins';

    // Canvas size cache
    this._cw = 0;
    this._ch = 0;

    this.init();
  }

  async init() {
    const messages = await this.api.getMessages('imu');
    const formattedMessages = messages.map(msg => ({
      id: msg.id,
      name: msg.name,
      type: msg.type,
      log_command: msg.log_command
    }));

    // Sort messages: INS messages first, then IMU messages
    formattedMessages.sort((a, b) => {
      const aUpper = String(a.name || a.id || '').toUpperCase();
      const bUpper = String(b.name || b.id || '').toUpperCase();
      const aIsINS = this.INS_MESSAGES.has(aUpper);
      const bIsINS = this.INS_MESSAGES.has(bUpper);
      if (aIsINS && !bIsINS) return -1;
      if (!aIsINS && bIsINS) return 1;
      return 0;
    });

    this.sourceSelector = new SourceSelector('att-source-selector', formattedMessages);

    // Toggle
    this.toggleBtn.onclick = () => this.toggleActive();

    // Default source but stay inactive - prioritize INS
    if (formattedMessages.length > 0) {
      const first = formattedMessages[0];
      this.sourceSelector.setCurrentSource(first.id, first.name);
      this.currentSource = { id: first.id, name: first.name, log_command: first.log_command };

      // Detect initial mode
      const msgIdUpper = String(first.id || '').toUpperCase();
      const msgNameUpper = String(first.name || '').toUpperCase();
      if (this.PURE_IMU_MESSAGES.has(msgIdUpper) || this.PURE_IMU_MESSAGES.has(msgNameUpper)) {
        this._visualMode = 'imu';
        console.log('[ImuCard] Initial mode: IMU (3D cube)');
      } else if (this.INS_MESSAGES.has(msgIdUpper) || this.INS_MESSAGES.has(msgNameUpper)) {
        this._visualMode = 'ins';
        console.log('[ImuCard] Initial mode: INS (PFD)');
      }
    }

    // Source change
    this.sourceSelector.onSourceChanged = async (msgId, msgName) => {
      // Detect visualization mode based on message ID/name
      const msgIdUpper = String(msgId || '').toUpperCase();
      const msgNameUpper = String(msgName || '').toUpperCase();

      console.log('[ImuCard] Source changed:', { msgId, msgName, msgIdUpper, msgNameUpper });

      if (this.PURE_IMU_MESSAGES.has(msgIdUpper) || this.PURE_IMU_MESSAGES.has(msgNameUpper)) {
        this._visualMode = 'imu';
        console.log('[ImuCard] Switched to IMU mode (3D cube)');
      } else if (this.INS_MESSAGES.has(msgIdUpper) || this.INS_MESSAGES.has(msgNameUpper)) {
        this._visualMode = 'ins';
        console.log('[ImuCard] Switched to INS mode (PFD)');
      } else {
        // Default to INS for unknown messages
        this._visualMode = 'ins';
        console.log('[ImuCard] Unknown message type, defaulting to INS mode');
      }

      if (this.isActive && this.currentSource) {
        try {
          await this.api.unsubscribe('imu', this.currentSource.id, this.currentSource.name);
          const oldCmd = this._getCommandName(this.currentSource);
          if (oldCmd) await this.api.sendCommand(`UNLOG ${oldCmd}`);
          for (const imuSrc of this.HIGH_RATE_IMU) {
            await this.api.sendCommand(`UNLOG ${imuSrc}`);
          }
        } catch (e) {
          console.error('[ImuCard] Error unlogging old sources:', e);
        }
      }

      const msgObj = this.sourceSelector.availableMessages.find(m => m.id == msgId);
      this.currentSource = { id: msgId, name: msgName, log_command: msgObj?.log_command };
      this._clearData();

      if (this.isActive) {
        try {
          await this.api.subscribe('imu', msgId, msgName);
          this.sourceSelector.startShimmer();
          const cmdName = this._getCommandName(this.currentSource);
          if (cmdName) {
            // Use ONNEW for high-rate IMU messages (100Hz)
            if (this.HIGH_RATE_IMU.has(cmdName.toUpperCase())) {
              await this.api.sendCommand(`LOG ${cmdName} ONNEW`);
            } else {
              const rateHz = this.sourceSelector.getCurrentRate() || 10;
              const period = 1.0 / Number(rateHz);
              await this.api.sendCommand(`LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`);
            }
          }
        } catch (e) {
          console.error('[ImuCard] Error subscribing:', e);
        }
      }

      window.dispatchEvent(new Event('log-changed'));
    };

    // Rate change (only affects non-high-rate sources)
    this.sourceSelector.onRateChanged = async (rate) => {
      if (this.currentSource && this.isActive) {
        const cmdName = this._getCommandName(this.currentSource);
        if (cmdName) {
          // High-rate IMU messages ignore rate changes (always ONNEW)
          if (!this.HIGH_RATE_IMU.has(cmdName.toUpperCase())) {
            const period = 1.0 / Number(rate);
            await this.api.sendCommand(`LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`);
          }
        }
      }
    };

    // Data listener
    this.api.onData('imu', (data) => this._update(data));

    this._resizeDebounce = null;
    const doResize = () => {
      if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
      this._resizeDebounce = setTimeout(() => {
        this._resizeCanvas();
        this._drawPFD();
      }, 60);
    };
    window.addEventListener('resize', doResize);
    if (this.canvas && this.canvas.parentElement) {
      this._resizeObs = new ResizeObserver(doResize);
      this._resizeObs.observe(this.canvas.parentElement);
    }

    this._resizeCanvas();
    this._drawPFD();
  }

  async toggleActive() {
    this.isActive = !this.isActive;

    if (this.isActive) {
      this.toggleBtn.classList.remove('inactive');
      this.toggleBtn.classList.add('active');
      this.toggleBtn.innerHTML = this.SVG_CHECK;
      this.sourceContainer.classList.add('active');

      if (this.currentSource) {
        // UNLOG all IMU sources first
        for (const imuSrc of this.HIGH_RATE_IMU) {
          await this.api.sendCommand(`UNLOG ${imuSrc}`);
        }

        await this.api.subscribe('imu', this.currentSource.id, this.currentSource.name);
        this.sourceSelector.startShimmer();

        const cmdName = this._getCommandName(this.currentSource);
        if (cmdName) {
          // Use ONNEW for high-rate IMU messages
          if (this.HIGH_RATE_IMU.has(cmdName.toUpperCase())) {
            await this.api.sendCommand(`LOG ${cmdName} ONNEW`);
          } else {
            const rateHz = this.sourceSelector.getCurrentRate() || 10;
            const period = 1.0 / Number(rateHz);
            await this.api.sendCommand(`LOG ${cmdName} ONTIME ${period.toFixed(2) * 1}`);
          }
        }

        this._startAnimation();
      }
    } else {
      this.toggleBtn.classList.remove('active');
      this.toggleBtn.classList.add('inactive');
      this.toggleBtn.innerHTML = this.SVG_CROSS;
      this.sourceContainer.classList.remove('active');

      if (this.currentSource) {
        await this.api.unsubscribe('imu', this.currentSource.id, this.currentSource.name);
        this.sourceSelector.stopShimmer();
        const cmdName = this._getCommandName(this.currentSource);
        if (cmdName) await this.api.sendCommand(`UNLOG ${cmdName}`);
      }
      for (const imuSrc of this.HIGH_RATE_IMU) {
        await this.api.sendCommand(`UNLOG ${imuSrc}`);
      }

      this._stopAnimation();
      this._clearData();
      this._drawPFD();
    }

    // Notify DeviceMonitor of log change
    window.dispatchEvent(new Event('log-changed'));
  }

  _update(data) {
    const now = performance.now();

    // --- 1. Determine Source & Attitude Mode ---
    const hasRoll = data.roll != null && !isNaN(data.roll);
    const hasPitch = data.pitch != null && !isNaN(data.pitch);
    const hasYaw = data.yaw != null && !isNaN(data.yaw);

    // Accel & Gyro
    const ax = data.accel_x, ay = data.accel_y, az = data.accel_z;
    const gx = data.gyro_x, gy = data.gyro_y, gz = data.gyro_z;

    // Store raw values for 3D cube axis display
    this._rawAx = ax; this._rawAy = ay; this._rawAz = az;
    this._rawGx = gx; this._rawGy = gy; this._rawGz = gz;
    this._rawFields = data.raw_fields || {};

    this._isImuTilt = false;

    if (this._visualMode === 'imu') {
      // --- IMU / 3D Cube mode ---
      // Process EVERY sample for accurate gyro integration
      const hasGyro = gx != null || gy != null || gz != null;
      const hasAccel = ax != null || ay != null || az != null;

      if (hasGyro || hasAccel) {
        this._hasAttitude = true;
        this._isImuTilt = true;

        // Dead zone: ignore small gyro values (sensor bias/noise)
        const DEAD_ZONE = 0.3; // deg/s threshold
        const rateX = gx != null ? Number(gx) : 0;
        const rateY = gy != null ? Number(gy) : 0;
        const rateZ = gz != null ? Number(gz) : 0;

        const dt = (now - (this._lastGyroTime || now)) / 1000;
        this._lastGyroTime = now;
        const activeX = Math.abs(rateX) > DEAD_ZONE;
        const activeY = Math.abs(rateY) > DEAD_ZONE;
        const activeZ = Math.abs(rateZ) > DEAD_ZONE;

        if (activeX) {
          this._targetRoll += rateX * dt;
        } else {
          this._targetRoll *= 0.97;
        }
        if (activeY) {
          this._targetPitch += rateY * dt;
        } else {
          this._targetPitch *= 0.97;
        }
        if (activeZ) {
          this._targetYaw += rateZ * dt;
        } else {
          this._targetYaw *= 0.97;
        }

        // Wrap angles to ±180
        this._targetRoll = ((this._targetRoll + 180) % 360 + 360) % 360 - 180;
        this._targetPitch = ((this._targetPitch + 180) % 360 + 360) % 360 - 180;
        this._targetYaw = ((this._targetYaw + 180) % 360 + 360) % 360 - 180;
      }
    } else {
      // --- INS / PFD mode ---
      if (hasRoll && hasPitch) {
        this._targetRoll = Number(data.roll);
        this._targetPitch = Number(data.pitch);
        this._hasAttitude = true;
      } else if (ax != null && ay != null && az != null) {
        const tilt = this._calculateImuTilt(Number(ax), Number(ay), Number(az));
        this._targetRoll = tilt.roll;
        this._targetPitch = tilt.pitch;
        this._isImuTilt = true;
        this._hasAttitude = true;
      } else {
        this._hasAttitude = false;
      }

      if (hasYaw) {
        this._targetYaw = Number(data.yaw);
      }
    }

    // --- 2. Turn Coordinator Metrics ---
    this._slipAccel = ax != null ? Number(ax) : 0;
    this._turnRate = gz != null ? Number(gz) : 0;

    // --- 3. UI Text Updates (throttled to 60Hz) ---
    if (now - this._lastUpdate < 16) return;
    this._lastUpdate = now;

    if (this.elNoAtt) {
      this.elNoAtt.style.display = this._hasAttitude ? 'none' : '';
    }

    const fmt = (v) => (v != null && !isNaN(v)) ? v.toFixed(2) + '°' : '--';
    if (this.elRoll) this.elRoll.textContent = fmt(this._targetRoll);
    if (this.elPitch) this.elPitch.textContent = fmt(this._targetPitch);
    if (this.elYaw) this.elYaw.textContent = hasYaw ? fmt(data.yaw) : '--';

    if (this.elInsStatus) {
      this.elInsStatus.textContent = data.ins_status || (this._isImuTilt ? 'IMU TILT' : '--');
      this.elInsStatus.style.color = this._isImuTilt ? '#FFC107' : '';
    }

    // Accel
    if (this.elAx) this.elAx.textContent = ax != null ? Number(ax).toFixed(3) : '--';
    if (this.elAy) this.elAy.textContent = ay != null ? Number(ay).toFixed(3) : '--';
    if (this.elAz) this.elAz.textContent = az != null ? Number(az).toFixed(3) : '--';

    // Gyro
    if (this.elGx) this.elGx.textContent = gx != null ? Number(gx).toFixed(3) : '--';
    if (this.elGy) this.elGy.textContent = gy != null ? Number(gy).toFixed(3) : '--';
    if (this.elGz) this.elGz.textContent = gz != null ? Number(gz).toFixed(3) : '--';

  }

  _calculateImuTilt(ax, ay, az) {
    // Pitch = atan2(Ay, Az), Roll = atan2(-Ax, Az)
    const radToDeg = 180 / Math.PI;
    const pitch = Math.atan2(ay, az) * radToDeg;
    const roll = Math.atan2(-ax, az) * radToDeg;
    return { roll, pitch };
  }

  _clearData() {
    this._targetRoll = 0;
    this._targetPitch = 0;
    this._targetYaw = 0;
    this._displayRoll = 0;
    this._displayPitch = 0;
    this._displayYaw = 0;
    this._hasAttitude = false;
    this._isImuTilt = false;
    this._slipAccel = 0;
    this._turnRate = 0;

    const dashes = '--';
    if (this.elRoll) this.elRoll.textContent = dashes;
    if (this.elPitch) this.elPitch.textContent = dashes;
    if (this.elYaw) this.elYaw.textContent = dashes;
    if (this.elInsStatus) {
      this.elInsStatus.textContent = dashes;
      this.elInsStatus.style.color = '';
    }
    if (this.elAx) this.elAx.textContent = dashes;
    if (this.elAy) this.elAy.textContent = dashes;
    if (this.elAz) this.elAz.textContent = dashes;
    if (this.elGx) this.elGx.textContent = dashes;
    if (this.elGy) this.elGy.textContent = dashes;
    if (this.elGz) this.elGz.textContent = dashes;
    if (this.elNoAtt) this.elNoAtt.style.display = 'none';
  }

  // --- Animation loop ---

  _startAnimation() {
    if (this._animId) return;
    const loop = () => {
      this._interpolateAttitude();
      this._drawPFD();
      this._animId = requestAnimationFrame(loop);
    };
    this._animId = requestAnimationFrame(loop);
  }

  _stopAnimation() {
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
  }

  _interpolateAttitude() {
    if (this._visualMode === 'ins') {
      // INS mode: Smooth animation for stable flight display
      const factor = 0.15;
      this._displayRoll += (this._targetRoll - this._displayRoll) * factor;
      this._displayPitch += (this._targetPitch - this._displayPitch) * factor;

      // Yaw: shortest path wrap-around
      let yawDiff = this._targetYaw - this._displayYaw;
      if (yawDiff > 180) yawDiff -= 360;
      if (yawDiff < -180) yawDiff += 360;
      this._displayYaw += yawDiff * factor;
      this._displayYaw = ((this._displayYaw % 360) + 360) % 360;
    } else {
      // IMU mode: Direct tracking, no interpolation lag
      this._displayRoll = this._targetRoll;
      this._displayPitch = this._targetPitch;
      this._displayYaw = this._targetYaw;
    }
  }

  // --- Canvas ---

  _resizeCanvas() {
    if (!this.canvas || !this.ctx) return;
    const container = this.canvas.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cw = rect.width;
    this._ch = rect.height;
  }

  _drawPFD() {
    const ctx = this.ctx;
    if (!ctx || this._cw === 0) return;

    const W = this._cw;
    const H = this._ch;
    const cx = W / 2;

    // Choose visualization based on mode
    if (this._visualMode === 'imu') {
      this._draw3DCube(ctx, W, H);
      return;
    }

    // INS mode: Draw PFD
    const cy = H / 2;
    const roll = this._displayRoll;
    const pitch = this._displayPitch;
    const yaw = this._displayYaw;

    // Pixels per degree for pitch
    const ppd = H / 40; // ±20° visible range

    ctx.save();
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);

    // --- Clipping circle for PFD area ---
    const pfdRadius = Math.min(W, H) * 0.44;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, pfdRadius, 0, Math.PI * 2);
    ctx.clip();

    // Rotate for roll
    ctx.translate(cx, cy);
    ctx.rotate(-roll * Math.PI / 180);

    // Pitch offset
    const pitchOffset = pitch * ppd;

    // --- Sky gradient ---
    const skyGrad = ctx.createLinearGradient(0, -H, 0, pitchOffset);
    skyGrad.addColorStop(0, '#0D47A1');
    skyGrad.addColorStop(0.5, '#1565C0');
    skyGrad.addColorStop(1, '#42A5F5');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(-W, -H * 2, W * 2, H * 2 + pitchOffset);

    // --- Ground gradient ---
    const gndGrad = ctx.createLinearGradient(0, pitchOffset, 0, H * 2);
    gndGrad.addColorStop(0, '#795548');
    gndGrad.addColorStop(0.5, '#5D4037');
    gndGrad.addColorStop(1, '#3E2723');
    ctx.fillStyle = gndGrad;
    ctx.fillRect(-W, pitchOffset, W * 2, H * 3);

    // --- Horizon line ---
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-W, pitchOffset);
    ctx.lineTo(W, pitchOffset);
    ctx.stroke();

    // --- Pitch ladder ---
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = 'bold 10px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1.5;

    for (let deg = -30; deg <= 30; deg += 5) {
      if (deg === 0) continue;
      const y = pitchOffset - deg * ppd;
      const isLarge = deg % 10 === 0;
      const halfW = isLarge ? 30 : 15;

      ctx.beginPath();
      if (deg < 0) {
        // Dashed for nose-down
        const dashLen = 4;
        for (let dx = -halfW; dx < halfW; dx += dashLen * 2) {
          ctx.moveTo(dx, y);
          ctx.lineTo(Math.min(dx + dashLen, halfW), y);
        }
      } else {
        ctx.moveTo(-halfW, y);
        ctx.lineTo(halfW, y);
      }
      ctx.stroke();

      if (isLarge) {
        ctx.fillText(`${Math.abs(deg)}`, halfW + 14, y);
        ctx.fillText(`${Math.abs(deg)}`, -halfW - 14, y);
      }
    }

    ctx.restore(); // Undo clip + rotate

    // --- Roll indicator (top arc) ---
    this._drawRollIndicator(ctx, cx, cy, pfdRadius, roll);

    // --- Aircraft symbol (fixed center) ---
    this._drawAircraftSymbol(ctx, cx, cy);

    // --- Slip Ball (Bottom Center) ---
    this._drawSlipBall(ctx, cx, cy, pfdRadius);

    // --- Turn Rate (Bottom Bar) ---
    this._drawTurnRate(ctx, cx, cy, pfdRadius);

    // --- IMU TILT Warning Overlay ---
    if (this._isImuTilt) {
      ctx.save();
      const flagText = "IMU TILT";
      ctx.font = 'bold 16px Segoe UI, sans-serif';
      const tm = ctx.measureText(flagText);
      const th = 20;

      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(cx - tm.width / 2 - 8, cy - 60, tm.width + 16, th + 4);

      ctx.fillStyle = '#FFC107'; // Amber (bootstrap warning)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(flagText, cx, cy - 58);
      ctx.restore();
    }

    // --- Heading tape (bottom) ---
    // this._drawHeadingTape(ctx, W, H, yaw);

    ctx.restore();
  }

  _drawRollIndicator(ctx, cx, cy, radius, rollDeg) {
    const arcR = radius + 6;

    ctx.save();
    ctx.translate(cx, cy);

    // Arc background
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, arcR, -Math.PI * 5 / 6, -Math.PI / 6);
    ctx.stroke();

    // Tick marks at ±10, ±20, ±30, ±45, ±60
    const ticks = [10, 20, 30, 45, 60];
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.5;

    for (const t of ticks) {
      for (const sign of [-1, 1]) {
        const angle = -Math.PI / 2 + sign * t * Math.PI / 180;
        const len = (t % 30 === 0) ? 10 : 6;
        const x1 = Math.cos(angle) * arcR;
        const y1 = Math.sin(angle) * arcR;
        const x2 = Math.cos(angle) * (arcR - len);
        const y2 = Math.sin(angle) * (arcR - len);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    // Zero (top) triangle marker
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    ctx.moveTo(0, -arcR);
    ctx.lineTo(-5, -arcR - 8);
    ctx.lineTo(5, -arcR - 8);
    ctx.closePath();
    ctx.fill();

    // Moving roll pointer (yellow triangle)
    const rollRad = -rollDeg * Math.PI / 180;
    ctx.save();
    ctx.rotate(rollRad);

    ctx.fillStyle = '#FFC107';
    ctx.beginPath();
    ctx.moveTo(0, -arcR + 2);
    ctx.lineTo(-5, -arcR + 12);
    ctx.lineTo(5, -arcR + 12);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
    ctx.restore();
  }

  _drawAircraftSymbol(ctx, cx, cy) {
    ctx.save();
    ctx.translate(cx, cy);

    // Wings
    ctx.strokeStyle = '#FFC107';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Left wing
    ctx.beginPath();
    ctx.moveTo(-40, 0);
    ctx.lineTo(-14, 0);
    ctx.lineTo(-14, 6);
    ctx.stroke();

    // Right wing
    ctx.beginPath();
    ctx.moveTo(40, 0);
    ctx.lineTo(14, 0);
    ctx.lineTo(14, 6);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = '#FFC107';
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawHeadingTape(ctx, W, H, yaw) {
    const tapeH = 22;
    const tapeY = H - tapeH;
    const ppd = W / 60; // 60° visible heading range

    ctx.save();

    // Tape background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, tapeY, W, tapeH);

    // Top border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, tapeY);
    ctx.lineTo(W, tapeY);
    ctx.stroke();

    // Cardinal directions
    const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    const cx = W / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = -180; deg <= 540; deg += 5) {
      let diff = deg - yaw;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;

      const x = cx + diff * ppd;
      if (x < -20 || x > W + 20) continue;

      const normDeg = ((deg % 360) + 360) % 360;

      if (deg % 10 === 0) {
        // Tick
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, tapeY);
        ctx.lineTo(x, tapeY + 4);
        ctx.stroke();
      }

      const cardinal = cardinals[normDeg];
      if (cardinal) {
        ctx.fillStyle = cardinal === 'N' ? '#EF4444' : 'rgba(255, 255, 255, 0.85)';
        ctx.font = cardinal.length === 1 ? 'bold 11px Segoe UI, sans-serif' : '9px Segoe UI, sans-serif';
        ctx.fillText(cardinal, x, tapeY + 13);
      } else if (normDeg % 30 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '9px Segoe UI, sans-serif';
        ctx.fillText(`${normDeg}`, x, tapeY + 13);
      }
    }

    // Center pointer (yellow triangle)
    ctx.fillStyle = '#FFC107';
    ctx.beginPath();
    ctx.moveTo(cx, tapeY);
    ctx.lineTo(cx - 4, tapeY - 5);
    ctx.lineTo(cx + 4, tapeY - 5);
    ctx.closePath();
    ctx.fill();

    // Heading value readout
    ctx.fillStyle = '#FFC107';
    ctx.font = 'bold 10px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(yaw)}°`, cx, tapeY - 10);

    ctx.restore();
  }

  _draw3DCube(ctx, W, H) {
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;
    const size = Math.min(W, H) * 0.22;

    ctx.save();
    ctx.translate(cx, cy);

    // Convert accumulated angles to radians
    const roll = this._displayRoll * Math.PI / 180;
    const pitch = this._displayPitch * Math.PI / 180;
    const yaw = this._displayYaw * Math.PI / 180;

    // Define cube vertices
    const s = size;
    const vertices = [
      [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
      [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]
    ];

    // Rotate and project vertices
    const rotated = vertices.map(v => {
      let [x, y, z] = v;
      let x1 = x * Math.cos(yaw) - y * Math.sin(yaw);
      let y1 = x * Math.sin(yaw) + y * Math.cos(yaw);
      let z1 = z;
      let x2 = x1 * Math.cos(pitch) + z1 * Math.sin(pitch);
      let y2 = y1;
      let z2 = -x1 * Math.sin(pitch) + z1 * Math.cos(pitch);
      let x3 = x2;
      let y3 = y2 * Math.cos(roll) - z2 * Math.sin(roll);
      let z3 = y2 * Math.sin(roll) + z2 * Math.cos(roll);
      const distance = 500;
      const scale = distance / (distance + z3);
      return [x3 * scale, y3 * scale, z3];
    });

    // Draw cube faces with transparency for depth
    const faces = [
      { verts: [0, 1, 2, 3], color: 'rgba(30, 60, 120, 0.15)' },
      { verts: [4, 5, 6, 7], color: 'rgba(30, 60, 120, 0.15)' },
      { verts: [0, 1, 5, 4], color: 'rgba(20, 80, 140, 0.10)' },
      { verts: [2, 3, 7, 6], color: 'rgba(20, 80, 140, 0.10)' },
      { verts: [0, 3, 7, 4], color: 'rgba(40, 50, 100, 0.10)' },
      { verts: [1, 2, 6, 5], color: 'rgba(40, 50, 100, 0.10)' },
    ];

    // Sort faces by average Z (painter's algorithm)
    faces.sort((a, b) => {
      const avgZa = a.verts.reduce((s, i) => s + rotated[i][2], 0) / 4;
      const avgZb = b.verts.reduce((s, i) => s + rotated[i][2], 0) / 4;
      return avgZa - avgZb;
    });

    faces.forEach(face => {
      ctx.fillStyle = face.color;
      ctx.beginPath();
      ctx.moveTo(rotated[face.verts[0]][0], rotated[face.verts[0]][1]);
      for (let i = 1; i < face.verts.length; i++) {
        ctx.lineTo(rotated[face.verts[i]][0], rotated[face.verts[i]][1]);
      }
      ctx.closePath();
      ctx.fill();
    });

    // Draw cube edges
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];

    ctx.strokeStyle = 'rgba(100, 180, 255, 0.5)';
    ctx.lineWidth = 1.5;
    edges.forEach(([i, j]) => {
      ctx.beginPath();
      ctx.moveTo(rotated[i][0], rotated[i][1]);
      ctx.lineTo(rotated[j][0], rotated[j][1]);
      ctx.stroke();
    });

    // --- Draw axis arrows with data values ---
    const axisLen = size * 1.6;
    const fmtVal = (v) => v != null ? Number(v).toFixed(1) : '--';

    // X-axis (Red)
    const xEnd = this._rotatePoint([axisLen, 0, 0], roll, pitch, yaw);
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(xEnd[0], xEnd[1]); ctx.stroke();
    // Arrowhead
    this._drawArrowHead(ctx, xEnd[0], xEnd[1], Math.atan2(xEnd[1], xEnd[0]), '#EF4444');
    // Label: X with accel + gyro values
    ctx.fillStyle = '#EF4444';
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    const xLabelX = xEnd[0] + 8;
    const xLabelY = xEnd[1];
    ctx.fillText('X', xLabelX, xLabelY - 6);
    ctx.font = '9px Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(255,140,140,0.9)';
    ctx.fillText(`A: ${fmtVal(this._rawAx)}`, xLabelX, xLabelY + 6);
    ctx.fillText(`G: ${fmtVal(this._rawGx)}`, xLabelX, xLabelY + 17);

    // Y-axis (Green)
    const yEnd = this._rotatePoint([0, axisLen, 0], roll, pitch, yaw);
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(yEnd[0], yEnd[1]); ctx.stroke();
    this._drawArrowHead(ctx, yEnd[0], yEnd[1], Math.atan2(yEnd[1], yEnd[0]), '#10B981');
    ctx.fillStyle = '#10B981';
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    const yLabelX = yEnd[0] + 8;
    const yLabelY = yEnd[1];
    ctx.fillText('Y', yLabelX, yLabelY - 6);
    ctx.font = '9px Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(100,255,180,0.9)';
    ctx.fillText(`A: ${fmtVal(this._rawAy)}`, yLabelX, yLabelY + 6);
    ctx.fillText(`G: ${fmtVal(this._rawGy)}`, yLabelX, yLabelY + 17);

    // Z-axis (Blue)
    const zEnd = this._rotatePoint([0, 0, axisLen], roll, pitch, yaw);
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(zEnd[0], zEnd[1]); ctx.stroke();
    this._drawArrowHead(ctx, zEnd[0], zEnd[1], Math.atan2(zEnd[1], zEnd[0]), '#3B82F6');
    ctx.fillStyle = '#3B82F6';
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    const zLabelX = zEnd[0] + 8;
    const zLabelY = zEnd[1];
    ctx.fillText('Z', zLabelX, zLabelY - 6);
    ctx.font = '9px Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(120,170,255,0.9)';
    ctx.fillText(`A: ${fmtVal(this._rawAz)}`, zLabelX, zLabelY + 6);
    ctx.fillText(`G: ${fmtVal(this._rawGz)}`, zLabelX, zLabelY + 17);

    ctx.restore();
  }

  _drawArrowHead(ctx, x, y, angle, color) {
    const headLen = 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - headLen * Math.cos(angle - 0.4), y - headLen * Math.sin(angle - 0.4));
    ctx.lineTo(x - headLen * Math.cos(angle + 0.4), y - headLen * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  _rotatePoint(point, roll, pitch, yaw) {
    let [x, y, z] = point;

    // Yaw (Z)
    let x1 = x * Math.cos(yaw) - y * Math.sin(yaw);
    let y1 = x * Math.sin(yaw) + y * Math.cos(yaw);
    let z1 = z;

    // Pitch (Y)
    let x2 = x1 * Math.cos(pitch) + z1 * Math.sin(pitch);
    let y2 = y1;
    let z2 = -x1 * Math.sin(pitch) + z1 * Math.cos(pitch);

    // Roll (X)
    let x3 = x2;
    let y3 = y2 * Math.cos(roll) - z2 * Math.sin(roll);
    let z3 = y2 * Math.sin(roll) + z2 * Math.cos(roll);

    // Perspective
    const distance = 500;
    const scale = distance / (distance + z3);
    return [x3 * scale, y3 * scale, z3];
  }

  _drawSlipBall(ctx, cx, cy, radius) {
    const yPos = cy + radius * 0.75;
    const width = 100;
    const height = 14;

    ctx.save();

    // Tube Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;

    // Draw slightly curved tube or straight bar
    ctx.beginPath();
    ctx.rect(cx - width / 2, yPos - height / 2, width, height);
    ctx.fill();
    ctx.stroke();

    // Center markers
    ctx.beginPath();
    ctx.moveTo(cx - 8, yPos - height / 2);
    ctx.lineTo(cx - 8, yPos + height / 2);
    ctx.moveTo(cx + 8, yPos - height / 2);
    ctx.lineTo(cx + 8, yPos + height / 2);
    ctx.stroke();

    // The Ball
    // Driven by Lateral Accel (Ax)
    // Scale: 5 m/s^2 (~0.5g) is full scale deflection
    const maxAccel = 5.0;
    let offset = (this._slipAccel / maxAccel) * (width / 2 - 6);

    // Clamp
    offset = Math.max(-width / 2 + 6, Math.min(width / 2 - 6, offset));

    ctx.fillStyle = '#E0E0E0'; // White/Grey ball
    ctx.beginPath();
    ctx.arc(cx + offset, yPos, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawTurnRate(ctx, cx, cy, radius) {
    // Simple bar indicating yaw rate (deg/s)
    const barY = cy + radius * 0.60;
    const width = 100;
    const height = 6;

    ctx.save();

    // Scale
    // Standard Rate = 3 deg/s. High speed turn = 6 deg/s.
    // Let's make 6 deg/s full scale.
    const maxRate = 6.0;
    const rateLen = (this._turnRate / maxRate) * (width / 2);
    const clampedLen = Math.max(-width / 2, Math.min(width / 2, rateLen));

    // Center Reference
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(cx - 1, barY - 3, 2, height + 6);

    // Standard Rate turn markers (Tick at 3 deg/s)
    const markerOff = (3.0 / maxRate) * (width / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillRect(cx - markerOff - 1, barY + height, 2, 4);
    ctx.fillRect(cx + markerOff - 1, barY + height, 2, 4);

    // Rate Bar
    ctx.fillStyle = '#E91E63'; // Pinkish for turn rate
    ctx.fillRect(cx, barY, clampedLen, height);

    ctx.restore();
  }

  _getCommandName(source) {
    if (!source) return null;
    if (source.log_command) return source.log_command;

    // For ASCII messages, use the tag/name directly
    // For binary messages, use the ID
    const name = source.name || source.tag || String(source.id);
    const lookupName = String(name).toUpperCase();

    // NMEA messages need GP prefix
    if (this.NMEA_MESSAGES.has(lookupName)) return `GP${lookupName}`;

    // Return the name/tag for ASCII, or string ID for binary
    return name;
  }
}
