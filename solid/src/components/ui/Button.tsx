// Ported 1:1 from frontend/src/components/button.rs.
import type { JSX, ParentProps } from 'solid-js'
import { splitProps } from 'solid-js'

import { cn } from '../../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-muted text-foreground hover:bg-muted/70',
  outline: 'border border-border bg-transparent text-foreground hover:bg-muted',
  ghost: 'bg-transparent text-foreground hover:bg-muted',
}

const BUTTON_BASE =
  'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none disabled:opacity-50'

interface ButtonProps
  extends ParentProps,
    Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant
  class?: string
  /** Defaults to "button" so action buttons inside a form never submit it by accident. */
  type?: 'button' | 'submit' | 'reset'
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ['variant', 'class', 'type', 'children'])
  return (
    <button
      type={local.type ?? 'button'}
      class={cn(BUTTON_BASE, VARIANT_CLASSES[local.variant ?? 'primary'], local.class)}
      {...rest}
    >
      {local.children}
    </button>
  )
}
