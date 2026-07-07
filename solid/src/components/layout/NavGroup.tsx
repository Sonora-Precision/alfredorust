// Collapsible sidebar category. Ported 1:1 from frontend/src/app.rs's
// `NavGroup` — native <details>/<summary>, no JS state needed, chevron
// rotates via the `group-[[open]]:rotate-90` arbitrary-variant selector.
// Open by default (every group starts expanded).
import type { JSX, ParentProps } from 'solid-js'

interface NavGroupProps extends ParentProps {
  title: string
}

export function NavGroup(props: NavGroupProps): JSX.Element {
  return (
    <details open class="group">
      <summary class="mt-3 flex cursor-pointer list-none select-none items-center justify-between rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span>{props.title}</span>
        <svg
          class="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-[[open]]:rotate-90"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M7 5l6 5-6 5" />
        </svg>
      </summary>
      <div class="ml-4 mt-1 space-y-0.5 border-l border-border pl-2">{props.children}</div>
    </details>
  )
}
