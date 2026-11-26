import { clamp, getTreeTotalDuration } from './tree.js';

/**
 * Pure Web Audio API routing graph, DSP buffer builders, and deterministic
 * composition scheduler. Designed to work identically with live AudioContext
 * and OfflineAudioContext for WAV export.
 */

export const AUDIO_FILES = {
  trunk: 'assets/audio/trunk.mp3',
  branch: 'assets/audio/branch.mp3',
  leaf: 'assets/audio/leaf.mp3',
  ambientRain: 'assets/audio/ambient-rain.mp3',
  ambientNight: 'assets/audio/ambient-night.mp3',
};

export const AUDIO_LABELS = {
  trunk: 'trunk.mp3',
  branch: 'branch.mp3',
  leaf: 'leaf.mp3',
  ambientRain: 'ambient-rain.mp3',
  ambientNight: 'ambient-night.mp3',
};

export const REVERB_PRESETS = {
  'small-garden': {
    label: 'Small Garden',
    duration: 1.25,
    decayPower: 3.3,
    damping: 0.66,
    wetScale: 0.65,
  },
  forest: {
    label: 'Forest',
    duration: 2.35,
    decayPower: 2.5,
    damping: 0.74,
    wetScale: 0.85,
  },
  'open-sky': {
    label: 'Open Sky',
    duration: 3.8,
    decayPower: 1.85,
    damping: 0.82,
    wetScale: 1.0,
  },
};

export const SCALES = {
  'c-major': {
    label: 'C major pentatonic (Calm)',
    slug: 'calm',
    // C4, D4, E4, G4, A4, C5, D5, E5, G5, A5, C6
    semitones: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24],
    trunkFreq: 130.81, // C3
    refFreq: 261.63,   // C4
    leafFreq: 1046.5,  // C6
    chords: [
      { name: 'Cadd9', padSemitones: [0, 7, 16], pitchClasses: [0, 4, 7] },
      { name: 'Am7', padSemitones: [-3, 4, 12], pitchClasses: [9, 0, 4] },
      { name: 'Dm9', padSemitones: [2, 9, 16], pitchClasses: [2, 4, 9] },
      { name: 'G6', padSemitones: [-5, 2, 14], pitchClasses: [7, 2] },
    ],
  },
  'a-minor': {
    label: 'A minor pentatonic (Dreamy)',
    slug: 'dreamy',
    // A3, C4, D4, E4, G4, A4, C5, D5, E5, G5, A5
    semitones: [-3, 0, 2, 4, 7, 9, 12, 14, 16, 19, 21],
    trunkFreq: 110.0,  // A2
    refFreq: 261.63,   // C4 reference for semitone offsets
    leafFreq: 880.0,   // A5
    chords: [
      { name: 'Am', padSemitones: [-3, 4, 12], pitchClasses: [9, 0, 4] },
      { name: 'C', padSemitones: [0, 7, 16], pitchClasses: [0, 4, 7] },
      { name: 'Dm7', padSemitones: [2, 9, 12], pitchClasses: [2, 9, 0] },
      { name: 'G6', padSemitones: [-5, 2, 16], pitchClasses: [7, 2, 4] },
    ],
  },
};

export const MAX_SIMULTANEOUS_NOTES = 8;

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * Convert a semitone offset relative to C4 (MIDI 60) into a readable note name.
 * @param {number} semitones
 * @returns {string}
 */
