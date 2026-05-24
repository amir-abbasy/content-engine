// Cinematic interaction engine — a pluggable library of click / mark / glow
// effects so each video can wear a different "look". Where cursor.js used to
// hardcode a single white ripple and attention.js a single yellow mark, the
// engine now owns those visuals and styles them from a named THEME:
//
//   theme  = { palette, click, mark }   — a cohesive cinematic look
//   click  = how a mousedown blooms (ripple / wave / bloom / neural / …)
//   mark   = how a target is framed before an edit (glowFrame / brackets / …)
//   palette = the colour set every effect tints itself with
//
// Selection (record.effects.theme): a specific theme name, "random"/"auto"
// (one theme per video, seeded for reproducibility), or "sequence" (rotate
// per scene). Scenes can override with `scene.effects`. Adding a new look is
// just another entry in FX_THEMES + an impl in CLICK_IMPL / MARK_IMPL.
//
// Architecture note: THEMES + PALETTES are PLAIN DATA defined here once and
// passed into the page via addInitScript(effectsInitScript, config). The page
// script holds the effect *implementations* keyed by the same names, so there
// is a single source of truth for which themes exist.

// ── Colour palettes. Each effect reads { core, glow, accent } and also mirrors
// them onto CSS custom properties (--fx-core/glow/accent) so attention.js's
// spotlight/pulse pick up the active theme's colour for free.
export const PALETTES = {
  gold:    { core: 'rgba(250, 204, 21, 1)',  glow: 'rgba(250, 204, 21, 0.6)',  accent: 'rgba(253, 224, 71, 1)' },
  cyan:    { core: 'rgba(34, 211, 238, 1)',  glow: 'rgba(34, 211, 238, 0.55)', accent: 'rgba(103, 232, 249, 1)' },
  violet:  { core: 'rgba(167, 139, 250, 1)', glow: 'rgba(139, 92, 246, 0.55)', accent: 'rgba(196, 181, 253, 1)' },
  emerald: { core: 'rgba(52, 211, 153, 1)',  glow: 'rgba(16, 185, 129, 0.55)', accent: 'rgba(110, 231, 183, 1)' },
  crimson: { core: 'rgba(248, 113, 113, 1)', glow: 'rgba(239, 68, 68, 0.55)',  accent: 'rgba(252, 165, 165, 1)' },
  magenta: { core: 'rgba(232, 121, 249, 1)', glow: 'rgba(217, 70, 239, 0.55)', accent: 'rgba(240, 171, 252, 1)' },
  azure:   { core: 'rgba(96, 165, 250, 1)',  glow: 'rgba(59, 130, 246, 0.55)', accent: 'rgba(147, 197, 253, 1)' },
  amber:   { core: 'rgba(251, 146, 60, 1)',  glow: 'rgba(249, 115, 22, 0.55)', accent: 'rgba(253, 186, 116, 1)' },
};

// ── Themes. `click` and `mark` reference impls in CLICK_IMPL / MARK_IMPL below.
export const FX_THEMES = [
  { name: 'gold-ripple',   palette: 'gold',    click: 'ripple',   mark: 'glowFrame' },
  { name: 'neon-wave',     palette: 'cyan',    click: 'wave',     mark: 'scan' },
  { name: 'aurora-bloom',  palette: 'violet',  click: 'bloom',    mark: 'brackets' },
  { name: 'neural-links',  palette: 'azure',   click: 'neural',   mark: 'reticle' },
  { name: 'energy-trails', palette: 'amber',   click: 'energy',   mark: 'brackets' },
  { name: 'magnetic',      palette: 'magenta', click: 'magnetic', mark: 'scan' },
  { name: 'orbit-rings',   palette: 'emerald', click: 'orbit',    mark: 'reticle' },
  { name: 'radar-sweep',   palette: 'crimson', click: 'radar',    mark: 'glowFrame' },
];

