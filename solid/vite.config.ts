import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// The Solid SPA is served by Axum under /v3 (see docs/solid-migration/PLAN.md
// §3.2), side by side with the existing Leptos SPA at /v2. The dev server
// proxies API/auth routes to the local Axum backend so cookies + same-origin
// fetches behave like production. Tenant subdomains still require running
// against `slug.localhost:8090` (see solid/README).
export default defineConfig({
  base: '/v3/',
  plugins: [solid()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
      '/login': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
      '/logout': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
    },
  },
})
