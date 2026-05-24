// Studio API server — a dependency-free Node http server that backs the Studio
// front-end. Responsibilities:
//   GET  /api/projects        list flows + legacy runs (flows first)
//   GET  /api/projects/:id    full project model (scenes + tracks) for a flow/run
//   GET  /api/pipeline?project=:id  raw pipeline.json the editor round-trips
//   GET  /media/:id/<path>    serve clip/audio files with HTTP Range support
//                             (Range is required for <video> seeking/scrubbing)
//
// Record / export / save endpoints arrive in later phases; this phase is the
// read-only preview + timeline. In dev the Vite server proxies /api and /media
// here; in production it serves the built studio/dist too.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, loadProject, loadPipelineRaw, loadPipelineForProject, resolveMedia } from './assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../../studio/dist');

const PORT = Number(process.env.STUDIO_API_PORT) || 5181;

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

// Stream a file, honouring a Range header so the browser can seek video.
function sendFile(req, res, absPath) {
  const stat = fs.statSync(absPath);
  const type = mimeFor(absPath);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(absPath).pipe(res);
  }
}

function serveStatic(res, absPath) {
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const buf = fs.readFileSync(absPath);
  res.writeHead(200, { 'Content-Type': mimeFor(absPath), 'Content-Length': buf.length });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  try {
    // ── /media/:runId/<...path> — clip + audio streaming ──
    if (parts[0] === 'media' && parts.length >= 3) {
      const abs = resolveMedia(parts[1], parts.slice(2));
      if (!abs) { res.writeHead(404); return res.end('Media not found'); }
      return sendFile(req, res, abs);
    }

    // ── API ──
    if (parts[0] === 'api') {
      // projects list (alias: runs, for any older clients)
      if ((parts[1] === 'projects' || parts[1] === 'runs') && parts.length === 2) {
        return sendJson(res, 200, { projects: listProjects() });
      }
      if ((parts[1] === 'projects' || parts[1] === 'runs') && parts.length === 3) {
        return sendJson(res, 200, loadProject(parts[2]));
      }
      if (parts[1] === 'pipeline' && parts.length === 2) {
        // ?project=<id> reads that flow's pipeline; default = root pipeline.json
        const projectId = url.searchParams.get('project');
        const pipeline = projectId ? loadPipelineForProject(projectId) : loadPipelineRaw();
        if (!pipeline) return sendJson(res, 404, { error: 'pipeline not found' });
        return sendJson(res, 200, pipeline);
      }
      return sendJson(res, 404, { error: `Unknown API route: /${parts.join('/')}` });
    }

    // ── built front-end (production only; dev uses Vite) ──
    if (fs.existsSync(DIST_DIR)) {
      const rel = parts.length ? parts.join(path.sep) : 'index.html';
      const candidate = path.join(DIST_DIR, rel);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return serveStatic(res, candidate);
      return serveStatic(res, path.join(DIST_DIR, 'index.html')); // SPA fallback
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Studio API running. Start the Vite dev server for the UI (npm run studio).');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[studio:api] http://localhost:${PORT}`);
});

export { server, PORT };
