// Ported from frontend/src/components/input.rs, WITH the conscious fix from
// docs/solid-migration/PLAN.md §13: `disabled` is actually wired onto the
// <input> element (the Leptos version has the CSS but never sets the attribute).
import type { JSX } from 'solid-js'
import { splitProps } from 'solid-js'

import { cn } from '../../lib/cn'

const INPUT_BASE =
  'w-full rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50'

interface InputProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onInput'> {
  value: string
  onInput: (value: string) => void
  class?: string
}

export function Input(props: InputProps): JSX.Element {
  const [local, rest] = splitProps(props, ['value', 'onInput', 'class'])
  return (
    <input
      class={cn(INPUT_BASE, local.class)}
      value={local.value}
      onInput={(ev) => local.onInput(ev.currentTarget.value)}
      {...rest}
    />
  )
}
