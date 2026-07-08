// Consistent page header used across the redesigned screens: optional
// breadcrumb (last crumb highlighted), title, subtitle, and a right-aligned
// actions slot. Keeps every page visually aligned as the design rolls out.
import { ChevronRight } from 'lucide-solid'
import { For, Show, type JSX } from 'solid-js'

interface PageHeaderProps {
  title: string
  subtitle?: string
  breadcrumb?: string[]
  actions?: JSX.Element
}

export function PageHeader(props: PageHeaderProps): JSX.Element {
  return (
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <Show when={props.breadcrumb?.length}>
          <div class="flex items-center gap-2 text-[12px] text-muted-foreground">
            <For each={props.breadcrumb}>
              {(crumb, i) => (
                <>
                  <Show when={i() > 0}>
                    <ChevronRight class="h-3.5 w-3.5" />
                  </Show>
                  <span classList={{ 'text-foreground': i() === (props.breadcrumb?.length ?? 0) - 1 }}>{crumb}</span>
                </>
              )}
            </For>
          </div>
        </Show>
        <h1 class="mt-1 text-2xl font-bold tracking-tight">{props.title}</h1>
        <Show when={props.subtitle}>
          <p class="mt-0.5 text-[13px] text-muted-foreground">{props.subtitle}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="flex items-center gap-2">{props.actions}</div>
      </Show>
    </div>
  )
}
