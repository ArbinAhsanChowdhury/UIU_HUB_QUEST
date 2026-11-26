# Fractal Garden

An interactive, framework-free web app that turns a recursive binary fractal tree into relaxing generative music and nocturnal ambient soundscapes using HTML5 Canvas and the Web Audio API.

## How to Run

Because Fractal Garden uses ES modules (`<script type="module">`) and fetches audio files from `assets/audio/`, serve it over a local HTTP server rather than opening `index.html` via `file://`.

### Option 1: Python (recommended)

```bash
python -m http.server 4173 --bind 127.0.0.1
```

Then open **`http://127.0.0.1:4173/`** in your browser.

### Option 2: Node.js

```bash
npx serve -l 4173
```

Then open **`http://localhost:4173/`**.

> Note: Modern browsers require a user click before audio starts. Click **Enter the Garden** (or **Play**) to start sound.

---

## How the Recursion Works

The tree geometry and growth timeline are generated purely in [`js/tree.js`](js/tree.js) without any DOM or Canvas calls. Starting from a root trunk at `(0, 0)` with `depth = 1`, each branch computes its endpoint, records a timed branch event, and recursively spawns a **left** and **right** child branch only after its own duration finishes (`child.startTime = parent.startTime + parent.duration`).

When `depth === maxDepth` (the **base case**), recursion terminates and marks that branch as a glowing leaf (`isLeaf = true`). An optional seeded PRNG (Mulberry32) ensures the same parameters and seed always produce the exact same tree and musical event sequence.

### Pseudocode

```text
function buildBranch(parentId, depth, x, y, length, angle, side, startTime):
    endX = x + cos(angle) * length
    endY = y + sin(angle) * length
    isLeaf = (depth >= maxDepth)
    duration = baseDuration * (length / trunkLength)^0.45

    events.push({ id, parentId, depth, x, y, endX, endY, length, angle, side, isLeaf, startTime, duration })

    // Base case: stop at maxDepth (becomes a glowing leaf)
    if isLeaf:
        return

    childStart = startTime + duration
    for childSide in ["left", "right"]:
        childAngle = angle ± branchAngle + seededVariation()
        childLength = length * lengthRatio * seededVariation()
        buildBranch(id, depth + 1, endX, endY, childLength, childAngle, childSide, childStart)
```

---

## Music & Audio Mapping

Each branch event in the sorted list drives both the Canvas growth animation and the Web Audio synthesis/sample playback:

| Element | Audio Source | Pitch / Frequency | Panning (`StereoPannerNode`) | Dynamics & Effects |
| :--- | :--- | :--- | :--- | :--- |
| **Trunk (`depth = 1`)** | `trunk.mp3` | Unshifted root (`1.0x`) | Center (`0.0`) | Warm foundational gain (`0.45`), moderate reverb |
| **Normal Branches (`2 .. maxDepth-1`)** | `branch.mp3` | Pitch-shifted via `playbackRate` onto **C major** (`0, 2, 4, 7, 9`) or **A minor** (`-3, 0, 2, 4, 7`) pentatonic over 2 octaves; deeper = higher, favoring active pad chord tones | Left/right pan from normalized `endX` (`[-0.85, +0.85]`) | Quieter at deeper levels (`0.84^(depth-2)`), brightness filter opens with growth |
| **Leaves (base case)** | `leaf.mp3` | Unshifted soft chime + resolving tonic chord bloom at finish | Normalized `endX` (`[-0.85, +0.85]`) | Very soft gain, subtle filtered delay (`0.32s`), lush reverb (`0.95` send) |
| **Rain & Night** | `ambient-rain.mp3`, `ambient-night.mp3` | Seamless `2.5s` equal-power crossfaded loops | Stereo | Independent On/Off & volume; minimal reverb on Rain (`0.10`), moderate on Night (`0.42`) |
| **Pad** | Procedural oscillators (sine + triangle) | Slow 4-chord progression every 2 bars in selected scale | Stereo center | Slow filter & amplitude LFO movement, lush reverb (`0.95` send) |
| **Wind** | Procedural seeded pink noise | Band-pass sweep (`~200–550 Hz`) | Stereo center | Slowly shifting gust speed and strength via LFOs |

