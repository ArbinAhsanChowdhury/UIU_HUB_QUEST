import { generateFractalTree, getTreeBounds, getTreeTotalDuration } from './tree.js';
import { TreeRenderer } from './renderer.js';
import { GardenAudio } from './audio.js';
import { renderCompositionWav, triggerBlobDownload } from './audio-export.js';

const DEFAULTS = {
  depth: 7,
  branchAngle: 25,
  lengthRatio: 0.72,
  randomness: 0.2,
  speed: 1.0,
  seed: 4217,
  scale: 'c-major',
  tempo: 70,
  reverbPreset: 'forest',
  reverb: 0.42,
  masterVolume: 0.8,
  notesVolume: 0.8,
  leavesVolume: 0.7,
  ambientVolume: 0.52,
  layers: {
    rain: { enabled: true, volume: 0.48 },
    night: { enabled: true, volume: 0.52 },
    pad: { enabled: true, volume: 0.46 },
    wind: { enabled: true, volume: 0.36 },
  },
};

const PRESETS = {
  'calm-rain': {
    depth: 6,
    branchAngle: 22,
    lengthRatio: 0.72,
    randomness: 0.15,
    speed: 0.9,
    scale: 'c-major',
    tempo: 66,
    reverbPreset: 'small-garden',
    reverb: 0.42,
    masterVolume: 0.8,
    notesVolume: 0.82,
    leavesVolume: 0.72,
    ambientVolume: 0.58,
    layers: {
      rain: { enabled: true, volume: 0.72 },
      night: { enabled: false, volume: 0.3 },
      pad: { enabled: true, volume: 0.42 },
      wind: { enabled: true, volume: 0.28 },
    },
  },
  'moonlit-night': {
    depth: 8,
    branchAngle: 32,
    lengthRatio: 0.74,
    randomness: 0.3,
    speed: 1.0,
    scale: 'a-minor',
    tempo: 62,
    reverbPreset: 'open-sky',
    reverb: 0.62,
    masterVolume: 0.8,
    notesVolume: 0.78,
    leavesVolume: 0.78,
    ambientVolume: 0.55,
    layers: {
      rain: { enabled: false, volume: 0.35 },
      night: { enabled: true, volume: 0.72 },
      pad: { enabled: true, volume: 0.55 },
      wind: { enabled: true, volume: 0.35 },
    },
  },
  'deep-forest': {
    depth: 9,
    branchAngle: 36,
    lengthRatio: 0.76,
    randomness: 0.45,
    speed: 0.8,
    scale: 'a-minor',
    tempo: 56,
    reverbPreset: 'forest',
    reverb: 0.68,
    masterVolume: 0.82,
    notesVolume: 0.76,
    leavesVolume: 0.7,
    ambientVolume: 0.6,
    layers: {
      rain: { enabled: true, volume: 0.52 },
      night: { enabled: true, volume: 0.64 },
      pad: { enabled: true, volume: 0.58 },
      wind: { enabled: true, volume: 0.56 },
    },
  },
};

const LOOP_HOLD_MS = 2200;

const welcomeOverlay = document.getElementById('welcome-overlay');
const enterGardenBtn = document.getElementById('enter-garden-btn');

