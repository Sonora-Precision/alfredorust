// Accessible modal/dialog on Kobalte's Dialog primitive, styled with the
// design-system tokens (Card look: rounded-xl border bg-card shadow-sm).
import { Dialog } from '@kobalte/core/dialog'
import type { JSX, ParentProps } from 'solid-js'
import { Show } from 'solid-js'

import { cn } from '../../lib/cn'

interface ModalProps extends ParentProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  class?: string
}

export function Modal(props: ModalProps): JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        {/* modal-overlay/modal-content classes drive the fade/scale keyframes
            in index.css, keyed off Kobalte's own data-expanded/data-closed
            presence tracking (see the comment there for why these must be
            @keyframes, not plain CSS transitions). */}
        <Dialog.Overlay class="modal-overlay fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content
            class={cn(
              'modal-content w-full max-w-lg rounded-xl border border-border bg-card text-card-foreground shadow-sm',
              props.class,
            )}
          >
            <Show when={props.title}>
              <div class="flex items-center justify-between border-b border-border p-6 pb-4">
                <Dialog.Title class="text-lg font-semibold leading-none tracking-tight">
                  {props.title}
                </Dialog.Title>
                <Dialog.CloseButton
                  class="text-muted-foreground hover:text-foreground"
                  aria-label="Cerrar"
                >
                  ✕
                </Dialog.CloseButton>
              </div>
            </Show>
            <div class="p-6 pt-4">{props.children}</div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
