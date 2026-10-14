import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Cloudflare Pages 直接托管 dist，产物保持扁平便于排查
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    proxy: {
      // 本地开发时把 API 请求转给 wrangler dev
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true },
      '/open': { target: 'http://127.0.0.1:8788', changeOrigin: true },
    },
  },
});
