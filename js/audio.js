import { clamp } from './tree.js';
import {
  AUDIO_FILES,
  AUDIO_LABELS,
  MAX_SIMULTANEOUS_NOTES,
  REVERB_PRESETS,
  SCALES,
  buildCycleSchedule,
  createCrossfadedLoopBuffer,
  createGardenAudioGraph,
  createPinkNoiseBuffer,
  findActiveStartOffset,
  getBranchPentatonicSemitones,
  semitonesToNoteName,
  semitonesToPlaybackRate,
} from './audio-graph.js';

export { REVERB_PRESETS, SCALES, getBranchPentatonicSemitones, semitonesToPlaybackRate };

const LAYER_FADE_SECONDS = 2.4;

/**
 * Web Audio API live sound engine for Fractal Garden.
 * Shares the deterministic routing graph and cycle schedule with OfflineAudioContext export.
 */
export class GardenAudio {
  /**
   * @param {Object} [callbacks]
   * @param {(info: { ready: boolean, missing: string[], message: string }) => void} [callbacks.onStatusChange]
   */
  constructor(callbacks = {}) {
    this.onStatusChange = callbacks.onStatusChange || (() => {});
    this.onNoteTriggered = callbacks.onNoteTriggered || (() => {});

    this.ctx = null;
    this.graph = null;
    this.initialized = false;
    this.loadingStarted = false;
    this.isPlayingTree = false;
    this.isPaused = false;
    this.isSettled = false;
    this.isSleepFaded = false;
    this.transportEpoch = 0;

    this.masterVolume = 0.8;
    this.preMuteVolume = 0.8;
    this.notesVolume = 0.8;
    this.leavesVolume = 0.7;
    this.ambientVolume = 0.52;
    this.reverbAmount = 0.42;
    this.reverbPreset = 'forest';
    this.muted = false;

    this.scale = 'c-major';
    this.pendingTempo = 70;
    this.activeTempo = 70;
    this.seed = 4217;
    this.scheduleSpeed = 1;

    this.layers = {
      rain: { enabled: true, volume: 0.48 },
      night: { enabled: true, volume: 0.52 },
      pad: { enabled: true, volume: 0.46 },
      wind: { enabled: true, volume: 0.36 },
    };

    this.layerHandles = {
      rain: null,
      night: null,
      pad: null,
      wind: null,
    };

    this.buffers = new Map();
    this.activeOffsets = new Map();
    this.loadingPromises = new Map();
    this.missingFiles = [];
    this.pinkNoiseBuffer = null;

    this.suspendTimer = null;
    this.chordInterval = null;
    this.currentChordIndex = 0;
    this.growthStartTime = 0;
    this.currentCycleSchedule = null;

    this.activeNotes = new Set();
    this.gridOrigin = 0;
    this.lastScheduledTime = -Infinity;
    this.energyData = null;
  }

