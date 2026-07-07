// Accessible tabs on Kobalte's Tabs primitive.
import { Tabs as KTabs } from '@kobalte/core/tabs'
import type { JSX } from 'solid-js'
import { For } from 'solid-js'

import { cn } from '../../lib/cn'

export interface TabItem {
  value: string
  label: string
  content: JSX.Element
}

interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (value: string) => void
  class?: string
}

export function Tabs(props: TabsProps): JSX.Element {
  return (
    <KTabs value={props.value} onChange={props.onChange} class={props.class}>
      <KTabs.List class="flex gap-1 border-b border-border">
        <For each={props.items}>
          {(item) => (
            <KTabs.Trigger
              value={item.value}
              class={cn(
                'px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                'data-[selected]:text-foreground',
              )}
            >
              {item.label}
            </KTabs.Trigger>
          )}
        </For>
        <KTabs.Indicator class="absolute bottom-0 h-0.5 bg-primary transition-all" />
      </KTabs.List>
      <For each={props.items}>
        {(item) => (
          <KTabs.Content value={item.value} class="py-4">
            {item.content}
          </KTabs.Content>
        )}
      </For>
    </KTabs>
  )
}
