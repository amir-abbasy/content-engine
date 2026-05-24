import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtTime } from '../lib/format.js';

// Left pane: a multi-track timeline over the whole video. Each lane shows what
// the pipeline authored — scene clips, camera/zoom, input actions, effects, and
// the audio/text lanes (voiceover / sfx / bgm / titles / subtitles / vo-script).
// Clicking a block seeks the player and selects it for the Inspector; clicking
// empty space scrubs. Read-only in Phase 1 (drag-to-edit comes in Phase 2).

// Short, human label for a block, per track.
function describe(track, ev) {
  const sel = (s) => (s ? s.split(/\s+/).pop().replace(/^\[.*?=["']?/, '').replace(/["']?\]$/, '').slice(0, 22) : '');
  switch (track) {
    case 'input':
    case 'setup':
      if (ev.type === 'fill' || ev.type === 'type') return `${ev.type} "${(ev.text || '').slice(0, 14)}"`;
      if (ev.type === 'press') return `press ${ev.key}`;
      if (ev.type === 'injectFlow') return `inject ${ev.nodeCount != null ? `(${ev.nodeCount})` : ''}`;
      if (ev.type === 'wait') return 'wait';
      return `${ev.type} ${sel(ev.selector)}`;
    case 'camera': return ev.zoom ? `zoom ×${ev.zoom}` : 'camera';
    case 'attention': return `${ev.type || 'attn'} ${sel(ev.selector)}`;
    case 'sfx': return ev.sound || 'sfx';
    case 'titles': return ev.text || 'title';
    case 'subtitles': return ev.text || 'caption';
    default: return ev.text || ev.type || '';
  }
}

// Per-scene lanes. Each returns blocks { x0, dur, label, ev } in seconds.
const SCENE_LANES = [
  { key: 'video', label: 'Video', kind: 'video' },
  { key: 'camera', label: 'Camera', kind: 'camera' },
  { key: 'input', label: 'Actions', kind: 'event' },
  { key: 'setup', label: 'Setup', kind: 'event' },
  { key: 'attention', label: 'Effects', kind: 'event' },
  { key: 'voiceover', label: 'Voiceover', kind: 'audio' },
  { key: 'sfx', label: 'SFX', kind: 'event' },
  { key: 'titles', label: 'Titles', kind: 'span' },
  { key: 'subtitles', label: 'Subtitles', kind: 'span' },
  { key: 'voscript', label: 'VO Script', kind: 'text' },
];

const RULER_H = 26;
const LANE_H = 34;

export default function Timeline({ segments, total, player, selected, onSelect }) {
  const [pps, setPps] = useState(70); // pixels per second (zoom)
  const scrollRef = useRef(null);
  const contentW = Math.max(total * pps, 200);

  // Map an authored scene-time to a global x (seconds), scaling the authored
  // duration onto the clip's real segment width.
  const toGlobalSec = (seg, at) => {
    const authored = seg.scene.authoredDurationSec || seg.dur || 1;
    const frac = authored > 0 ? Math.max(0, Math.min(1, (at || 0) / authored)) : 0;
    return seg.t0 + frac * seg.dur;
  };

  // Build every block once per layout change.
  const lanes = useMemo(() => {
    return SCENE_LANES.map((lane) => {
      const blocks = [];
      for (const seg of segments) {
        const s = seg.scene;
        const tr = s.tracks || {};
        if (lane.key === 'video') {
          blocks.push({ x0: seg.t0, dur: seg.dur, label: s.id, ev: { __scene: s }, sceneId: s.id, status: s.status });
        } else if (lane.key === 'voiceover' || lane.key === 'voscript') {
          for (const v of tr.voiceover || []) {
            blocks.push({ x0: seg.t0, dur: seg.dur, label: lane.key === 'voscript' ? (v.text || '(no script)') : (v.audio ? 'vo' : 'awaiting vo'),
              ev: v, sceneId: s.id, muted: !v.audio && lane.key === 'voiceover' });
          }
        } else if (lane.key === 'camera') {
          const cam = tr.camera || [];
          if (cam.length === 0) blocks.push({ x0: seg.t0, dur: seg.dur, label: 'auto-zoom', ev: { __auto: true }, sceneId: s.id, faint: true });
          else cam.forEach((ev) => blocks.push({ x0: toGlobalSec(seg, ev.at), dur: 0, label: describe('camera', ev), ev, sceneId: s.id }));
        } else if (lane.kind === 'span') {
          for (const ev of tr[lane.key] || []) {
            blocks.push({ x0: toGlobalSec(seg, ev.at), dur: (ev.durationSec || 0) * (seg.dur / (s.authoredDurationSec || seg.dur || 1)), label: describe(lane.key, ev), ev, sceneId: s.id });
          }
        } else { // event lanes: input / setup / attention / sfx
          for (const ev of tr[lane.key] || []) {
            blocks.push({ x0: toGlobalSec(seg, ev.at), dur: 0, label: describe(lane.key, ev), ev, sceneId: s.id });
          }
        }
      }
      return { ...lane, blocks };
    });
  }, [segments, pps]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = player.globalTime * pps;
    if (x < el.scrollLeft + 60 || x > el.scrollLeft + el.clientWidth - 60) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    }
  }, [player.globalTime, pps]);

  const seekFromClick = (e) => {
    const el = scrollRef.current;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    player.seek(x / pps);
  };

  const ticks = useMemo(() => {
    const step = pps < 40 ? 5 : pps < 90 ? 2 : 1;
    const out = [];
    for (let t = 0; t <= total + 0.001; t += step) out.push(t);
    return out;
  }, [total, pps]);

  const isSel = (laneKey, b) => selected && selected.track === laneKey && selected.event === b.ev;

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <span className="tl-title">Timeline</span>
        <div className="tl-zoom">
          <button onClick={() => setPps((p) => Math.max(20, p - 15))}>－</button>
          <span>{pps}px/s</span>
          <button onClick={() => setPps((p) => Math.min(240, p + 15))}>＋</button>
        </div>
      </div>

      <div className="tl-grid">
        <div className="tl-labels">
          <div className="tl-corner" style={{ height: RULER_H }} />
          {SCENE_LANES.map((l) => (
            <div key={l.key} className={`tl-label kind-${l.kind}`} style={{ height: LANE_H }}>{l.label}</div>
          ))}
        </div>

        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-content" style={{ width: contentW }}>
            {/* Ruler */}
            <div className="tl-ruler" style={{ height: RULER_H }} onClick={seekFromClick}>
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  <span>{fmtTime(t)}</span>
                </div>
              ))}
              {/* scene boundaries */}
              {segments.map((seg) => (
                <div key={seg.scene.id} className="scene-bound" style={{ left: seg.t0 * pps }} />
              ))}
            </div>

            {/* Lanes */}
            {lanes.map((lane) => (
              <div key={lane.key} className={`tl-lane kind-${lane.kind}`} style={{ height: LANE_H }} onClick={seekFromClick}>
                {segments.map((seg) => (
                  <div key={seg.scene.id} className="lane-seg-bound" style={{ left: seg.t0 * pps }} />
                ))}
                {lane.blocks.map((b, i) => {
                  const left = b.x0 * pps;
                  const width = Math.max(b.dur * pps, b.dur ? 4 : 0);
                  const point = !b.dur;
                  return (
                    <div
                      key={i}
                      className={[
                        'block', `bk-${lane.kind}`, point ? 'point' : 'span',
                        b.faint ? 'faint' : '', b.muted ? 'muted' : '',
                        b.status === 'missing' || b.status === 'failed' ? 'bad' : '',
                        isSel(lane.key, b) ? 'sel' : '',
                      ].join(' ')}
                      style={point ? { left } : { left, width }}
                      title={b.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        player.seek(b.x0 + 0.001);
                        onSelect({ track: lane.key, sceneId: b.sceneId, event: b.ev, label: b.label });
                      }}
                    >
                      <span className="block-label">{b.label}</span>
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Playhead */}
            <div className="playhead" style={{ left: player.globalTime * pps, height: RULER_H + SCENE_LANES.length * LANE_H }} />
          </div>
        </div>
      </div>
    </div>
  );
}
