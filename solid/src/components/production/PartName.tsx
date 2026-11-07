// A part number wherever it appears (board, plant, quality, search): when the part has a
// drawing, hovering shows it and clicking opens it, so nobody has to memorize numbers.
import { createQuery } from '@tanstack/solid-query'
import { FileText } from 'lucide-solid'
import { type JSX, Show, createMemo } from 'solid-js'

import { DrawingHover } from '../projects/DrawingHover'
import { type PartFile, listCompanyPartDrawings } from '../../lib/api/partFiles'

export const PART_DRAWINGS_KEY = ['part-drawings'] as const

/** Newest drawing per part of the company, shared by every PartName on the page. */
export function usePartDrawings() {
  const q = createQuery(() => ({
    queryKey: PART_DRAWINGS_KEY,
    queryFn: listCompanyPartDrawings,
    staleTime: 5 * 60_000,
  }))
  return createMemo(() => new Map<string, PartFile>((q.data ?? []).map((f) => [f.concept_id, f])))
}

/** The drawing of a part as a small preview; click opens the full PDF. */
export function PartDrawingThumb(props: { conceptId: string; part: string; class?: string }): JSX.Element {
  const drawings = usePartDrawings()
  const file = () => drawings().get(props.conceptId)
  return (
    <Show
      when={file()}
      fallback={<p class="px-3 py-6 text-center text-xs text-muted-foreground">Sin plano</p>}
    >
      {(f) => (
        <a
          href={f().url}
          target="_blank"
          rel="noopener"
          class={`relative block bg-white ${props.class ?? 'h-56'}`}
          title={`Abrir plano de ${props.part}`}
        >
          {/* The iframe ignores the mouse so a click lands on the link and opens the full PDF. */}
          <iframe
            src={`${f().url}#toolbar=0&navpanes=0&view=Fit`}
            title={`Plano de ${props.part}`}
            loading="lazy"
            class="pointer-events-none h-full w-full"
          />
        </a>
      )}
    </Show>
  )
}

export function PartName(props: { conceptId: string; part: string; class?: string }): JSX.Element {
  const drawings = usePartDrawings()
  const file = () => drawings().get(props.conceptId)
  return (
    <Show when={file()} fallback={<span class={props.class}>{props.part}</span>}>
      {(f) => (
        <DrawingHover url={f().url} label={props.part} class={props.class}>
          <a
            href={f().url}
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-0.5 underline decoration-sky-500/50 decoration-dotted underline-offset-2 hover:text-sky-600"
            onClick={(e) => e.stopPropagation()}
          >
            {props.part}
            <FileText class="h-3 w-3 shrink-0 text-sky-600" aria-label="Tiene plano" />
          </a>
        </DrawingHover>
      )}
    </Show>
  )
}

/** The drawing of a part filling its box, with the PDF viewer's zoom, beside a form that
 * takes measures from it (Daniel, 2026-11-06). */
export function PartDrawingPanel(props: { conceptId: string; part: string }): JSX.Element {
  const drawings = usePartDrawings()
  const file = () => drawings().get(props.conceptId)
  return (
    <div class="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm">
        <span class="inline-flex min-w-0 items-center gap-2 font-semibold text-foreground">
          <FileText class="h-4 w-4 shrink-0" />
          <span class="truncate">Plano · {props.part}</span>
        </span>
        <Show when={file()}>
          {(f) => (
            <a href={f().url} target="_blank" rel="noopener" class="shrink-0 text-xs text-sky-600 hover:underline">
              Abrir en otra pestaña
            </a>
          )}
        </Show>
      </div>
      <Show
        when={file()}
        fallback={
          <div class="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
            Esta parte todavía no tiene plano. Súbelo desde Seguimiento (Plano).
          </div>
        }
      >
        {(f) => <iframe src={`${f().url}#navpanes=0&view=Fit`} title={`Plano de ${props.part}`} class="h-full w-full flex-1 bg-white" />}
      </Show>
    </div>
  )
}
