import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api':    { target: 'http://localhost:8788', changeOrigin: true },
      '/health': { target: 'http://localhost:8788', changeOrigin: true },
      // Local deploy sidecar (scripts/deploy-server.mjs). Lets the Website
      // module trigger a "Publish to nyyon.com" build + Pages deploy
      // without leaving the ops UI. Same-origin proxy keeps the browser
      // happy (no CORS dance from the sidecar). 8791 — 8790 is taken by
      // OpenWA's control daemon on this machine.
      '/deploy': { target: 'http://localhost:8791', changeOrigin: true },
    },
  },
});
