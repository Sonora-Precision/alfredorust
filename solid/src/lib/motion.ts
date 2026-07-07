// Shared helpers for the Fase C animation pass (see
// docs/solid-migration/animation-strategy.md). CSS-driven transitions
// (solid-transition-group class toggles, Kobalte's data-expanded/data-closed
// keyframes) get their reduced-motion guard for free from the global
// `@media (prefers-reduced-motion: reduce)` block in src/index.css — this
// module is for the JS-driven paths (solid-motionone `transition`/`initial`
// props, the KPI count-up tween) that can't rely on a CSS media query alone.
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Snapshot of the user's reduced-motion preference at call time. Not
 * reactive to preference changes mid-session (matches this app's other
 * one-shot environment reads, e.g. lib/theme.ts) — reload picks up changes.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

/**
 * Tweens a numeric signal toward `target()` using requestAnimationFrame +
 * an ease-out curve (solid-motionone/@motionone don't expose spring easing
 * yet, and this needs to interpolate a plain number rather than a DOM
 * property, so it's a small hand-rolled WAAPI-adjacent tween per the
 * strategy doc's guidance for KPI count-up). Jumps straight to the target
 * under prefers-reduced-motion.
 */
export function createCountUp(target: Accessor<number>, durationMs = 600): Accessor<number> {
  const [value, setValue] = createSignal(0)
  let frame: number | undefined

  createEffect(() => {
    const to = target()

    if (prefersReducedMotion()) {
      if (frame !== undefined) cancelAnimationFrame(frame)
      setValue(to)
      return
    }

    const from = untrack(value)
    if (from === to) return

    if (frame !== undefined) cancelAnimationFrame(frame)
    const start = performance.now()

    const tick = (now: number): void => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / durationMs)
      setValue(from + (to - from) * easeOutCubic(t))
      frame = t < 1 ? requestAnimationFrame(tick) : undefined
    }
    frame = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return value
}
