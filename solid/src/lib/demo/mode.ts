// Demo mode: a fully client-side, read-only sandbox that never talks to the
// server. Activated on the `demo.` subdomain (demo.alfredorivera.dev) so the
// same SPA build doubles as a public product tour — and, being unauthenticated,
// lets Lighthouse/PageSpeed audit real pages without credentials.
//
// When on, lib/api/client.ts short-circuits every request: GETs return hardcoded
// fixtures (lib/demo/data.ts), mutations no-op with a friendly toast, and
// `/api/me` returns a fake admin so RequireAuth passes with no real session.

let cached: boolean | null = null

/** True when the app is running as the public read-only demo. Memoized. */
export function isDemo(): boolean {
  if (cached !== null) return cached
  if (typeof window === 'undefined') {
    cached = false
    return cached
  }
  const host = window.location.hostname
  // `demo.alfredorivera.dev` in prod; `demo.localhost` or `?demo=1` for local dev.
  const byHost = host === 'demo.localhost' || host.startsWith('demo.')
  const byQuery = new URLSearchParams(window.location.search).get('demo') === '1'
  if (byQuery) {
    try {
      sessionStorage.setItem('demo', '1')
    } catch {
      /* private mode — fall back to host/query detection */
    }
  }
  let bySession = false
  try {
    bySession = sessionStorage.getItem('demo') === '1'
  } catch {
    bySession = false
  }
  cached = byHost || byQuery || bySession
  return cached
}
