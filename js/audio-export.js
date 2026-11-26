import {
  AUDIO_FILES,
  AUDIO_LABELS,
  SCALES,
  buildCompositionSchedule,
  createCrossfadedLoopBuffer,
  createGardenAudioGraph,
  createPinkNoiseBuffer,
  findActiveStartOffset,
  semitonesToPlaybackRate,
} from './audio-graph.js';

const EXPORT_SAMPLE_RATE = 44100;
const TARGET_PEAK_LINEAR = Math.pow(10, -1 / 20); // -1.0 dBFS (~0.89125)

/**
 * Scan peak amplitude across all channels and compute safe -1 dB normalization gain.
 * Avoids dividing by zero on silent buffers and never produces clipping.
 * @param {AudioBuffer} buffer
 * @returns {{ peak: number, normGain: number, isSilent: boolean }}
 */
export function computeSafeNormalization(buffer) {
  let maxAbs = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > maxAbs) maxAbs = v;
    }
  }

  if (maxAbs <= 1e-6) {
    return { peak: 0, normGain: 1, isSilent: true };
  }

  // Safely scale up quiet mixes (capped at +15 dB / 5.6x) or attenuate loud peaks to -1 dB
  const normGain = Math.min(5.6, TARGET_PEAK_LINEAR / maxAbs);
  return { peak: maxAbs, normGain, isSilent: false };
}

/**
 * Encode a stereo AudioBuffer to a 16-bit 44.1 kHz PCM WAV Blob
 * with safe peak normalization around -1 dB (no external libraries).
 * @param {AudioBuffer} audioBuffer
 * @returns {{ blob: Blob, duration: number, peakAfterNorm: number, isSilent: boolean }}
 */
export function encodeWav16Stereo(audioBuffer) {
  const numChannels = 2;
  const sampleRate = audioBuffer.sampleRate || EXPORT_SAMPLE_RATE;
  const numFrames = audioBuffer.length;
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;

  const { normGain, isSilent } = computeSafeNormalization(audioBuffer);
  const dataBytes = numFrames * numChannels * 2;
  const wavBuffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wavBuffer);

  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // Standard 44-byte RIFF/WAVE PCM header
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  let peakAfterNorm = 0;

  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, left[i] * normGain));
    const r = Math.max(-1, Math.min(1, right[i] * normGain));

    const absL = Math.abs(l);
    const absR = Math.abs(r);
    if (absL > peakAfterNorm) peakAfterNorm = absL;
    if (absR > peakAfterNorm) peakAfterNorm = absR;

    const intL = l < 0 ? Math.round(l * 32768) : Math.round(l * 32767);
    const intR = r < 0 ? Math.round(r * 32768) : Math.round(r * 32767);

    view.setInt16(offset, Math.max(-32768, Math.min(32767, intL)), true);
    view.setInt16(offset + 2, Math.max(-32768, Math.min(32767, intR)), true);
    offset += 4;
  }

  return {
    blob: new Blob([wavBuffer], { type: 'audio/wav' }),
    duration: numFrames / sampleRate,
    peakAfterNorm,
    isSilent,
  };
}

/**
 * Decode all 5 audio files directly onto the target OfflineAudioContext so sample
 * rates align cleanly at 44.1 kHz without altering live AudioContext buffers.
 */
async function decodeAssetsForContext(ctx) {
  const buffers = new Map();
  const activeOffsets = new Map();
  const missing = [];

  await Promise.all(
    Object.entries(AUDIO_FILES).map(async ([key, url]) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const raw = await response.arrayBuffer();
        const decoded = await ctx.decodeAudioData(raw);
        if (key === 'ambientRain' || key === 'ambientNight') {
          buffers.set(key, createCrossfadedLoopBuffer(ctx, decoded, 2.5));
        } else {
          buffers.set(key, decoded);
          activeOffsets.set(key, findActiveStartOffset(decoded));
        }
      } catch {
        missing.push(AUDIO_LABELS[key]);
      }
    })
  );

  return { buffers, activeOffsets, missing };
}

/**
 * Schedule a sample note onto OfflineAudioContext without real-time timers.
 */
function scheduleSampleNote(ctx, bus, {
  buffer,
  offset,
  when,
  playbackRate,
  gainAmount,
  pan,
  noteDuration,
  attack,
  release,
}) {
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
  panner.connect(bus);

  source.start(when, offset);
  source.stop(endTime + 0.02);
}

/**
 * Schedule a synthesized fallback or resolving chord tone onto OfflineAudioContext.
 */