  /**
   * Ensure AudioContext is created and resumed inside a user gesture handler.
   * @returns {Promise<boolean>}
   */
  async unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      this.emitStatus('Web Audio API is unavailable in this browser.');
      return false;
    }

    if (!this.ctx) {
      this.ctx = new AudioCtx();
      this.graph = createGardenAudioGraph(this.ctx, {
        masterVolume: this.masterVolume,
        notesVolume: this.notesVolume,
        leavesVolume: this.leavesVolume,
        ambientVolume: this.ambientVolume,
        reverbAmount: this.reverbAmount,
        reverbPreset: this.reverbPreset,
        seed: this.seed,
        muted: this.muted,
        withAnalyser: true,
      });

      this.syncLayerBusVolumes();
      this.pinkNoiseBuffer = createPinkNoiseBuffer(this.ctx, 4, this.seed);
      if (this.graph.analyser) {
        this.energyData = new Uint8Array(this.graph.analyser.fftSize);
      }

      this.initialized = true;
      this.gridOrigin = this.ctx.currentTime;
    }

    if (!this.loadingStarted) {
      this.loadingStarted = true;
      this.loadAllAssets();
    }

    if (this.ctx.state === 'suspended' && !this.isPaused) {
      try {
        await this.ctx.resume();
      } catch {
        // Ignore resume failure outside gesture
      }
    }

    return true;
  }

  syncLayerBusVolumes() {
    if (!this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    this.graph.rainBus.gain.setValueAtTime(this.layers.rain.volume, now);
    this.graph.nightBus.gain.setValueAtTime(this.layers.night.volume, now);
    this.graph.padBus.gain.setValueAtTime(this.layers.pad.volume, now);
    this.graph.windBus.gain.setValueAtTime(this.layers.wind.volume, now);
  }

  async loadAllAssets() {
    const entries = Object.entries(AUDIO_FILES);
    const missing = [];

    await Promise.all(
      entries.map(([key, url]) => {
        const task = (async () => {
          try {
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const decoded = await this.ctx.decodeAudioData(arrayBuffer);

            if (key === 'ambientRain' || key === 'ambientNight') {
              this.buffers.set(key, createCrossfadedLoopBuffer(this.ctx, decoded, 2.5));
            } else {
              this.buffers.set(key, decoded);
              this.activeOffsets.set(key, findActiveStartOffset(decoded));
            }
          } catch {
            missing.push(AUDIO_LABELS[key]);
          }
        })();
        this.loadingPromises.set(key, task);
        return task;
      })
    );

    this.missingFiles = missing;

    if (this.isPlayingTree && !this.isPaused) {
      this.syncAllLayers(LAYER_FADE_SECONDS);
    }

    if (missing.length > 0) {
      this.emitStatus(
        `Missing or unreadable audio file(s): ${missing.join(', ')} — using soft synthesized fallback.`
      );
    } else {
      this.emitActiveSummary();
    }
  }

  emitActiveSummary() {
    if (!this.initialized || this.missingFiles.length > 0) return;
    const scaleName = this.scale === 'a-minor' ? 'A minor' : 'C major';
    const presetName = (REVERB_PRESETS[this.reverbPreset] || REVERB_PRESETS.forest).label;
    this.emitStatus(`Audio ready · ${scaleName} · ${this.activeTempo} BPM · ${presetName}`);
  }

  emitStatus(message) {
    this.onStatusChange({
      ready: this.initialized,
      missing: [...this.missingFiles],
      message,
    });
  }

  clearSuspendTimer() {
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  clearChordScheduler() {
    if (this.chordInterval !== null) {
      clearInterval(this.chordInterval);
      this.chordInterval = null;
    }
  }

  getCurrentChord() {
    const scale = SCALES[this.scale] || SCALES['c-major'];
    const idx = clamp(this.currentChordIndex, 0, scale.chords.length - 1);
    return scale.chords[idx];
  }

  startChordScheduler() {
    this.clearChordScheduler();
    if (!this.ctx) return;

    this.currentChordIndex = 0;
    this.growthStartTime = this.ctx.currentTime;

    this.chordInterval = setInterval(() => {
      if (!this.ctx || !this.isPlayingTree || this.isPaused) return;

      if (this.isSettled) {
        if (this.currentChordIndex !== 0) {
          this.currentChordIndex = 0;
          this.glidePadToCurrentChord(1.2);
        }
        return;
      }

      const elapsed = Math.max(0, this.ctx.currentTime - this.growthStartTime);
      let nextIndex = 0;

      if (this.currentCycleSchedule && this.currentCycleSchedule.chords.length > 0) {
        for (const c of this.currentCycleSchedule.chords) {
          if (c.time <= elapsed) {
            nextIndex = c.chordIndex;
          } else {
            break;
          }
        }
      } else {
        const scale = SCALES[this.scale] || SCALES['c-major'];
        const twoBarsSec = (60 / this.activeTempo) * 8;
        nextIndex = Math.floor(elapsed / twoBarsSec) % scale.chords.length;
      }

      if (nextIndex !== this.currentChordIndex) {
        this.currentChordIndex = nextIndex;
        this.glidePadToCurrentChord(0.85);
      }
    }, 300);
  }

  /**
   * Start or restart audio playback from t = 0 using the shared deterministic schedule.
   */
  async startGrowth({
    keepAmbient = false,
    events = null,
    bounds = null,
    maxDepth = 7,
    speed = 1,
    seed = this.seed,
  } = {}) {
    const epoch = ++this.transportEpoch;
    this.clearSuspendTimer();

    this.activeTempo = this.pendingTempo;
    this.seed = seed;
    this.scheduleSpeed = clamp(Number(speed) || 1, 0.5, 2);
    this.isPlayingTree = true;
    this.isPaused = false;
    this.isSettled = false;
    this.currentChordIndex = 0;

    if (events && bounds) {
      this.currentCycleSchedule = buildCycleSchedule({
        events,
        bounds,
        maxDepth,
        speed: this.scheduleSpeed,
        tempo: this.activeTempo,
        scale: this.scale,
        seed: this.seed,
      });
    } else {
      this.currentCycleSchedule = null;
    }

    const ok = await this.unlock();
    if (!ok || epoch !== this.transportEpoch) return;

    this.stopAllNotes(0.035);

    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        return;
      }
      if (epoch !== this.transportEpoch) return;
    }

    const now = this.ctx.currentTime;
    this.gridOrigin = now;
    this.lastScheduledTime = -Infinity;
    this.growthStartTime = now;

    this.graph.setBrightnessProgress(0, false);
    if (this.isSleepFaded) {
      this.cancelSleepFade();
    }
    this.graph.pauseGain.gain.cancelScheduledValues(now);
    this.graph.pauseGain.gain.setValueAtTime(this.graph.pauseGain.gain.value, now);
    this.graph.pauseGain.gain.linearRampToValueAtTime(1, now + 0.06);

    this.startChordScheduler();
    this.syncAllLayers(keepAmbient ? 1.0 : LAYER_FADE_SECONDS);
    this.glidePadToCurrentChord(0.6);
    this.emitActiveSummary();
  }

  updateGrowthProgress(progress) {
    if (!this.ctx || !this.graph || this.isPaused || this.isSettled) return;
    this.graph.setBrightnessProgress(progress, false);
  }

  completeGrowth() {
    if (!this.ctx || !this.graph || !this.isPlayingTree || this.isPaused || this.isSettled) {
      return;
    }
    this.isSettled = true;
    this.currentChordIndex = 0;
    this.graph.setBrightnessProgress(1, true);
    this.glidePadToCurrentChord(1.2);

    if (this.ctx.state === 'running' && !this.muted) {
      const now = this.ctx.currentTime;
      const scale = SCALES[this.scale] || SCALES['c-major'];
      const resolving = this.currentCycleSchedule
        ? this.currentCycleSchedule.resolvingNotes
        : scale.chords[0].padSemitones.map((st, idx) => ({
            time: 0.08 + idx * 0.07,
            frequency: scale.refFreq * semitonesToPlaybackRate(st),
            gainAmount: 0.055,
            pan: [-0.28, 0.28, 0][idx % 3],
            noteDuration: 2.2,
            attack: 0.32,
            release: 1.25,
          }));

      const baseOffset = this.currentCycleSchedule
        ? this.currentCycleSchedule.treeWallDuration
        : 0;

      for (const rNote of resolving) {
        if (this.activeNotes.size >= MAX_SIMULTANEOUS_NOTES) break;
        const delay = Math.max(0.05, rNote.time - baseOffset);
        this.triggerSynthFallbackNote({
          when: now + delay,
          frequency: rNote.frequency,
          gainAmount: rNote.gainAmount,
          pan: rNote.pan,
          noteDuration: rNote.noteDuration,
          attack: rNote.attack,
          release: rNote.release,
          isLeaf: true,
          targetBus: this.graph.leavesBus,
        });
      }
    }
  }

  async pause() {
    const epoch = ++this.transportEpoch;
    this.clearSuspendTimer();
    if (!this.ctx || !this.isPlayingTree || this.isPaused) return;

    this.isPaused = true;
    const now = this.ctx.currentTime;
    this.stopAllNotes(0.045);

    this.graph.pauseGain.gain.cancelScheduledValues(now);
    this.graph.pauseGain.gain.setValueAtTime(this.graph.pauseGain.gain.value, now);
    this.graph.pauseGain.gain.linearRampToValueAtTime(0, now + 0.08);

    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (epoch === this.transportEpoch && this.isPaused && this.ctx && this.ctx.state === 'running') {
        this.ctx.suspend().catch(() => {});
      }
    }, 105);
  }

  async resume() {
    const epoch = ++this.transportEpoch;
    this.clearSuspendTimer();
    if (!this.ctx || !this.isPlayingTree || !this.isPaused) return;

    this.isPaused = false;

    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        return;
      }
      if (epoch !== this.transportEpoch) return;
    }

    const now = this.ctx.currentTime;
    this.gridOrigin = now;
    this.lastScheduledTime = -Infinity;

    this.graph.pauseGain.gain.cancelScheduledValues(now);
    this.graph.pauseGain.gain.setValueAtTime(this.graph.pauseGain.gain.value, now);
    this.graph.pauseGain.gain.linearRampToValueAtTime(1, now + 0.12);

    this.syncAllLayers(0.8);
  }

  stop() {
    const epoch = ++this.transportEpoch;
    this.clearSuspendTimer();
    this.clearChordScheduler();
    this.isPlayingTree = false;
    this.isPaused = false;
    this.isSettled = false;
    this.currentCycleSchedule = null;
    this.lastScheduledTime = -Infinity;

    if (!this.ctx || !this.graph) return;

    const now = this.ctx.currentTime;
    this.stopAllNotes(0.06);
    this.syncAllLayers(1.1);

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    if (epoch === this.transportEpoch) {
      this.graph.pauseGain.gain.cancelScheduledValues(now);
      this.graph.pauseGain.gain.setValueAtTime(this.graph.pauseGain.gain.value, now);
      this.graph.pauseGain.gain.linearRampToValueAtTime(1, now + 0.06);
    }
  }

  /**
   * Gently fade master output to zero over sleepFadeSeconds for the sleep timer.
   */
  fadeOutForSleep(fadeSeconds = 5.0) {
    if (!this.ctx || !this.graph) return;
    this.isSleepFaded = true;
    const now = this.ctx.currentTime;
    this.graph.masterGain.gain.cancelScheduledValues(now);
    this.graph.masterGain.gain.setValueAtTime(this.graph.masterGain.gain.value, now);
    this.graph.masterGain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
  }

  /**
   * Restore master gain smoothly if a pending sleep fade is cancelled.
   */
  cancelSleepFade() {
    this.isSleepFaded = false;
    if (!this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    const target = this.muted ? 0 : this.masterVolume;
    this.graph.masterGain.gain.cancelScheduledValues(now);
    this.graph.masterGain.gain.setTargetAtTime(target, now, 0.12);
  }

  setSeed(seed) {
    this.seed = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 4217;
    if (this.ctx && this.pinkNoiseBuffer) {
      this.pinkNoiseBuffer = createPinkNoiseBuffer(this.ctx, 4, this.seed);
    }
  }

  setMasterVolume(value) {
    const v = clamp(Number(value) || 0, 0, 1);
    this.masterVolume = v;
    this.isSleepFaded = false;
    if (v > 0) {
      this.preMuteVolume = v;
      if (this.muted) {
        this.muted = false;
      }
    }
    if (!this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    const target = this.muted ? 0 : this.masterVolume;
    this.graph.masterGain.gain.cancelScheduledValues(now);
    this.graph.masterGain.gain.setTargetAtTime(target, now, 0.025);
  }

  setNotesVolume(value) {
    this.notesVolume = clamp(Number(value) || 0, 0, 1);
    if (!this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    this.graph.notesBus.gain.cancelScheduledValues(now);
    this.graph.notesBus.gain.setTargetAtTime(this.notesVolume, now, 0.025);
  }

  setLeavesVolume(value) {
    this.leavesVolume = clamp(Number(value) || 0, 0, 1);
    if (!this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    this.graph.leavesBus.gain.cancelScheduledValues(now);
    this.graph.leavesBus.gain.setTargetAtTime(this.leavesVolume, now, 0.025);
  }

  setAmbientVolume(value) {
    this.ambientVolume = clamp(Number(value) || 0, 0, 1);
    if (!this.ctx || !this.graph) return;
    this.graph.setAmbientMasterVolume(this.ambientVolume);
  }

  setLayerEnabled(layerName, enabled) {
    if (!this.layers[layerName]) return;
    this.layers[layerName].enabled = Boolean(enabled);
    if (this.ctx && this.isPlayingTree && !this.isPaused) {
      this.syncLayer(layerName, this.layers[layerName].enabled, LAYER_FADE_SECONDS);
    }
  }

  setLayerVolume(layerName, value) {
    if (!this.layers[layerName]) return;
    const v = clamp(Number(value) || 0, 0, 1);
    this.layers[layerName].volume = v;
    if (!this.ctx || !this.graph) return;
    const bus = this.graph[`${layerName}Bus`];
    if (!bus) return;
    const now = this.ctx.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setTargetAtTime(v, now, 0.04);
  }

  setReverbAmount(value) {
    this.reverbAmount = clamp(Number(value) || 0, 0, 1);
    if (!this.ctx || !this.graph) return;
    this.graph.setReverbAmount(this.reverbAmount);
  }

  setReverbPreset(presetId) {
    this.reverbPreset = REVERB_PRESETS[presetId] ? presetId : 'forest';
    if (this.ctx && this.graph) {
      this.graph.setReverbPreset(this.reverbPreset, 0.85);
    }
    this.emitActiveSummary();
  }

  setTempo(bpm) {
    this.pendingTempo = Math.round(clamp(Number(bpm) || 70, 50, 90));
  }

  setScale(scaleId) {
    this.scale = scaleId === 'a-minor' ? 'a-minor' : 'c-major';
    if (this.ctx && this.layerHandles.pad) {
      this.glidePadToCurrentChord(0.8);
    }
    this.emitActiveSummary();
  }

  setMuted(muted) {
    const nextMuted = Boolean(muted);
    if (nextMuted) {
      if (this.masterVolume > 0) {
        this.preMuteVolume = this.masterVolume;
      }
      this.muted = true;
    } else {
      this.muted = false;
      this.masterVolume = this.preMuteVolume > 0 ? this.preMuteVolume : 0.8;
    }

    if (this.ctx && this.graph) {
      const now = this.ctx.currentTime;
      const target = this.muted ? 0 : this.masterVolume;
      this.graph.masterGain.gain.cancelScheduledValues(now);
      this.graph.masterGain.gain.setTargetAtTime(target, now, 0.025);
    }

    return this.muted ? 0 : this.masterVolume;
  }

  syncAllLayers(fadeSeconds = LAYER_FADE_SECONDS) {
    if (!this.ctx || !this.graph) return;
    const active = this.isPlayingTree && !this.isPaused;
    for (const name of ['rain', 'night', 'pad', 'wind']) {
      this.syncLayer(name, active && this.layers[name].enabled, fadeSeconds);
    }
  }

  syncLayer(name, shouldPlay, fadeSeconds = LAYER_FADE_SECONDS) {
    if (!this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    let handle = this.layerHandles[name];

    if (shouldPlay) {
      if (handle) {
        if (handle.stopTimer !== null) {
          clearTimeout(handle.stopTimer);
          handle.stopTimer = null;
        }
        handle.fadeGain.gain.cancelScheduledValues(now);
        handle.fadeGain.gain.setValueAtTime(handle.fadeGain.gain.value, now);
        handle.fadeGain.gain.linearRampToValueAtTime(1, now + fadeSeconds);
        return;
      }

      handle = this.createLayerHandle(name, now);
      if (handle) {
        this.layerHandles[name] = handle;
        handle.fadeGain.gain.setValueAtTime(0, now);
        handle.fadeGain.gain.linearRampToValueAtTime(1, now + fadeSeconds);
      }
      return;
    }

    if (!handle) return;

    if (handle.stopTimer !== null) {
      clearTimeout(handle.stopTimer);
    }
    handle.fadeGain.gain.cancelScheduledValues(now);
    handle.fadeGain.gain.setValueAtTime(handle.fadeGain.gain.value, now);
    handle.fadeGain.gain.linearRampToValueAtTime(0, now + fadeSeconds);

    handle.stopTimer = setTimeout(() => {
      this.destroyLayerHandle(name, handle);
    }, Math.ceil(fadeSeconds * 1000) + 90);
  }

  destroyLayerHandle(name, expectedHandle) {
    const current = this.layerHandles[name];
    if (current !== expectedHandle || !expectedHandle) return;

    if (expectedHandle.stopTimer !== null) {
      clearTimeout(expectedHandle.stopTimer);
      expectedHandle.stopTimer = null;
    }

    for (const src of expectedHandle.stoppables) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
    }
    for (const node of expectedHandle.nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected
      }
    }

    this.layerHandles[name] = null;
  }

  createLayerHandle(name, now) {
    const ctx = this.ctx;
    const fadeGain = ctx.createGain();
    fadeGain.gain.setValueAtTime(0, now);

    if (name === 'rain' || name === 'night') {
      const bufferKey = name === 'rain' ? 'ambientRain' : 'ambientNight';
      const targetBus = name === 'rain' ? this.graph.rainBus : this.graph.nightBus;
      const buffer = this.buffers.get(bufferKey);

      if (buffer) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.connect(fadeGain);
        fadeGain.connect(targetBus);
        src.start(now);
        return { fadeGain, stoppables: [src], nodes: [src, fadeGain], stopTimer: null };
      }

      if (this.missingFiles.includes(AUDIO_LABELS[bufferKey])) {
        if (name === 'rain') {
          const src = ctx.createBufferSource();
          src.buffer = this.pinkNoiseBuffer;
          src.loop = true;
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.setValueAtTime(750, now);
          const scaleGain = ctx.createGain();
          scaleGain.gain.setValueAtTime(0.42, now);
          src.connect(filter);
          filter.connect(scaleGain);
          scaleGain.connect(fadeGain);
          fadeGain.connect(targetBus);
          src.start(now);
          return {
            fadeGain,
            stoppables: [src],
            nodes: [src, filter, scaleGain, fadeGain],
            stopTimer: null,
          };
        }

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(196, now);
        const scaleGain = ctx.createGain();
        scaleGain.gain.setValueAtTime(0.08, now);
        osc.connect(scaleGain);
        scaleGain.connect(fadeGain);
        fadeGain.connect(targetBus);
        osc.start(now);
        return {
          fadeGain,
          stoppables: [osc],
          nodes: [osc, scaleGain, fadeGain],
          stopTimer: null,
        };
      }
      return null;
    }

    if (name === 'pad') {
      const scale = SCALES[this.scale] || SCALES['c-major'];
      const chord = this.getCurrentChord();

      const padFilter = ctx.createBiquadFilter();
      padFilter.type = 'lowpass';
      padFilter.frequency.setValueAtTime(640, now);
      padFilter.Q.setValueAtTime(0.7, now);

      const padBreathGain = ctx.createGain();
      padBreathGain.gain.setValueAtTime(0.24, now);

      const filterLfo = ctx.createOscillator();
      filterLfo.type = 'sine';
      filterLfo.frequency.setValueAtTime(0.08, now);
      const filterLfoDepth = ctx.createGain();
      filterLfoDepth.gain.setValueAtTime(240, now);
      filterLfo.connect(filterLfoDepth);
      filterLfoDepth.connect(padFilter.frequency);

      const ampLfo = ctx.createOscillator();
      ampLfo.type = 'sine';
      ampLfo.frequency.setValueAtTime(0.062, now);
      const ampLfoDepth = ctx.createGain();
      ampLfoDepth.gain.setValueAtTime(0.06, now);
      ampLfo.connect(ampLfoDepth);
      ampLfoDepth.connect(padBreathGain.gain);

      const voiceOscs = [];
      const voiceNodes = [];

      chord.padSemitones.forEach((st, idx) => {
        const osc = ctx.createOscillator();
        osc.type = idx === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(scale.refFreq * semitonesToPlaybackRate(st), now);

        const voiceGain = ctx.createGain();
        voiceGain.gain.setValueAtTime(idx === 0 ? 0.36 : 0.22, now);

        osc.connect(voiceGain);
        voiceGain.connect(padFilter);
        osc.start(now);

        voiceOscs.push(osc);
        voiceNodes.push(osc, voiceGain);
      });

      padFilter.connect(padBreathGain);
      padBreathGain.connect(fadeGain);
      fadeGain.connect(this.graph.padBus);

      filterLfo.start(now);
      ampLfo.start(now);

      return {
        fadeGain,
        voiceOscs,
        stoppables: [...voiceOscs, filterLfo, ampLfo],
        nodes: [
          ...voiceNodes,
          padFilter,
          padBreathGain,
          filterLfo,
          filterLfoDepth,
          ampLfo,
          ampLfoDepth,
          fadeGain,
        ],
        stopTimer: null,
      };
    }

    if (name === 'wind') {
      const src = ctx.createBufferSource();
      src.buffer = this.pinkNoiseBuffer;
      src.loop = true;

      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.setValueAtTime(360, now);
      windFilter.Q.setValueAtTime(1.25, now);

      const windBreathGain = ctx.createGain();
      windBreathGain.gain.setValueAtTime(0.45, now);

      const filterLfo = ctx.createOscillator();
      filterLfo.type = 'sine';
      filterLfo.frequency.setValueAtTime(0.09, now);
      const filterLfoDepth = ctx.createGain();
      filterLfoDepth.gain.setValueAtTime(175, now);
      filterLfo.connect(filterLfoDepth);
      filterLfoDepth.connect(windFilter.frequency);

      const ampLfo = ctx.createOscillator();
      ampLfo.type = 'sine';
      ampLfo.frequency.setValueAtTime(0.055, now);
      const ampLfoDepth = ctx.createGain();
      ampLfoDepth.gain.setValueAtTime(0.24, now);
      ampLfo.connect(ampLfoDepth);
      ampLfoDepth.connect(windBreathGain.gain);

      src.connect(windFilter);
      windFilter.connect(windBreathGain);
      windBreathGain.connect(fadeGain);
      fadeGain.connect(this.graph.windBus);

      src.start(now);
      filterLfo.start(now);
      ampLfo.start(now);

      return {
        fadeGain,
        stoppables: [src, filterLfo, ampLfo],
        nodes: [
          src,
          windFilter,
          windBreathGain,
          filterLfo,
          filterLfoDepth,
          ampLfo,
          ampLfoDepth,
          fadeGain,
        ],
        stopTimer: null,
      };
    }

    return null;
  }

  glidePadToCurrentChord(timeConstant = 0.8) {
    if (!this.ctx || !this.layerHandles.pad || !this.layerHandles.pad.voiceOscs) return;
    const now = this.ctx.currentTime;
    const scale = SCALES[this.scale] || SCALES['c-major'];
    const chord = this.getCurrentChord();

    this.layerHandles.pad.voiceOscs.forEach((osc, idx) => {
      const st = chord.padSemitones[idx] ?? chord.padSemitones[0];
      const freq = scale.refFreq * semitonesToPlaybackRate(st);
      osc.frequency.cancelScheduledValues(now);
      osc.frequency.setTargetAtTime(freq, now, timeConstant);
    });
  }

  pruneActiveNotes(now) {
    for (const note of this.activeNotes) {
      if (now >= note.endTime) {
        this.activeNotes.delete(note);
      }
    }
  }

  stopAllNotes(fadeSeconds = 0.04) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const note of this.activeNotes) {
      try {
        note.gainNode.gain.cancelScheduledValues(now);
        note.gainNode.gain.setValueAtTime(note.gainNode.gain.value, now);
        note.gainNode.gain.linearRampToValueAtTime(0, now + fadeSeconds);
        note.source.stop(now + fadeSeconds + 0.02);
      } catch {
        // Already stopped
      }
    }
    this.activeNotes.clear();
  }

  getActiveCounts() {
    if (this.ctx) {
      this.pruneActiveNotes(this.ctx.currentTime);
    }
    const activeLayers = Object.values(this.layerHandles).filter(Boolean).length;
    return {
      activeNotes: this.activeNotes.size,
      activeLayers,
    };
  }

  getEnergyLevel() {
    if (
      !this.ctx ||
      !this.graph ||
      !this.graph.analyser ||
      !this.energyData ||
      !this.isPlayingTree ||
      this.isPaused ||
      this.muted ||
      this.ctx.state !== 'running'
    ) {
      return 0;
    }

    this.graph.analyser.getByteTimeDomainData(this.energyData);
    let sumSq = 0;
    for (let i = 0; i < this.energyData.length; i++) {
      const sample = (this.energyData[i] - 128) / 128;
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / this.energyData.length);
    return clamp(rms * 4.2, 0, 1);
  }

  /**
   * Play a branch sound using the precomputed cycle schedule when active,
   * ensuring live playback matches offline WAV export.
   */
  playBranchEvent(branch, bounds, maxDepth, currentElapsedSec = null) {
    if (
      !this.ctx ||
      !this.graph ||
      !this.initialized ||
      !this.isPlayingTree ||
      this.isPaused ||
      this.ctx.state !== 'running'
    ) {
      return;
    }

    const now = this.ctx.currentTime;
    this.pruneActiveNotes(now);
    if (this.activeNotes.size >= MAX_SIMULTANEOUS_NOTES) {
      return;
    }

    let scheduledTime = now;
    let key = 'branch';
    let targetBus = this.graph.notesBus;
    let playbackRate = 1;
    let baseGain = 0.36;
    let noteDuration = 0.8;
    let attack = 0.035;
    let release = 0.35;
    let fallbackFreq = 261.63;
    let noteName = 'C4';
    let chordName = this.getCurrentChord().name;
    let pan = 0;

    if (this.currentCycleSchedule) {
      const planned = this.currentCycleSchedule.notesByBranchId.get(branch.id);
      if (!planned) {
        return;
      }

      const wallPos =
        currentElapsedSec !== null
          ? currentElapsedSec / this.scheduleSpeed
          : branch.startTime / this.scheduleSpeed;
      const offsetFromNow = clamp(planned.time - wallPos, 0.005, 0.25);
      scheduledTime = now + offsetFromNow;
      key = planned.key;
      targetBus = planned.busName === 'leavesBus' ? this.graph.leavesBus : this.graph.notesBus;
      playbackRate = planned.playbackRate;
      baseGain = planned.gainAmount;
      noteDuration = planned.noteDuration;
      attack = planned.attack;
      release = planned.release;
      fallbackFreq = planned.fallbackFreq;
      noteName = planned.noteName;
      chordName = planned.chordName;
      this.lastScheduledTime = scheduledTime;
      pan = planned.pan;
    } else {
      const beatSeconds = 60 / this.activeTempo;
      const gridStep = beatSeconds / 4;
      const minGap = clamp(beatSeconds * 0.16, 0.1, 0.22);
      const isTrunk = branch.side === 'trunk' && branch.depth === 1;

      if (!isTrunk) {
        const stepsAhead = Math.max(0, Math.ceil((now - this.gridOrigin) / gridStep));
        let quantized = this.gridOrigin + stepsAhead * gridStep;
        if (quantized - this.lastScheduledTime < minGap) {
          const nextSlot = quantized + gridStep;
          if (
            nextSlot - this.lastScheduledTime >= minGap &&
            nextSlot - now <= gridStep * 1.6
          ) {
            quantized = nextSlot;
          } else {
            return;
          }
        }
        scheduledTime = Math.max(now + 0.005, quantized);
      }

      this.lastScheduledTime = scheduledTime;
      const scaleDef = SCALES[this.scale] || SCALES['c-major'];
      const currentChord = this.getCurrentChord();
      chordName = currentChord.name;

      if (isTrunk) {
        key = 'trunk';
        baseGain = 0.45;
        noteDuration = 1.25;
        attack = 0.055;
        release = 0.5;
        fallbackFreq = scaleDef.trunkFreq;
        noteName = this.scale === 'a-minor' ? 'A2' : 'C3';
      } else if (branch.isLeaf) {
        key = 'leaf';
        targetBus = this.graph.leavesBus;
        baseGain = 0.12 * Math.pow(0.92, Math.max(0, branch.depth - 1));
        noteDuration = 0.65;
        attack = 0.045;
        release = 0.36;
        fallbackFreq = scaleDef.leafFreq;
        noteName = this.scale === 'a-minor' ? 'A5 (Leaf)' : 'C6 (Leaf)';
      } else {
        const semitones = getBranchPentatonicSemitones(
          branch.depth,
          maxDepth,
          branch.side,
          this.scale,
          currentChord.pitchClasses
        );
        playbackRate = semitonesToPlaybackRate(semitones);
        baseGain = 0.36 * Math.pow(0.84, Math.max(0, branch.depth - 2));
        noteDuration = Math.max(0.55, 0.85 - Math.max(0, branch.depth - 2) * 0.04);
        fallbackFreq = scaleDef.refFreq * playbackRate;
        noteName = semitonesToNoteName(semitones);
      }

      const halfSpan = Math.max(20, Math.abs(bounds.minX), Math.abs(bounds.maxX));
      pan = isTrunk ? 0 : clamp(branch.endX / halfSpan, -0.85, 0.85);
    }

    this.onNoteTriggered({
      branchId: branch.id,
      noteName,
      chordName,
      duration: noteDuration,
      isLeaf: branch.isLeaf,
    });

    const buffer = this.buffers.get(key);
    if (buffer) {
      this.triggerSampleNote({
        buffer,
        offset: this.activeOffsets.get(key) || 0,
        when: scheduledTime,
        playbackRate,
        gainAmount: baseGain,
        pan,
        noteDuration,
        attack,
        release,
        targetBus,
      });
    } else if (this.missingFiles.includes(AUDIO_LABELS[key]) || !this.loadingPromises.has(key)) {
      this.triggerSynthFallbackNote({
        when: scheduledTime,
        frequency: fallbackFreq,
        gainAmount: baseGain * 0.45,
        pan,
        noteDuration,
        attack,
        release,
        isLeaf: branch.isLeaf,
        targetBus,
      });
    } else {
      const triggeredAt = now;
      const epoch = this.transportEpoch;
      this.loadingPromises.get(key).then(() => {
        if (
          epoch !== this.transportEpoch ||
          !this.ctx ||
          !this.isPlayingTree ||
          this.isPaused ||
          this.ctx.state !== 'running'
        ) {
          return;
        }
        const currentNow = this.ctx.currentTime;
        if (currentNow - triggeredAt > 1.2) return;
        this.pruneActiveNotes(currentNow);
        if (this.activeNotes.size >= MAX_SIMULTANEOUS_NOTES) return;

        const decoded = this.buffers.get(key);
        if (decoded) {
          this.triggerSampleNote({
            buffer: decoded,
            offset: this.activeOffsets.get(key) || 0,
            when: currentNow + 0.01,
            playbackRate,
            gainAmount: baseGain,
            pan,
            noteDuration,
            attack,
            release,
            targetBus,
          });
        } else {
          this.triggerSynthFallbackNote({
            when: currentNow + 0.01,
            frequency: fallbackFreq,
            gainAmount: baseGain * 0.45,
            pan,
            noteDuration,
            attack,
            release,
            isLeaf: branch.isLeaf,
            targetBus,
          });
        }
      });
    }
  }

  triggerSampleNote({
    buffer,
    offset,
    when,
    playbackRate,
    gainAmount,
    pan,
    noteDuration,
    attack,
    release,
    targetBus,
  }) {
    const ctx = this.ctx;
    const maxPlayable = Math.max(0.12, (buffer.duration - offset) / playbackRate - 0.02);
    const dur = Math.min(noteDuration, maxPlayable);
    const safeAttack = Math.min(attack, dur * 0.35);
    const safeRelease = Math.min(release, dur * 0.6);
    const releaseStart = Math.max(when + safeAttack, when + dur - safeRelease);
    const endTime = when + dur;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(playbackRate, when);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, when);
    gainNode.gain.linearRampToValueAtTime(gainAmount, when + safeAttack);
    gainNode.gain.setValueAtTime(gainAmount, releaseStart);
    gainNode.gain.linearRampToValueAtTime(0, endTime);

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, when);

    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(targetBus);

    const record = { source, gainNode, panner, endTime };
    this.activeNotes.add(record);
    source.onended = () => {
      this.activeNotes.delete(record);
      try {
        source.disconnect();
        gainNode.disconnect();
        panner.disconnect();
      } catch {
        // Already disconnected
      }
    };

    source.start(when, offset);
    source.stop(endTime + 0.02);
  }

  triggerSynthFallbackNote({
    when,
    frequency,
    gainAmount,
    pan,
    noteDuration,
    attack,
    release,
    isLeaf,
    targetBus,
  }) {
    const ctx = this.ctx;
    const dur = noteDuration;
    const safeAttack = Math.min(attack, dur * 0.35);
    const safeRelease = Math.min(release, dur * 0.6);
    const releaseStart = Math.max(when + safeAttack, when + dur - safeRelease);
    const endTime = when + dur;

    const osc = ctx.createOscillator();
    osc.type = isLeaf ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(frequency, when);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(isLeaf ? 2200 : 1400, when);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, when);
    gainNode.gain.linearRampToValueAtTime(gainAmount, when + safeAttack);
    gainNode.gain.setValueAtTime(gainAmount * 0.85, releaseStart);
    gainNode.gain.linearRampToValueAtTime(0, endTime);

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, when);

    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(targetBus);

    const record = { source: osc, gainNode, panner, endTime };
    this.activeNotes.add(record);
    osc.onended = () => {
      this.activeNotes.delete(record);
      try {
        osc.disconnect();
        filter.disconnect();
        gainNode.disconnect();
        panner.disconnect();
      } catch {
        // Already disconnected
      }
    };

    osc.start(when);
    osc.stop(endTime + 0.02);
  }
}
