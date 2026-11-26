import { clamp, getTreeBounds, getTreeTotalDuration } from './tree.js';

/**
 * Smooth easing curve for organic branch extension.
 * @param {number} t Normalized progress [0, 1]
 * @returns {number}
 */
function easeInOutSine(t) {
  return 0.5 * (1 - Math.cos(Math.PI * t));
}

/**
 * Smooth deceleration curve for blooming leaf tips.
 * @param {number} t Normalized progress [0, 1]
 * @returns {number}
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Linearly interpolate between two RGB triples and return a CSS rgb() string.
 * @param {[number, number, number]} c1
 * @param {[number, number, number]} c2
 * @param {number} t
 * @returns {string}
 */
function lerpRgb(c1, c2, t) {
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

// Calm night-garden bark-to-seafoam color stops across depth
const COLOR_TRUNK = [88, 114, 122];     // moonlit slate-cedar
const COLOR_MID = [94, 148, 142];       // misty sage-teal
const COLOR_TWIG = [132, 214, 192];     // soft seafoam-mint

/**
 * Create an offscreen radial glow sprite for crisp, lag-free bioluminescence
 * across hundreds of leaves and fireflies.
 * @param {string} innerColor
 * @param {string} midColor
 * @param {string} outerColor
 * @returns {HTMLCanvasElement}
 */
function createGlowSprite(innerColor, midColor, outerColor) {
  const size = 64;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext('2d');
  const half = size / 2;

  const grad = sctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, innerColor);
  grad.addColorStop(0.35, midColor);
  grad.addColorStop(1, outerColor);

  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, size, size);
  return sprite;
}

/**
 * Manages HTML5 Canvas rendering, viewport fitting, fireflies,
 * and requestAnimationFrame animation playback for a fractal tree.
 */