function scheduleSynthNote(ctx, bus, {
  when,
  frequency,
  gainAmount,
  pan,
  noteDuration,
  attack,
  release,
  isLeaf,
}) {
  const safeAttack = Math.min(attack, noteDuration * 0.35);
  const safeRelease = Math.min(release, noteDuration * 0.6);
  const releaseStart = Math.max(when + safeAttack, when + noteDuration - safeRelease);
  const endTime = when + noteDuration;

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
  panner.connect(bus);

  osc.start(when);
  osc.stop(endTime + 0.02);
}

/**
 * Render the current Fractal Garden composition offline with OfflineAudioContext,
 * sharing the exact routing, settings, seeded randomness, and schedule as live playback.
 *
 * @param {Object} options
 * @param {Array<Object>} options.events
 * @param {Object} options.bounds
 * @param {number} options.maxDepth
 * @param {number} options.speed
 * @param {number} options.seed
 * @param {number} options.tempo
 * @param {string} options.scale
 * @param {string} options.reverbPreset
 * @param {number} options.reverbAmount
 * @param {number} options.masterVolume Effective unmuted master volume [0, 1]
 * @param {number} options.notesVolume
 * @param {number} options.leavesVolume
 * @param {number} options.ambientVolume
 * @param {Object} options.layers
 * @param {string} options.lengthMode 'full' | '1m' | '3m'
 * @param {(pct: number) => void} [options.onProgress]
 * @returns {Promise<{ blob: Blob, fileName: string, duration: number, peakAfterNorm: number, missing: string[] }>}
 */
