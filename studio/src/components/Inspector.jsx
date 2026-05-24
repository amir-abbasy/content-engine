import React from 'react';

// Bottom strip: full detail of the selected timeline block. Read-only in
// Phase 1 (becomes an editable form in Phase 2). Falls back to a hint.
export default function Inspector({ selected, project }) {
  if (!selected) {
    return (
      <div className="inspector empty">
        <span>Select a block on the timeline to inspect its pipeline detail · Space = play/pause · ←/→ = scene</span>
      </div>
    );
  }

  const { track, sceneId, event, label } = selected;
  const scene = event && event.__scene;

  const rows = [];
  if (scene) {
    rows.push(['scene', scene.id]);
    rows.push(['status', scene.status]);
    rows.push(['duration', `${scene.authoredDurationSec}s`]);
    if (scene.description) rows.push(['description', scene.description]);
    if (scene.target) rows.push(['target', JSON.stringify(scene.target)]);
    rows.push(['effects', `${scene.tracks.effects.theme || '—'}${scene.tracks.effects.palette ? ' / ' + scene.tracks.effects.palette : ''}`]);
  } else if (event && event.__auto) {
    rows.push(['camera', 'auto-zoom (Screen-Studio style; generated from input actions)']);
  } else if (event) {
    for (const [k, v] of Object.entries(event)) {
      if (v === undefined || v === null) continue;
      rows.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    }
  }

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className={`chip chip-${track}`}>{track}</span>
        <span className="insp-title">{label}</span>
        <span className="insp-scene">scene: {sceneId}</span>
      </div>
      <div className="insp-grid">
        {rows.map(([k, v]) => (
          <div key={k} className="insp-row">
            <span className="insp-key">{k}</span>
            <span className="insp-val">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
