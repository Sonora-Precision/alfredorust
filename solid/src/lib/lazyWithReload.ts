import { lazy, type Component } from 'solid-js'

// Wrap a route's dynamic import so a failed chunk fetch — the classic "stale
// hashed chunk after a deploy" 404 — triggers a one-time hard reload to pick up
// the fresh build, instead of rendering a blank page. Guarded so it can't loop:
// at most one reload per 10s; if it still fails after that, the error surfaces
// to the nearest ErrorBoundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors solid-js `lazy`'s own signature
export function lazyWithReload<T extends Component<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy<T>(() =>
    factory().catch((err: unknown) => {
      const KEY = 'a4_chunk_reload_at'
      const last = Number(sessionStorage.getItem(KEY) || 0)
      if (Date.now() - last > 10_000) {
        sessionStorage.setItem(KEY, String(Date.now()))
        window.location.reload()
        // Never resolve: nothing should render in the instant before reload.
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    }),
  )
}
