import React, { useEffect } from 'react';
import { fmtTime } from '../lib/format.js';

// Right pane: the 9:16 preview. One <video> (driven by usePlayer) plays the
// scene clips back-to-back; title/subtitle overlays render on top so the
// preview matches what export will burn in. Audio mixing arrives in Phase 3.
export default function Player({ project, segments, total, player }) {
  const { videoRef, handlers, playing, globalTime, activeIndex, toggle, next, prev, seek } = player;
  const active = segments[activeIndex] || null;
  const scene = active && active.scene;
  const localSec = active ? globalTime - active.t0 : 0;

  // Spacebar = play/pause, arrows = prev/next scene.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.code === 'ArrowRight') next();
      else if (e.code === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, next, prev]);

  const activeTitles = scene ? (scene.tracks.titles || []).filter(
    (t) => localSec >= (t.at || 0) && localSec <= (t.at || 0) + (t.durationSec || 0)) : [];
  const activeSubs = scene ? (scene.tracks.subtitles || []).filter(
    (s) => localSec >= (s.at || 0) && localSec <= (s.at || 0) + (s.durationSec || 0)) : [];

  return (
    <div className="player">
      <div className="stage">
        <div className="frame" style={{ aspectRatio: `${project?.resolution.width || 9} / ${project?.resolution.height || 16}` }}>
          {scene && scene.clipUrl ? (
            <video
              ref={videoRef}
              playsInline
              onLoadedMetadata={handlers.onLoadedMetadata}
              onTimeUpdate={handlers.onTimeUpdate}
              onEnded={handlers.onEnded}
              onClick={toggle}
            />
          ) : (
            <div className="frame-empty">
              {scene
                ? (scene.status === 'not-recorded'
                    ? `"${scene.id}" not recorded yet — run this flow to generate the clip`
                    : `clip missing for "${scene.id}"`)
                : 'no flow loaded'}
            </div>
          )}

          {/* Overlays (structure ready; data lands in Phase 3) */}
          <div className="overlays">
            {activeTitles.map((t, i) => <div key={i} className="ov-title">{t.text}</div>)}
            {activeSubs.length > 0 && (
              <div className="ov-subs">{activeSubs.map((s) => s.text).join(' ')}</div>
            )}
          </div>

          {scene && (
            <div className="badge">
              {scene.tracks.effects.theme || 'no theme'}
              {scene.tracks.effects.palette ? ` · ${scene.tracks.effects.palette}` : ''}
            </div>
          )}
        </div>
      </div>

      <div className="transport">
        <div className="tx-row">
          <button className="ic" onClick={prev} title="Previous scene (←)">⏮</button>
          <button className="ic play" onClick={toggle} title="Play/Pause (Space)">{playing ? '⏸' : '▶'}</button>
          <button className="ic" onClick={next} title="Next scene (→)">⏭</button>
          <span className="time">{fmtTime(globalTime, true)} / {fmtTime(total, true)}</span>
          <span className="scene-label">
            {scene ? `${activeIndex + 1}/${segments.length} · ${scene.id}` : '—'}
          </span>
        </div>
        <input
          className="scrub"
          type="range"
          min={0}
          max={total || 0}
          step={0.01}
          value={Math.min(globalTime, total || 0)}
          onChange={(e) => seek(parseFloat(e.target.value))}
        />
      </div>
    </div>
  );
}
