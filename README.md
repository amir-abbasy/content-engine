# Content Engine

Build modular short-form trading content — 30-50s vertical (9:16) reels for
Instagram / TikTok / Shorts — by automating a real web app, recording it, and
slicing the session into eased, humanized scene clips driven by a single JSON
timeline.

The whole reel is **data**. Every cursor move, dropdown click, color pick,
camera pan, spotlight, and click ripple is an event on a typed track in
`pipeline.json`. Re-running with the same `seed` produces the same performance.

---

## Phase 1 — Pipeline-driven app recorder

1. Opens the target app (`http://localhost:3000/` by default).
2. Waits for **Pyodide** to finish loading.
3. Walks an ordered list of **scenes** in one continuous browser recording.
4. Inside each scene: a scheduler dispatches events from per-track lists
   (`input`, `camera`, `reveal`, `attention`) by their absolute `at` time.
5. Slices the raw `.webm` and crops each scene to a vertical 9:16 clip with an
   eased camera pan baked into the ffmpeg crop expression.

The app itself is **not** made responsive — each scene crops a sub-region of
the desktop canvas, so different scenes can use different panes or screen
areas.

### Requirements

- Node.js >= 20
- `ffmpeg` and `ffprobe` on `PATH` (override with `FFMPEG_PATH` / `FFPROBE_PATH`)
- The target app running (e.g. the "vite - Flow" app on `localhost:3000`)

### Install

```bash
npm install
npx playwright install chromium
```

### Run

```bash
npm run record                 # uses ./pipeline.json
npm run record:headed          # force a visible window
npm run record:headless        # force headless

node src/record.js my.json --headless --out builds --url http://localhost:5173/
```

CLI flags override the pipeline file: `--headed`, `--headless`, `--out <dir>`,
`--url <url>`.

### Output

Each run writes a timestamped folder under `output/`:

```
output/<pipeline-name>-<YYYY-MM-DD>_<HH-MM-SS>/
  raw/<session>.webm        full desktop recording (kept if output.keepRaw)
  scenes/<scene-id>.mp4     one vertical clip per scene
  manifest.json             scenes with timings, regions, camera keyframes
```

---

## The pipeline file

`pipeline.json` is the timeline. `pipeline.schema.json` is the authoritative
contract — point your editor's JSON schema at it for inline docs and
validation.

Top-level shape:

```jsonc
{
  "name": "algo-trading-reel-01",
  "app": {
    "url": "http://localhost:3000/",
    "viewport": { "width": 1920, "height": 1080 },
    "waitForPyodide": true,
    "pyodideLoaderSelector": ".app-pyodide-loader",
    "readySelector": "#main-chart",
    "readyTimeoutMs": 120000
  },
  "record": {
    "browser": "chromium",
    "headless": false,
    "timelineOffsetMs": 0,
    "settleMs": 600,
    "humanize": {
      "seed": 7,                    // PRNG seed — same seed = same performance
      "jitter": 0.15,               // ±15% randomness on numeric durations
      "scale": 1.0,                 // global multiplier
      "preActionPause": [120, 280]  // ms; tiny hesitation before each click/fill
    },
    "cursor": {
      "movement": "human",           // "human" (bezier) | "linear"
      "duration":   [380, 720],      // ms travel time per move
      "overshoot":  0.12,            // fractional overshoot past target
      "hesitation": [70, 180],       // ms hover before clicking
      "curvature":  0.4              // bezier control-point bend
    }
  },
  "output": {
    "dir": "output",
    "resolution": { "width": 1080, "height": 1920 },
    "fps": 30,
    "fitMode": "cover",             // cover = scale-fill + center-crop
    "keepRaw": true
  },
  "scenes": [ /* see below */ ]
}
```

### Scenes as timeline tracks

Each scene is a region of the desktop canvas plus four event tracks dispatched
on an absolute, scene-relative time axis (seconds):

```jsonc
{
  "id": "01-build-strategy",
  "description": "Build Candles -> 2 EMAs -> 2 Plots",
  "target": { "selector": ".react-flow", "aspect": "9:16", "anchor": "center" },
  "durationSec": 44.5,
  "holdAfterSec": 1.0,
  "setup": [
    { "at": 0.0, "type": "press",      "key": "Digit2", "shift": true },
    { "at": 0.5, "type": "injectFlow", "file": "flows/ema-plot.json" },
    { "at": 1.8, "type": "injectFlow", "file": "flows/ema-plot.json", "nodeCount": 0 }
  ],
  "tracks": {
    "input":     [ /* events the user does — clicks, fills, etc */ ],
    "camera":    [ /* explicit pan keyframes with per-segment ease */ ],
    "reveal":    [],   // RESERVED: progressive node/port/edge reveals
    "attention": [ /* spotlight / mark / pulse / dim / release */ ]
  }
}
```

