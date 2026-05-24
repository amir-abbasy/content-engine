import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Studio UI dev server. /api and /media are proxied to the Node API
// (src/studio/server.js) so the browser talks to one origin and video Range
// requests stream straight through.
const API = `http://localhost:${process.env.STUDIO_API_PORT || 5181}`;

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: Number(process.env.STUDIO_WEB_PORT) || 5180,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/media': { target: API, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
