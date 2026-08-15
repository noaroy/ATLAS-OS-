import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The console shares the server's domain types, so a contract change
      // breaks the build rather than surfacing as a runtime surprise.
      '@atlas/contracts': resolve(here, '../../packages/contracts/src/index.ts'),
      '@': resolve(here, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4700', changeOrigin: true, ws: true },
      '/healthz': { target: 'http://localhost:4700', changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(here, '../../dist/console'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