`setup` runs before the scene clock starts (its `at` is relative to setup
start). Once setup finishes and the bbox is measured, the scene clock starts
and tracks fire by their absolute `at`.

### Targets — what fills the vertical frame

Provide **exactly one** of:

| Key            | Captures                                                            |
|----------------|---------------------------------------------------------------------|
| `selector`     | An element's bounding box                                            |
| `pane`         | Named pane: `chart` \| `flow` \| `result`                            |
| `paneIndex`    | The Nth `[data-panel]` element                                       |
| `region`       | A fixed `{ x, y, width, height }` rectangle                          |
| `fullViewport` | The whole viewport                                                   |

Then optionally refine the resolved box:

- `aspect` + `anchor` — carve the largest `"W:H"` sub-rectangle (e.g. `"9:16"`)
  and place it (`left` / `right` / `center` / `top` / `bottom` / corners)
- `padding` — number or `{top,right,bottom,left}` to shrink / expand

---

## Tracks

### Input track — what the user does

Every input event has `at` (seconds, scene-relative) and a `type`. Cursor-
bearing types (`click`, `rightClick`, `dblclick`, `hover`, `fill`) route
through the **humanized cursor driver**: bezier travel with overshoot + hover
hesitation, then click.

| `type`            | Notes                                                                 |
|-------------------|-----------------------------------------------------------------------|
| `press`           | Keyboard combo: `{ "key": "Digit1", "shift": true }`                  |
| `type`            | Types into focused element with per-key jitter                        |
| `fill`            | Cursor moves to selector → click → clear → types char-by-char         |
| `click`           | Left click with humanized travel                                      |
| `rightClick`      | Right click (yellow ripple)                                            |
| `dblclick`        | Double click                                                          |
| `hover`           | Cursor travel only, no click                                          |
| `wait`            | Pause `ms` (rarely needed — use `at` instead)                          |
| `waitForSelector` | Wait for selector to reach `state`                                    |
| `scroll`          | Wheel deltas, optionally over selector                                |
| `drag`            | Press selector → glide to `to` / `toSelector` → release               |
| `eval`            | Run a JS expression in the page                                       |
| `injectFlow`      | Build a node graph via `window.__injectFlow` — `file` (+ `nodeCount`) |

Selectors that match multiple elements resolve to the **first** match (override
with `nth`).

`cameraFollow: true` on an input event auto-emits a camera keyframe at the
event's target the moment it fires.

### Camera track — pan + zoom keyframes with ease

Each keyframe has `at`, `point: {x, y}` *or* `selector` (+ optional
`position`), optional `zoom` (1.0 = full bbox, >1.0 = cinematic push-in), and
`ease` (the curve used to arrive at this keyframe from the previous one).
Eases: `linear`, `quad-in`/`out`/`in-out`, `cubic-in`/`out`/`in-out`.

```jsonc
"camera": [
  { "at":  0.0, "point": {"x": 503, "y": 290}, "zoom": 1.0,  "ease": "cubic-out" },
  { "at":  4.8, "point": {"x": 503, "y": 290}, "zoom": 1.6,  "ease": "cubic-in-out" }, // push-in
  { "at":  5.7, "selector": ".react-flow__node[data-id=\"1\"]", "zoom": 1.85, "ease": "cubic-in-out" },
  { "at":  7.3, "point": {"x": 896, "y": 200}, "zoom": 1.2,  "ease": "cubic-in-out" }  // pull-back
]
```

Selector keyframes resolve at firing time (so dynamic positions work). Two
consecutive keyframes with the same value = hold. Both pan and `zoom` are eased
and baked into the ffmpeg crop: the crop window shrinks (`bbox / zoom`) and the
`zoompan` filter scales it back to the output resolution = a real zoom-in.

### Automatic zoom (Screen Studio-style)

Authoring camera keyframes by hand is tedious. Set `record.autoZoom.enabled`
and the engine **derives the whole camera track from your input actions** — no
`camera` track needed. Every cursor action (`click`/`rightClick`/`fill`/…) and
every node reveal (`injectFlow`) becomes a *focus moment*: the camera arrives
on that element just before it happens, zooms in, holds, then eases to the next
moment — dipping to a wide shot when two moments are far apart (idle / scene
change).

```jsonc
"record": {
  "autoZoom": {
    "enabled": true,
    "zoom": 1.85,          // zoom on each cursor action
    "revealZoom": 1.5,     // zoom when framing a freshly-injected node
    "wideZoom": 1.2,       // resting / establishing / idle-dip zoom
    "leadMs": 450,         // arrive on target this long BEFORE the action
    "holdMs": 450,         // linger this long AFTER it
    "clusterGapMs": 1700,  // gap larger than this ⇒ dip to wideZoom between
    "ease": "cubic-in-out"
  }
}
```

