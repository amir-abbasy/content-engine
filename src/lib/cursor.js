// Recording overlay: paint a visible mouse cursor + click ripples into the
// page. Playwright's recording captures only the page DOM (not the OS
// cursor), so the recorder injects this script via context.addInitScript so
// every interaction it drives leaves a visible trace in the final video.
//
// Behaviour:
//   - small arrow cursor follows `mousemove` (with a short CSS transition so
//     Playwright's teleporting moves still glide rather than snap)
//   - `mousedown` spawns an expanding ripple at the click point; right-clicks
//     get a yellow ripple, regular clicks white
//   - the cursor auto-hides after ~1.5s of inactivity so it doesn't sit
//     parked on screen during static holds / camera pans

// IMPORTANT: this runs in the page context via Playwright addInitScript.
// It must be a self-contained function (no outer-scope refs).
export function cursorInitScript() {
  if (window.__cursorInstalled) return;
  window.__cursorInstalled = true;

  const CURSOR_IMG = 'https://focusee.imobie-resource.com/img/mouse_style_7.png';
  const CURSOR_SIZE = 36;

  const install = () => {
    const style = document.createElement('style');
    style.textContent = `
      .__rec-cursor {
        position: fixed; left: 0; top: 0;
        width: ${CURSOR_SIZE}px; height: ${CURSOR_SIZE}px;
        pointer-events: none; z-index: 2147483647;
        transform: translate(-100px, -100px);
        /* No transform transition — the cursor driver visits many bezier
           waypoints, so the cursor already animates naturally. */
        transition: opacity 220ms ease;
        opacity: 0;
        filter: drop-shadow(0 2px 5px rgba(0,0,0,0.55));
      }
      .__rec-cursor img {
        width: 100%; height: 100%; display: block;
        user-select: none; -webkit-user-drag: none; pointer-events: none;
      }

      /* Real ripple: a glowing filled core that fades + collapses, plus three
         concentric expanding rings (staggered) for a clear, prominent
         "drop in water" look. Much bigger + brighter than v1 so the click
         reads even on dark backgrounds. */
      .__rec-ripple {
        position: fixed; pointer-events: none; z-index: 2147483646;
        width: 22px; height: 22px;
        transform: translate(-50%, -50%);
        border-radius: 50%;
        background: var(--c, rgba(255,255,255,1));
        box-shadow: 0 0 18px 6px var(--c-glow, rgba(255,255,255,0.6));
        animation: __rec-ripple-core 680ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
      }
      .__rec-ripple::before, .__rec-ripple::after {
        content: '';
        position: absolute; top: 50%; left: 50%;
        width: 22px; height: 22px;
        transform: translate(-50%, -50%);
        border: 4px solid var(--c, rgba(255,255,255,1));
        border-radius: 50%;
        box-sizing: border-box;
        box-shadow: 0 0 12px var(--c-glow, rgba(255,255,255,0.5));
        animation: __rec-ripple-ring 1100ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
      }
      .__rec-ripple::after { animation-delay: 220ms; }

      @keyframes __rec-ripple-core {
        0%   { opacity: 1; transform: translate(-50%, -50%) scale(1);   box-shadow: 0 0 22px 8px var(--c-glow, rgba(255,255,255,0.65)); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.25); box-shadow: 0 0 0 0 transparent; }
      }
      @keyframes __rec-ripple-ring {
        0%   { opacity: 0.95; width: 22px;  height: 22px;  border-width: 4px; }
        100% { opacity: 0;    width: 180px; height: 180px; border-width: 1px; }
      }
    `;
    document.documentElement.appendChild(style);

    // Preload the cursor image so the first paint isn't broken.
    const preload = new Image();
    preload.src = CURSOR_IMG;

    const cursor = document.createElement('div');
    cursor.className = '__rec-cursor';
    const img = document.createElement('img');
    img.src = CURSOR_IMG;
    img.draggable = false;
    img.alt = '';
    cursor.appendChild(img);
    (document.body || document.documentElement).appendChild(cursor);

    let hideTimer;
    const bump = (x, y) => {
      // Hotspot at upper-left tip of the arrow image (~2px in, 2px down).
      cursor.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
      cursor.style.opacity = '1';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { cursor.style.opacity = '0'; }, 1500);
    };

    window.addEventListener('mousemove', (e) => bump(e.clientX, e.clientY), true);

    window.addEventListener('mousedown', (e) => {
      bump(e.clientX, e.clientY);
      const r = document.createElement('div');
      r.className = '__rec-ripple';
      const isRight = e.button === 2;
      r.style.setProperty('--c', isRight ? 'rgba(250, 204, 21, 1)'     : 'rgba(255, 255, 255, 1)');
      r.style.setProperty('--c-glow', isRight ? 'rgba(250, 204, 21, 0.55)' : 'rgba(255, 255, 255, 0.6)');
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      (document.body || document.documentElement).appendChild(r);
      setTimeout(() => r.remove(), 1400);
    }, true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}
