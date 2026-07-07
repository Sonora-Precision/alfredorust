// Ported 1:1 from frontend/src/components/select.rs. Controlled native <select>.
import type { JSX, ParentProps } from 'solid-js'
import { splitProps } from 'solid-js'

import { cn } from '../../lib/cn'

const SELECT_BASE =
  'w-full rounded-md border border-input bg-background text-foreground px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30'

interface SelectProps
  extends ParentProps,
    Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  class?: string
}

export function Select(props: SelectProps): JSX.Element {
  const [local, rest] = splitProps(props, ['value', 'onChange', 'class', 'children'])
  return (
    <select
      class={cn(SELECT_BASE, local.class)}
      value={local.value}
      onChange={(ev) => local.onChange(ev.currentTarget.value)}
      {...rest}
    >
      {local.children}
    </select>
  )
}