export function semitonesToNoteName(semitones) {
  const midi = 60 + Math.round(semitones);
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/**
 * Compute playbackRate from semitone offset.
 * @param {number} semitones
 * @returns {number}
 */
export function semitonesToPlaybackRate(semitones) {
  return Math.pow(2, semitones / 12);
}

/**
 * Deterministic PRNG for audio synthesis (reverb IR, wind noise, subtle variations)
 * so live and offline renders produce matching textures without Math.random.
 * @param {number} [seed=1337]
 * @returns {() => number}
 */
export function createAudioSeededRandom(seed = 1337) {
  let s = (Math.trunc(Number(seed)) || 1337) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compute pentatonic semitone offset (limited to 2 octaves) so deeper branches
 * play higher or equal notes while favoring pitch classes from the active chord.
 */
export function getBranchPentatonicSemitones(
  depth,
  maxDepth,
  side,
  scaleId = 'c-major',
  chordPitchClasses = null
) {
  const scale = SCALES[scaleId] || SCALES['c-major'];
  const ladder = scale.semitones;

  if (depth <= 1 || maxDepth <= 2) {
    return ladder[0];
  }

  const chordSet = chordPitchClasses ? new Set(chordPitchClasses) : null;
  const normalLevels = Math.max(1, maxDepth - 2);

  let minBandIdx = 0;
  let maxBandIdx = ladder.length - 1;
  let preferredIdx = 0;

  if (normalLevels <= 5) {
    const baseIndex = (depth - 2) * 2;
    minBandIdx = clamp(baseIndex, 0, ladder.length - 1);
    maxBandIdx = clamp(baseIndex + 1, minBandIdx, ladder.length - 1);
    preferredIdx = clamp(baseIndex + (side === 'right' ? 1 : 0), minBandIdx, maxBandIdx);
  } else {
    const ratio = clamp((depth - 2) / (normalLevels - 1), 0, 1);
    preferredIdx = clamp(Math.round(ratio * (ladder.length - 1)), 0, ladder.length - 1);
    minBandIdx = preferredIdx;
    maxBandIdx = clamp(preferredIdx + 1, minBandIdx, ladder.length - 1);
  }

  if (!chordSet) {
    return ladder[preferredIdx];
  }

  const altIdx = preferredIdx === minBandIdx ? maxBandIdx : minBandIdx;
  for (const idx of [preferredIdx, altIdx]) {
    const pc = ((ladder[idx] % 12) + 12) % 12;
    if (chordSet.has(pc)) {
      return ladder[idx];
    }
  }

  return ladder[preferredIdx];
}

/**
 * Scan decoded PCM channel data to skip leading silence while preserving transients.
 * @param {AudioBuffer} buffer
 * @returns {number}
 */
export function findActiveStartOffset(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate || 44100;
  const windowSize = Math.max(256, Math.floor(sampleRate * 0.02));
  const maxScanSamples = Math.min(data.length, Math.floor(sampleRate * 8));

  for (let i = 0; i < maxScanSamples; i += windowSize) {
    let peak = 0;
    const end = Math.min(data.length, i + windowSize);
    for (let j = i; j < end; j++) {
      const abs = Math.abs(data[j]);
      if (abs > peak) peak = abs;
    }
    if (peak >= 0.02) {
      return Math.max(0, i / sampleRate - 0.02);
    }
  }
  return 0;
}

/**
 * Generate a stereo impulse response buffer for the requested reverb preset.
 * @param {BaseAudioContext} ctx
 * @param {string} [presetId='forest']
 * @param {number} [seed=4217]
 * @returns {AudioBuffer}
 */
export function createReverbImpulse(ctx, presetId = 'forest', seed = 4217) {
  const preset = REVERB_PRESETS[presetId] || REVERB_PRESETS.forest;
  const sampleRate = ctx.sampleRate || 44100;
  const length = Math.max(1024, Math.floor(sampleRate * preset.duration));
  const impulse = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const channel = impulse.getChannelData(ch);
    const rand = createAudioSeededRandom(seed + presetId.length * 997 + ch * 49157);
    let lp = 0;
    const attackSamples = Math.max(1, Math.floor(sampleRate * 0.022));

    for (let i = 0; i < length; i++) {
      const t = i / length;
      const attack = Math.min(1, i / attackSamples);
      const decay = Math.pow(1 - t, preset.decayPower);
      const white = rand() * 2 - 1;
      lp = lp * preset.damping + white * (1 - preset.damping);
      channel[i] = lp * attack * decay * 0.48;
    }
  }

  return impulse;
}

/**
 * Create a seamlessly crossfaded looping AudioBuffer from a decoded sample,
 * eliminating MP3 frame boundary gaps and clicks without runtime timers.
 * @param {BaseAudioContext} ctx
 * @param {AudioBuffer} sourceBuffer
 * @param {number} [crossfadeSeconds=2.5]
 * @returns {AudioBuffer}
 */
export function createCrossfadedLoopBuffer(ctx, sourceBuffer, crossfadeSeconds = 2.5) {
  if (!sourceBuffer || sourceBuffer.length < 64) {
    return sourceBuffer;
  }

  const sampleRate = sourceBuffer.sampleRate || ctx.sampleRate || 44100;
  const numChannels = sourceBuffer.numberOfChannels;
  const rawLength = sourceBuffer.length;

  const ch0 = sourceBuffer.getChannelData(0);
  const threshold = 0.003;
  let startSample = 0;
  let endSample = rawLength - 1;

  const maxTrim = Math.floor(rawLength * 0.2);
  while (startSample < maxTrim && Math.abs(ch0[startSample]) < threshold) {
    startSample++;
  }
  while (endSample > rawLength - 1 - maxTrim && Math.abs(ch0[endSample]) < threshold) {
    endSample--;
  }

  const trimmedLength = Math.max(256, endSample - startSample + 1);
  const maxFade = Math.floor(trimmedLength * 0.25);
  const fadeSamples = Math.min(maxFade, Math.max(32, Math.floor(sampleRate * crossfadeSeconds)));
  const outLength = Math.max(64, trimmedLength - fadeSamples);

  const outBuffer = ctx.createBuffer(numChannels, outLength, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const src = sourceBuffer.getChannelData(ch);
    const dst = outBuffer.getChannelData(ch);

    for (let i = fadeSamples; i < outLength; i++) {
      dst[i] = src[startSample + i];
    }

    for (let i = 0; i < fadeSamples; i++) {
      const progress = i / fadeSamples;
      const fadeIn = Math.sin(progress * Math.PI * 0.5);
      const fadeOut = Math.cos(progress * Math.PI * 0.5);
      const headSample = src[startSample + i];
      const tailSample = src[startSample + outLength + i];
      dst[i] = headSample * fadeIn + tailSample * fadeOut;
    }
  }

  return outBuffer;
}

/**
 * Create a smooth seeded pink-noise AudioBuffer for procedural wind synthesis.
 * @param {BaseAudioContext} ctx
 * @param {number} [seconds=4]
 * @param {number} [seed=4217]
 * @returns {AudioBuffer}
 */
export function createPinkNoiseBuffer(ctx, seconds = 4, seed = 4217) {
  const sampleRate = ctx.sampleRate || 44100;
  const length = Math.max(1024, Math.floor(sampleRate * seconds));
  const raw = ctx.createBuffer(1, length, sampleRate);
  const data = raw.getChannelData(0);

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  const rand = createAudioSeededRandom(seed + 9001);

  for (let i = 0; i < length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.09;
    b6 = white * 0.115926;
  }

  return createCrossfadedLoopBuffer(ctx, raw, Math.min(1.0, seconds * 0.25));
}

/**
 * Build a deterministic single-cycle schedule of chord changes, branch notes,
 * and resolving chord chimes shared identically by live playback and OfflineAudioContext.
 */
export function buildCycleSchedule({
  events,
  bounds,
  maxDepth,
  speed = 1,
  tempo = 70,
  scale = 'c-major',
  seed = 4217,
}) {
  const safeSpeed = clamp(Number(speed) || 1, 0.5, 2);
  const safeTempo = Math.round(clamp(Number(tempo) || 70, 50, 90));
  const scaleDef = SCALES[scale] || SCALES['c-major'];
  const rand = createAudioSeededRandom(seed + 777);

  const treeWallDuration = getTreeTotalDuration(events) / safeSpeed;
  const beatSeconds = 60 / safeTempo;
  const gridStep = beatSeconds / 4;
  const minGap = clamp(beatSeconds * 0.16, 0.1, 0.22);
  const twoBarsSec = beatSeconds * 8;

  // 1. Chord progression timeline (every 2 bars, settling to chord 0 at end)
  const chords = [];
  for (let t = 0, step = 0; t < treeWallDuration; t += twoBarsSec, step++) {
    const chordIndex = step % scaleDef.chords.length;
    chords.push({
      time: t,
      chordIndex,
      chord: scaleDef.chords[chordIndex],
      isResolving: false,
    });
  }
  chords.push({
    time: treeWallDuration,
    chordIndex: 0,
    chord: scaleDef.chords[0],
    isResolving: true,
  });

  const getChordAt = (wallTime) => {
    let active = chords[0];
    for (const c of chords) {
      if (c.time <= wallTime) {
        active = c;
      } else {
        break;
      }
    }
    return active;
  };

  // 2. Deterministic branch / trunk / leaf note schedule
  const notes = [];
  const notesByBranchId = new Map();
  let activeEndTimes = [];
  let lastScheduledTime = -Infinity;
  const halfSpan = Math.max(20, Math.abs(bounds.minX), Math.abs(bounds.maxX));

  for (const branch of events) {
    const wallStart = branch.startTime / safeSpeed;
    const isTrunk = branch.side === 'trunk' && branch.depth === 1;
    let scheduledTime = wallStart;

    if (!isTrunk) {
      const stepsAhead = Math.max(0, Math.ceil(wallStart / gridStep));
      let quantized = stepsAhead * gridStep;

      if (quantized - lastScheduledTime < minGap) {
        const nextSlot = quantized + gridStep;
        if (
          nextSlot - lastScheduledTime >= minGap &&
          nextSlot - wallStart <= gridStep * 1.6
        ) {
          quantized = nextSlot;
        } else {
          continue;
        }
      }
      scheduledTime = Math.max(0.005, quantized);
    }

    activeEndTimes = activeEndTimes.filter((endT) => endT > scheduledTime);
    if (activeEndTimes.length >= MAX_SIMULTANEOUS_NOTES) {
      continue;
    }

    const chordInfo = getChordAt(scheduledTime);
    const subtleHumanGain = 0.94 + rand() * 0.12;

    let key = 'branch';
    let busName = 'notesBus';
    let playbackRate = 1;
    let gainAmount = 0.36;
    let noteDuration = 0.8;
    let attack = 0.035;
    let release = 0.35;
    let fallbackFreq = scaleDef.refFreq;
    let noteName = 'C4';

    if (isTrunk) {
      key = 'trunk';
      busName = 'notesBus';
      playbackRate = 1;
      gainAmount = 0.45;
      noteDuration = 1.25;
      attack = 0.055;
      release = 0.5;
      fallbackFreq = scaleDef.trunkFreq;
      noteName = scale === 'a-minor' ? 'A2' : 'C3';
    } else if (branch.isLeaf) {
      key = 'leaf';
      busName = 'leavesBus';
      playbackRate = 1;
      gainAmount = 0.12 * Math.pow(0.92, Math.max(0, branch.depth - 1)) * subtleHumanGain;
      noteDuration = 0.65;
      attack = 0.045;
      release = 0.36;
      fallbackFreq = scaleDef.leafFreq;
      noteName = scale === 'a-minor' ? 'A5 (Leaf)' : 'C6 (Leaf)';
    } else {
      key = 'branch';
      busName = 'notesBus';
      const semitones = getBranchPentatonicSemitones(
        branch.depth,
        maxDepth,
        branch.side,
        scale,
        chordInfo.chord.pitchClasses
      );
      playbackRate = semitonesToPlaybackRate(semitones);
      gainAmount = 0.36 * Math.pow(0.84, Math.max(0, branch.depth - 2)) * subtleHumanGain;
      noteDuration = Math.max(0.55, 0.85 - Math.max(0, branch.depth - 2) * 0.04);
      attack = 0.035;
      release = 0.35;
      fallbackFreq = scaleDef.refFreq * playbackRate;
      noteName = semitonesToNoteName(semitones);
    }

    const pan = isTrunk ? 0 : clamp(branch.endX / halfSpan, -0.85, 0.85);
    lastScheduledTime = scheduledTime;
    activeEndTimes.push(scheduledTime + noteDuration);

    const noteEvent = {
      branchId: branch.id,
      treeTime: branch.startTime,
      time: scheduledTime,
      key,
      busName,
      playbackRate,
      gainAmount,
      pan,
      noteDuration,
      attack,
      release,
      fallbackFreq,
      noteName,
      chordName: chordInfo.chord.name,
      isLeaf: branch.isLeaf,
    };

    notes.push(noteEvent);
    notesByBranchId.set(branch.id, noteEvent);
  }

  // 3. Resolving tonic chord bloom when tree finishes
  const resolvingPans = [-0.28, 0.28, 0];
  const resolvingNotes = scaleDef.chords[0].padSemitones.map((st, idx) => ({
    time: treeWallDuration + 0.08 + idx * 0.07,
    frequency: scaleDef.refFreq * semitonesToPlaybackRate(st),
    gainAmount: 0.055,
    pan: resolvingPans[idx % resolvingPans.length],
    noteDuration: 2.2,
    attack: 0.32,
    release: 1.25,
    isLeaf: true,
    busName: 'leavesBus',
  }));

  return {
    treeWallDuration,
    chords,
    notes,
    notesByBranchId,
    resolvingNotes,
  };
}

/**
 * Build a complete composition timeline for offline WAV rendering
 * supporting Full tree once, 1 minute, and 3 minutes with 2s fade-in,
 * 4s fade-out, and natural unclipped reverb tail.
 */
export function buildCompositionSchedule({
  events,
  bounds,
  maxDepth,
  speed = 1,
  tempo = 70,
  scale = 'c-major',
  seed = 4217,
  lengthMode = 'full',
  reverbPreset = 'forest',
  hasAmbient = true,
}) {
  const cycle = buildCycleSchedule({
    events,
    bounds,
    maxDepth,
    speed,
    tempo,
    scale,
    seed,
  });

  const fadeInSec = 2.0;
  const fadeOutSec = 4.0;
  const presetMeta = REVERB_PRESETS[reverbPreset] || REVERB_PRESETS.forest;
  const reverbTailSec = presetMeta.duration + 0.55;
  const firstCycleStart = hasAmbient ? 1.5 : 0.2;
  const cycleHoldSec = 2.2;

  let fadeOutStart = 0;
  let fadeOutEnd = 0;

  if (lengthMode === '1m') {
    fadeOutEnd = 60.0;
    fadeOutStart = 56.0;
  } else if (lengthMode === '3m') {
    fadeOutEnd = 180.0;
    fadeOutStart = 176.0;
  } else {
    fadeOutStart = firstCycleStart + cycle.treeWallDuration + 1.5;
    fadeOutEnd = fadeOutStart + fadeOutSec;
  }

  const totalRenderSec = fadeOutEnd + reverbTailSec;
  const cyclePeriod = cycle.treeWallDuration + cycleHoldSec;

  const scheduledNotes = [];
  const scheduledResolvingNotes = [];
  const scheduledChords = [];
  const brightnessEvents = [];

  const maxCycles = lengthMode === 'full' ? 1 : Math.ceil(fadeOutEnd / Math.max(0.5, cyclePeriod)) + 1;

  for (let c = 0; c < maxCycles; c++) {
    const offset = firstCycleStart + c * cyclePeriod;
    if (lengthMode !== 'full' && offset >= fadeOutStart - 1.0) {
      break;
    }

    for (const ch of cycle.chords) {
      const t = offset + ch.time;
      if (t < fadeOutEnd - 0.5) {
        scheduledChords.push({ ...ch, time: t });
      }
    }

    brightnessEvents.push({ time: offset, frequency: 2200, settled: false });
    const midTime = offset + cycle.treeWallDuration * 0.5;
    if (midTime < fadeOutEnd - 0.8) {
      brightnessEvents.push({ time: midTime, frequency: 4700, settled: false });
    }
    const endTime = offset + cycle.treeWallDuration;
    if (endTime < fadeOutEnd - 0.4) {
      brightnessEvents.push({ time: endTime, frequency: 6800, settled: false });
      brightnessEvents.push({ time: endTime + 0.15, frequency: 3400, settled: true });
    }

    for (const note of cycle.notes) {
      const t = offset + note.time;
      if (t < fadeOutEnd - 0.6) {
        scheduledNotes.push({ ...note, time: t });
      }
    }

    for (const rNote of cycle.resolvingNotes) {
      const t = offset + rNote.time;
      if (t < fadeOutEnd - 0.8) {
        scheduledResolvingNotes.push({ ...rNote, time: t });
      }
    }
  }

  return {
    fadeInSec,
    fadeOutSec,
    fadeOutStart,
    fadeOutEnd,
    reverbTailSec,
    totalRenderSec,
    treeWallDuration: cycle.treeWallDuration,
    notes: scheduledNotes,
    resolvingNotes: scheduledResolvingNotes,
    chords: scheduledChords,
    brightnessEvents,
  };
}

/**
 * Build the complete Web Audio signal graph onto any BaseAudioContext
 * (live AudioContext or OfflineAudioContext).
 */
export function createGardenAudioGraph(ctx, initial = {}) {
  const now = ctx.currentTime || 0;
  const masterVolume = initial.masterVolume ?? 0.8;
  const notesVolume = initial.notesVolume ?? 0.8;
  const leavesVolume = initial.leavesVolume ?? 0.7;
  const ambientVolume = initial.ambientVolume ?? 0.52;
  const reverbAmount = initial.reverbAmount ?? 0.42;
  const reverbPreset = initial.reverbPreset ?? 'forest';
  const seed = initial.seed ?? 4217;
  const muted = Boolean(initial.muted);
  const withAnalyser = initial.withAnalyser !== false && typeof ctx.createAnalyser === 'function';

  // --- Melodic & Leaf Buses ---
  const notesBus = ctx.createGain();
  notesBus.gain.setValueAtTime(notesVolume, now);

  const leavesBus = ctx.createGain();
  leavesBus.gain.setValueAtTime(leavesVolume, now);

  const leafDelay = ctx.createDelay(1.0);
  leafDelay.delayTime.setValueAtTime(0.32, now);

  const leafDelayFilter = ctx.createBiquadFilter();
  leafDelayFilter.type = 'lowpass';
  leafDelayFilter.frequency.setValueAtTime(1750, now);

  const leafDelayFeedback = ctx.createGain();
  leafDelayFeedback.gain.setValueAtTime(0.24, now);

  const leafDelayWet = ctx.createGain();
  leafDelayWet.gain.setValueAtTime(0.26, now);

  const notesHPF = ctx.createBiquadFilter();
  notesHPF.type = 'highpass';
  notesHPF.frequency.setValueAtTime(75, now);
  notesHPF.Q.setValueAtTime(0.7, now);

  const brightnessFilter = ctx.createBiquadFilter();
  brightnessFilter.type = 'lowpass';
  brightnessFilter.frequency.setValueAtTime(2400, now);
  brightnessFilter.Q.setValueAtTime(0.65, now);

  const dryBus = ctx.createGain();
  dryBus.gain.setValueAtTime(0.88 - reverbAmount * 0.14, now);

  // --- Ambient Layer Buses ---
  const rainBus = ctx.createGain();
  rainBus.gain.setValueAtTime(0.48, now);

  const nightBus = ctx.createGain();
  nightBus.gain.setValueAtTime(0.52, now);

  const padBus = ctx.createGain();
  padBus.gain.setValueAtTime(0.46, now);

  const windBus = ctx.createGain();
  windBus.gain.setValueAtTime(0.36, now);

  const ambientHPF = ctx.createBiquadFilter();
  ambientHPF.type = 'highpass';
  ambientHPF.frequency.setValueAtTime(85, now);

  const ambientLPF = ctx.createBiquadFilter();
  ambientLPF.type = 'lowpass';
  ambientLPF.frequency.setValueAtTime(5400, now);

  const ambientMasterBus = ctx.createGain();
  ambientMasterBus.gain.setValueAtTime(ambientVolume * 0.34, now);

  // --- Reverb Send Levels & Dual-Convolver Crossfade ---
  const wetSendSum = ctx.createGain();
  wetSendSum.gain.setValueAtTime(1.0, now);

  const notesReverbSend = ctx.createGain();
  notesReverbSend.gain.setValueAtTime(0.48, now);

  const leavesReverbSend = ctx.createGain();
  leavesReverbSend.gain.setValueAtTime(0.95, now);

  const rainReverbSend = ctx.createGain();
  rainReverbSend.gain.setValueAtTime(0.10, now);

  const nightReverbSend = ctx.createGain();
  nightReverbSend.gain.setValueAtTime(0.42, now);

  const padReverbSend = ctx.createGain();
  padReverbSend.gain.setValueAtTime(0.95, now);

  const windReverbSend = ctx.createGain();
  windReverbSend.gain.setValueAtTime(0.48, now);

  const irCache = new Map();
  const getIr = (presetId) => {
    const key = REVERB_PRESETS[presetId] ? presetId : 'forest';
    if (!irCache.has(key)) {
      irCache.set(key, createReverbImpulse(ctx, key, seed));
    }
    return irCache.get(key);
  };

  const convolverA = ctx.createConvolver();
  convolverA.buffer = getIr(reverbPreset);
  const convolverGainA = ctx.createGain();
  convolverGainA.gain.setValueAtTime(1, now);

  const convolverB = ctx.createConvolver();
  convolverB.buffer = getIr(reverbPreset);
  const convolverGainB = ctx.createGain();
  convolverGainB.gain.setValueAtTime(0, now);

  const reverbLPF = ctx.createBiquadFilter();
  reverbLPF.type = 'lowpass';
  reverbLPF.frequency.setValueAtTime(4600, now);

  const presetMeta = REVERB_PRESETS[reverbPreset] || REVERB_PRESETS.forest;
  const wetBus = ctx.createGain();
  wetBus.gain.setValueAtTime(reverbAmount * presetMeta.wetScale * 0.78, now);

  // --- Master Cleanup, Compressor & Anti-Clip Limiter ---
  const mixSum = ctx.createGain();
  mixSum.gain.setValueAtTime(1.0, now);

  const masterHPF = ctx.createBiquadFilter();
  masterHPF.type = 'highpass';
  masterHPF.frequency.setValueAtTime(42, now);

  const masterLPF = ctx.createBiquadFilter();
  masterLPF.type = 'lowpass';
  masterLPF.frequency.setValueAtTime(11500, now);

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-16, now);
  compressor.knee.setValueAtTime(20, now);
  compressor.ratio.setValueAtTime(3.2, now);
  compressor.attack.setValueAtTime(0.012, now);
  compressor.release.setValueAtTime(0.22, now);

  const safetyLimiter = ctx.createDynamicsCompressor();
  safetyLimiter.threshold.setValueAtTime(-1.5, now);
  safetyLimiter.knee.setValueAtTime(0, now);
  safetyLimiter.ratio.setValueAtTime(20, now);
  safetyLimiter.attack.setValueAtTime(0.002, now);
  safetyLimiter.release.setValueAtTime(0.08, now);

  const pauseGain = ctx.createGain();
  pauseGain.gain.setValueAtTime(1.0, now);

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(muted ? 0 : masterVolume, now);

  let analyser = null;
  if (withAnalyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;
  }

  // Routing
  notesBus.connect(dryBus);
  notesBus.connect(notesReverbSend);
  notesReverbSend.connect(wetSendSum);

  leavesBus.connect(dryBus);
  leavesBus.connect(leavesReverbSend);
  leavesReverbSend.connect(wetSendSum);

  leavesBus.connect(leafDelay);
  leafDelay.connect(leafDelayFilter);
  leafDelayFilter.connect(leafDelayFeedback);
  leafDelayFeedback.connect(leafDelay);
  leafDelayFilter.connect(leafDelayWet);
  leafDelayWet.connect(dryBus);
  leafDelayWet.connect(leavesReverbSend);

  dryBus.connect(notesHPF);
  notesHPF.connect(brightnessFilter);
  brightnessFilter.connect(mixSum);

  const ambientDryGate = ctx.createGain();
  ambientDryGate.gain.setValueAtTime(0.85, now);

  const ambientWetMaster = ctx.createGain();
  ambientWetMaster.gain.setValueAtTime(ambientVolume * 0.42, now);

  rainBus.connect(ambientMasterBus);
  nightBus.connect(ambientMasterBus);
  padBus.connect(ambientMasterBus);
  windBus.connect(ambientMasterBus);

  rainBus.connect(rainReverbSend);
  nightBus.connect(nightReverbSend);
  padBus.connect(padReverbSend);
  windBus.connect(windReverbSend);

  rainReverbSend.connect(ambientWetMaster);
  nightReverbSend.connect(ambientWetMaster);
  padReverbSend.connect(ambientWetMaster);
  windReverbSend.connect(ambientWetMaster);
  ambientWetMaster.connect(wetSendSum);

  ambientMasterBus.connect(ambientHPF);
  ambientHPF.connect(ambientLPF);
  ambientLPF.connect(ambientDryGate);
  ambientDryGate.connect(mixSum);

  wetSendSum.connect(convolverA);
  wetSendSum.connect(convolverB);
  convolverA.connect(convolverGainA);
  convolverB.connect(convolverGainB);
  convolverGainA.connect(reverbLPF);
  convolverGainB.connect(reverbLPF);
  reverbLPF.connect(wetBus);
  wetBus.connect(mixSum);

  mixSum.connect(masterHPF);
  masterHPF.connect(masterLPF);
  masterLPF.connect(compressor);
  compressor.connect(safetyLimiter);
  safetyLimiter.connect(pauseGain);
  pauseGain.connect(masterGain);

  if (analyser) {
    masterGain.connect(analyser);
    analyser.connect(ctx.destination);
  } else {
    masterGain.connect(ctx.destination);
  }

  let activeConvolverSlot = 'A';
  let currentReverbPreset = REVERB_PRESETS[reverbPreset] ? reverbPreset : 'forest';
  let currentReverbAmount = reverbAmount;

  return {
    notesBus,
    leavesBus,
    rainBus,
    nightBus,
    padBus,
    windBus,
    ambientMasterBus,
    ambientWetMaster,
    brightnessFilter,
    dryBus,
    wetBus,
    pauseGain,
    masterGain,
    compressor,
    safetyLimiter,
    analyser,

    setReverbPreset(nextPresetId, fadeSeconds = 0.8) {
      const targetId = REVERB_PRESETS[nextPresetId] ? nextPresetId : 'forest';
      const t = ctx.currentTime || 0;
      const meta = REVERB_PRESETS[targetId];

      if (targetId !== currentReverbPreset) {
        currentReverbPreset = targetId;
        const ir = getIr(targetId);

        if (activeConvolverSlot === 'A') {
          convolverB.buffer = ir;
          convolverGainA.gain.cancelScheduledValues(t);
          convolverGainB.gain.cancelScheduledValues(t);
          convolverGainA.gain.setValueAtTime(convolverGainA.gain.value, t);
          convolverGainB.gain.setValueAtTime(convolverGainB.gain.value, t);
          convolverGainA.gain.linearRampToValueAtTime(0, t + fadeSeconds);
          convolverGainB.gain.linearRampToValueAtTime(1, t + fadeSeconds);
          activeConvolverSlot = 'B';
        } else {
          convolverA.buffer = ir;
          convolverGainA.gain.cancelScheduledValues(t);
          convolverGainB.gain.cancelScheduledValues(t);
          convolverGainA.gain.setValueAtTime(convolverGainA.gain.value, t);
          convolverGainB.gain.setValueAtTime(convolverGainB.gain.value, t);
          convolverGainB.gain.linearRampToValueAtTime(0, t + fadeSeconds);
          convolverGainA.gain.linearRampToValueAtTime(1, t + fadeSeconds);
          activeConvolverSlot = 'A';
        }
      }

      wetBus.gain.cancelScheduledValues(t);
      wetBus.gain.setTargetAtTime(currentReverbAmount * meta.wetScale * 0.78, t, 0.05);
    },

    setReverbAmount(amount) {
      currentReverbAmount = Math.min(1, Math.max(0, amount));
      const t = ctx.currentTime || 0;
      const meta = REVERB_PRESETS[currentReverbPreset] || REVERB_PRESETS.forest;
      wetBus.gain.cancelScheduledValues(t);
      wetBus.gain.setTargetAtTime(currentReverbAmount * meta.wetScale * 0.78, t, 0.035);
      dryBus.gain.cancelScheduledValues(t);
      dryBus.gain.setTargetAtTime(0.88 - currentReverbAmount * 0.14, t, 0.035);
    },

    setAmbientMasterVolume(volume) {
      const v = Math.min(1, Math.max(0, volume));
      const t = ctx.currentTime || 0;
      ambientMasterBus.gain.cancelScheduledValues(t);
      ambientMasterBus.gain.setTargetAtTime(v * 0.34, t, 0.04);
      ambientWetMaster.gain.cancelScheduledValues(t);
      ambientWetMaster.gain.setTargetAtTime(v * 0.42, t, 0.04);
    },

    setBrightnessProgress(progress, isSettled = false) {
      const t = ctx.currentTime || 0;
      if (isSettled) {
        brightnessFilter.frequency.cancelScheduledValues(t);
        brightnessFilter.frequency.setTargetAtTime(3400, t, 0.45);
        return;
      }
      const p = Math.min(1, Math.max(0, progress));
      const targetFreq = 2200 + Math.pow(p, 0.85) * 4600;
      brightnessFilter.frequency.cancelScheduledValues(t);
      brightnessFilter.frequency.setTargetAtTime(targetFreq, t, 0.18);
    },
  };
}
