// Part-number search for every screen where orders are assigned or taken: "¿dónde va esta
// parte?". Searches all part numbers of the company (on the board or not) as you type —
// partial and any case, by part or folio — and shows who has it, its step, queue, place
// and pieces. `onQuery` lets the screen also filter its own list. No money.
import { createQuery } from '@tanstack/solid-query'
import { Search, X } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createSignal, onCleanup } from 'solid-js'

import * as productionApi from '../../lib/api/production'
import type { WorkOrderSearchHit } from '../../lib/api/types'

const QUEUE_LABEL: Record<string, string> = {
  programming: 'Programación',
  setup: 'Setup',
  machining: 'Máquina',
  finishing: 'Acabado',
}

/** OT-0058 for 58. */
export function folioOf(n: number | null | undefined): string {
  return n == null ? 'OT-?' : `OT-${String(n).padStart(4, '0')}`
}

/**
 * Same rule as the server: partial match on folio or item name, any case. A folio may be
 * typed short: "OT-58", "ot58", "#58" or "58" all find OT-0058.
 */
export function matchesWorkOrder(o: { folio: string; part: string }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '' || o.folio.toLowerCase().includes(q) || o.part.toLowerCase().includes(q)) return true
  const bare = q.replace(/^ot/, '').replace(/^[-\s#]+/, '')
  return /^\d+$/.test(bare) && o.folio.toLowerCase() === folioOf(Number(bare)).toLowerCase()
}

export function WorkOrderSearch(props: {
  onQuery?: (q: string) => void
  placeholder?: string
}): JSX.Element {
  const [text, setText] = createSignal('')
  const [query, setQuery] = createSignal('')

  // Debounce so typing "CH-4471" sends one request, not seven.
  createEffect(() => {
    const t = text()
    props.onQuery?.(t)
    const handle = setTimeout(() => setQuery(t.trim()), 250)
    onCleanup(() => clearTimeout(handle))
  })

  const results = createQuery(() => ({
    queryKey: ['production', 'search', query()],
    queryFn: () => productionApi.searchWorkOrders(query()),
    enabled: query().length > 0,
  }))

  return (
    <div class="space-y-2">
      <div class="relative">
        <Search class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          type="search"
          class="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm text-foreground"
          placeholder={props.placeholder ?? 'Buscar por OT o nombre del item (ej. OT-12, 4471)'}
          aria-label="Buscar número de parte"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <Show when={text()}>
          <button
            type="button"
            class="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
            aria-label="Limpiar búsqueda"
            onClick={() => setText('')}
          >
            <X class="h-4 w-4" />
          </button>
        </Show>
      </div>
      <Show when={query().length > 0}>
        <div class="rounded-lg border border-border bg-card p-2 text-sm">
          <Show
            when={(results.data?.length ?? 0) > 0}
            fallback={
              <p class="px-1 text-xs text-muted-foreground">
                {results.isLoading ? 'Buscando…' : 'Sin resultados.'}
              </p>
            }
          >
            <ul class="divide-y divide-border">
              <For each={results.data}>{(hit) => <SearchHitRow hit={hit} />}</For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function SearchHitRow(props: { hit: WorkOrderSearchHit }): JSX.Element {
  const h = () => props.hit
  return (
    <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-1 py-1.5">
      <div class="min-w-0">
        <p class="truncate">
          <span class="font-semibold tabular-nums text-foreground">{h().folio}</span>{' '}
          <span class="text-foreground">{h().part}</span>
        </p>
        <p class="truncate text-xs text-muted-foreground">
          {h().project}
          <Show when={h().client}> · {h().client}</Show>
        </p>
      </div>
      <div class="text-right text-xs">
        <p class="font-medium text-foreground">{h().assignee ? h().assignee!.name : 'Libre'}</p>
        <p class="text-muted-foreground">
          {h().status_label}
          <Show when={h().queue}>
            {' · '}
            {QUEUE_LABEL[h().queue!] ?? h().queue} #{h().position}
          </Show>
          {' · '}
          {h().released_quantity.toLocaleString('es-MX')}/{h().quantity.toLocaleString('es-MX')} pzas liberadas
        </p>
        <p class="text-muted-foreground">
          {h().completed_quantity.toLocaleString('es-MX')} producidas
          <Show when={h().awaiting_release > 0}>
            {' · '}
            <span class="text-amber-600">{h().awaiting_release.toLocaleString('es-MX')} en liberación</span>
          </Show>
          <Show when={h().rejected_quantity > 0}> · ✖ {h().rejected_quantity.toLocaleString('es-MX')} rechazadas</Show>
        </p>
      </div>
    </li>
  )
}
