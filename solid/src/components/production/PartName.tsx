// A part number wherever it appears (board, plant, quality, search): when the part has a
// drawing, hovering shows it and clicking opens it, so nobody has to memorize numbers.
import { createQuery } from '@tanstack/solid-query'
import { FileText } from 'lucide-solid'
import { type JSX, Show, createMemo } from 'solid-js'

import { DrawingHover } from '../projects/DrawingHover'
import { type PartFile, listCompanyPartDrawings } from '../../lib/api/partFiles'

export const PART_DRAWINGS_KEY = ['part-drawings'] as const

/** Newest drawing per part of the company, shared by every PartName on the page. */
function useDrawings() {
  const q = createQuery(() => ({
    queryKey: PART_DRAWINGS_KEY,
    queryFn: listCompanyPartDrawings,
    staleTime: 5 * 60_000,
  }))
  return createMemo(() => new Map<string, PartFile>((q.data ?? []).map((f) => [f.concept_id, f])))
}

export function PartName(props: { conceptId: string; part: string; class?: string }): JSX.Element {
  const drawings = useDrawings()
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
