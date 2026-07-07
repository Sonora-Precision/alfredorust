// Light/dark theme handling. Ported from frontend/src/theme.rs. The dark
// "night" palette is the default (see src/index.css); choosing light sets
// `data-theme="light"` on the root <html> element. The choice is persisted in
// localStorage under the SAME key the Leptos app used, so state survives a
// cutover on the same domain/browser.
import { createSignal } from 'solid-js'

const STORAGE_KEY = 'alfredodev-theme'

export type Theme = 'dark' | 'light'

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light'
}

function localStorageSafe(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The persisted choice, defaulting to dark when nothing is stored. */
export function storedTheme(): Theme {
  const raw = localStorageSafe()?.getItem(STORAGE_KEY) ?? null
  return isTheme(raw) ? raw : 'dark'
}

/** Reflect the theme onto <html data-theme>: dark is the default (no attribute). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    root.removeAttribute('data-theme')
  }
}

/** Persist and apply a theme choice. */
export function setTheme(theme: Theme): void {
  localStorageSafe()?.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

export function toggled(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}

// Module-level signal so every consumer (ThemeToggle, anything reading the
// current theme) shares one source of truth, applied once at import time.
const initial = storedTheme()
applyTheme(initial)
const [theme, setThemeSignal] = createSignal<Theme>(initial)

export function useTheme() {
  return theme
}

export function toggleTheme(): void {
  const next = toggled(theme())
  setTheme(next)
  setThemeSignal(next)
}
