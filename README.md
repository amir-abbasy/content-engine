# Content Engine

Build a modular automated short-form trading content engine focused on Instagram/TikTok reels for algorithmic trading education.

---

## Phase 1 — Pipeline-driven app recorder

Phase 1 turns a running web app into raw vertical (9:16) scene clips, fully
driven by a JSON pipeline. It:

1. Opens the target app (`http://localhost:3000/` by default).
2. Waits for **Pyodide** to finish loading.
3. Walks an ordered list of **scenes** in one continuous recording — each scene
   opens its own pane / region and is held for a set duration.
4. Slices the raw session video and crops each scene to a vertical clip.

The app itself is **not** made responsive — each scene crops a sub-region of the
desktop canvas, so different scenes can use different panes or screen areas.

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
output/<pipeline-name>-<YYYYMMDD-HHMMSS>/
  raw/<session>.webm        full desktop recording (kept if output.keepRaw)
  scenes/<scene-id>.mp4     one vertical clip per scene
  manifest.json             scenes with timings, regions, fit mode, clip paths
```

## The pipeline file

`pipeline.json` is the **full automation pipeline**. `pipeline.schema.json` is
the authoritative, fully-commented contract — point your editor's JSON schema
at it for inline docs and validation.

Shape:

```jsonc
{
  "name": "algo-trading-reel-01",
  "app": {
    "url": "http://localhost:3000/",
    "viewport": { "width": 1920, "height": 1080 },
    "waitForPyodide": true,
    "pyodideLoaderSelector": ".app-pyodide-loader",  // detaches when ready
    "readySelector": "#main-chart",                  // optional extra wait
    "readyTimeoutMs": 120000
  },
  "record": {
    "browser": "chromium",
    "headless": false,
    "timelineOffsetMs": 0,   // nudge if clips land a few frames early/late
    "settleMs": 500          // pause after setup before measuring a region
  },
  "output": {
    "dir": "output",
    "resolution": { "width": 1080, "height": 1920 },  // 9:16
    "fps": 30,
    "fitMode": "cover",      // cover = scale-fill + center-crop; contain = fit + pad
    "keepRaw": true
  },
  "scenes": [ /* ordered scenes — see below */ ]
}
```

### Scenes

Each scene captures its own region:

```jsonc
{
  "id": "01-price-chart",          // becomes scenes/01-price-chart.mp4
  "description": "Price chart",
  "setup":  [ /* actions BEFORE timing — e.g. open a pane */ ],
  "target": { "selector": "#main-chart", "aspect": "9:16", "anchor": "right" },
  "settleMs": 500,                 // optional per-scene override
  "waitBeforeMs": 300,             // pause after measuring, before the clock
  "durationMs": 6000,              // min length, runs concurrently with actions
  "stopWhen": { "selector": ".done", "state": "visible" },
  "actions": [ /* actions DURING the take */ ],
  "holdAfterMs": 2000,             // static hold AFTER actions finish
  "fitMode": "cover"               // optional per-scene override
}
```

A scene needs at least one of `durationMs`, `stopWhen`, `holdAfterMs`, or
`actions`. Total length is `max(durationMs, actions time) + holdAfterMs`.

### Targets — what fills the vertical frame

Provide **exactly one** of:

| Key            | Captures                                                            |
|----------------|---------------------------------------------------------------------|
| `selector`     | An element's bounding box, e.g. `#main-chart`, `.react-flow`         |
| `pane`         | Named pane shortcut: `chart` \| `flow` \| `result` (full panel box)  |
| `paneIndex`    | The Nth `[data-panel]` element, left-to-right (0-based)              |
| `region`       | A fixed `{ x, y, width, height }` rectangle                         |
| `fullViewport` | The whole viewport                                                  |

Then optionally refine the resolved box:

- `aspect` + `anchor` — carve the largest `"W:H"` sub-rectangle (e.g. `"9:16"`)
  and place it (`left` / `right` / `center` / `top` / `bottom` / corners). This
  is **true vertical framing** — no squish, no black bars.
- `padding` — number or `{top,right,bottom,left}` to shrink/expand the box.

### Actions

Used in `setup` (pre-roll) and `actions` (live). Actions are **selector-based**,
not coordinate-based — selectors survive layout changes. Types:

- `press` — keyboard combo: `{ "type": "press", "key": "Digit1", "shift": true }`
  (the target app keys panes off `event.code`, so `key` is a code token)
- `type` — type into the focused element: `{ "type": "type", "text": "..." }`
- `fill` — focus + clear + set an input: `{ "type": "fill", "selector": "input[...]", "text": "..." }`
- `click` / `rightClick` / `dblclick` / `hover` — by `selector`; optional
  `position` (offset inside the element, e.g. right-clicking empty canvas) and
  `nth` (which match). `{ "type": "rightClick", "selector": ".react-flow__pane", "position": { "x": 1500, "y": 430 } }`
- `wait` — `{ "type": "wait", "ms": 500 }`
- `waitForSelector` — `{ "type": "waitForSelector", "selector": "...", "state": "visible" }`
- `scroll` — `{ "type": "scroll", "selector": "...", "deltaY": 300 }`
- `mouseMove` — `{ "type": "mouseMove", "x": 960, "y": 540 }`
- `eval` — `{ "type": "eval", "script": "window.scrollTo(0,0)" }`

A selector matching multiple elements resolves to the **first** match (override
with `nth`).

### How timing works

Playwright records video per browser context, so the whole session is one
`.webm`; scene clips are cut from it by wall-clock timestamps. If clips look a
few frames early/late, tune `record.timelineOffsetMs`.

## Project layout

```
pipeline.json          example pipeline (the automation contract)
pipeline.schema.json   JSON schema — full field docs + validation
src/record.js          orchestrator: record session -> slice -> crop
src/config.js          defaults + CLI parsing
src/lib/pipeline.js    load + validate pipeline
src/lib/browser.js     launch context, open app, wait for Pyodide
src/lib/actions.js     setup / live action runner
src/lib/target.js      resolve a scene target -> pixel region
src/lib/crop.js        ffmpeg slice + crop to vertical
```