const appShell = document.getElementById('app-shell');
const canvas = document.getElementById('garden-canvas');
const controlPanel = document.getElementById('control-panel');
const focusBtn = document.getElementById('focus-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const panelToggleBtn = document.getElementById('panel-toggle-btn');
const panelCloseBtn = document.getElementById('panel-close-btn');

const readoutDepth = document.getElementById('readout-depth');
const readoutBranches = document.getElementById('readout-branches');
const readoutLeaves = document.getElementById('readout-leaves');
const readoutSound = document.getElementById('readout-sound');

const playPauseBtn = document.getElementById('play-pause-btn');
const stopBtn = document.getElementById('stop-btn');
const restartBtn = document.getElementById('restart-btn');
const loopBtn = document.getElementById('loop-btn');
const sleepTimerSelect = document.getElementById('sleep-timer-select');
const sleepCountdown = document.getElementById('sleep-countdown');

const progressBar = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const timeReadout = document.getElementById('time-readout');

const presetButtons = Array.from(document.querySelectorAll('[data-preset]'));
const resetDefaultsBtn = document.getElementById('reset-defaults-btn');

const depthInput = document.getElementById('depth-input');
const angleInput = document.getElementById('angle-input');
const ratioInput = document.getElementById('ratio-input');
const randomnessInput = document.getElementById('randomness-input');
const speedInput = document.getElementById('speed-input');
const seedInput = document.getElementById('seed-input');
const newSeedBtn = document.getElementById('new-seed-btn');

const scaleSelect = document.getElementById('scale-select');
const tempoInput = document.getElementById('tempo-input');
const reverbInput = document.getElementById('reverb-input');
const reverbPresetButtons = Array.from(document.querySelectorAll('[data-reverb-preset]'));

const muteBtn = document.getElementById('mute-btn');
const masterVolInput = document.getElementById('master-vol-input');
const notesVolInput = document.getElementById('notes-vol-input');
const leavesVolInput = document.getElementById('leaves-vol-input');
const ambientVolInput = document.getElementById('ambient-vol-input');

const exportLengthSelect = document.getElementById('export-length-select');
const downloadWavBtn = document.getElementById('download-wav-btn');
const exportProgressWrap = document.getElementById('export-progress-wrap');
const exportProgressFill = document.getElementById('export-progress-fill');
const exportStatus = document.getElementById('export-status');

const layerControls = {
  rain: {
    toggle: document.getElementById('rain-toggle'),
    input: document.getElementById('rain-vol-input'),
    output: document.getElementById('rain-vol-value'),
  },
  night: {
    toggle: document.getElementById('night-toggle'),
    input: document.getElementById('night-vol-input'),
    output: document.getElementById('night-vol-value'),
  },
  pad: {
    toggle: document.getElementById('pad-toggle'),
    input: document.getElementById('pad-vol-input'),
    output: document.getElementById('pad-vol-value'),
  },
  wind: {
    toggle: document.getElementById('wind-toggle'),
    input: document.getElementById('wind-vol-input'),
    output: document.getElementById('wind-vol-value'),
  },
};

const depthValue = document.getElementById('depth-value');
const angleValue = document.getElementById('angle-value');
const ratioValue = document.getElementById('ratio-value');
const randomnessValue = document.getElementById('randomness-value');
const speedValue = document.getElementById('speed-value');
const tempoValue = document.getElementById('tempo-value');
const reverbValue = document.getElementById('reverb-value');
const masterVolValue = document.getElementById('master-vol-value');
const notesVolValue = document.getElementById('notes-vol-value');
const leavesVolValue = document.getElementById('leaves-vol-value');
const ambientVolValue = document.getElementById('ambient-vol-value');

const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const treeMeta = document.getElementById('tree-meta');
const audioStatus = document.getElementById('audio-status');

const params = {
  depth: Number(depthInput.value),
  branchAngle: Number(angleInput.value),
  lengthRatio: Number(ratioInput.value),
  randomness: Number(randomnessInput.value),
  speed: Number(speedInput.value),
  seed: Number(seedInput.value),
};

let currentEvents = [];
let currentBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
let leafCount = 0;
let loopEnabled = false;
let loopHoldTimer = null;
let activePresetId = null;
let isExporting = false;
let focusMode = false;
let panelCollapsed = true;
let controlsHidden = false;
let inactivityTimer = null;
let pausedByVisibility = false;

const INACTIVITY_HIDE_MS = 3500;

let lastNoteLabel = '—';
let lastChordLabel = 'Cadd9';

let sleepTimerInterval = null;
let sleepRemainingSeconds = 0;
let sleepFadeTriggered = false;

const triggeredBranchIds = new Set();

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let isReducedMotion = motionQuery.matches;

const audio = new GardenAudio({
  onStatusChange: ({ missing, message }) => {
    audioStatus.textContent = message;
    audioStatus.classList.toggle('is-warning', missing.length > 0);
  },
  onNoteTriggered: ({ branchId, noteName, chordName, duration }) => {
    lastNoteLabel = noteName;
    lastChordLabel = chordName;
    readoutSound.textContent = `${lastNoteLabel} · ${lastChordLabel}`;
    renderer.highlightBranch(branchId, Math.min(0.95, duration * 0.78));
  },
});

const renderer = new TreeRenderer(canvas, {
  onStateChange: handleRendererStateChange,
  onProgress: handleGrowthProgress,
  getAudioLevel: () => audio.getEnergyLevel(),
});

function formatTime(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = (safe % 60).toFixed(1).padStart(4, '0');
  return `${mins}:${secs}`;
}

function formatCountdown(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(safe / 60);
  const secs = String(safe % 60).padStart(2, '0');
  return `${String(mins).padStart(2, '0')}:${secs}`;
}

function clearLoopTimer() {
  if (loopHoldTimer !== null) {
    clearTimeout(loopHoldTimer);
    loopHoldTimer = null;
  }
}

function updateLiveRecursionReadout(elapsed, state) {
  const totalBranches = currentEvents.length;
  let reachedDepth = 0;
  let branchesGrown = 0;
  let leavesReached = 0;

  if (state === 'preview' || state === 'complete') {
    reachedDepth = params.depth;
    branchesGrown = totalBranches;
    leavesReached = leafCount;
  } else if (state !== 'idle') {
    for (const branch of currentEvents) {
      if (branch.startTime > elapsed) {
        break;
      }
      branchesGrown++;
      if (branch.depth > reachedDepth) {
        reachedDepth = branch.depth;
      }
      if (branch.isLeaf && elapsed >= branch.startTime + branch.duration * 0.55) {
        leavesReached++;
      }
    }
  }

  readoutDepth.textContent = `${reachedDepth} / ${params.depth}`;
  readoutBranches.textContent = `${branchesGrown} / ${totalBranches}`;
  readoutLeaves.textContent = `${leavesReached} / ${leafCount}`;
  readoutSound.textContent = `${lastNoteLabel} · ${audio.getCurrentChord().name}`;
}

function clearInactivityTimer() {
  if (inactivityTimer !== null) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function showControlsAndResetIdle() {
  if (controlsHidden) {
    controlsHidden = false;
    appShell.classList.remove('is-controls-hidden');
  }
  clearInactivityTimer();

  const isPlaying =
    welcomeOverlay.hidden &&
    panelCollapsed &&
    !focusMode &&
    !isExporting &&
    (renderer.state === 'growing' || (audio.isPlayingTree && !audio.isPaused));

  if (isPlaying) {
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null;
      if (
        welcomeOverlay.hidden &&
        panelCollapsed &&
        !focusMode &&
        !isExporting &&
        (renderer.state === 'growing' || (audio.isPlayingTree && !audio.isPaused))
      ) {
        controlsHidden = true;
        appShell.classList.add('is-controls-hidden');
      }
    }, INACTIVITY_HIDE_MS);
  }
}

