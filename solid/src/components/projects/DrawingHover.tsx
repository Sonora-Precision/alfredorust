// Hover preview of a part drawing: after a short pause the PDF opens in a floating panel
// beside the element, so moving the mouse across a table does not load every drawing.
import { type JSX, Show, createSignal, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'

const PREVIEW_W = 560
const PREVIEW_H = 420

export function DrawingHover(props: {
  /** The PDF; without it the children render as they are. */
  url: string | undefined
  label: string
  class?: string
  children: JSX.Element
}): JSX.Element {
  const [pos, setPos] = createSignal<{ top: number; left: number } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const show = (el: HTMLElement) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const r = el.getBoundingClientRect()
      const room = window.innerWidth - r.right
      const left = room > PREVIEW_W + 16 ? r.right + 8 : Math.max(8, r.left - PREVIEW_W - 8)
      const top = Math.min(Math.max(8, r.top - PREVIEW_H / 2), window.innerHeight - PREVIEW_H - 8)
      setPos({ top, left })
    }, 300)
  }
  const hide = () => {
    clearTimeout(timer)
    setPos(null)
  }
  onCleanup(() => clearTimeout(timer))

  return (
    <span
      class={props.class}
      onMouseEnter={(e) => props.url && show(e.currentTarget)}
      onMouseLeave={hide}
    >
      {props.children}
      <Show when={pos() && props.url}>
        {(url) => (
          <Portal>
            <div
              class="pointer-events-none fixed z-50 overflow-hidden rounded-lg border border-border bg-white shadow-2xl"
              style={{
                top: `${pos()!.top}px`,
                left: `${pos()!.left}px`,
                width: `${PREVIEW_W}px`,
                height: `${PREVIEW_H}px`,
              }}
            >
              <iframe
                src={`${url()}#toolbar=0&navpanes=0&view=Fit`}
                title={`Plano de ${props.label}`}
                class="h-full w-full"
              />
            </div>
          </Portal>
        )}
      </Show>
    </span>
  )
}
