// Accessible dropdown menu on Kobalte's DropdownMenu primitive.
import { DropdownMenu } from '@kobalte/core/dropdown-menu'
import type { JSX, ParentProps } from 'solid-js'
import { For } from 'solid-js'

import { cn } from '../../lib/cn'

export interface DropdownItem {
  label: string
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

interface DropdownProps extends ParentProps {
  items: DropdownItem[]
  class?: string
}

/** `props.children` is the trigger content (usually a Button). */
export function Dropdown(props: DropdownProps): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger class={cn('inline-flex', props.class)}>
        {props.children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="z-50 min-w-[10rem] overflow-hidden rounded-md border border-border bg-card p-1 text-card-foreground shadow-sm">
          <For each={props.items}>
            {(item) => (
              <DropdownMenu.Item
                class={cn(
                  'cursor-pointer select-none rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  item.destructive && 'text-destructive',
                )}
                disabled={item.disabled}
                onSelect={item.onSelect}
              >
                {item.label}
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