function handleGrowthProgress(elapsed, prevElapsed, state) {
  updateLiveRecursionReadout(elapsed, state);

  if (!audio.initialized || !audio.isPlayingTree || audio.isPaused) return;

  const progress = renderer.totalDuration > 0 ? Math.min(1, elapsed / renderer.totalDuration) : 1;
  audio.updateGrowthProgress(progress);

  for (const branch of currentEvents) {
    if (branch.startTime > elapsed) {
      break;
    }
    if (triggeredBranchIds.has(branch.id)) {
      continue;
    }
    if (branch.startTime >= prevElapsed - 0.08) {
      triggeredBranchIds.add(branch.id);
      audio.playBranchEvent(branch, currentBounds, params.depth, elapsed);
    } else {
      triggeredBranchIds.add(branch.id);
    }
  }

  if (state === 'complete') {
    audio.completeGrowth();
  }
}

function handleRendererStateChange(state, progress) {
  updatePlaybackUI(state, progress);
  updateLiveRecursionReadout(renderer.elapsed, state);

  if (state === 'complete' && loopEnabled && !isReducedMotion) {
    clearLoopTimer();
    statusText.textContent = 'Full bloom · looping…';
    loopHoldTimer = setTimeout(() => {
      loopHoldTimer = null;
      if (loopEnabled && renderer.state === 'complete') {
        startPlayback({ keepAmbient: true });
      }
    }, LOOP_HOLD_MS);
  }
}

function updateReadouts() {
  depthValue.textContent = String(params.depth);
  angleValue.textContent = `${params.branchAngle}°`;
  ratioValue.textContent = params.lengthRatio.toFixed(2);
  randomnessValue.textContent = params.randomness.toFixed(2);
  speedValue.textContent = `${params.speed.toFixed(1)}x`;

  tempoValue.textContent = `${audio.pendingTempo} BPM`;
  reverbValue.textContent = `${Math.round(audio.reverbAmount * 100)}%`;

  const displayMaster = audio.muted ? 0 : audio.masterVolume;
  masterVolValue.textContent = `${Math.round(displayMaster * 100)}%`;
  notesVolValue.textContent = `${Math.round(audio.notesVolume * 100)}%`;
  leavesVolValue.textContent = `${Math.round(audio.leavesVolume * 100)}%`;
  ambientVolValue.textContent = `${Math.round(audio.ambientVolume * 100)}%`;

  for (const name of ['rain', 'night', 'pad', 'wind']) {
    layerControls[name].output.textContent = `${Math.round(audio.layers[name].volume * 100)}%`;
  }
}