### Musical Comfort & Mastering Rules
- **Beat Grid & Polyphony**: Notes quantize to a `50–90 BPM` 16th-note grid (default `70 BPM`), enforce a minimum inter-note gap, and cap simultaneous voices at **8** so high depths (`Depth 10` = 1,023 branches) remain calm.
- **Click-Free Envelopes & Space**: Soft attack/release ramps on every note, dual crossfaded `ConvolverNode` reverb presets (**Small Garden**, **Forest**, **Open Sky**), `42 Hz` HPF / `11.5 kHz` LPF mix cleanup, master `DynamicsCompressorNode`, and `-1.5 dB` safety limiter.
- **Missing File Fallback**: If any MP3 in `assets/audio/` is missing or fails to decode, a clear notice is displayed and soft procedural synthesis is used instead.

---

## Features

- **Calm Night Garden Canvas**: Responsive high-DPI tree fitting at any viewport/depth, smooth `requestAnimationFrame` growth, playing-branch glow highlights, audio-reactive fireflies & leaves, and live recursion/note readout.
- **Interactive Controls**: Collapsible **Tree**, **Music**, **Volume**, and **How it works** panels (side panel on desktop, bottom sheet on mobile), **Focus mode**, **Fullscreen**, **Loop**, and **Sleep timer** (`5`, `10`, `20` min with gentle fade-out).
- **Presets**: **Calm Rain**, **Moonlit Night**, **Deep Forest**, and **Reset to defaults**.
- **Offline WAV Export**: Renders **Full tree once**, **1 minute**, or **3 minutes** via `OfflineAudioContext` using the exact same routing graph, deterministic schedule, and seeded randomness, outputting a `-1 dB` normalized **16-bit 44.1 kHz stereo `.wav`** with `2s` fade-in, `4s` fade-out, and unclipped reverb tail.
- **Accessibility & Reliability**: Welcome dialog, keyboard shortcuts (`Space` play/pause, `M` mute, `R` restart, `F` focus mode, `Esc` exit focus), `>= 44px` touch targets, `aria-live` updates, `prefers-reduced-motion` support, and automatic pause/resume on hidden tabs.

---

## Folder Structure

```text
Fractal Garden Hackathon/
├── index.html                  # App markup, welcome screen, controls, and export UI
├── style.css                   # Night garden theme, desktop sidebar & mobile bottom sheet
├── README.md                   # Project documentation
├── CREDITS.md                  # Audio credits and attribution
├── AI_PROMPT_LOGS.md           # Complete Markdown AI prompt & response chain
├── ai-logs/
│   └── transcript_full.jsonl   # Complete raw JSONL agent session log
├── claude-logs/
│   └── README.md               # Shared Claude conversation link
├── assets/
│   └── audio/
│       ├── trunk.mp3           # Trunk sound sample
│       ├── branch.mp3          # Branch sound sample (pitch-shifted)
│       ├── leaf.mp3            # Leaf chime sample
│       ├── ambient-rain.mp3    # Looping rain atmosphere
│       └── ambient-night.mp3   # Looping night atmosphere
└── js/
    ├── tree.js                 # Pure recursive fractal tree generator & bounds math
    ├── renderer.js             # HTML5 Canvas rendering, highlights & firefly animation
    ├── audio-graph.js          # Shared BaseAudioContext routing, DSP buffers & schedule
    ├── audio.js                # Live Web Audio playback engine, layers & harmony
    ├── audio-export.js         # OfflineAudioContext renderer & 16-bit WAV encoder
    └── main.js                 # UI wiring, presets, focus mode, sleep timer & shortcuts
```

---

## AI Prompt Logs

The full prompt chain and AI coding agent transcript used to build **Fractal Garden** are included in this repository:

- [AI_PROMPT_LOGS.md](AI_PROMPT_LOGS.md) — Clean chronological Markdown log of every user prompt and assistant response.
- [ai-logs/transcript_full.jsonl](ai-logs/transcript_full.jsonl) — Complete unedited JSONL session transcript exported from Google Antigravity (`dfb5f90a-1f5e-43b9-a532-96b0fc69408b`).
- [claude-logs/README.md](claude-logs/README.md) — Shared Claude conversation log link: https://claude.ai/share/96dbd822-0aba-41d3-a427-ca7dfd439326
