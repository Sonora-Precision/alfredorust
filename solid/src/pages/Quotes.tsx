// Cotizaciones — every quote, before and after it becomes a project (Daniel, 2026-11-06).
// Pendientes: no project yet (borrador or enviada); Aprobadas: already a project. Each folio
// shows its latest revision; older revisions open from the document. Admin only: it is money.
import { A } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { Plus } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import * as quotesApi from '../lib/api/quotes'
import type { QuoteView } from '../lib/api/quotes'
import { money } from '../lib/format'

type Filter = 'pendientes' | 'aprobadas' | 'todas'

export default function Quotes(): JSX.Element {
  const quotes = createQuery(() => ({ queryKey: ['quotes'], queryFn: quotesApi.listQuotes }))
  const [filter, setFilter] = createSignal<Filter>('pendientes')
  const [text, setText] = createSignal('')

  // Latest revision of each folio, newest first.
  const latest = createMemo(() => {
    const by = new Map<string, QuoteView>()
    for (const q of quotes.data ?? []) {
      const prev = by.get(q.folio_base)
      if (!prev || q.revision > prev.revision) by.set(q.folio_base, q)
    }
    return [...by.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
  })
  const shown = createMemo(() => {
    const t = text().trim().toLowerCase()
    return latest().filter((q) => {
      if (filter() === 'pendientes' && q.project_id) return false
      if (filter() === 'aprobadas' && !q.project_id) return false
      if (!t) return true
      return [q.folio, q.client_name, q.attention ?? '', ...q.lines.map((l) => l.description)].some((s) => s.toLowerCase().includes(t))
    })
  })
  const count = (f: Filter) => latest().filter((q) => (f === 'todas' ? true : f === 'aprobadas' ? !!q.project_id : !q.project_id)).length

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${active ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`

  return (
    <div class="space-y-4">
      <PageHeader
        title="Cotizaciones"
        breadcrumb={['Cotizaciones']}
        actions={
          <A href="/cotizaciones/nueva">
            <Button>
              <Plus class="h-4 w-4" /> Nueva cotización
            </Button>
          </A>
        }
      />
      <p class="text-sm text-muted-foreground">
        Cotiza aquí antes de que exista el proyecto. Cuando el cliente la apruebe o mande su orden de compra, ábrela y toca
        "Convertir en proyecto": se crea en Pedidos con sus números de parte y precios.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <For each={['pendientes', 'aprobadas', 'todas'] as Filter[]}>
          {(f) => (
            <button type="button" class={chip(filter() === f)} onClick={() => setFilter(f)}>
              {f === 'pendientes' ? 'Pendientes' : f === 'aprobadas' ? 'Ya son proyecto' : 'Todas'} ({count(f)})
            </button>
          )}
        </For>
        <input
          class="h-8 w-56 rounded-lg border border-border bg-background px-2 text-sm"
          placeholder="Buscar folio, cliente o parte…"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </div>

      <Show when={!quotes.isLoading} fallback={<Spinner />}>
        <div class="overflow-x-auto rounded-xl border border-border">
          <table class="w-full min-w-[760px] text-sm">
            <thead class="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th class="px-3 py-2">Folio</th>
                <th class="px-3 py-2">Fecha</th>
                <th class="px-3 py-2">Cliente</th>
                <th class="px-3 py-2 text-right">Partidas</th>
                <th class="px-3 py-2 text-right">Neto</th>
                <th class="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()} fallback={<tr><td colspan={6} class="px-3 py-6 text-center text-muted-foreground">No hay cotizaciones aquí.</td></tr>}>
                {(q) => (
                  <tr class="border-t border-border">
                    <td class="px-3 py-2">
                      <A href={`/cotizaciones/${q.id}`} class="font-semibold tabular-nums text-sky-600 hover:underline">
                        {q.folio}
                      </A>
                    </td>
                    <td class="px-3 py-2 tabular-nums text-muted-foreground">{new Date(q.date).toLocaleDateString('es-MX')}</td>
                    <td class="px-3 py-2">
                      {q.client_name}
                      <Show when={q.attention}>
                        <span class="text-xs text-muted-foreground"> · {q.attention}</span>
                      </Show>
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums">{q.lines.length}</td>
                    <td class="px-3 py-2 text-right tabular-nums">
                      {money(q.net)} <span class="text-xs text-muted-foreground">{q.currency}</span>
                    </td>
                    <td class="px-3 py-2">
                      <Show
                        when={q.project_id}
                        fallback={
                          <span class={`rounded px-1.5 text-[11px] ${q.sent_at ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-muted text-muted-foreground'}`}>
                            {q.sent_at ? 'Enviada' : 'Borrador'}
                          </span>
                        }
                      >
                        <A href={`/projects/${q.project_id}`} class="rounded bg-emerald-500/15 px-1.5 text-[11px] text-emerald-700 hover:underline dark:text-emerald-300">
                          Proyecto: {q.project_title ?? 'abrir'}
                        </A>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  )
}