function updateToggleButtons() {
  muteBtn.setAttribute('aria-pressed', String(audio.muted));
  muteBtn.textContent = audio.muted ? 'Muted' : 'Mute';
  muteBtn.classList.toggle('is-muted', audio.muted);

  loopBtn.setAttribute('aria-pressed', String(loopEnabled));
  loopBtn.textContent = loopEnabled ? 'Loop: On' : 'Loop: Off';
  loopBtn.classList.toggle('is-active', loopEnabled);

  for (const btn of reverbPresetButtons) {
    const active = btn.dataset.reverbPreset === audio.reverbPreset;
    btn.setAttribute('aria-pressed', String(active));
    btn.classList.toggle('is-active', active);
  }

  for (const name of ['rain', 'night', 'pad', 'wind']) {
    const enabled = audio.layers[name].enabled;
    const btn = layerControls[name].toggle;
    btn.setAttribute('aria-pressed', String(enabled));
    btn.textContent = enabled ? 'On' : 'Off';
    btn.classList.toggle('is-active', enabled);
  }

  for (const btn of presetButtons) {
    btn.classList.toggle('is-active', btn.dataset.preset === activePresetId);
  }
}

function updateViewControls() {
  appShell.classList.toggle('is-focus-mode', focusMode);
  appShell.classList.toggle('is-panel-collapsed', panelCollapsed);
  controlPanel.setAttribute('aria-hidden', String(panelCollapsed || focusMode));

  focusBtn.setAttribute('aria-pressed', String(focusMode));
  focusBtn.textContent = focusMode ? 'Exit focus' : 'Focus mode';

  panelToggleBtn.setAttribute('aria-expanded', String(!panelCollapsed));
  panelToggleBtn.textContent = panelCollapsed ? 'Controls' : 'Hide panel';

  const fsActive = Boolean(document.fullscreenElement);
  fullscreenBtn.setAttribute('aria-pressed', String(fsActive));
  fullscreenBtn.textContent = fsActive ? 'Exit fullscreen' : 'Fullscreen';

  showControlsAndResetIdle();
}

function updateTreeMeta() {
  const totalBranches = currentEvents.length;
  const durationSec = (getTreeTotalDuration(currentEvents) / params.speed).toFixed(1);
  const branchLabel = totalBranches === 1 ? 'branch' : 'branches';
  const leafLabel = leafCount === 1 ? 'leaf' : 'leaves';
  treeMeta.textContent = `${totalBranches} ${branchLabel} · ${leafCount} ${leafLabel} · ${durationSec}s`;
}

function updatePlaybackUI(state, progress) {
  statusDot.dataset.state = state;

  const totalSec = getTreeTotalDuration(currentEvents) / params.speed;
  const elapsedSec =
    state === 'preview' || state === 'idle'
      ? 0
      : state === 'complete'
        ? totalSec
        : renderer.elapsed / params.speed;
  const pct = Math.round(
    state === 'preview' || state === 'idle' ? 0 : progress * 100
  );

  progressFill.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', String(pct));
  timeReadout.textContent = `${formatTime(elapsedSec)} / ${formatTime(totalSec)}`;

  if (isReducedMotion) {
    playPauseBtn.textContent = 'Play';
    playPauseBtn.disabled = false;
    stopBtn.disabled = state === 'idle';
    statusText.textContent =
      state === 'idle' ? 'Stopped (reduced motion)' : `Static preview · ${currentEvents.length} branches`;
    return;
  }

  switch (state) {
    case 'growing':
      playPauseBtn.textContent = 'Pause';
      stopBtn.disabled = false;
      statusText.textContent = `Playing… ${pct}%`;
      break;
    case 'paused':
      playPauseBtn.textContent = 'Resume';
      stopBtn.disabled = false;
      statusText.textContent = pausedByVisibility ? 'Paused (tab hidden)' : `Paused · ${pct}%`;
      break;
    case 'complete':
      playPauseBtn.textContent = 'Play';
      stopBtn.disabled = false;
      statusText.textContent = `Full bloom · ${currentEvents.length} branches`;
      break;
    case 'preview':
      playPauseBtn.textContent = 'Play';
      stopBtn.disabled = false;
      statusText.textContent = `Preview · ${currentEvents.length} branches`;
      break;
    case 'idle':
    default:
      playPauseBtn.textContent = 'Play';
      stopBtn.disabled = true;
      statusText.textContent = 'Stopped';
      break;
  }
}

