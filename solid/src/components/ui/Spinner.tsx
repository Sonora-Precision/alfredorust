import type { JSX } from 'solid-js'

import { cn } from '../../lib/cn'

interface SpinnerProps {
  class?: string
  label?: string
}

export function Spinner(props: SpinnerProps): JSX.Element {
  return (
    <svg
      class={cn('h-5 w-5 animate-spin text-muted-foreground', props.class)}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={props.label ?? 'Cargando'}
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}
