// A project's PO and quote as small links in the projects list (Daniel, 2026-11-09): open
// them without going into the project. Admin only: they carry prices.
import { FileText } from 'lucide-solid'
import { type JSX, For, Show } from 'solid-js'

import type { ProjectDocument } from '../../lib/api/projectDocuments'

const SHORT: Record<string, string> = { orden_compra: 'PO', cotizacion: 'Cotización', otro: 'Doc' }
const ORDER: Record<string, number> = { orden_compra: 0, cotizacion: 1, otro: 2 }
const tone = (k: string) =>
  k === 'orden_compra'
    ? 'border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10'
    : k === 'cotizacion'
      ? 'border-sky-500/40 text-sky-500 hover:bg-sky-500/10'
      : 'border-border text-muted-foreground hover:bg-muted'

export function ProjectDocLinks(props: { docs: ProjectDocument[] | undefined }): JSX.Element {
  const sorted = () => [...(props.docs ?? [])].sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))
  return (
    <Show when={sorted().length}>
      <span class="inline-flex flex-wrap gap-1">
        <For each={sorted()}>
          {(d) => (
            <a
              href={d.url}
              target="_blank"
              rel="noopener"
              title={d.filename}
              class={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${tone(d.kind)}`}
              onClick={(e) => e.stopPropagation()}
            >
              <FileText class="h-3 w-3" />
              {SHORT[d.kind] ?? 'Doc'}
            </a>
          )}
        </For>
      </span>
    </Show>
  )
}