function previewTreeChanges() {
  clearLoopTimer();
  audio.stop();
  triggeredBranchIds.clear();
  lastNoteLabel = '—';

  audio.setSeed(params.seed);
  currentEvents = generateFractalTree({
    depth: params.depth,
    branchAngle: params.branchAngle,
    lengthRatio: params.lengthRatio,
    randomness: params.randomness,
    seed: params.seed,
  });

  currentBounds = getTreeBounds(currentEvents);
  leafCount = currentEvents.reduce((count, branch) => count + (branch.isLeaf ? 1 : 0), 0);

  updateReadouts();
  updateTreeMeta();
  renderer.showPreview(currentEvents, params.depth);
  updateLiveRecursionReadout(renderer.elapsed, renderer.state);
}

function startPlayback({ keepAmbient = false } = {}) {
  clearLoopTimer();
  pausedByVisibility = false;
  triggeredBranchIds.clear();
  lastNoteLabel = '—';
  if (sleepFadeTriggered) {
    sleepFadeTriggered = false;
    audio.cancelSleepFade();
  }
  audio.startGrowth({
    keepAmbient,
    events: currentEvents,
    bounds: currentBounds,
    maxDepth: params.depth,
    speed: params.speed,
    seed: params.seed,
  });
  renderer.grow();
  showControlsAndResetIdle();
}

function handlePlayPause() {
  clearLoopTimer();
  pausedByVisibility = false;

  if (isReducedMotion) {
    startPlayback();
    return;
  }

  if (renderer.state === 'growing') {
    renderer.togglePause();
    audio.pause();
    showControlsAndResetIdle();
  } else if (renderer.state === 'paused') {
    renderer.togglePause();
    audio.resume();
    showControlsAndResetIdle();
  } else {
    startPlayback();
  }
}

function handleStop() {
  clearLoopTimer();
  pausedByVisibility = false;
  triggeredBranchIds.clear();
  lastNoteLabel = '—';
  audio.stop();
  renderer.reset();
  updateLiveRecursionReadout(0, 'idle');
  showControlsAndResetIdle();
}

function handleRestart() {
  startPlayback();
}

function pickNewSeed() {
  let nextSeed = Math.floor(Math.random() * 999999) + 1;
  if (nextSeed === params.seed) {
    nextSeed = (nextSeed % 999999) + 1;
  }
  activePresetId = null;
  params.seed = nextSeed;
  seedInput.value = String(nextSeed);
  updateToggleButtons();
  previewTreeChanges();
}

function applyConfiguration(config, presetId) {
  activePresetId = presetId;

  params.depth = config.depth;
  params.branchAngle = config.branchAngle;
  params.lengthRatio = config.lengthRatio;
  params.randomness = config.randomness;
  params.speed = config.speed;
  if (config.seed !== undefined) {
    params.seed = config.seed;
    seedInput.value = String(config.seed);
  }

  depthInput.value = String(params.depth);
  angleInput.value = String(params.branchAngle);
  ratioInput.value = String(params.lengthRatio);
  randomnessInput.value = String(params.randomness);
  speedInput.value = String(params.speed);
  renderer.setSpeed(params.speed);

  scaleSelect.value = config.scale;
  audio.setScale(config.scale);

  tempoInput.value = String(config.tempo);
  audio.setTempo(config.tempo);

  audio.setReverbPreset(config.reverbPreset);
  reverbInput.value = String(config.reverb);
  audio.setReverbAmount(config.reverb);

  masterVolInput.value = String(config.masterVolume);
  audio.setMasterVolume(config.masterVolume);

  notesVolInput.value = String(config.notesVolume);
  audio.setNotesVolume(config.notesVolume);

  leavesVolInput.value = String(config.leavesVolume);
  audio.setLeavesVolume(config.leavesVolume);

  ambientVolInput.value = String(config.ambientVolume);
  audio.setAmbientVolume(config.ambientVolume);

  for (const name of ['rain', 'night', 'pad', 'wind']) {
    const layerCfg = config.layers[name];
    audio.setLayerEnabled(name, layerCfg.enabled);
    audio.setLayerVolume(name, layerCfg.volume);
    layerControls[name].input.value = String(layerCfg.volume);
  }

  if (config.loop !== undefined) {
    loopEnabled = config.loop;
  }
  if (config.muted === false) {
    audio.setMuted(false);
  }

  updateToggleButtons();
  previewTreeChanges();
}

async function handleToggleMute() {
  await audio.unlock();
  const nextSliderVal = audio.setMuted(!audio.muted);
  masterVolInput.value = String(nextSliderVal);
  updateToggleButtons();
  updateReadouts();
}

