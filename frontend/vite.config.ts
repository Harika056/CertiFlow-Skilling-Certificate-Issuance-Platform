import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite proxies to the local API and the mock WhatsApp provider.
// In Docker, nginx does the same job (see nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true },
      '/wa': { target: process.env.WA_URL ?? 'http://localhost:4100', changeOrigin: true, rewrite: (p) => p.replace(/^\/wa/, '') },
    },
  },
});
