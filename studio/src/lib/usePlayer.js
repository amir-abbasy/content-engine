import { useCallback, useEffect, useRef, useState } from 'react';
import { locate } from './format.js';

// Drives one <video> element across many scene clips so they play as a single
// continuous timeline. The hook owns playback truth (active clip, global time,
// playing state); the Player component just renders the <video> via `videoRef`
// and the Timeline reads `globalTime` / calls `seek`.
//
// Scrubbing across a scene boundary swaps the <video> src and applies the
// pending local offset once metadata is ready (and resumes play if it was
// playing) — so seeking feels continuous even though it's N separate files.
export function usePlayer(segments) {
  const videoRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [globalTime, setGlobalTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pendingLocal = useRef(null);
  const wasPlaying = useRef(false);
  const segRef = useRef(segments);
  segRef.current = segments;

  const active = segments[activeIndex] || null;

  // Swap the <video> source whenever the active clip changes.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !active || !active.scene.clipUrl) return;
    if (v.dataset.idx !== String(activeIndex)) {
      v.dataset.idx = String(activeIndex);
      v.src = active.scene.clipUrl;
      v.load();
    }
  }, [activeIndex, active]);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (pendingLocal.current != null) {
      v.currentTime = Math.min(pendingLocal.current, (v.duration || 0) - 0.05);
      pendingLocal.current = null;
    }
    if (wasPlaying.current) { v.play().catch(() => {}); }
  }, []);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    const seg = segRef.current[activeIndex];
    if (!v || !seg) return;
    setGlobalTime(seg.t0 + v.currentTime);
  }, [activeIndex]);

  const onEnded = useCallback(() => {
    const segs = segRef.current;
    if (activeIndex < segs.length - 1) {
      wasPlaying.current = true;
      pendingLocal.current = 0;
      setActiveIndex(activeIndex + 1);
    } else {
      setPlaying(false);
      wasPlaying.current = false;
    }
  }, [activeIndex]);

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    wasPlaying.current = true;
    setPlaying(true);
    v.play().catch(() => {});
  }, []);

  const pause = useCallback(() => {
    const v = videoRef.current;
    wasPlaying.current = false;
    setPlaying(false);
    if (v) v.pause();
  }, []);

  const toggle = useCallback(() => { (playing ? pause : play)(); }, [playing, play, pause]);

  // Seek to an absolute global time; crosses clip boundaries transparently.
  const seek = useCallback((globalSec) => {
    const segs = segRef.current;
    const { index, local } = locate(globalSec, segs);
    setGlobalTime(globalSec);
    if (index !== activeIndex) {
      pendingLocal.current = local;
      setActiveIndex(index);
    } else {
      const v = videoRef.current;
      if (v) v.currentTime = local;
    }
  }, [activeIndex]);

  const goToScene = useCallback((index) => {
    const segs = segRef.current;
    if (index < 0 || index >= segs.length) return;
    pendingLocal.current = 0;
    setActiveIndex(index);
    setGlobalTime(segs[index].t0);
  }, []);

  const next = useCallback(() => goToScene(activeIndex + 1), [activeIndex, goToScene]);
  const prev = useCallback(() => goToScene(activeIndex - 1), [activeIndex, goToScene]);

  return {
    videoRef, activeIndex, active, globalTime, playing,
    handlers: { onLoadedMetadata, onTimeUpdate, onEnded },
    play, pause, toggle, seek, next, prev, goToScene,
  };
}