// Sleep Timer
function clearSleepTimer(restoreGain = false) {
  if (sleepTimerInterval !== null) {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
  }
  sleepRemainingSeconds = 0;
  sleepCountdown.hidden = true;
  if (sleepFadeTriggered && restoreGain) {
    audio.cancelSleepFade();
  }
  sleepFadeTriggered = false;
}

function setSleepTimerMinutes(minutes) {
  clearSleepTimer(true);
  const mins = Number(minutes) || 0;
  if (mins <= 0) return;

  sleepRemainingSeconds = mins * 60;
  sleepCountdown.hidden = false;
  sleepCountdown.textContent = formatCountdown(sleepRemainingSeconds);

  sleepTimerInterval = setInterval(() => {
    if (renderer.state === 'paused' && pausedByVisibility) return;
    sleepRemainingSeconds = Math.max(0, sleepRemainingSeconds - 1);
    sleepCountdown.textContent = formatCountdown(sleepRemainingSeconds);

    if (sleepRemainingSeconds <= 5 && !sleepFadeTriggered) {
      sleepFadeTriggered = true;
      audio.fadeOutForSleep(Math.max(1, sleepRemainingSeconds));
    }

    if (sleepRemainingSeconds <= 0) {
      clearSleepTimer(false);
      sleepTimerSelect.value = '0';
      handleStop();
      statusText.textContent = 'Sleep timer finished — good night.';
    }
  }, 1000);
}

// Welcome Screen entry
function enterGarden() {
  if (!welcomeOverlay.hidden) {
    welcomeOverlay.hidden = true;
    startPlayback();
    playPauseBtn.focus();
  }
}

enterGardenBtn.addEventListener('click', enterGarden);

// Focus Mode, Fullscreen & Panel Collapse
focusBtn.addEventListener('click', () => {
  focusMode = !focusMode;
  updateViewControls();
});

panelToggleBtn.addEventListener('click', () => {
  panelCollapsed = !panelCollapsed;
  updateViewControls();
  if (!panelCollapsed) {
    panelCloseBtn.focus();
  }
});

panelCloseBtn.addEventListener('click', () => {
  panelCollapsed = true;
  updateViewControls();
  panelToggleBtn.focus();
});

// Show auto-hidden controls on mouse movement, touch, or keyboard focus
for (const evtName of ['mousemove', 'pointerdown', 'touchstart', 'keydown', 'focusin']) {
  window.addEventListener(evtName, () => {
    showControlsAndResetIdle();
  }, { passive: true });
}

if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) {
  fullscreenBtn.disabled = true;
  fullscreenBtn.title = 'Fullscreen is unavailable in this browser view';
}

fullscreenBtn.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    audioStatus.textContent = 'Fullscreen could not be activated by the browser.';
  }
  updateViewControls();
});

document.addEventListener('fullscreenchange', updateViewControls);

// Sleep timer select
sleepTimerSelect.addEventListener('change', () => {
  setSleepTimerMinutes(sleepTimerSelect.value);
});

// Export WAV
function setExportFeedback(message, type = 'info') {
  exportStatus.hidden = !message;
  exportStatus.textContent = message;
  exportStatus.classList.toggle('is-warning', type === 'warning');
  exportStatus.classList.toggle('is-success', type === 'success');
}