export class TreeRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [callbacks]
   * @param {(state: string, progress: number) => void} [callbacks.onStateChange]
   */
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onStateChange = callbacks.onStateChange || (() => {});
    this.onProgress = callbacks.onProgress || (() => {});
    this.getAudioLevel = callbacks.getAudioLevel || (() => 0);

    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    this.events = [];
    this.maxDepth = 7;
    this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
    this.totalDuration = 0;

    this.state = 'preview'; // 'idle' | 'preview' | 'growing' | 'paused' | 'complete'
    this.elapsed = 0;     // seconds in 1.0x tree timeline
    this.ambientTime = 0; // seconds for gentle fireflies and leaf breathing
    this.smoothedAudioLevel = 0;
    this.highlightedBranches = new Map(); // branchId -> { start, duration }
    this.speed = 1;
    this.reducedMotion = false;

    this.rafId = null;
    this.lastTimestamp = null;

    this.fireflies = [];
    this.leafGlowSprite = createGlowSprite(
      'rgba(182, 255, 224, 0.92)',
      'rgba(116, 226, 194, 0.35)',
      'rgba(116, 226, 194, 0)'
    );
    this.fireflyGlowSprite = createGlowSprite(
      'rgba(222, 252, 180, 0.95)',
      'rgba(154, 238, 178, 0.36)',
      'rgba(154, 238, 178, 0)'
    );
    this.tipGlowSprite = createGlowSprite(
      'rgba(210, 255, 238, 0.95)',
      'rgba(130, 232, 200, 0.42)',
      'rgba(130, 232, 200, 0)'
    );

    this.resizeObserver = null;
    this.bindResize();
  }

  /**
   * Observe canvas container size changes and keep DPR sharp.
   */
  bindResize() {
    const updateSize = () => {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      this.width = rect.width;
      this.height = rect.height;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);

      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      this.syncFireflies();
      const targetAudio = this.reducedMotion ? 0 : clamp(this.getAudioLevel(), 0, 1);
      this.smoothedAudioLevel += (targetAudio - this.smoothedAudioLevel) * 0.14;

      this.draw();
    };

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(updateSize);
      if (this.canvas.parentElement) {
        this.resizeObserver.observe(this.canvas.parentElement);
      }
    }
    window.addEventListener('resize', updateSize);
    this._cleanupResize = () => {
      if (this.resizeObserver) this.resizeObserver.disconnect();
      window.removeEventListener('resize', updateSize);
    };

    updateSize();
  }

  /**
   * Populate ambient fireflies scaled gently to viewport area.
   */
  syncFireflies() {
    const area = this.width * this.height;
    const targetCount = clamp(Math.round(area / 28000), 14, 34);

    if (this.fireflies.length === targetCount) return;

    this.fireflies = Array.from({ length: targetCount }, (_, i) => {
      // Deterministic gentle placement across the night garden
      const rx = ((i * 73 + 19) % 97) / 97;
      const ry = ((i * 41 + 11) % 89) / 89;
      return {
        baseX: 0.06 + rx * 0.88,
        baseY: 0.08 + ry * 0.78,
        driftX: 12 + (i % 5) * 6,
        driftY: 8 + (i % 4) * 5,
        speedX: 0.22 + (i % 7) * 0.05,
        speedY: 0.18 + (i % 5) * 0.04,
        phase: i * 1.37,
        pulseSpeed: 0.8 + (i % 6) * 0.22,
        size: 1.5 + (i % 3) * 0.7,
      };
    });
  }

  /**
   * Highlight a branch briefly while its musical note is playing.
   * @param {number} branchId
   * @param {number} [duration=0.75]
   */
  highlightBranch(branchId, duration = 0.75) {
    if (this.reducedMotion) return;
    this.highlightedBranches.set(branchId, {
      start: this.ambientTime,
      duration: clamp(Number(duration) || 0.75, 0.25, 1.4),
    });
  }

  /**
   * Clear active playing branch highlights.
   */
  clearHighlights() {
    this.highlightedBranches.clear();
  }

  /**
   * Immediately show a complete still preview of the tree and stop active playback.
   * @param {Array<Object>} events
   * @param {number} maxDepth
   */
  showPreview(events, maxDepth) {
    this.events = events;
    this.maxDepth = maxDepth;
    this.bounds = getTreeBounds(events);
    this.totalDuration = getTreeTotalDuration(events);
    this.elapsed = this.totalDuration;
    this.state = 'preview';
    this.lastTimestamp = null;
    this.clearHighlights();

    this.draw();
    this.emitState();
    this.ensureLoop();
  }

  /**
   * Set the generated branch events while preserving normalized playback state.
   * @param {Array<Object>} events
   * @param {number} maxDepth
   */
  setTree(events, maxDepth) {
    this.showPreview(events, maxDepth);
  }

  /**
   * Update playback speed multiplier (0.5x to 2x).
   * @param {number} speed
   */
  setSpeed(speed) {
    this.speed = clamp(Number(speed) || 1, 0.5, 2);
  }

  /**
   * Toggle reduced-motion behavior.
   * @param {boolean} reduced
   */
  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
    if (this.reducedMotion) {
      this.elapsed = this.totalDuration;
      this.state = 'complete';
      this.smoothedAudioLevel = 0;
      this.clearHighlights();
      this.stopLoop();
      this.draw();
      this.emitState();
    } else {
      this.ensureLoop();
    }
  }

  /**
   * Start or restart tree growth from the beginning.
   */
  grow() {
    this.clearHighlights();
    if (this.reducedMotion) {
      this.elapsed = this.totalDuration;
      this.state = 'complete';
      this.draw();
      this.emitState();
      return;
    }

    this.elapsed = 0;
    this.state = 'growing';
    this.lastTimestamp = null;
    this.draw();
    this.emitState();
    this.ensureLoop();
  }

  /**
   * Pause growth if growing, or resume if paused.
   */
  togglePause() {
    if (this.reducedMotion) return;

    if (this.state === 'growing') {
      this.state = 'paused';
      this.stopLoop();
      this.draw();
      this.emitState();
    } else if (this.state === 'paused') {
      this.state = 'growing';
      this.lastTimestamp = null;
      this.emitState();
      this.ensureLoop();
    }
  }

  /**
   * Reset growth back to the initial un-grown seed state.
   */
  reset() {
    this.elapsed = 0;
    this.state = 'idle';
    this.lastTimestamp = null;
    this.smoothedAudioLevel = 0;
    this.clearHighlights();
    this.draw();
    this.emitState();
    this.ensureLoop();
  }

  /**
   * Notify UI of current playback state and normalized progress.
   */
  emitState() {
    const progress =
      this.state === 'preview' || this.totalDuration <= 0
        ? 0
        : clamp(this.elapsed / this.totalDuration, 0, 1);
    this.onStateChange(this.state, progress);
  }

  /**
   * Start the requestAnimationFrame loop only when motion is active.
   */
  ensureLoop() {
    if (this.reducedMotion || this.state === 'paused') {
      this.stopLoop();
      return;
    }

    if (this.rafId !== null) return;

    const tick = (timestamp) => {
      if (this.lastTimestamp === null) {
        this.lastTimestamp = timestamp;
      }
      const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.1);
      this.lastTimestamp = timestamp;

      this.ambientTime += dt;

      if (this.state === 'growing') {
        const prevElapsed = this.elapsed;
        this.elapsed += dt * this.speed;
        if (this.elapsed >= this.totalDuration) {
          this.elapsed = this.totalDuration;
          this.state = 'complete';
          this.onProgress(this.elapsed, prevElapsed, this.state);
          this.emitState();
        } else {
          this.onProgress(this.elapsed, prevElapsed, this.state);
          this.emitState();
        }
      }

      const targetAudio = this.reducedMotion ? 0 : clamp(this.getAudioLevel(), 0, 1);
      this.smoothedAudioLevel += (targetAudio - this.smoothedAudioLevel) * 0.14;

      this.draw();

      if (!this.reducedMotion && this.state !== 'paused') {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = null;
      }
    };

    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * Stop any active animation frame cleanly.
   */
  stopLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastTimestamp = null;
  }

  /**
   * Compute viewport fit transform so the entire tree always fits cleanly
   * inside the canvas regardless of depth, angle, randomness, or screen size.
   * @returns {{ scale: number, offsetX: number, offsetY: number, groundY: number }}
   */
  computeFitTransform() {
    const w = this.width;
    const h = this.height;
    const padX = Math.max(26, w * 0.08);
    const padTop = Math.max(30, h * 0.10);
    const padBottom = Math.max(34, h * 0.09);

    const availW = Math.max(40, w - padX * 2);
    const availH = Math.max(40, h - padTop - padBottom);

    const treeW = Math.max(this.bounds.width, 1);
    const treeH = Math.max(this.bounds.height, 1);

    const scaleX = availW / treeW;
    const scaleY = availH / treeH;
    // Keep a single depth-1 trunk gracefully proportioned (~55% of available height)
    const maxScale = (availH * 0.56) / 100;
    const scale = Math.min(scaleX, scaleY, maxScale);

    const renderedW = this.bounds.width * scale;
    const renderedH = this.bounds.height * scale;

    const offsetX = padX + (availW - renderedW) / 2 - this.bounds.minX * scale;
    const offsetY = padTop + (availH - renderedH) * 0.88 - this.bounds.minY * scale;

    // Ground curve sits directly beneath the trunk origin (0, 0)
    const groundY = Math.min(h - 14, Math.max(offsetY, padTop + availH * 0.85));

    return { scale, offsetX, offsetY, groundY };
  }

  /**
   * Draw the calm night garden background, ground silhouette, fireflies,
   * growing branches, and soft glowing leaves.
   */
  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    // 1. Deep blue-green twilight sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
    skyGrad.addColorStop(0, '#041019');
    skyGrad.addColorStop(0.55, '#09222e');
    skyGrad.addColorStop(1, '#10343f');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // Subtle moonlit canopy aura
    const auraGrad = ctx.createRadialGradient(
      w * 0.5,
      h * 0.42,
      Math.min(w, h) * 0.04,
      w * 0.5,
      h * 0.42,
      Math.max(w, h) * 0.55
    );
    auraGrad.addColorStop(0, 'rgba(72, 168, 162, 0.12)');
    auraGrad.addColorStop(0.6, 'rgba(32, 96, 112, 0.05)');
    auraGrad.addColorStop(1, 'rgba(4, 16, 25, 0)');
    ctx.fillStyle = auraGrad;
    ctx.fillRect(0, 0, w, h);

    const transform = this.computeFitTransform();

    // 2. Distant stars & background fireflies
    this.drawFireflies(ctx, w, h, true);

    // 3. Soft mossy garden horizon mound beneath the tree
    this.drawGardenGround(ctx, w, h, transform.offsetX, transform.groundY);

    // 4. Fractal tree branches and glowing base-case leaves
    this.drawTree(ctx, transform);

    // 5. Foreground gentle fireflies
    this.drawFireflies(ctx, w, h, false);
  }

  /**
   * Draw the subtle night garden mound where the tree is rooted.
   */
  drawGardenGround(ctx, w, h, rootX, groundY) {
    const moundTop = Math.min(h - 8, groundY - 2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, moundTop + 18);
    ctx.quadraticCurveTo(rootX, moundTop - 10, w, moundTop + 20);
    ctx.lineTo(w, h);
    ctx.closePath();

    const groundGrad = ctx.createLinearGradient(0, moundTop - 10, 0, h);
    groundGrad.addColorStop(0, '#0a2028');
    groundGrad.addColorStop(1, '#040c11');
    ctx.fillStyle = groundGrad;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Draw gentle glowing fireflies split across background and foreground layers.
   */
  drawFireflies(ctx, w, h, isBackgroundLayer) {
    const t = this.reducedMotion ? 0 : this.ambientTime;
    const audioBoost = this.reducedMotion ? 0 : this.smoothedAudioLevel;

    for (let i = 0; i < this.fireflies.length; i++) {
      const f = this.fireflies[i];
      if ((i % 2 === 0) !== isBackgroundLayer) continue;

      const x = f.baseX * w + Math.sin(t * f.speedX + f.phase) * f.driftX;
      const y = f.baseY * h + Math.cos(t * f.speedY + f.phase * 1.3) * f.driftY;
      const basePulse = this.reducedMotion
        ? 0.55
        : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * f.pulseSpeed + f.phase));
      const pulse = clamp(basePulse + audioBoost * 0.32, 0.25, 1.0);

      const glowRadius = f.size * (isBackgroundLayer ? 6.5 : 8.5) * (1 + audioBoost * 0.24);
      ctx.save();
      ctx.globalAlpha = clamp((isBackgroundLayer ? 0.45 : 0.72) * pulse, 0, 1);
      ctx.drawImage(
        this.fireflyGlowSprite,
        x - glowRadius,
        y - glowRadius,
        glowRadius * 2,
        glowRadius * 2
      );

      ctx.globalAlpha = (isBackgroundLayer ? 0.6 : 0.9) * pulse;
      ctx.fillStyle = '#e7ffbe';
      ctx.beginPath();
      ctx.arc(x, y, f.size * (isBackgroundLayer ? 0.7 : 0.95), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Draw branches up to current elapsed time and soft glowing leaves at base cases.
   */
  drawTree(ctx, { scale, offsetX, offsetY }) {
    const rootX = offsetX;
    const rootY = offsetY;

    // In idle state before growth begins, show a serene glowing seed resting on the soil
    if (this.elapsed <= 0 || this.events.length === 0) {
      const seedPulse = this.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(this.ambientTime * 2.2);
      const r = 18 * seedPulse;
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.drawImage(this.leafGlowSprite, rootX - r, rootY - r, r * 2, r * 2);
      ctx.fillStyle = '#9ff0d3';
      ctx.beginPath();
      ctx.arc(rootX, rootY, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    const baseStroke = clamp(Math.min(this.width, this.height) * 0.022, 6.5, 13.5);
    const taper = this.maxDepth <= 4 ? 0.68 : 0.74;
    const leafBaseSize = clamp(
      Math.min(this.width, this.height) * (this.maxDepth >= 9 ? 0.011 : 0.018),
      3.4,
      11
    );

    // Prune expired playing-branch highlights
    if (this.highlightedBranches.size > 0) {
      for (const [id, info] of this.highlightedBranches) {
        if (this.ambientTime - info.start > info.duration) {
          this.highlightedBranches.delete(id);
        }
      }
    }

    const leavesToDraw = [];

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const branch of this.events) {
      if (branch.startTime >= this.elapsed) {
        // Events are sorted chronologically by startTime
        break;
      }

      const rawProgress = clamp((this.elapsed - branch.startTime) / branch.duration, 0, 1);
      const progress = easeInOutSine(rawProgress);

      const sx = branch.startX * scale + offsetX;
      const sy = branch.startY * scale + offsetY;
      const ex = branch.endX * scale + offsetX;
      const ey = branch.endY * scale + offsetY;

      const curX = sx + (ex - sx) * progress;
      const curY = sy + (ey - sy) * progress;

      const depthNorm =
        this.maxDepth > 1 ? (branch.depth - 1) / (this.maxDepth - 1) : 0;

      const branchColor =
        depthNorm < 0.5
          ? lerpRgb(COLOR_TRUNK, COLOR_MID, depthNorm * 2)
          : lerpRgb(COLOR_MID, COLOR_TWIG, (depthNorm - 0.5) * 2);

      const lineWidth = Math.max(0.95, baseStroke * Math.pow(taper, branch.depth - 1));

      ctx.strokeStyle = branchColor;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(curX, curY);
      ctx.stroke();

      const highlightInfo = this.highlightedBranches.get(branch.id);
      if (highlightInfo) {
        const hlAlpha = clamp(
          1 - (this.ambientTime - highlightInfo.start) / highlightInfo.duration,
          0,
          1
        );
        ctx.strokeStyle = `rgba(176, 255, 228, ${(0.36 * hlAlpha).toFixed(3)})`;
        ctx.lineWidth = lineWidth + 5.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(curX, curY);
        ctx.stroke();

        ctx.strokeStyle = `rgba(232, 255, 245, ${(0.82 * hlAlpha).toFixed(3)})`;
        ctx.lineWidth = lineWidth + 1.1;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(curX, curY);
        ctx.stroke();
      }

      // Gentle glowing energy spark at actively growing branch tips
      if (rawProgress > 0 && rawProgress < 1) {
        const sparkRadius = Math.max(5, lineWidth * 2.1);
        ctx.globalAlpha = 0.75;
        ctx.drawImage(
          this.tipGlowSprite,
          curX - sparkRadius,
          curY - sparkRadius,
          sparkRadius * 2,
          sparkRadius * 2
        );
        ctx.globalAlpha = 1;
      }

      // Queue base-case leaves to render softly on top of twigs
      if (branch.isLeaf && rawProgress > 0.55) {
        const leafRaw = clamp((rawProgress - 0.55) / 0.45, 0, 1);
        leavesToDraw.push({
          x: curX,
          y: curY,
          angle: branch.angle,
          bloom: easeOutCubic(leafRaw),
          phase: branch.id * 0.73,
        });
      }
    }

    // Draw soft glowing leaves at base-case branch tips
    const audioBoost = this.reducedMotion ? 0 : this.smoothedAudioLevel;
    for (const leaf of leavesToDraw) {
      const breathe = this.reducedMotion
        ? 1
        : 0.9 + 0.1 * Math.sin(this.ambientTime * 1.6 + leaf.phase);
      const glowRadius = leafBaseSize * 2.1 * leaf.bloom * breathe * (1 + audioBoost * 0.28);
      const petalLen = leafBaseSize * 0.85 * leaf.bloom;
      const petalWidth = petalLen * 0.48;

      ctx.save();
      ctx.globalAlpha = clamp((0.72 + audioBoost * 0.24) * leaf.bloom * breathe, 0, 1);
      ctx.drawImage(
        this.leafGlowSprite,
        leaf.x - glowRadius,
        leaf.y - glowRadius,
        glowRadius * 2,
        glowRadius * 2
      );

      ctx.translate(leaf.x, leaf.y);
      ctx.rotate(leaf.angle);
      ctx.globalAlpha = 0.86 * leaf.bloom;
      ctx.fillStyle = '#a8f5d6';
      ctx.beginPath();
      ctx.ellipse(petalLen * 0.35, 0, petalLen * 0.6, petalWidth * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Clean up listeners and animation frames.
   */
  destroy() {
    this.stopLoop();
    if (this._cleanupResize) {
      this._cleanupResize();
    }
  }
}