export async function renderCompositionWav({
  events,
  bounds,
  maxDepth,
  speed,
  seed,
  tempo,
  scale,
  reverbPreset,
  reverbAmount,
  masterVolume,
  notesVolume,
  leavesVolume,
  ambientVolume,
  layers,
  lengthMode = 'full',
  onProgress = () => {},
}) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    throw new Error('OfflineAudioContext is not supported in this browser.');
  }

  const hasAmbient =
    ambientVolume > 0 &&
    ['rain', 'night', 'pad', 'wind'].some((k) => layers[k]?.enabled && layers[k]?.volume > 0);

  const schedule = buildCompositionSchedule({
    events,
    bounds,
    maxDepth,
    speed,
    tempo,
    scale,
    seed,
    lengthMode,
    reverbPreset,
    hasAmbient,
  });

  const frameCount = Math.max(
    EXPORT_SAMPLE_RATE,
    Math.ceil(schedule.totalRenderSec * EXPORT_SAMPLE_RATE)
  );
  const ctx = new OfflineCtx(2, frameCount, EXPORT_SAMPLE_RATE);

  onProgress(5);
  const { buffers, activeOffsets, missing } = await decodeAssetsForContext(ctx);
  onProgress(18);

  const graph = createGardenAudioGraph(ctx, {
    masterVolume,
    notesVolume,
    leavesVolume,
    ambientVolume,
    reverbAmount,
    reverbPreset,
    seed,
    muted: false,
    withAnalyser: false,
  });

  // Set per-layer bus volumes
  graph.rainBus.gain.setValueAtTime(layers.rain.enabled ? layers.rain.volume : 0, 0);
  graph.nightBus.gain.setValueAtTime(layers.night.enabled ? layers.night.volume : 0, 0);
  graph.padBus.gain.setValueAtTime(layers.pad.enabled ? layers.pad.volume : 0, 0);
  graph.windBus.gain.setValueAtTime(layers.wind.enabled ? layers.wind.volume : 0, 0);

  // 2s fade-in at start and 4s fade-out of source buses before reverb tail finishes
  const { fadeInSec, fadeOutStart, fadeOutEnd, totalRenderSec } = schedule;

  graph.ambientMasterBus.gain.setValueAtTime(0, 0);
  graph.ambientMasterBus.gain.linearRampToValueAtTime(ambientVolume * 0.34, fadeInSec);
  graph.ambientMasterBus.gain.setValueAtTime(ambientVolume * 0.34, fadeOutStart);
  graph.ambientMasterBus.gain.linearRampToValueAtTime(0, fadeOutEnd);

  graph.ambientWetMaster.gain.setValueAtTime(0, 0);
  graph.ambientWetMaster.gain.linearRampToValueAtTime(ambientVolume * 0.42, fadeInSec);
  graph.ambientWetMaster.gain.setValueAtTime(ambientVolume * 0.42, fadeOutStart);
  graph.ambientWetMaster.gain.linearRampToValueAtTime(0, fadeOutEnd);

  graph.notesBus.gain.setValueAtTime(notesVolume, 0);
  graph.notesBus.gain.setValueAtTime(notesVolume, fadeOutStart);
  graph.notesBus.gain.linearRampToValueAtTime(0, fadeOutEnd);

  graph.leavesBus.gain.setValueAtTime(leavesVolume, 0);
  graph.leavesBus.gain.setValueAtTime(leavesVolume, fadeOutStart);
  graph.leavesBus.gain.linearRampToValueAtTime(0, fadeOutEnd);

  // Gentle anti-click master envelope; stays at target through reverbTailSec
  graph.masterGain.gain.setValueAtTime(0, 0);
  graph.masterGain.gain.linearRampToValueAtTime(masterVolume, 0.08);
  graph.masterGain.gain.setValueAtTime(masterVolume, Math.max(0.1, totalRenderSec - 0.12));
  graph.masterGain.gain.linearRampToValueAtTime(0, totalRenderSec);

  const pinkNoiseBuffer = createPinkNoiseBuffer(ctx, 4, seed);

  // Schedule enabled ambient layers strictly up to fadeOutEnd (letting reverb ring out after)
  const ambientStopTime = fadeOutEnd + 0.05;

  if (layers.rain.enabled && layers.rain.volume > 0) {
    const rainBuf = buffers.get('ambientRain');
    if (rainBuf) {
      const src = ctx.createBufferSource();
      src.buffer = rainBuf;
      src.loop = true;
      src.connect(graph.rainBus);
      src.start(0);
      src.stop(ambientStopTime);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = pinkNoiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(750, 0);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.42, 0);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(graph.rainBus);
      src.start(0);
      src.stop(ambientStopTime);
    }
  }

  if (layers.night.enabled && layers.night.volume > 0) {
    const nightBuf = buffers.get('ambientNight');
    if (nightBuf) {
      const src = ctx.createBufferSource();
      src.buffer = nightBuf;
      src.loop = true;
      src.connect(graph.nightBus);
      src.start(0);
      src.stop(ambientStopTime);
    } else {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(196, 0);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.08, 0);
      osc.connect(gain);
      gain.connect(graph.nightBus);
      osc.start(0);
      osc.stop(ambientStopTime);
    }
  }

  if (layers.pad.enabled && layers.pad.volume > 0) {
    const scaleDef = SCALES[scale] || SCALES['c-major'];
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.setValueAtTime(640, 0);
    padFilter.Q.setValueAtTime(0.7, 0);

    const padBreathGain = ctx.createGain();
    padBreathGain.gain.setValueAtTime(0.24, 0);

    const filterLfo = ctx.createOscillator();
    filterLfo.type = 'sine';
    filterLfo.frequency.setValueAtTime(0.08, 0);
    const filterDepth = ctx.createGain();
    filterDepth.gain.setValueAtTime(240, 0);
    filterLfo.connect(filterDepth);
    filterDepth.connect(padFilter.frequency);

    const ampLfo = ctx.createOscillator();
    ampLfo.type = 'sine';
    ampLfo.frequency.setValueAtTime(0.062, 0);
    const ampDepth = ctx.createGain();
    ampDepth.gain.setValueAtTime(0.06, 0);
    ampLfo.connect(ampDepth);
    ampDepth.connect(padBreathGain.gain);

    const voiceOscs = scaleDef.chords[0].padSemitones.map((st, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(scaleDef.refFreq * semitonesToPlaybackRate(st), 0);

      const vGain = ctx.createGain();
      vGain.gain.setValueAtTime(idx === 0 ? 0.36 : 0.22, 0);
      osc.connect(vGain);
      vGain.connect(padFilter);
      osc.start(0);
      osc.stop(ambientStopTime);
      return osc;
    });

    // Schedule deterministic chord progression glides without timers
    for (const ch of schedule.chords) {
      voiceOscs.forEach((osc, idx) => {
        const st = ch.chord.padSemitones[idx] ?? ch.chord.padSemitones[0];
        const freq = scaleDef.refFreq * semitonesToPlaybackRate(st);
        osc.frequency.setTargetAtTime(freq, ch.time, ch.isResolving ? 1.1 : 0.75);
      });
    }

    padFilter.connect(padBreathGain);
    padBreathGain.connect(graph.padBus);
    filterLfo.start(0);
    ampLfo.start(0);
    filterLfo.stop(ambientStopTime);
    ampLfo.stop(ambientStopTime);
  }

  if (layers.wind.enabled && layers.wind.volume > 0) {
    const src = ctx.createBufferSource();
    src.buffer = pinkNoiseBuffer;
    src.loop = true;

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.setValueAtTime(360, 0);
    windFilter.Q.setValueAtTime(1.25, 0);

    const windBreathGain = ctx.createGain();
    windBreathGain.gain.setValueAtTime(0.45, 0);

    const filterLfo = ctx.createOscillator();
    filterLfo.type = 'sine';
    filterLfo.frequency.setValueAtTime(0.09, 0);
    const filterDepth = ctx.createGain();
    filterDepth.gain.setValueAtTime(175, 0);
    filterLfo.connect(filterDepth);
    filterDepth.connect(windFilter.frequency);

    const ampLfo = ctx.createOscillator();
    ampLfo.type = 'sine';
    ampLfo.frequency.setValueAtTime(0.055, 0);
    const ampDepth = ctx.createGain();
    ampDepth.gain.setValueAtTime(0.24, 0);
    ampLfo.connect(ampDepth);
    ampDepth.connect(windBreathGain.gain);

    src.connect(windFilter);
    windFilter.connect(windBreathGain);
    windBreathGain.connect(graph.windBus);

    src.start(0);
    filterLfo.start(0);
    ampLfo.start(0);
    src.stop(ambientStopTime);
    filterLfo.stop(ambientStopTime);
    ampLfo.stop(ambientStopTime);
  }

  // Schedule deterministic brightness curve
  for (const b of schedule.brightnessEvents) {
    graph.brightnessFilter.frequency.setTargetAtTime(b.frequency, b.time, b.settled ? 0.45 : 0.25);
  }

  // Schedule all tree notes
  for (const note of schedule.notes) {
    const bus = note.busName === 'leavesBus' ? graph.leavesBus : graph.notesBus;
    const buffer = buffers.get(note.key);
    if (buffer) {
      scheduleSampleNote(ctx, bus, {
        buffer,
        offset: activeOffsets.get(note.key) || 0,
        when: note.time,
        playbackRate: note.playbackRate,
        gainAmount: note.gainAmount,
        pan: note.pan,
        noteDuration: note.noteDuration,
        attack: note.attack,
        release: note.release,
      });
    } else {
      scheduleSynthNote(ctx, bus, {
        when: note.time,
        frequency: note.fallbackFreq,
        gainAmount: note.gainAmount * 0.45,
        pan: note.pan,
        noteDuration: note.noteDuration,
        attack: note.attack,
        release: note.release,
        isLeaf: note.isLeaf,
      });
    }
  }

  // Schedule soft resolving chord notes
  for (const rNote of schedule.resolvingNotes) {
    scheduleSynthNote(ctx, graph.leavesBus, {
      when: rNote.time,
      frequency: rNote.frequency,
      gainAmount: rNote.gainAmount,
      pan: rNote.pan,
      noteDuration: rNote.noteDuration,
      attack: rNote.attack,
      release: rNote.release,
      isLeaf: true,
    });
  }

  onProgress(24);

  // Render offline audio while smoothly reporting progress via requestAnimationFrame
  let rafId = null;
  let visualPct = 24;
  const updateRenderProgress = () => {
    const ctxPct =
      schedule.totalRenderSec > 0
        ? 24 + (ctx.currentTime / schedule.totalRenderSec) * 64
        : 24;
    visualPct = Math.min(88, Math.max(visualPct + 0.5, ctxPct));
    onProgress(Math.round(visualPct));
    rafId = requestAnimationFrame(updateRenderProgress);
  };
  if (typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(updateRenderProgress);
  }

  let renderedBuffer;
  try {
    renderedBuffer = await ctx.startRendering();
  } finally {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
    }
  }

  onProgress(92);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const encoded = encodeWav16Stereo(renderedBuffer);
  onProgress(100);

  const moodSlug = (SCALES[scale] || SCALES['c-major']).slug;
  const fileName = `fractal-garden_depth${maxDepth}_seed${seed}_${moodSlug}.wav`;

  return {
    blob: encoded.blob,
    fileName,
    duration: encoded.duration,
    peakAfterNorm: encoded.peakAfterNorm,
    isSilent: encoded.isSilent,
    missing,
  };
}

/**
 * Trigger browser file download for a Blob and clean up object URL.
 * @param {Blob} blob
 * @param {string} fileName
 */
export function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