// gold-ripple reproduces the engine's pre-existing look, so it's the default —
// pipelines that don't opt in keep their current visuals.
export const DEFAULT_THEME = 'gold-ripple';

// ── Node-side resolver. Decides the per-video theme from record.effects using
// the seeded RNG (so "random" is reproducible), and returns the full config
// object handed to the page. `sequence` (non-null) tells record.js to rotate
// themes per scene.
export function resolveEffects(record, rng) {
  const cfg = (record && record.effects) || {};
  const names = FX_THEMES.map((t) => t.name);
  const mode = cfg.theme || DEFAULT_THEME;

  let active = DEFAULT_THEME;
  let sequence = null;
  const pick = () => names[Math.floor((rng ? rng() : Math.random()) * names.length)] || DEFAULT_THEME;

  if (mode === 'random' || mode === 'auto') {
    active = pick();
  } else if (mode === 'sequence') {
    sequence = names.slice();
    active = sequence[0];
  } else if (names.includes(mode)) {
    active = mode;
  } // else: unknown name → DEFAULT_THEME

  return {
    themes: FX_THEMES,
    palettes: PALETTES,
    active,
    sequence,
    paletteOverride: cfg.palette || null,
  };
}

// ── Page-context installer. Runs via Playwright addInitScript(fn, config) — it
// receives `config` (plain data from resolveEffects) and MUST be self-contained
// (no outer-scope references). Builds the effect runtime and exposes:
//
//   window.__fx.click(x, y, opts)   — spawn the active click effect
//   window.__fx.mark(rect, opts)    — frame a rect with the active mark effect
//   window.__fx.setTheme(name)      — switch the active theme (per-scene)
//   window.__fx.setPalette(name)    — override just the palette
//   window.__fx.theme               — current theme name
//
// A capturing mousedown listener fires click() automatically, so every gesture
// the recorder drives leaves a themed trace in the video.
export function effectsInitScript(config) {
  if (window.__fxInstalled) return;
  window.__fxInstalled = true;

  const install = () => {
    const TAU = Math.PI * 2;
    const PALETTES = config.palettes || {};
    const FALLBACK = { core: 'rgba(250,204,21,1)', glow: 'rgba(250,204,21,0.6)', accent: 'rgba(253,224,71,1)' };
    const THEMES = {};
    for (const t of (config.themes || [])) THEMES[t.name] = t;

    // A single overlay layer hosts every effect element. Children are
    // position:fixed (viewport coords = clientX/clientY) and pointer-inert.
    const layer = document.createElement('div');
    layer.id = '__fx-layer';
    Object.assign(layer.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none',
      zIndex: '2147483646', overflow: 'hidden',
    });
    (document.body || document.documentElement).appendChild(layer);

    const style = document.createElement('style');
    style.textContent = `.__fx { position: fixed; pointer-events: none; will-change: transform, opacity; }`;
    document.documentElement.appendChild(style);

    // ── DOM + animation helpers ───────────────────────────────────────────
    const el = (styles) => {
      const d = document.createElement('div');
      d.className = '__fx';
      Object.assign(d.style, styles);
      layer.appendChild(d);
      return d;
    };
    // Animate via WAAPI, then self-remove when the animation settles.
    const fx = (node, frames, opts) => {
      const a = node.animate(frames, opts);
      const done = () => node.remove();
      a.finished.then(done).catch(done);
      return a;
    };
    const rnd = (a, b) => a + Math.random() * (b - a);

    // ── CLICK effects ─────────────────────────────────────────────────────
    // Each: (x, y, p) → spawns self-cleaning DOM. p = { core, glow, accent }.
    const CLICK_IMPL = {
      // Concentric expanding rings + a collapsing glow core (the classic look).
      ripple(x, y, p) {
        fx(el({
          left: x + 'px', top: y + 'px', width: '22px', height: '22px', borderRadius: '50%',
          transform: 'translate(-50%,-50%)', background: p.core, boxShadow: `0 0 22px 8px ${p.glow}`,
        }), [
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(0.25)', opacity: 0 },
        ], { duration: 680, easing: 'cubic-bezier(0.2,0.7,0.3,1)', fill: 'forwards' });
        for (let i = 0; i < 3; i++) {
          fx(el({
            left: x + 'px', top: y + 'px', width: '22px', height: '22px', borderRadius: '50%',
            border: `4px solid ${p.core}`, boxSizing: 'border-box', transform: 'translate(-50%,-50%)',
            boxShadow: `0 0 12px ${p.glow}`,
          }), [
            { width: '22px', height: '22px', opacity: 0.95, borderWidth: '4px' },
            { width: '200px', height: '200px', opacity: 0, borderWidth: '1px' },
          ], { duration: 1100, delay: i * 200, easing: 'cubic-bezier(0.2,0.7,0.3,1)', fill: 'forwards' });
        }
      },

      // Wave propagation — a rapid succession of thin rings rolling outward.
      wave(x, y, p) {
        for (let i = 0; i < 5; i++) {
          fx(el({
            left: x + 'px', top: y + 'px', width: '14px', height: '14px', borderRadius: '50%',
            border: `3px solid ${p.core}`, boxSizing: 'border-box', transform: 'translate(-50%,-50%)',
            boxShadow: `0 0 10px ${p.glow}`,
          }), [
            { width: '14px', height: '14px', opacity: 0.85, borderWidth: '3px' },
            { width: '260px', height: '260px', opacity: 0, borderWidth: '0.5px' },
          ], { duration: 1000, delay: i * 120, easing: 'cubic-bezier(0.15,0.7,0.25,1)', fill: 'forwards' });
        }
      },

      // Glow bloom — a soft radial flare swelling out of a bright core.
      bloom(x, y, p) {
        fx(el({
          left: x + 'px', top: y + 'px', width: '60px', height: '60px', borderRadius: '50%',
          transform: 'translate(-50%,-50%) scale(0.3)',
          background: `radial-gradient(circle, ${p.core} 0%, ${p.glow} 42%, transparent 70%)`,
        }), [
          { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 0.95 },
          { transform: 'translate(-50%,-50%) scale(5)', opacity: 0 },
        ], { duration: 760, easing: 'cubic-bezier(0.2,0.8,0.2,1)', fill: 'forwards' });
        fx(el({
          left: x + 'px', top: y + 'px', width: '12px', height: '12px', borderRadius: '50%',
          transform: 'translate(-50%,-50%)', background: '#fff', boxShadow: `0 0 18px 6px ${p.core}`,
        }), [
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(2.6)', opacity: 0 },
        ], { duration: 440, easing: 'ease-out', fill: 'forwards' });
      },

      // Energy trails — streaks firing radially outward from the click.
      energy(x, y, p) {
        const n = 12;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + rnd(-0.18, 0.18);
          const dist = rnd(50, 105);
          const len = rnd(10, 22);
          fx(el({
            left: x + 'px', top: y + 'px', width: len + 'px', height: '3px', borderRadius: '2px',
            transformOrigin: '0 50%', background: `linear-gradient(90deg, ${p.accent}, transparent)`,
            boxShadow: `0 0 8px ${p.glow}`,
          }), [
            { transform: `translate(0,-50%) rotate(${a}rad) translateX(0px)`, opacity: 0.95 },
            { transform: `translate(0,-50%) rotate(${a}rad) translateX(${dist}px)`, opacity: 0 },
          ], { duration: rnd(520, 700), easing: 'cubic-bezier(0.1,0.7,0.2,1)', fill: 'forwards' });
        }
        fx(el({
          left: x + 'px', top: y + 'px', width: '14px', height: '14px', borderRadius: '50%',
          transform: 'translate(-50%,-50%)', background: '#fff', boxShadow: `0 0 16px 5px ${p.core}`,
        }), [
          { transform: 'translate(-50%,-50%) scale(1.2)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(0)', opacity: 0 },
        ], { duration: 380, easing: 'ease-out', fill: 'forwards' });
      },

      // Neural links — links grow outward, lighting up a node at each tip.
      neural(x, y, p) {
        const n = 7;
        fx(el({
          left: x + 'px', top: y + 'px', width: '12px', height: '12px', borderRadius: '50%',
          transform: 'translate(-50%,-50%)', background: p.core, boxShadow: `0 0 14px 3px ${p.glow}`,
        }), [
          { transform: 'translate(-50%,-50%) scale(0.6)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(1.3)', opacity: 1, offset: 0.5 },
          { transform: 'translate(-50%,-50%) scale(0.8)', opacity: 0 },
        ], { duration: 900, easing: 'ease-in-out', fill: 'forwards' });
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + 0.2;
          const dist = rnd(46, 84);
          fx(el({
            left: x + 'px', top: y + 'px', height: '2px', width: dist + 'px', transformOrigin: '0 50%',
            background: `linear-gradient(90deg, ${p.glow}, ${p.accent})`, boxShadow: `0 0 6px ${p.glow}`,
          }), [
            { transform: `rotate(${a}rad) scaleX(0)`, opacity: 0.9 },
            { transform: `rotate(${a}rad) scaleX(1)`, opacity: 0.9, offset: 0.6 },
            { transform: `rotate(${a}rad) scaleX(1)`, opacity: 0 },
          ], { duration: 780, delay: i * 28, easing: 'cubic-bezier(0.2,0.8,0.2,1)', fill: 'forwards' });
          const nx = Math.cos(a) * dist, ny = Math.sin(a) * dist;
          const base = `translate(-50%,-50%) translate(${nx}px,${ny}px)`;
          fx(el({
            left: x + 'px', top: y + 'px', width: '7px', height: '7px', borderRadius: '50%',
            background: p.accent, boxShadow: `0 0 10px ${p.glow}`,
          }), [
            { transform: `${base} scale(0)`, opacity: 0, offset: 0 },
            { transform: `${base} scale(0)`, opacity: 0, offset: 0.55 },
            { transform: `${base} scale(1.5)`, opacity: 1, offset: 0.78 },
            { transform: `${base} scale(1)`, opacity: 0, offset: 1 },
          ], { duration: 820, delay: i * 28, easing: 'ease-out', fill: 'forwards' });
        }
      },

      // Magnetic attraction — particles rush inward from a ring, then burst.
      magnetic(x, y, p) {
        const n = 14;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + rnd(-0.12, 0.12);
          const dist = rnd(70, 110);
          const sx = Math.cos(a) * dist, sy = Math.sin(a) * dist;
          fx(el({
            left: x + 'px', top: y + 'px', width: '6px', height: '6px', borderRadius: '50%',
            background: p.accent, boxShadow: `0 0 8px ${p.glow}`,
          }), [
            { transform: `translate(-50%,-50%) translate(${sx}px,${sy}px) scale(0.4)`, opacity: 0 },
            { transform: `translate(-50%,-50%) translate(${sx}px,${sy}px) scale(1)`, opacity: 1, offset: 0.15 },
            { transform: 'translate(-50%,-50%) translate(0,0) scale(0.8)', opacity: 1, offset: 0.85 },
            { transform: 'translate(-50%,-50%) translate(0,0) scale(0)', opacity: 0 },
          ], { duration: 560, delay: i * 8, easing: 'cubic-bezier(0.5,0,0.4,1)', fill: 'forwards' });
        }
        fx(el({
          left: x + 'px', top: y + 'px', width: '30px', height: '30px', borderRadius: '50%',
          transform: 'translate(-50%,-50%) scale(0)',
          background: `radial-gradient(circle, #fff 0%, ${p.core} 45%, transparent 70%)`,
        }), [
          { transform: 'translate(-50%,-50%) scale(0)', opacity: 0, offset: 0 },
          { transform: 'translate(-50%,-50%) scale(0)', opacity: 0, offset: 0.6 },
          { transform: 'translate(-50%,-50%) scale(1.6)', opacity: 1, offset: 0.78 },
          { transform: 'translate(-50%,-50%) scale(2.8)', opacity: 0, offset: 1 },
        ], { duration: 640, easing: 'ease-out', fill: 'forwards' });
      },

      // Orbit rings — counter-rotating dashed rings + orbiting satellites.
      orbit(x, y, p) {
        fx(el({
          left: x + 'px', top: y + 'px', width: '12px', height: '12px', borderRadius: '50%',
          transform: 'translate(-50%,-50%)', background: p.core, boxShadow: `0 0 14px 3px ${p.glow}`,
        }), [
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 0 },
        ], { duration: 760, easing: 'ease-out', fill: 'forwards' });
        for (let i = 0; i < 2; i++) {
          const dir = i === 0 ? 1 : -1;
          fx(el({
            left: x + 'px', top: y + 'px', width: '26px', height: '26px', borderRadius: '50%',
            border: `2px dashed ${p.accent}`, boxSizing: 'border-box', boxShadow: `0 0 10px ${p.glow}`,
          }), [
            { transform: 'translate(-50%,-50%) rotate(0deg) scale(1)', opacity: 0.9 },
            { transform: `translate(-50%,-50%) rotate(${dir * 200}deg) scale(5.5)`, opacity: 0 },
          ], { duration: 900, delay: i * 120, easing: 'cubic-bezier(0.2,0.7,0.3,1)', fill: 'forwards' });
        }
        const orb = el({ left: x + 'px', top: y + 'px', width: '0', height: '0' });
        for (let k = 0; k < 3; k++) {
          const sat = document.createElement('div');
          Object.assign(sat.style, {
            position: 'absolute', left: '0', top: '0', width: '6px', height: '6px', borderRadius: '50%',
            background: p.core, boxShadow: `0 0 8px ${p.glow}`,
            transform: `rotate(${(k / 3) * 360}deg) translateX(34px)`,
          });
          orb.appendChild(sat);
        }
        fx(orb, [
          { transform: 'translate(-50%,-50%) rotate(0deg) scale(0.6)', opacity: 1 },
          { transform: 'translate(-50%,-50%) rotate(220deg) scale(1.7)', opacity: 0 },
        ], { duration: 820, easing: 'cubic-bezier(0.2,0.7,0.3,1)', fill: 'forwards' });
      },

      // Radar sweep — an expanding ring plus a rotating scan sector.
      radar(x, y, p) {
        fx(el({
          left: x + 'px', top: y + 'px', width: '20px', height: '20px', borderRadius: '50%',
          border: `2px solid ${p.core}`, boxSizing: 'border-box', transform: 'translate(-50%,-50%)',
          boxShadow: `0 0 12px ${p.glow}`,
        }), [
          { width: '20px', height: '20px', opacity: 0.9 },
          { width: '190px', height: '190px', opacity: 0 },
        ], { duration: 900, easing: 'ease-out', fill: 'forwards' });
        fx(el({
          left: x + 'px', top: y + 'px', width: '190px', height: '190px', borderRadius: '50%',
          transform: 'translate(-50%,-50%) rotate(0deg)',
          background: `conic-gradient(from 0deg, ${p.glow} 0deg, transparent 65deg)`,
        }), [
          { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 0.8 },
          { transform: 'translate(-50%,-50%) rotate(360deg)', opacity: 0 },
        ], { duration: 850, easing: 'cubic-bezier(0.3,0,0.4,1)', fill: 'forwards' });
      },
    };

    // ── MARK effects ──────────────────────────────────────────────────────
    // Each: (rect, p, opts) → frames a rect. opts = { padding, durationMs }.
    const MARK_IMPL = {
      // Glowing rounded rectangle that blinks twice then fades (classic mark).
      glowFrame(rect, p, o) {
        const pad = o.padding;
        fx(el({
          left: (rect.left - pad) + 'px', top: (rect.top - pad) + 'px',
          width: (rect.width + 2 * pad) + 'px', height: (rect.height + 2 * pad) + 'px',
          borderRadius: '6px', border: `2px solid ${p.core}`,
          boxShadow: `0 0 18px 4px ${p.glow}, inset 0 0 6px ${p.glow}`,
        }), [
          { opacity: 0, transform: 'scale(1.18)' },
          { opacity: 1, transform: 'scale(1.02)', offset: 0.16 },
          { opacity: 0.5, transform: 'scale(1)', offset: 0.38 },
          { opacity: 1, transform: 'scale(1.02)', offset: 0.58 },
          { opacity: 0, transform: 'scale(1)' },
        ], { duration: o.durationMs, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'forwards' });
      },

      // Four corner brackets that snap inward onto the target — a targeting HUD.
      brackets(rect, p, o) {
        const pad = o.padding;
        const L = Math.max(12, Math.min(26, Math.min(rect.width, rect.height) / 2 + pad));
        const x0 = rect.left - pad, y0 = rect.top - pad;
        const x1 = rect.left + rect.width + pad, y1 = rect.top + rect.height + pad;
        const corners = [
          { cx: x0, cy: y0, h: 'left',  v: 'top' },
          { cx: x1, cy: y0, h: 'right', v: 'top' },
          { cx: x0, cy: y1, h: 'left',  v: 'bottom' },
          { cx: x1, cy: y1, h: 'right', v: 'bottom' },
        ];
        for (const c of corners) {
          const anchor = `translate(${c.h === 'right' ? '-100%' : '0'}, ${c.v === 'bottom' ? '-100%' : '0'})`;
          const ox = (c.h === 'left' ? -1 : 1) * 16, oy = (c.v === 'top' ? -1 : 1) * 16;
          const node = el({
            left: c.cx + 'px', top: c.cy + 'px', width: L + 'px', height: L + 'px', boxShadow: `0 0 10px ${p.glow}`,
            borderTop:    c.v === 'top'    ? `3px solid ${p.core}` : 'none',
            borderBottom: c.v === 'bottom' ? `3px solid ${p.core}` : 'none',
            borderLeft:   c.h === 'left'   ? `3px solid ${p.core}` : 'none',
            borderRight:  c.h === 'right'  ? `3px solid ${p.core}` : 'none',
          });
          fx(node, [
            { transform: `translate(${ox}px,${oy}px) ${anchor}`, opacity: 0 },
            { transform: `translate(0,0) ${anchor}`, opacity: 1, offset: 0.3 },
            { transform: `translate(0,0) ${anchor}`, opacity: 1, offset: 0.82 },
            { transform: `translate(0,0) ${anchor}`, opacity: 0 },
          ], { duration: o.durationMs, easing: 'cubic-bezier(0.2,0.8,0.2,1)', fill: 'forwards' });
        }
      },

      // Thin frame with a bright scan-line sweeping across it twice.
      scan(rect, p, o) {
        const pad = o.padding;
        const fw = rect.width + 2 * pad, fh = rect.height + 2 * pad;
        const frame = el({
          left: (rect.left - pad) + 'px', top: (rect.top - pad) + 'px', width: fw + 'px', height: fh + 'px',
          borderRadius: '4px', border: `1.5px solid ${p.glow}`, boxShadow: `0 0 14px ${p.glow}`, overflow: 'hidden',
        });
        fx(frame, [
          { opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.85 }, { opacity: 0 },
        ], { duration: o.durationMs, easing: 'ease', fill: 'forwards' });
        const line = document.createElement('div');
        Object.assign(line.style, {
          position: 'absolute', left: '0', top: '0', width: '100%', height: '3px',
          background: `linear-gradient(90deg, transparent, ${p.core}, transparent)`,
          boxShadow: `0 0 12px 2px ${p.glow}`,
        });
        frame.appendChild(line);
        line.animate(
          [{ transform: 'translateY(0)' }, { transform: `translateY(${fh}px)` }],
          { duration: o.durationMs * 0.7, iterations: 2, easing: 'ease-in-out' },
        );
      },

      // Reticle — a crosshair ring with sweeping rotate-in (the "target" lock).
      reticle(rect, p, o) {
        const pad = o.padding;
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const d = Math.max(rect.width, rect.height) + 2 * pad;
        fx(el({
          left: cx + 'px', top: cy + 'px', width: d + 'px', height: d + 'px', borderRadius: '50%',
          border: `2px solid ${p.core}`, boxShadow: `0 0 14px ${p.glow}`,
        }), [
          { transform: 'translate(-50%,-50%) scale(1.5) rotate(-30deg)', opacity: 0 },
          { transform: 'translate(-50%,-50%) scale(1) rotate(0deg)', opacity: 1, offset: 0.3 },
          { transform: 'translate(-50%,-50%) scale(1) rotate(0deg)', opacity: 1, offset: 0.8 },
          { transform: 'translate(-50%,-50%) scale(0.96) rotate(0deg)', opacity: 0 },
        ], { duration: o.durationMs, easing: 'cubic-bezier(0.2,0.8,0.2,1)', fill: 'forwards' });
        for (const horiz of [true, false]) {
          const ln = el({
            left: cx + 'px', top: cy + 'px', background: p.glow, boxShadow: `0 0 8px ${p.glow}`,
            transform: 'translate(-50%,-50%)',
            width: horiz ? (d + 22) + 'px' : '1.5px',
            height: horiz ? '1.5px' : (d + 22) + 'px',
          });
          fx(ln, [
            { opacity: 0 }, { opacity: 0.8, offset: 0.3 }, { opacity: 0.8, offset: 0.8 }, { opacity: 0 },
          ], { duration: o.durationMs, easing: 'ease', fill: 'forwards' });
        }
      },
    };

    // ── Active theme state + CSS-var mirroring ────────────────────────────
    let active = THEMES[config.active] || (config.themes && THEMES[config.themes[0] && config.themes[0].name]) || null;
    let paletteOverride = config.paletteOverride || null;

    const paletteOf = (t) => PALETTES[paletteOverride || (t && t.palette)] || FALLBACK;
    const applyVars = () => {
      const p = paletteOf(active);
      const root = document.documentElement.style;
      root.setProperty('--fx-core', p.core);
      root.setProperty('--fx-glow', p.glow);
      root.setProperty('--fx-accent', p.accent);
    };
    applyVars();

    window.__fx = {
      get theme() { return active ? active.name : null; },
      setTheme(name) {
        if (THEMES[name]) { active = THEMES[name]; applyVars(); return true; }
        return false;
      },
      setPalette(name) {
        if (PALETTES[name]) { paletteOverride = name; applyVars(); return true; }
        return false;
      },
      click(x, y, opts) {
        const name = (opts && opts.fx) || (active && active.click) || 'ripple';
        (CLICK_IMPL[name] || CLICK_IMPL.ripple)(x, y, paletteOf(active));
      },
      mark(rect, opts) {
        const o = {
          padding: (opts && opts.padding != null) ? opts.padding : 6,
          durationMs: (opts && opts.durationMs) || 1400,
        };
        const name = (opts && opts.mark) || (active && active.mark) || 'glowFrame';
        (MARK_IMPL[name] || MARK_IMPL.glowFrame)(rect, paletteOf(active), o);
      },
    };

    // Auto-paint every mousedown the recorder drives.
    window.addEventListener('mousedown', (e) => {
      window.__fx.click(e.clientX, e.clientY, {});
    }, true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}
