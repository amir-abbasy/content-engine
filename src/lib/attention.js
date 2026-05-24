// Attention overlay: a CSS bundle + window-level helpers the recorder calls
// to direct the viewer's eye. Three primitives, each authored as a typed event
// on the `attention` track:
//
//   spotlight  — adds a glow to the target and dims everything else
//   pulse      — brief 600ms glow on a single element (no dim)
//   dim/release — global ambient dim overlay; release clears any active state
//
// Effects layer over the page non-destructively (filters + extra CSS classes),
// so they don't fight with the app's hover/selected states.

// IMPORTANT: this runs in the page context via Playwright addInitScript.
// Must be self-contained (no outer-scope references).
export function attentionInitScript() {
  if (window.__attentionInstalled) return;
  window.__attentionInstalled = true;

  const install = () => {
    // Static rules — pulse animation + ambient dim overlay. The spotlight is
    // applied as a DYNAMICALLY-injected rule (see below) instead of a class
    // on the target element, because React re-renders (e.g. when typing into
    // an input inside a React Flow node) clobber injected classes — but
    // they preserve the node's `data-id` attribute, so we target that.
    // Colours come from the active effects theme via CSS custom properties
    // (--fx-glow / --fx-core, set by effects.js). The rgba() fallbacks keep the
    // original gold look when the effects engine isn't installed.
    const style = document.createElement('style');
    style.textContent = `
      @keyframes __rec-attn-pulse {
        0%   { filter: drop-shadow(0 0 0px transparent); }
        45%  { filter: drop-shadow(0 0 22px var(--fx-glow, rgba(250, 204, 21, 0.85))); }
        100% { filter: drop-shadow(0 0 0px transparent); }
      }
      .__rec-attn-pulse {
        animation: __rec-attn-pulse 620ms ease-in-out !important;
      }
      .__rec-attn-dim-overlay {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.42);
        pointer-events: none;
        z-index: 2147483645;
        opacity: 0;
        transition: opacity 260ms ease;
      }
      .__rec-attn-dim-overlay.active { opacity: 1; }

      /* Mark fallback — only used when the effects engine (window.__fx) isn't
         installed; otherwise mark() delegates to the themed mark effects.
         Animated rectangle drawn around a target to prime the viewer's eye
         ~0.5s before an edit. Blinks twice + glows + fades out. */
      .__rec-attn-mark {
        position: fixed;
        pointer-events: none;
        z-index: 2147483646;
        border-radius: 6px;
        border: 2px solid var(--fx-core, rgba(250, 204, 21, 0.95));
        box-shadow: 0 0 18px 4px var(--fx-glow, rgba(250, 204, 21, 0.55)), inset 0 0 6px var(--fx-glow, rgba(250, 204, 21, 0.25));
        opacity: 0;
        animation: __rec-attn-mark-blink 1.35s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      }
      @keyframes __rec-attn-mark-blink {
        0%   { opacity: 0; transform: scale(1.18); }
        16%  { opacity: 1; transform: scale(1.02); }
        38%  { opacity: 0.5; transform: scale(1); }
        58%  { opacity: 1; transform: scale(1.02); }
        100% { opacity: 0; transform: scale(1); }
      }
    `;
    document.documentElement.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = '__rec-attn-dim-overlay';
    (document.body || document.documentElement).appendChild(overlay);

    // The dynamic rule is rewritten on every spotlight() call so it tracks
    // the current target's data-id. It survives React re-renders because the
    // rule matches by attribute, not by an injected class.
    const dynStyle = document.createElement('style');
    dynStyle.id = '__rec-attn-dynamic';
    document.documentElement.appendChild(dynStyle);

    window.__attention = {
      spotlight(selector) {
        const target = document.querySelector(selector);
        if (!target) { dynStyle.textContent = ''; return false; }
        // Prefer data-id (React Flow node) for stable matching; fall back to a
        // unique data-attribute we tag onto the element ourselves.
        let dataId = target.getAttribute('data-id');
        if (!dataId) {
          dataId = `attn-${Date.now()}`;
          target.setAttribute('data-attn-target', dataId);
          dynStyle.textContent = `
            [data-attn-target="${dataId}"] {
              filter: drop-shadow(0 0 18px var(--fx-glow, rgba(96, 165, 250, 0.75))) brightness(1.06) !important;
              z-index: 50 !important;
              transition: filter 280ms cubic-bezier(0.2, 0.7, 0.3, 1) !important;
            }
            .react-flow__node:not([data-attn-target="${dataId}"]) {
              opacity: 0.32 !important;
              filter: saturate(0.4) brightness(0.7) !important;
              transition: opacity 280ms ease, filter 280ms ease !important;
            }
            .react-flow__edge {
              opacity: 0.3 !important;
              transition: opacity 280ms ease !important;
            }`;
        } else {
          dynStyle.textContent = `
            .react-flow__node[data-id="${dataId}"] {
              filter: drop-shadow(0 0 18px var(--fx-glow, rgba(96, 165, 250, 0.75))) brightness(1.06) !important;
              z-index: 50 !important;
              transition: filter 280ms cubic-bezier(0.2, 0.7, 0.3, 1) !important;
            }
            .react-flow__node:not([data-id="${dataId}"]) {
              opacity: 0.32 !important;
              filter: saturate(0.4) brightness(0.7) !important;
              transition: opacity 280ms ease, filter 280ms ease !important;
            }
            .react-flow__edge {
              opacity: 0.3 !important;
              transition: opacity 280ms ease !important;
            }`;
        }
        return true;
      },
      pulse(selector) {
        const target = document.querySelector(selector);
        if (!target) return false;
        target.classList.remove('__rec-attn-pulse');
        void target.offsetWidth;
        target.classList.add('__rec-attn-pulse');
        setTimeout(() => target.classList.remove('__rec-attn-pulse'), 700);
        return true;
      },
      dim(amount) {
        if (amount !== undefined) overlay.style.background = `rgba(0, 0, 0, ${Math.max(0, Math.min(0.85, amount))})`;
        overlay.classList.add('active');
      },
      mark(selector, opts) {
        // `nth` picks among repeated matches (e.g. a node's several int fields).
        const target = (opts && opts.nth != null)
          ? document.querySelectorAll(selector)[opts.nth]
          : document.querySelector(selector);
        if (!target) return false;
        const r = target.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        // Prefer the themed mark effects (brackets / scan / reticle / glowFrame)
        // when the cinematic engine is installed; the `mark`/`fx` opts can pick
        // a specific effect per event, else the active theme's mark is used.
        if (window.__fx && typeof window.__fx.mark === 'function') {
          window.__fx.mark(
            { left: r.left, top: r.top, width: r.width, height: r.height },
            opts || {},
          );
          return true;
        }
        const pad = (opts && typeof opts.padding === 'number') ? opts.padding : 6;
        const div = document.createElement('div');
        div.className = '__rec-attn-mark';
        div.style.left   = `${r.left - pad}px`;
        div.style.top    = `${r.top - pad}px`;
        div.style.width  = `${r.width + 2 * pad}px`;
        div.style.height = `${r.height + 2 * pad}px`;
        (document.body || document.documentElement).appendChild(div);
        const ms = (opts && opts.durationMs) || 1400;
        setTimeout(() => div.remove(), ms);
        return true;
      },
      release() {
        dynStyle.textContent = '';
        document.querySelectorAll('[data-attn-target]').forEach((el) => el.removeAttribute('data-attn-target'));
        overlay.classList.remove('active');
      },
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}
