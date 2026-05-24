// Recording overlay: paint a visible mouse cursor into the page. Playwright's
// recording captures only the page DOM (not the OS cursor), so the recorder
// injects this script via context.addInitScript so every interaction it drives
// leaves a visible trace in the final video.
//
// Click *visuals* (ripples / blooms / trails / …) are owned by the cinematic
// interaction engine in effects.js (window.__fx), which is themed per video.
// This module is now purely the pointer itself.
//
// Behaviour:
//   - small arrow cursor follows `mousemove` (with a short CSS transition so
//     Playwright's teleporting moves still glide rather than snap)
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
    // Keep the cursor visible on press too (the click *effect* itself is
    // painted by the effects engine — window.__fx — not here).
    window.addEventListener('mousedown', (e) => bump(e.clientX, e.clientY), true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}
