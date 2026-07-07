// Generic accessible accordion on Kobalte's Accordion primitive (used for
// content sections; the Sidebar's NavGroup uses native <details> instead —
// see components/layout/NavGroup.tsx — since that one needs no JS state).
import { Accordion as KAccordion } from '@kobalte/core/accordion'
import type { JSX } from 'solid-js'
import { For } from 'solid-js'

export interface AccordionItem {
  value: string
  title: string
  content: JSX.Element
}

interface AccordionProps {
  items: AccordionItem[]
  multiple?: boolean
  class?: string
}

export function Accordion(props: AccordionProps): JSX.Element {
  return (
    <KAccordion multiple={props.multiple ?? false} class={props.class}>
      <For each={props.items}>
        {(item) => (
          <KAccordion.Item value={item.value} class="border-b border-border">
            <KAccordion.Header>
              <KAccordion.Trigger class="flex w-full items-center justify-between py-3 text-sm font-medium text-foreground [&[data-expanded]>svg]:rotate-90">
                {item.title}
                <svg
                  class="h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M7 5l6 5-6 5" />
                </svg>
              </KAccordion.Trigger>
            </KAccordion.Header>
            <KAccordion.Content class="pb-3 text-sm text-muted-foreground">
              {item.content}
            </KAccordion.Content>
          </KAccordion.Item>
        )}
      </For>
    </KAccordion>
  )
}
