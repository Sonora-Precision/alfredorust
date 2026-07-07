// Ported 1:1 from frontend/src/components/checkbox.rs.
import type { JSX } from 'solid-js'

import { cn } from '../../lib/cn'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  class?: string
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  return (
    <label class={cn('inline-flex items-center gap-2 text-sm text-foreground', props.class)}>
      <input
        type="checkbox"
        class="h-4 w-4 rounded border-input"
        checked={props.checked}
        onChange={(ev) => props.onChange(ev.currentTarget.checked)}
      />
      {props.label}
    </label>
  )
}
