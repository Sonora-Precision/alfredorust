// Right-anchored slide-over on Kobalte's Dialog primitive (focus trap +
// presence for free, like Modal). The drawer-content class drives the
// slide-in/out keyframes in styles/app-theme.css off Kobalte's
// data-expanded/data-closed. Pass a `title` for the sticky glass header, or
// omit it and render your own inside `children`.
import { Dialog } from '@kobalte/core/dialog'
import { X } from 'lucide-solid'
import type { JSX, ParentProps } from 'solid-js'
import { Show } from 'solid-js'

import { cn } from '../../lib/cn'

interface DrawerProps extends ParentProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  subtitle?: string
  class?: string
  /** Shown on the rest of the screen, left of the panel (wide screens only): e.g. the
   * part drawing while its material is filled in (Daniel, 2026-11-06). It is part of the
   * dialog, so working in it keeps the drawer open. */
  aside?: JSX.Element
}

export function Drawer(props: DrawerProps): JSX.Element {
  const header = () => (
    <Show when={props.title}>
      <div class="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/90 px-5 py-4 backdrop-blur">
        <div>
          <Dialog.Title class="text-[16px] font-bold leading-tight">{props.title}</Dialog.Title>
          <Show when={props.subtitle}>
            <p class="text-[12px] text-muted-foreground">{props.subtitle}</p>
          </Show>
        </div>
        <Dialog.CloseButton
          class="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Cerrar"
        >
          <X class="h-5 w-5" />
        </Dialog.CloseButton>
      </div>
    </Show>
  )
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <div class="fixed inset-0 z-50 flex justify-end">
          <Show
            when={props.aside}
            fallback={
              <Dialog.Content
                class={cn(
                  'drawer-content flex h-full w-full max-w-[520px] flex-col overflow-y-auto border-l border-border bg-glass shadow-2xl',
                  props.class,
                )}
              >
                {header()}
                {props.children}
              </Dialog.Content>
            }
          >
            <Dialog.Content class={cn('drawer-content flex h-full w-full', props.class)}>
              <div class="hidden h-full min-w-0 flex-1 p-3 md:block">{props.aside}</div>
              <div class="flex h-full w-full max-w-[520px] shrink-0 flex-col overflow-y-auto border-l border-border bg-glass shadow-2xl md:ml-auto">
                {header()}
                {props.children}
              </div>
            </Dialog.Content>
          </Show>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
