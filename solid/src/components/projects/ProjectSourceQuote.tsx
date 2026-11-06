// The quote a project came from (Daniel, 2026-11-06): quotes live in Cotizaciones, before
// the project; the project only links back to them. Admin only: it is money.
import { A } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { FileText } from 'lucide-solid'
import { type JSX, For, Show, createMemo } from 'solid-js'

import * as quotesApi from '../../lib/api/quotes'

export function ProjectSourceQuote(props: { projectId: string }): JSX.Element {
  const quotes = createQuery(() => ({
    queryKey: ['project-quotes', props.projectId],
    queryFn: () => quotesApi.listProjectQuotes(props.projectId),
  }))
  // Latest revision of each folio.
  const latest = createMemo(() => {
    const by = new Map<string, quotesApi.QuoteView>()
    for (const q of quotes.data ?? []) {
      const prev = by.get(q.folio_base)
      if (!prev || q.revision > prev.revision) by.set(q.folio_base, q)
    }
    return [...by.values()]
  })
  return (
    <Show when={latest().length > 0}>
      <p class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <FileText class="h-4 w-4" /> Cotización:
        <For each={latest()}>
          {(q) => (
            <A href={`/cotizaciones/${q.id}`} class="font-semibold tabular-nums text-sky-600 hover:underline">
              {q.folio}
            </A>
          )}
        </For>
      </p>
    </Show>
  )
}
