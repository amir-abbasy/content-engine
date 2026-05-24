import { useEffect, useState } from 'react';

// Probe each clip's real playback duration by loading just its metadata.
// Returns { [sceneId]: durationSec }. Until a clip resolves, callers fall back
// to the authored duration so the timeline still lays out.
export function useDurations(scenes) {
  const [durations, setDurations] = useState({});

  useEffect(() => {
    setDurations({});
    if (!scenes || !scenes.length) return;
    let cancelled = false;
    const videos = [];
    for (const scene of scenes) {
      if (!scene.clipUrl) continue;
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.src = scene.clipUrl;
      v.addEventListener('loadedmetadata', () => {
        if (cancelled) return;
        setDurations((d) => ({ ...d, [scene.id]: v.duration }));
      });
      videos.push(v);
    }
    return () => {
      cancelled = true;
      for (const v of videos) { v.removeAttribute('src'); v.load(); }
    };
  }, [scenes]);

  return durations;
}
