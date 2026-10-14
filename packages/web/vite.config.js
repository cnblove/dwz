import { defineConfig } from 'vite';

// 后台由 Worker 的静态资源绑定托管（见 packages/worker/wrangler.toml 的 [assets]），
// 因此产物里不需要 Pages 的 _redirects：SPA 回落由 not_found_handling 负责。
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 产物直接交给 Worker assets，保持扁平便于排查
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
