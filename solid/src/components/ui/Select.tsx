// Ported 1:1 from frontend/src/components/select.rs. Controlled native <select>.
import type { JSX, ParentProps } from 'solid-js'
import { createEffect, splitProps } from 'solid-js'

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
  let el!: HTMLSelectElement
  // A native <select> silently drops its value when the matching <option> isn't
  // in the DOM yet — e.g. options loaded async from a query, or the value set
  // (edit form) before the options mount. The declarative `value` below covers
  // the common case; this effect re-applies it whenever EITHER the value or the
  // option set changes, so edit forms reliably pre-select category/account/etc.
  createEffect(() => {
    const v = local.value ?? ''
    void local.children // track option changes
    if (el && el.value !== v) el.value = v
  })
  return (
    <select
      ref={el}
      class={cn(SELECT_BASE, local.class)}
      value={local.value}
      onChange={(ev) => local.onChange(ev.currentTarget.value)}
      {...rest}
    >
      {local.children}
    </select>
  )
}
