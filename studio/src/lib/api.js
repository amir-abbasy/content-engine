// Thin fetch wrappers around the Studio API (proxied to the Node server).
const json = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
};

// A "project" is a flow (flows/<name>) or a legacy timestamped run.
export const fetchProjects = () => json('/api/projects').then((d) => d.projects || []);
export const fetchProject = (id) => json(`/api/projects/${encodeURIComponent(id)}`);
export const fetchPipeline = (projectId) =>
  json(`/api/pipeline${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`);
