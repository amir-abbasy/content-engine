// Minimal console logger with timestamps and levels. No deps on purpose.

const pad = (n) => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const log = {
  info: (...a) => console.log(`[${stamp()}]`, ...a),
  step: (...a) => console.log(`[${stamp()}] •`, ...a),
  ok: (...a) => console.log(`[${stamp()}] ✓`, ...a),
  warn: (...a) => console.warn(`[${stamp()}] ! `, ...a),
  error: (...a) => console.error(`[${stamp()}] ✗`, ...a),
};
