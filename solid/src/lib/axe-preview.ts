// A/B preview aid: `html.axe-max` swaps the translucent glassmorphism surfaces
// for opaque ones so automated contrast checkers (axe/pa11y) can measure them —
// and so you can eyeball how much the look changes vs. the current glass.
// Persisted in localStorage; also force-enabled with `?axe=1` (used by pa11y).
import { createSignal } from 'solid-js'

const STORAGE_KEY = 'alfredodev-axe-max'

function lsSafe(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function initial(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('axe') === '1') return true
  } catch {
    /* ignore */
  }
  return lsSafe()?.getItem(STORAGE_KEY) === '1'
}

export function applyAxeMax(on: boolean): void {
  document.documentElement.classList.toggle('axe-max', on)
}

const start = initial()
applyAxeMax(start)
const [axeMax, setSignal] = createSignal(start)

export function useAxeMax() {
  return axeMax
}

export function setAxeMax(on: boolean): void {
  lsSafe()?.setItem(STORAGE_KEY, on ? '1' : '0')
  applyAxeMax(on)
  setSignal(on)
}
