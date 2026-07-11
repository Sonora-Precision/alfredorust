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

// Preload the body font (IBM Plex Sans 400, latin) so it starts downloading
// with the HTML instead of after the CSS is parsed — trims the font's critical
// path and shortens the swap (LCP/FCP). Only the primary weight is preloaded;
// the rest keep font-display: swap.
function preloadPrimaryFont(): Plugin {
  return {
    name: 'preload-primary-font',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html
      const font = Object.keys(ctx.bundle).find(
        (f) => f.includes('ibm-plex-sans-latin-400-normal') && f.endsWith('.woff2'),
      )
      if (!font) return html
      const tag = `<link rel="preload" href="/${font}" as="font" type="font/woff2" crossorigin>`
      return html.replace('</head>', `    ${tag}\n  </head>`)
    },
  }
}

// The Solid SPA is served by Axum at the site root (fallback_service — it's the
// primary front-end). The dev server proxies API/auth routes to the local Axum
// backend so cookies + same-origin fetches behave like production. Tenant
// subdomains still require running against `slug.localhost:8090` (see solid/README).
export default defineConfig({
  base: '/',
  plugins: [solid(), inlineEntryCss(), preloadPrimaryFont()],
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
