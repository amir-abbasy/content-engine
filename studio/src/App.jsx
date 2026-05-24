import React, { useEffect, useMemo, useState } from 'react';
import { fetchProjects, fetchProject } from './lib/api.js';
import { buildSegments } from './lib/format.js';
import { useDurations } from './lib/useDurations.js';
import { usePlayer } from './lib/usePlayer.js';
import TopBar from './components/TopBar.jsx';
import Player from './components/Player.jsx';
import Timeline from './components/Timeline.jsx';
import Inspector from './components/Inspector.jsx';

export default function App() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // { track, sceneId, event }

  // Load the project list; default to the first one that has a rendered video,
  // else the first project (so an unrecorded flow still opens for inspection).
  useEffect(() => {
    fetchProjects()
      .then((ps) => {
        setProjects(ps);
        const def = ps.find((p) => p.hasVideo) || ps[0];
        if (def) setProjectId(def.id);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Load the selected project's model.
  useEffect(() => {
    if (!projectId) return;
    setProject(null);
    setSelected(null);
    fetchProject(projectId).then(setProject).catch((e) => setError(e.message));
  }, [projectId]);

  const scenes = project ? project.scenes : [];
  const durations = useDurations(scenes);
  const { segments, total } = useMemo(() => buildSegments(scenes, durations), [scenes, durations]);
  const player = usePlayer(segments);

  return (
    <div className="studio">
      <TopBar
        projects={projects}
        projectId={projectId}
        onSelectProject={setProjectId}
        project={project}
        total={total}
      />
      {error && <div className="banner error">⚠ {error}</div>}
      <div className="main">
        <div className="left">
          <Timeline
            segments={segments}
            total={total}
            player={player}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
        <div className="right">
          <Player project={project} segments={segments} total={total} player={player} />
        </div>
      </div>
      <Inspector selected={selected} project={project} />
    </div>
  );
}
