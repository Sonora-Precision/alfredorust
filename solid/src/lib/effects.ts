// Single "visual effects" switch (merges the old motion + axe-preview toggles).
// ON by default = the full space-glass experience (translucent glass, starfield,
// animations). Turning it OFF adds `html.calm`, which makes surfaces opaque,
// hides the starfield and disables motion — a calm / high-contrast / low-power
// mode. `?calm=1` forces it off (used by contrast checks).
import { createSignal } from 'solid-js'

const STORAGE_KEY = 'alfredodev-effects'

function lsSafe(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function initial(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('calm') === '1') return false
  } catch {
    /* ignore */
  }
  const raw = lsSafe()?.getItem(STORAGE_KEY)
  return raw === null ? true : raw === '1' // default ON
}

function apply(on: boolean): void {
  document.documentElement.classList.toggle('calm', !on)
}

const start = initial()
apply(start)
const [effectsOn, setSignal] = createSignal(start)

export function useEffects() {
  return effectsOn
}

/** True when visual effects are OFF (calm mode). Read by motion + charts. */
export function isCalm(): boolean {
  return !effectsOn()
}

export function setEffects(on: boolean): void {
  lsSafe()?.setItem(STORAGE_KEY, on ? '1' : '0')
  apply(on)
  setSignal(on)
}
