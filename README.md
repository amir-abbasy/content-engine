# Content Engine

Build modular short-form trading content — punchy vertical (9:16) reels for
Instagram / TikTok / Shorts — by automating a real web app, recording it, and
slicing the session into eased, humanized scene clips driven by a single JSON
timeline. A configurable **speed-up** compresses the finished video to a social
pace (e.g. ≤ 20s) without breaking the recording.

The whole reel is **data**. Every cursor move, dropdown click, color pick,
camera zoom, spotlight, and click ripple is an event on a typed track in
`pipeline.json`. Re-running with the same `seed` produces the same performance.

The camera is **automatic**: you describe the actions, and the engine derives a
Screen Studio-style camera that glides to each hotspot, zooms in to frame what
you're doing, holds locked while you type/choose, then snaps back out centered
on the node you just built. See [Automatic camera](#automatic-camera).

And you usually don't write the timeline by hand at all: **drop a strategy's
flow JSON and one command generates the whole reel** — it builds the flow on
camera node-by-node (search → add → enter settings → wire its connections) and
records it. See [From a flow to a video](#from-a-flow-to-a-video-generated-no-hand-authoring).

---

## Phase 1 — Pipeline-driven app recorder

1. Opens the target app (`http://localhost:3000/` by default).
2. Waits for **Pyodide** to finish loading.
3. Walks an ordered list of **scenes** in one continuous browser recording.
4. Inside each scene: a scheduler dispatches events from per-track lists
   (`input`, `camera`, `reveal`, `attention`) by their absolute `at` time.
5. Slices the raw `.webm` and crops each scene to a vertical 9:16 clip with the
   eased camera pan **and zoom** baked into the ffmpeg crop/zoompan expression.
6. Optionally time-compresses each clip (`setpts`) so the whole reel fits a
   target length — see [Speed-up](#speed-up).

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
node src/record.js --max-total-sec 15   # cap the final video at 15s
node src/record.js --speed 2.0          # explicit 2× speed-up
node --env-file=.env src/record.js      # load env vars from .env (Node 22+)
```

CLI flags override the pipeline file: `--headed`, `--headless`, `--out <dir>`,
`--url <url>`, `--speed <n>`, `--max-total-sec <n>`, `s=<n>` (record one scene),
`flow=<name>` / `--flow <name>` (record a named flow into a fixed dir).

### From a flow to a video (generated, no hand-authoring)

You don't hand-write a pipeline for a strategy. Drop the flow's JSON export and
run **one command** — every recorder step (each node add, its on-camera
settings, and every wiring drag) is DERIVED from the flow. No AI.

```bash
npm run flow rsi            # generate fixture + pipeline, then record → output/rsi/
npm run flow rsi --headed   # extra args pass through to the recorder (--speed, s=1, …)
npm run gen rsi             # just (re)generate, don't record
```

**One name, fixed paths** (no timestamps — overwritten in place):

```
flows/<name>/flow.json      your export (input)   — you provide
  (also accepted: flows/<name>.json, flows/flow-<name>.json)
flows/<name>/build.json     build fixture         — generated
flows/<name>/pipeline.json  recorder timeline     — generated
output/<name>/              the video             — recorded
```

**Zero-config:** an unknown name with a matching flow file just works. It builds
the WHOLE flow in **one scene**: for each node (left-to-right) it right-clicks →
searches → picks the node, types its settings / picks its colours on camera,
then immediately **drags every connection that just became possible** — i.e. the
new node's inputs from nodes already on the canvas. Finally it clicks Execute.
Nodes are added via the real context-menu (which *appends*, so wiring already
drawn is never wiped), and the build reads like a human assembling the strategy.

**Customise** only when needed, by adding a `STRATEGIES` entry in
`scripts/lib/build-flow.js`:

| field | purpose |
|---|---|
| `reposition` | `{ <id\|nodeKey>: {x,y} }` — override node layout for the video |
| `searchOverrides` | `{ <nodeKey>: { search, menu } }` — when a node's search term/label differs from its display name |
| `configOnCamera` | enter numeric/colour settings on camera (default `true`) |
| `extraDragEdges` | edges the export can't supply (e.g. a synthesised node) |
| `mode: 'split'` | legacy: a base set is built in an earlier scene; regenerate only a later "complete" scene of an existing multi-scene `pipeline.json` (the `ema` entry) |

It tolerates messy exports: duplicate edges are de-duped, edges to dropped nodes
are skipped, and a drag falls back to the Nth handle of a node when the export's
handle id doesn't match what the app renders (optional/dynamic inputs shift it).

Generated builds are full-length (every node, setting, and connection on camera);
for a social-length cut add a speed-up, e.g. `npm run flow rsi --speed 6`.

Env vars (override `pipeline.json`, overridden by CLI): `OUTPUT_SPEED`,
`OUTPUT_MAX_TOTAL_SEC`, `FFMPEG_PATH`, `FFPROBE_PATH`. Precedence for any value:
**CLI flag > env var > pipeline.json > built-in default**.

### Output

Each run writes a timestamped folder under `output/`:

```
output/<pipeline-name>-<YYYY-MM-DD>_<HH-MM-SS>/
  raw/<session>.webm        full desktop recording (kept if output.keepRaw)
  scenes/<scene-id>.mp4     one vertical clip per scene
  manifest.json             scenes with timings, regions, camera keyframes
```

---

## Studio (preview + timeline)

A local review tool that plays a flow's scenes one after another while showing
its full authored timeline. Same flow model as above — pick a **flow** and the
Studio reads *its* `flows/<name>/pipeline.json` and plays *its* `output/<name>/`
clips (legacy timestamped runs use the root `pipeline.json`). A flow that hasn't
been recorded yet still opens — you inspect the planned timeline, the player
shows "not recorded yet".

```bash
npm run studio          # API + UI → http://localhost:5180
```

- **Right** — a 9:16 player that plays every scene clip back-to-back as one
  continuous video (scrub, prev/next scene, Space = play/pause, ←/→ = scene).
- **Left** — a multi-track timeline of everything the pipeline authored: Video,
  Camera, Actions, Setup, Effects, plus the audio/text lanes (Voiceover, SFX,
  BGM, Titles, Subtitles, VO Script). Click a block to seek there and inspect
  its full detail. Audio/text lanes are present but empty until those
  generators land.

Record / export / timeline-editing are staged for later phases. Backed by
`src/studio/` (Node API) + `studio/` (Vite + React); run `vite build` (or
`npm run studio`) to (re)generate `studio/dist/` for production serving.

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
    "settleMs": 300,
    "humanize": {
      "seed": 7,                    // PRNG seed — same seed = same performance
      "jitter": 0.15,               // ±15% randomness on numeric durations
      "scale": 1.0,                 // global multiplier
      "preActionPause": [40, 90]    // ms; tiny hesitation before each click/fill
    },
    "autoZoom": { /* see "Automatic camera" below */ },
    "cursor": {
      "movement": "human",           // "human" (bezier) | "linear"
      "duration":   [140, 260],      // ms travel time per move
      "overshoot":  0.12,            // fractional overshoot past target
      "hesitation": [25, 60],        // ms hover before clicking
      "curvature":  0.4              // bezier control-point bend
    }
  },
  "output": {
    "dir": "output",
    "resolution": { "width": 1080, "height": 1920 },
    "fps": 30,
    "fitMode": "cover",             // cover = scale-fill + center-crop
    "keepRaw": true,
    "speed": 1.0,                   // explicit playback speed-up (>=1)
    "maxTotalSec": 19               // auto-derive a speed-up so the reel fits this
  },
  "scenes": [ /* see below */ ]
}
```

> The timing values above are tuned for a **fast social pace** — short cursor
> travel, brief pauses, and a speed-up. Raise them (and drop `speed` /
> `maxTotalSec`) for a calmer, more deliberate feel.

### Scenes as timeline tracks

Each scene is a region of the desktop canvas plus four event tracks dispatched
on an absolute, scene-relative time axis (seconds):

```jsonc
{
  "id": "01-build-strategy",
  "description": "Build Candles -> 2 EMAs -> 2 Plots",
  "target": { "selector": ".react-flow", "aspect": "9:16", "anchor": "center" },
  "durationSec": 28.0,
  "holdAfterSec": 0.5,
  "autoCamera": true,             // derive the camera from the input track
  "setup": [
    { "at": 0.0, "type": "press",      "key": "Digit2", "shift": true },
    { "at": 0.5, "type": "injectFlow", "file": "flows/ema-plot.json" },
    { "at": 1.8, "type": "injectFlow", "file": "flows/ema-plot.json", "nodeCount": 0 }
  ],
  "tracks": {
    "input":     [ /* events the user does — clicks, fills, etc (tag hotspots with focusZoom) */ ],
    "camera":    [ /* OPTIONAL: explicit keyframes; omit to use the automatic camera */ ],
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
with `nth`). A selector that never appears fails fast (~6s, not Playwright's
30s default) so a typo can't balloon the recording; override per event with
`timeoutMs`.

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

### Automatic camera

Authoring camera keyframes by hand is tedious. Set `record.autoZoom.enabled`
and the engine **derives the whole camera track from your input actions** — no
`camera` track needed. The camera rests at a wide 9:16 view and only moves for
**hotspots**: input events you tag with `focusZoom`. Each hotspot plays one
clean beat:

1. **Glide** — hold on the previous node, then snap to the hotspot over `panMs`
   (a fast move, not a slow drift across the gap).
2. **Zoom in** — wait `delayMs` after the triggering action, then zoom in over
   `zoomMs` to frame the search menu / input / dialog.
3. **Hold** — stay **pixel-locked** on that element while you type and choose
   (one resolved position is reused, so there's zero drift).
4. **Pull out** — zoom out over `zoomOutMs`, ending **centered on the node that
   was just added/edited** (so it's always visible), then glide to the next.

```jsonc
"record": {
  "autoZoom": {
    "enabled": true,
    "lockX": false,        // false = camera pans horizontally to each hotspot;
                           // true  = pinned to centre (zoom only, no L/R pan)
    "restZoom": 1.0,       // resting / wide zoom between hotspots
    "focusZoom": 2.0,      // default punch-in zoom for a hotspot
    "delayMs": 350,        // wait this long after the action before zooming in
    "zoomMs": 500,         // zoom-IN duration
    "zoomOutMs": 300,      // zoom-OUT (pull-back) duration — snappier
    "holdMs": 400,         // min hold for inputs with no explicit commit
    "panMs": 250,          // fast inter-hotspot glide
    "ease": "cubic-in-out"
  }
}
```

**Timing is anchored to REAL events, not the plan.** Each segment's start/end is
pinned to when the triggering input *actually* fires (+ an exact offset), so the
designed durations stay precise no matter how cursor travel or typing drifts —
and the pull-out can never fire before the thing it's waiting on:

- **Search** (`fill` on the node-search box): zoom-in starts after the opening
  right-click; the camera holds until the picked node **lands in the flow** (the
  following `injectFlow`), then pulls out.
- **Color / dialog** (a click that opens a `[role="dialog"]`): holds until the
  **swatch is clicked**, then pulls out.
- **Value input** (`fill` on a field): zoom in, hold `holdMs`, pull out.

Segments are **atomic** — a hotspot's pull-out always finishes before the next
zoom-in begins, so two hotspots can never interleave (no camera "shaking").

Per-event hints on any input event:

- `"focusZoom": 2.4` — makes this event a hotspot and sets its zoom (tighter for
  a small input, wider for a menu). Element-anchored — locks onto the live
  element with no cursor jitter.
- `"focusSelector": "[role=\"dialog\"]"` — frame a **different** element than the
  one acted on (e.g. click a node's swatch but frame the color popover).
- `"noFocus": true` — exclude an event from triggering a zoom.

Notes:

- A scene uses auto-camera when `autoZoom.enabled` and it has no manual `camera`
  track. Force per-scene with `"autoCamera": true`, or opt out with `false`.
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

## Speed-up

The recording runs at a realistic pace (the app needs real time to open menus,
render nodes, etc.), but the **finished clips are time-compressed** for a punchy
social feel. This is post-processing only — applied as a final `setpts` stage in
the ffmpeg filter, so the actual interactions always record at normal speed and
nothing breaks; only playback is faster.

Two knobs, in [`output`](#the-pipeline-file) (also settable via env / CLI):

| Key            | Meaning                                                              |
|----------------|----------------------------------------------------------------------|
| `speed`        | Explicit multiplier applied to every clip (`1.0` = real time).        |
| `maxTotalSec`  | Auto-derive a multiplier so the **combined** video fits this length.  |

Whichever implies the larger speed-up wins, and the factor is applied uniformly
to every scene so motion stays consistent. With `maxTotalSec` set, the final
length is **guaranteed** to fit regardless of how long the raw recording drifts
— the engine measures the real scene durations and computes the factor. The run
log prints `Speed-up ×N (raw Xs → ~Ys)`.

```bash
# all three set the same thing; CLI > env > pipeline.json
node src/record.js --max-total-sec 19
OUTPUT_MAX_TOTAL_SEC=19 npm run record
# or in pipeline.json: "output": { "maxTotalSec": 19 }
```

For a hard real-time cut (no speed-up) set `speed: 1` and omit `maxTotalSec` (or
set it larger than the raw length).

---

## Cinematography model

The "feels human, not scripted" comes from layering:

1. **Humanized timing** (`record.humanize`) — seeded PRNG wraps every `ms`
   value with `±jitter` and inserts `preActionPause` before cursor events.
2. **Humanized cursor** (`record.cursor`) — quadratic bezier path with
   perpendicular bend, eased velocity, slight overshoot + correction at the
   destination, hover hesitation before the click.
3. **Eased camera** — per-keyframe `ease` baked into ffmpeg crop expressions so
   pans/zooms accelerate / settle instead of running constant-velocity, with a
   fast `panMs` snap between hotspots and a locked hold while you work.
4. **Visible click effects** — a page-injected cursor image (configurable URL
   in [src/lib/cursor.js](src/lib/cursor.js)) follows real mouse events;
   `mousedown` spawns a large concentric-ring ripple (yellow for right-click,
   white for left).
5. **Attention choreography** — `mark` primes the viewer's eye 0.5s before an
   edit; `spotlight` keeps focus on the active node while the rest dims.
6. **Char-by-char typing** — `fill` clicks the input then types each character
   with per-key jittered delay instead of Playwright's instant `.fill()`.

7. **Speed-up** — the finished clips are time-compressed (`setpts`) to a social
   pace; the recording itself stays real-time so interactions don't break.

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
realistic spacing between cursor-bearing events.

The **camera is immune to this drift**: each auto-camera keyframe records the
*actual* fire time of the input event it's anchored to (plus an exact offset),
so zoom-in/out durations and trigger points stay precise even when actions run
late. Camera positions still resolve live against the real DOM.

If clips look a few frames early / late after crop, tune
`record.timelineOffsetMs`.

---

## Project layout

```
pipeline.json              the timeline (your reel) — also hand-authorable
pipeline.schema.json       JSON schema — full field docs + validation
flows/<name>/              one folder per strategy: flow.json (input) +
                           build.json + pipeline.json (generated)
scripts/lib/build-flow.js  STRATEGIES table + getStrategy() + buildFlow()
scripts/gen-build.js       write a flow's build fixture from its export
scripts/gen-pipeline.js    write a flow's recorder timeline from its export
scripts/gen.js             gen-build + gen-pipeline for a flow (npm run gen <name>)
scripts/flow.js            gen + record a flow (npm run flow <name>)
src/record.js              orchestrator: record session -> slice -> crop
src/config.js              defaults + CLI parsing
src/lib/pipeline.js        load + validate the timeline
src/lib/browser.js         launch context, inject overlays, wait for Pyodide
src/lib/timeline.js        scheduler: sort by `at` -> dispatch
src/lib/autocamera.js      derive the camera track from input hotspots
src/lib/actions.js         per-event handlers (cursor-driver-aware)
src/lib/cursor.js          page-injected cursor image + ripple overlay (CSS)
src/lib/cursor-driver.js   humanized mouse (bezier, overshoot, hesitation)
src/lib/attention.js       page-injected spotlight / mark / pulse / dim CSS
src/lib/target.js          resolve a scene target -> pixel region
src/lib/humanize.js        seeded PRNG, sample(), ease curves, bezier sampler
src/lib/crop.js            ffmpeg slice + eased pan crop expression
scripts/debug-*.js         throwaway debug probes (DOM inspection)
src/lib/effects.js         cinematic interaction engine — themed click/mark FX
src/studio/                Studio backend: server.js (API) + assets.js + start.js
studio/                    Studio front-end (Vite + React): player + timeline
```
