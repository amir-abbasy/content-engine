import React from 'react';
import { fmtTime } from '../lib/format.js';

// Top bar: flow/project picker + summary. Flows (flows/<name>) are listed first,
// then legacy timestamped runs. Record / Export / Preset are stubbed here
// (wired in later phases) so the layout is final.
export default function TopBar({ projects, projectId, onSelectProject, project, total }) {
  const flows = projects.filter((p) => p.kind === 'flow');
  const runs = projects.filter((p) => p.kind === 'run');
  const opt = (p) => (
    <option key={p.id} value={p.id}>
      {p.label} · {p.sceneCount} scenes{p.hasVideo ? '' : ' · not recorded'}
    </option>
  );

  return (
    <header className="topbar">
      <div className="brand">◐ Content Engine <span>Studio</span></div>

      <label className="field">
        <span>Flow</span>
        <select value={projectId || ''} onChange={(e) => onSelectProject(e.target.value)}>
          {projects.length === 0 && <option value="">no flows found</option>}
          {flows.length > 0 && <optgroup label="Flows">{flows.map(opt)}</optgroup>}
          {runs.length > 0 && <optgroup label="Legacy runs">{runs.map(opt)}</optgroup>}
        </select>
      </label>

      {project && (
        <div className="meta">
          <span className={`kind kind-${project.kind}`}>{project.kind}</span>
          <span>{project.pipelineName}</span>
          <span className="dot">·</span>
          <span className="path" title={project.pipelinePath}>{project.pipelinePath}</span>
          <span className="dot">·</span>
          <span>{project.resolution.width}×{project.resolution.height}@{project.fps}</span>
          <span className="dot">·</span>
          <span>{project.scenes.length} scenes · {fmtTime(total)}</span>
          {!project.recorded && <span className="warn-pill">planned — not recorded</span>}
        </div>
      )}

      <div className="spacer" />

      <div className="actions">
        <button className="btn" disabled title="Phase 2">⏺ Record</button>
        <select className="btn" disabled title="Phase 4">
          <option>Instagram Reel</option>
          <option>TikTok</option>
        </select>
        <button className="btn primary" disabled title="Phase 4">⬆ Export</button>
      </div>
    </header>
  );
}