- A scene uses auto-camera when `autoZoom.enabled` and it has no manual `camera`
  track. Force it per-scene with `"autoCamera": true`, or opt out with `false`.
- Add `"focusZoom": 2.2` to any input event to override the base zoom for that
  one action (push tighter on a small input, wider on a menu). Element-anchored,
  so it locks onto the live element with no cursor jitter.
- The manual `camera` track and auto-camera are mutually exclusive per scene —
  use the manual track for deliberate non-action moves (e.g. a slow chart pan).

### Attention track — direct the viewer's eye

Four primitives. Implemented as injected CSS + `window.__attention` helpers
applied via dynamic CSS rules that survive React re-renders (matched by
`data-id`, not by injected classes).

```jsonc
"attention": [
  { "at": 13.0, "type": "mark",      "selector": ".react-flow__node[data-id=\"2\"] input[placeholder=\"int\"]" },
  { "at": 13.3, "type": "spotlight", "selector": ".react-flow__node[data-id=\"2\"]" },
  { "at": 15.3, "type": "release" }
]
```

| `type`      | Effect                                                                        |
|-------------|-------------------------------------------------------------------------------|
| `spotlight` | Target gets a glow halo; all sibling nodes/edges dim. Persists until `release` |
| `mark`      | Animated yellow rectangle outline blinks around target for ~1.4s (one-shot)    |
| `pulse`     | Single 620ms yellow glow flash on target (one-shot)                            |
| `dim`       | Full-viewport semi-opaque overlay; optional `amount: 0..0.85`                  |
| `release`   | Clears spotlight + dim                                                         |

`spotlight` and `dim` accept an optional `durationSec` for auto-release.

### Reveal track — RESERVED

Track type accepted by the schema. Runtime not yet implemented — events parse
and warn. Intended for staggered node/port/edge/parameter reveals.

---

## Cinematography model

The "feels human, not scripted" comes from layering:

1. **Humanized timing** (`record.humanize`) — seeded PRNG wraps every `ms`
   value with `±jitter` and inserts `preActionPause` before cursor events.
2. **Humanized cursor** (`record.cursor`) — quadratic bezier path with
   perpendicular bend, eased velocity, slight overshoot + correction at the
   destination, hover hesitation before the click.
3. **Eased camera** — per-keyframe `ease` baked into ffmpeg crop expressions
   so pans accelerate / settle instead of running constant-velocity.
4. **Visible click effects** — a page-injected cursor image (configurable URL
   in [src/lib/cursor.js](src/lib/cursor.js)) follows real mouse events;
   `mousedown` spawns a large concentric-ring ripple (yellow for right-click,
   white for left).
5. **Attention choreography** — `mark` primes the viewer's eye 0.5s before an
   edit; `spotlight` keeps focus on the active node while the rest dims.
6. **Char-by-char typing** — `fill` clicks the input then types each character
   with per-key jittered delay instead of Playwright's instant `.fill()`.

Reproducibility: change `record.humanize.seed` to roll a different
performance; keep it fixed and re-runs are identical.

---

## How timing works

Playwright records video per browser context — the whole session is one
`.webm`. The scheduler in [src/lib/timeline.js](src/lib/timeline.js) sorts all
track events by `at` and dispatches in order: it waits until each event's
scheduled wall-clock, then fires the handler.

Drift handling is **strict** — if a cursor-bearing event takes longer than the
gap to the next event, the next event fires immediately (no shift). Author
realistic spacing (~1.0–1.5s between cursor-bearing events; cycles of ~7–9s
per multi-event sequence).

If clips look a few frames early / late after crop, tune
`record.timelineOffsetMs`.

---

## Project layout

```
pipeline.json              the timeline (your reel)
pipeline.schema.json       JSON schema — full field docs + validation
flows/                     flow JSON fixtures injected by `injectFlow` events
src/record.js              orchestrator: record session -> slice -> crop
src/config.js              defaults + CLI parsing
src/lib/pipeline.js        load + validate the timeline
src/lib/browser.js         launch context, inject overlays, wait for Pyodide
src/lib/timeline.js        scheduler: sort by `at` -> dispatch
src/lib/actions.js         per-event handlers (cursor-driver-aware)
src/lib/cursor.js          page-injected cursor image + ripple overlay (CSS)
src/lib/cursor-driver.js   humanized mouse (bezier, overshoot, hesitation)
src/lib/attention.js       page-injected spotlight / mark / pulse / dim CSS
src/lib/target.js          resolve a scene target -> pixel region
src/lib/humanize.js        seeded PRNG, sample(), ease curves, bezier sampler
src/lib/crop.js            ffmpeg slice + eased pan crop expression
scripts/                   throwaway debug probes (DOM inspection)
```
