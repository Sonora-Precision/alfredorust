// Reactive CSS media-query matcher. Used to render EITHER the desktop table or
// the mobile cards (not both) so a virtualized long list keeps only one
// structure in the DOM.
import { createSignal, onCleanup } from 'solid-js'

export function useMediaQuery(query: string): () => boolean {
  const mql = typeof window !== 'undefined' ? window.matchMedia(query) : null
  const [matches, setMatches] = createSignal(mql ? mql.matches : false)
  if (mql) {
    const on = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', on)
    onCleanup(() => mql.removeEventListener('change', on))
  }
  return matches
}
