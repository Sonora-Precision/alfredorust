// Helpers for @tanstack/solid-virtual lists.
import { onMount, type Accessor } from 'solid-js'

// Work around a virtualizer measuring a 0×0 viewport: it attaches its
// ResizeObserver during the render pass (when getScrollElement first returns the
// scroll container), before the h-[65vh] box has been laid out, so it caches a
// 0×0 size and never renders any rows. Once layout settles, detach+reattach the
// scroll element so the observer re-measures the real height. Call this right
// after wiring the virtualizer, passing the scrollEl signal getter/setter.
export function remeasureAfterLayout(
  scrollEl: Accessor<HTMLElement | undefined>,
  setScrollEl: (v: HTMLElement | undefined) => void,
): void {
  onMount(() => {
    requestAnimationFrame(() => {
      const el = scrollEl()
      if (el) {
        setScrollEl(undefined)
        setScrollEl(el)
      }
    })
  })
}