async function handleDownloadWav() {
  if (isExporting) return;

  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    setExportFeedback('WAV export requires OfflineAudioContext, which is not supported here.', 'warning');
    return;
  }

  const exportMasterVolume = audio.muted ? audio.preMuteVolume : audio.masterVolume;
  const hasEnabledAmbient =
    audio.ambientVolume > 0 &&
    ['rain', 'night', 'pad', 'wind'].some(
      (k) => audio.layers[k].enabled && audio.layers[k].volume > 0
    );
  const hasAudibleNotes = audio.notesVolume > 0 || audio.leavesVolume > 0;

  if (exportMasterVolume <= 0 || (!hasAudibleNotes && !hasEnabledAmbient)) {
    setExportFeedback(
      'Volume is 0%. Raise Master or at least one active sound slider before downloading.',
      'warning'
    );
    return;
  }

  isExporting = true;
  downloadWavBtn.disabled = true;
  exportLengthSelect.disabled = true;
  exportProgressWrap.hidden = false;
  exportProgressFill.style.width = '4%';

  const muteNote = audio.muted
    ? ` (exported at ${Math.round(exportMasterVolume * 100)}% unmuted volume)`
    : '';

  setExportFeedback('Preparing your music… 0%', 'info');

  try {
    const result = await renderCompositionWav({
      events: currentEvents,
      bounds: currentBounds,
      maxDepth: params.depth,
      speed: params.speed,
      seed: params.seed,
      tempo: audio.pendingTempo,
      scale: audio.scale,
      reverbPreset: audio.reverbPreset,
      reverbAmount: audio.reverbAmount,
      masterVolume: exportMasterVolume,
      notesVolume: audio.notesVolume,
      leavesVolume: audio.leavesVolume,
      ambientVolume: audio.ambientVolume,
      layers: audio.layers,
      lengthMode: exportLengthSelect.value,
      onProgress: (pct) => {
        exportProgressFill.style.width = `${pct}%`;
        setExportFeedback(`Preparing your music… ${pct}%`, 'info');
      },
    });

    if (result.isSilent) {
      setExportFeedback(
        'Rendered audio is silent — check that volume sliders are above 0%.',
        'warning'
      );
      return;
    }

    triggerBlobDownload(result.blob, result.fileName);

    const missingNote =
      result.missing.length > 0
        ? ` Fallback synthesis used for missing: ${result.missing.join(', ')}.`
        : '';

    setExportFeedback(
      `Downloaded ${result.fileName} (${result.duration.toFixed(1)}s, 44.1 kHz 16-bit WAV)${muteNote}.${missingNote}`,
      'success'
    );
  } catch (err) {
    setExportFeedback(
      `Export failed: ${err && err.message ? err.message : 'Unable to render WAV.'}`,
      'warning'
    );
  } finally {
    isExporting = false;
    downloadWavBtn.disabled = false;
    exportLengthSelect.disabled = false;
    exportProgressWrap.hidden = true;
    exportProgressFill.style.width = '0%';
    showControlsAndResetIdle();
  }
}

// Playback & Export listeners
playPauseBtn.addEventListener('click', handlePlayPause);
stopBtn.addEventListener('click', handleStop);
restartBtn.addEventListener('click', handleRestart);
downloadWavBtn.addEventListener('click', handleDownloadWav);

loopBtn.addEventListener('click', () => {
  loopEnabled = !loopEnabled;
  if (!loopEnabled) {
    clearLoopTimer();
  } else if (renderer.state === 'complete' && !isReducedMotion) {
    handleRendererStateChange('complete', 1);
  }
  updateToggleButtons();
});

// Presets
for (const btn of presetButtons) {
  btn.addEventListener('click', () => {
    const id = btn.dataset.preset;
    if (PRESETS[id]) {
      applyConfiguration(PRESETS[id], id);
    }
  });
}

resetDefaultsBtn.addEventListener('click', () => {
  applyConfiguration({ ...DEFAULTS, loop: false, muted: false }, null);
});

// Tree sliders
depthInput.addEventListener('input', () => {
  activePresetId = null;
  params.depth = Number(depthInput.value);
  updateToggleButtons();
  previewTreeChanges();
});

angleInput.addEventListener('input', () => {
  activePresetId = null;
  params.branchAngle = Number(angleInput.value);
  updateToggleButtons();
  previewTreeChanges();
});

ratioInput.addEventListener('input', () => {
  activePresetId = null;
  params.lengthRatio = Number(ratioInput.value);
  updateToggleButtons();
  previewTreeChanges();
});

randomnessInput.addEventListener('input', () => {
  activePresetId = null;
  params.randomness = Number(randomnessInput.value);
  updateToggleButtons();
  previewTreeChanges();
});

speedInput.addEventListener('input', () => {
  activePresetId = null;
  params.speed = Number(speedInput.value);
  renderer.setSpeed(params.speed);
  updateToggleButtons();
  updateReadouts();
  updateTreeMeta();
  updatePlaybackUI(
    renderer.state,
    renderer.totalDuration > 0 ? renderer.elapsed / renderer.totalDuration : 0
  );
});

seedInput.addEventListener('input', () => {
  const raw = seedInput.value.trim();
  if (raw === '') return;
  const parsed = Math.trunc(Number(raw));
  if (Number.isFinite(parsed) && parsed >= 0) {
    activePresetId = null;
    params.seed = Math.min(999999, parsed);
    updateToggleButtons();
    previewTreeChanges();
  }
});

seedInput.addEventListener('change', () => {
  const raw = seedInput.value.trim();
  const parsed = Math.trunc(Number(raw));
  if (raw === '' || !Number.isFinite(parsed) || parsed < 0) {
    seedInput.value = String(params.seed);
  } else {
    activePresetId = null;
    params.seed = Math.min(999999, parsed);
    seedInput.value = String(params.seed);
    updateToggleButtons();
    previewTreeChanges();
  }
});

newSeedBtn.addEventListener('click', pickNewSeed);

