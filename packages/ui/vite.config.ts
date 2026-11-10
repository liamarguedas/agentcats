import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// `pnpm dev` runs a mock daemon here; the Vite dev server proxies /api to it.
const DEV_DAEMON = process.env['AGENTCATS_DEV_DAEMON'] ?? 'http://127.0.0.1:4545';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@agentcats/source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: DEV_DAEMON,
        ws: true,
        changeOrigin: true,
        // The daemon only accepts its own Origin, so present the proxied request as same-origin.
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.setHeader('origin', DEV_DAEMON));
          proxy.on('proxyReqWs', (req) => req.setHeader('origin', DEV_DAEMON));
        },
      },
    },
  },
});
