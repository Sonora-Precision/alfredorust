import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Inline the entry CSS into a <style> tag instead of a render-blocking
// <link rel="stylesheet">. The bundle is tiny (~10 KB gzip) and single-file, so
// inlining removes the extra blocking round-trip on first paint (Lighthouse
// "render-blocking resources") with no FOUC — the styles arrive in <head> with
// the HTML, before the app's JS renders. Only touches the build output.
function inlineEntryCss(): Plugin {
  return {
    name: 'inline-entry-css',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html
      let out = html
      for (const [fileName, asset] of Object.entries(ctx.bundle)) {
        if (!fileName.endsWith('.css') || asset.type !== 'asset') continue
        const base = fileName.split('/').pop()!
        const linkRe = new RegExp(`<link[^>]*rel="stylesheet"[^>]*href="[^"]*${base}"[^>]*>`)
        if (linkRe.test(out)) {
          out = out.replace(linkRe, `<style>${asset.source}</style>`)
          delete ctx.bundle[fileName] // drop the now-unreferenced .css file
        }
      }
      return out
    },
  }
}

// The Solid SPA is served by Axum at the site root (fallback_service — it's the
// primary front-end). The dev server proxies API/auth routes to the local Axum
// backend so cookies + same-origin fetches behave like production. Tenant
// subdomains still require running against `slug.localhost:8090` (see solid/README).
export default defineConfig({
  base: '/',
  plugins: [solid(), inlineEntryCss()],
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