// Music controls
scaleSelect.addEventListener('change', () => {
  activePresetId = null;
  audio.setScale(scaleSelect.value);
  updateToggleButtons();
  updateLiveRecursionReadout(renderer.elapsed, renderer.state);
});

tempoInput.addEventListener('input', () => {
  activePresetId = null;
  audio.setTempo(Number(tempoInput.value));
  updateToggleButtons();
  updateReadouts();
});

reverbInput.addEventListener('input', async () => {
  activePresetId = null;
  await audio.unlock();
  audio.setReverbAmount(Number(reverbInput.value));
  updateToggleButtons();
  updateReadouts();
});

for (const btn of reverbPresetButtons) {
  btn.addEventListener('click', async () => {
    activePresetId = null;
    await audio.unlock();
    audio.setReverbPreset(btn.dataset.reverbPreset);
    updateToggleButtons();
  });
}

// Volume & independent ambient layer controls
muteBtn.addEventListener('click', handleToggleMute);

masterVolInput.addEventListener('input', async () => {
  activePresetId = null;
  await audio.unlock();
  audio.setMasterVolume(Number(masterVolInput.value));
  updateToggleButtons();
  updateReadouts();
});

notesVolInput.addEventListener('input', async () => {
  activePresetId = null;
  await audio.unlock();
  audio.setNotesVolume(Number(notesVolInput.value));
  updateToggleButtons();
  updateReadouts();
});

leavesVolInput.addEventListener('input', async () => {
  activePresetId = null;
  await audio.unlock();
  audio.setLeavesVolume(Number(leavesVolInput.value));
  updateToggleButtons();
  updateReadouts();
});

ambientVolInput.addEventListener('input', async () => {
  activePresetId = null;
  await audio.unlock();
  audio.setAmbientVolume(Number(ambientVolInput.value));
  updateToggleButtons();
  updateReadouts();
});

for (const name of ['rain', 'night', 'pad', 'wind']) {
  const { toggle, input } = layerControls[name];

  toggle.addEventListener('click', async () => {
    activePresetId = null;
    await audio.unlock();
    audio.setLayerEnabled(name, !audio.layers[name].enabled);
    updateToggleButtons();
  });

  input.addEventListener('input', async () => {
    activePresetId = null;
    await audio.unlock();
    audio.setLayerVolume(name, Number(input.value));
    updateToggleButtons();
    updateReadouts();
  });
}

// Browser tab visibility handling: pause cleanly while hidden, resume on return
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (renderer.state === 'growing') {
      pausedByVisibility = true;
      renderer.togglePause();
      audio.pause();
      updatePlaybackUI(
        renderer.state,
        renderer.totalDuration > 0 ? renderer.elapsed / renderer.totalDuration : 0
      );
    }
  } else if (pausedByVisibility) {
    pausedByVisibility = false;
    if (renderer.state === 'paused') {
      renderer.togglePause();
      audio.resume();
    }
  }
});

// Keyboard shortcuts (do not override normal keys while any control is focused)
window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (!welcomeOverlay.hidden) {
    if (event.key === 'Escape') {
      enterGarden();
    }
    return;
  }

  if (event.key === 'Escape' && focusMode) {
    focusMode = false;
    updateViewControls();
    return;
  }

  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toUpperCase() : '';
  const isControlFocused =
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    tag === 'BUTTON' ||
    tag === 'SUMMARY' ||
    Boolean(target && target.isContentEditable);

  if (isControlFocused) return;

  if (event.code === 'Space') {
    event.preventDefault();
    handlePlayPause();
    return;
  }

  const key = event.key.toLowerCase();
  if (key === 'm') {
    handleToggleMute();
  } else if (key === 'r') {
    handleRestart();
  } else if (key === 'f') {
    focusMode = !focusMode;
    updateViewControls();
  }
});

// Dynamic reduced-motion handling
const handleMotionChange = (event) => {
  isReducedMotion = event.matches;
  if (isReducedMotion) {
    clearLoopTimer();
  }
  renderer.setReducedMotion(isReducedMotion);
};

if (typeof motionQuery.addEventListener === 'function') {
  motionQuery.addEventListener('change', handleMotionChange);
} else if (typeof motionQuery.addListener === 'function') {
  motionQuery.addListener(handleMotionChange);
}

// Initial boot: show calm preview behind welcome screen
renderer.setSpeed(params.speed);
renderer.setReducedMotion(isReducedMotion);
updateViewControls();
applyConfiguration({ ...DEFAULTS, loop: false, muted: false }, null);
enterGardenBtn.focus();
