// Toast notifications on Kobalte's imperative `toaster` + `Toast.Region`.
// Mount <Toaster /> once near the app root (see src/App.tsx); call the
// `toast` helpers from anywhere (pages, mutations' onError/onSuccess).
import { Toast as KToast, toaster } from '@kobalte/core/toast'
import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

import { cn } from '../../lib/cn'

export type ToastTone = 'success' | 'error' | 'info'

const TONE_CLASSES: Record<ToastTone, string> = {
  success: 'border-emerald-500/30 bg-emerald-500/10',
  error: 'border-destructive/30 bg-destructive/10',
  info: 'border-sky-500/30 bg-sky-500/10',
}

function show(tone: ToastTone, title: string, description?: string): void {
  toaster.show((props) => (
    <KToast
      toastId={props.toastId}
      class={cn(
        // toast-item drives the slide+fade keyframes in index.css, keyed off
        // Kobalte's data-opened/data-closed presence tracking (same
        // animationend-only mechanism as Modal — see index.css comment).
        'toast-item flex w-full items-start gap-2 rounded-md border bg-card p-3 text-sm text-card-foreground shadow-sm ring-1 ring-border',
        TONE_CLASSES[tone],
      )}
    >
      <div class="flex-1">
        <KToast.Title class="font-semibold">{title}</KToast.Title>
        <Show when={description}>
          <KToast.Description class="text-muted-foreground">{description}</KToast.Description>
        </Show>
      </div>
      <KToast.CloseButton class="text-muted-foreground hover:text-foreground" aria-label="Cerrar">
        ✕
      </KToast.CloseButton>
    </KToast>
  ))
}

export const toast = {
  success: (title: string, description?: string) => show('success', title, description),
  error: (title: string, description?: string) => show('error', title, description),
  info: (title: string, description?: string) => show('info', title, description),
}

/** Mount once near the app root — hosts the toast viewport. */
export function Toaster(): JSX.Element {
  return (
    <KToast.Region duration={5000} swipeDirection="right">
      <KToast.List class="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2 outline-none" />
    </KToast.Region>
  )
}
