// Clicking a machine in the plant view shows this panel below the map: the part number it runs now and
// what is planned to run next, each with its drawing (Daniel, 2026-11-03: "saber qué
// número de parte se está corriendo y qué es lo que se planea correr a futuro"). The DNC's
// last program is a hint, not the whole story, so what runs is also set by hand: each
// programmer picks the machine they work on and finishes their job there. No money.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowDown, ArrowUp, GripVertical, Play, Plus, Square, X } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js'

import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { PartDrawingThumb, PartName } from './PartName'
import { ProgrammerName } from './ProgrammerPanel'
import { humanizeError } from '../../lib/api/client'
import * as productionApi from '../../lib/api/production'
import type { MachineStatus, PlantMachine } from '../../lib/api/types'

const STATUS_LABEL: Record<MachineStatus, string> = {
  working: 'Trabajando',
  setup: 'En setup',
  stopped: 'Parada',
}

const SOURCE_LABEL: Record<string, string> = {
  dnc: 'monitor DNC',
  movimiento: 'estimado por movimiento',
  manual: 'marcado a mano',
}

const pieces = (o: { completed_quantity: number; quantity: number }) =>
  `${o.completed_quantity.toLocaleString('es-MX')}/${o.quantity.toLocaleString('es-MX')} pzas`

export function MachinePanel(props: {
  machine: PlantMachine | undefined
  /** Programmers and whoever manages the board say what runs and edit the queue. */
  canEdit: boolean
  onClose: () => void
}): JSX.Element {
  const qc = useQueryClient()
  const m = () => props.machine
  const run = createMutation(() => ({
    mutationFn: (v: { fn: () => Promise<void>; done?: string }) => v.fn(),
    onSuccess: (_d, v) => {
      if (v.done) toast.success(v.done)
      void qc.invalidateQueries({ queryKey: ['production'] })
    },
    onError: (err) => toast.error('No se pudo actualizar', humanizeError(err, 'Intenta de nuevo')),
  }))

  // Shown under the plant map, not as a side drawer (Daniel, 2026-11-05): picking another
  // machine swaps the list and brings it into view, the map stays in sight above.
  let box: HTMLElement | undefined
  createEffect(
    on(
      () => m()?.resource_id,
      (id) => {
        if (id) requestAnimationFrame(() => box?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
      },
    ),
  )

  // Changing only the light keeps the order and setup it runs.
  const setStatus = (status: MachineStatus) => {
    const machine = m()!
    const keep = status !== 'stopped' && machine.source === 'manual' ? machine.order : null
    run.mutate({
      fn: () =>
        productionApi.setMachineState(machine.resource_id, {
          status,
          concept_id: keep?.id ?? null,
          label: keep ? machine.label : null,
        }),
    })
  }

  // One list, top to bottom (Daniel, 2026-11-05): first what runs now, then the queue in the
  // order it will run. Drag a queued job to another place, or use the arrows.
  const [dragId, setDragId] = createSignal<string | null>(null)
  const [overAt, setOverAt] = createSignal<number | null>(null)
  const dropAt = (to: number) => {
    const id = dragId()
    setDragId(null)
    setOverAt(null)
    const from = m()?.queue.findIndex((e) => e.id === id) ?? -1
    if (!id || from < 0 || from === to) return
    run.mutate({ fn: () => productionApi.moveQueueEntryTo(id, to) })
  }

  return (
    <Show when={m()}>
      {(machine) => (
        <section ref={box} class="mt-4 scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card/70">
          <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div class="min-w-0">
              <h2 class="truncate text-base font-semibold text-foreground">{machine().name}</h2>
              <p class="text-xs text-muted-foreground">
                {machine().status
                  ? `${STATUS_LABEL[machine().status!]} · ${SOURCE_LABEL[machine().source] ?? 'sin fuente'}`
                  : 'Sin datos'}
                <Show when={machine().program}>
                  {' '}· DNC: último programa {machine().program}
                  <Show when={machine().part_number}> · parte {machine().part_number}</Show>
                </Show>
                <Show when={machine().note}> · Nota: {machine().note}</Show>
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Show when={props.canEdit}>
                <For each={Object.entries(STATUS_LABEL) as [MachineStatus, string][]}>
                  {([status, label]) => (
                    <Button
                      variant={machine().status === status ? 'secondary' : 'outline'}
                      disabled={run.isPending}
                      onClick={() => setStatus(status)}
                    >
                      {label}
                    </Button>
                  )}
                </For>
              </Show>
              <Button variant="ghost" aria-label="Cerrar" onClick={() => props.onClose()}>
                <X class="h-4 w-4" />
              </Button>
            </div>
          </header>

          <ol class="max-h-[75vh] divide-y divide-border overflow-y-auto">
            {/* 1. What runs now. */}
            <li class="flex gap-3 border-l-4 border-emerald-500 bg-emerald-500/5 p-3">
              <Show
                when={machine().order}
                fallback={<p class="py-2 text-sm text-muted-foreground">▶ Nada en producción.</p>}
              >
                {(o) => (
                  <>
                    <div class="h-32 w-44 shrink-0 overflow-hidden rounded-lg border border-border">
                      <PartDrawingThumb conceptId={o().id} part={o().part} class="h-full" />
                    </div>
                    <div class="min-w-0 flex-1 space-y-0.5 text-sm">
                      <p class="text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                        ▶ Corriendo ahora
                      </p>
                      <p class="truncate">
                        <span class="font-semibold tabular-nums text-foreground">{o().folio}</span>{' '}
                        <PartName conceptId={o().id} part={o().part} class="text-foreground" />
                        <Show when={machine().label}>
                          <span class="ml-1 rounded bg-muted px-1.5 text-xs">{machine().label}</span>
                        </Show>
                      </p>
                      <p class="truncate text-xs text-muted-foreground">
                        {o().client ?? o().project} · {pieces(o())}
                      </p>
                      <p class="text-xs text-muted-foreground">
                        <Show when={machine().running_by}>
                          {(p) => <>La puso a correr <ProgrammerName id={p().id} name={p().name} /></>}
                        </Show>
                        <Show when={machine().programmer}>
                          {(p) => <> · programó <ProgrammerName id={p().id} name={p().name} /></>}
                        </Show>
                      </p>
                      <StockAndCuts order={o()} />
                    </div>
                    <Show when={props.canEdit && machine().source === 'manual'}>
                      <div class="shrink-0 self-center">
                        <Button
                          variant="primary"
                          disabled={run.isPending}
                          onClick={() => {
                            if (window.confirm(`¿Terminar el trabajo de ${o().folio} en ${machine().name}?`))
                              run.mutate({
                                fn: () => productionApi.finishMachineJob(machine().resource_id),
                                done: `Trabajo terminado en ${machine().name}`,
                              })
                          }}
                        >
                          <Square class="h-4 w-4" />
                          Terminar trabajo
                        </Button>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
            </li>

            {/* 2..n. The queue, in the order it will run. */}
            <For each={machine().queue}>
              {(e, i) => (
                <li
                  draggable={props.canEdit}
                  class={`flex gap-3 p-3 transition-colors ${dragId() === e.id ? 'opacity-40' : ''} ${
                    overAt() === i() && dragId() !== e.id ? 'bg-primary/10 ring-2 ring-inset ring-primary' : ''
                  }`}
                  onDragStart={(ev) => {
                    setDragId(e.id)
                    ev.dataTransfer?.setData('text/plain', e.id)
                    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(ev) => {
                    if (!dragId()) return
                    ev.preventDefault()
                    setOverAt(i())
                  }}
                  onDragLeave={() => overAt() === i() && setOverAt(null)}
                  onDrop={(ev) => {
                    ev.preventDefault()
                    dropAt(i())
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setOverAt(null)
                  }}
                >
                  <Show when={props.canEdit}>
                    <span class="flex shrink-0 cursor-grab items-center text-muted-foreground" title="Arrastra para cambiar el orden">
                      <GripVertical class="h-5 w-5" />
                    </span>
                  </Show>
                  <div class="h-28 w-40 shrink-0 overflow-hidden rounded-lg border border-border">
                    <PartDrawingThumb conceptId={e.order.id} part={e.order.part} class="h-full" />
                  </div>
                  <div class="min-w-0 flex-1 space-y-0.5 text-sm">
                    <p class="truncate">
                      <span class="mr-1 rounded bg-muted px-1.5 text-xs font-semibold tabular-nums">{i() + 1}</span>
                      <span class="font-semibold tabular-nums text-foreground">{e.order.folio}</span>{' '}
                      <PartName conceptId={e.order.id} part={e.order.part} class="text-foreground" />
                      <Show when={e.label}>
                        <span class="ml-1 rounded bg-muted px-1.5 text-xs">{e.label}</span>
                      </Show>
                    </p>
                    <p class="truncate text-xs text-muted-foreground">
                      {e.order.client ?? e.order.project} · {pieces(e.order)}
                    </p>
                    <StockAndCuts order={e.order} />
                  </div>
                  <Show when={props.canEdit}>
                    <div class="flex shrink-0 flex-col items-end justify-between gap-1">
                      <div class="flex gap-0.5">
                        <Button
                          variant="ghost"
                          aria-label={`Subir ${e.order.folio}`}
                          disabled={run.isPending || i() === 0}
                          onClick={() => run.mutate({ fn: () => productionApi.moveQueueEntry(e.id, true) })}
                        >
                          <ArrowUp class="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`Bajar ${e.order.folio}`}
                          disabled={run.isPending || i() === machine().queue.length - 1}
                          onClick={() => run.mutate({ fn: () => productionApi.moveQueueEntry(e.id, false) })}
                        >
                          <ArrowDown class="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`Quitar ${e.order.folio} de la fila`}
                          disabled={run.isPending}
                          onClick={() => run.mutate({ fn: () => productionApi.removeQueueEntry(e.id) })}
                        >
                          <X class="h-4 w-4" />
                        </Button>
                      </div>
                      <Button
                        variant={i() === 0 ? 'primary' : 'outline'}
                        disabled={run.isPending}
                        onClick={() => {
                          const replacing = machine().order
                          if (
                            replacing &&
                            !window.confirm(`${machine().name} tiene ${replacing.folio} en producción. ¿Cambiar a ${e.order.folio}?`)
                          )
                            return
                          run.mutate({
                            fn: () => productionApi.startQueueEntry(e.id),
                            done: `${e.order.folio} en producción en ${machine().name}`,
                          })
                        }}
                      >
                        <Play class="h-4 w-4" />
                        Pasar a producción
                      </Button>
                    </div>
                  </Show>
                </li>
              )}
            </For>
            <Show when={machine().queue.length === 0}>
              <li class="p-3 text-sm text-muted-foreground">No hay trabajos en fila.</li>
            </Show>
          </ol>

          <Show when={props.canEdit}>
            <div class="border-t border-border p-4">
              <AddJob machine={machine()} busy={run.isPending} onRun={(v) => run.mutate(v)} />
            </div>
          </Show>
        </section>
      )}
    </Show>
  )
}

const inch = (v: number | null | undefined) => (v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.'))

/**
 * What to load for a job, without switching screens (Daniel, 2026-11-04): material, stock
 * (blank) size and, for the saw, the cuts from each assigned bar.
 */
function StockAndCuts(props: { order: NonNullable<PlantMachine['order']> }): JSX.Element {
  const m = () => props.order.material
  const blank = () => {
    const mat = m()
    if (!mat) return ''
    return [mat.thickness, mat.width, mat.length].filter((v) => v != null).map(inch).join('" × ')
  }
  return (
    <Show when={m()}>
      {(mat) => (
        <div class="mt-1 space-y-0.5 text-xs">
          <p class="text-foreground">
            {[mat().material, mat().shape].filter(Boolean).join(' ')}
            <Show when={blank()}>
              {' · '}stock <span class="font-semibold">{blank()}"</span>
            </Show>
          </p>
          <For each={props.order.cuts}>
            {(c) => (
              <p class="text-muted-foreground">
                Barra {[c.thickness, c.width, c.length].filter((v) => v != null).map(inch).join('" × ')}"{' → '}
                <span class="font-semibold text-foreground">
                  {c.cuts} {c.cuts === 1 ? 'corte' : 'cortes'} de {inch(mat().length)}"
                </span>{' '}
                (sobran {inch(c.leftover)}")
              </p>
            )}
          </For>
          <Show when={props.order.cuts.length === 0 && mat().bar_to_order}>
            <p class="text-muted-foreground">Sin barra asignada · se pide {mat().bar_to_order}</p>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Search a part by OT or name and queue it here, or run it right away. */
function AddJob(props: {
  machine: PlantMachine
  busy: boolean
  onRun: (v: { fn: () => Promise<void>; done?: string }) => void
}): JSX.Element {
  const [text, setText] = createSignal('')
  const [query, setQuery] = createSignal('')
  const [label, setLabel] = createSignal('Setup 1')
  createEffect(() => {
    const t = text().trim()
    const handle = setTimeout(() => setQuery(t), 250)
    onCleanup(() => clearTimeout(handle))
  })
  const results = createQuery(() => ({
    queryKey: ['production', 'search', query()],
    queryFn: () => productionApi.searchWorkOrders(query()),
    enabled: query().length > 0,
  }))
  const cleanLabel = () => label().trim() || null

  return (
    <section class="space-y-2">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agregar trabajo</h3>
      <div class="flex gap-2">
        <input
          type="search"
          class="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
          placeholder="OT o número de parte (ej. OT-37, 16587)"
          aria-label="Buscar la parte a agregar"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <input
          class="h-9 w-24 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
          aria-label="Setup u operación"
          placeholder="Setup 1"
          value={label()}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
      </div>
      <Show when={query().length > 0}>
        <ul class="divide-y divide-border rounded-lg border border-border bg-card text-sm">
          <Show when={(results.data?.length ?? 0) === 0}>
            <li class="px-3 py-2 text-xs text-muted-foreground">
              {results.isLoading ? 'Buscando…' : 'Sin resultados.'}
            </li>
          </Show>
          <For each={results.data}>
            {(hit) => (
              <li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span class="min-w-0 truncate">
                  <span class="font-semibold tabular-nums text-foreground">{hit.folio}</span>{' '}
                  <PartName conceptId={hit.id} part={hit.part} class="text-foreground" />
                  <span class="text-xs text-muted-foreground"> · {hit.client ?? hit.project}</span>
                </span>
                <span class="flex gap-1">
                  <Button
                    variant="outline"
                    disabled={props.busy}
                    onClick={() =>
                      props.onRun({
                        fn: () => productionApi.queueOnMachine(props.machine.resource_id, hit.id, cleanLabel()),
                        done: `${hit.folio} en la fila de ${props.machine.name}`,
                      })
                    }
                  >
                    <Plus class="h-4 w-4" />
                    A la fila
                  </Button>
                  <Button
                    variant="primary"
                    disabled={props.busy}
                    onClick={() => {
                      const replacing = props.machine.order
                      if (
                        replacing &&
                        !window.confirm(`${props.machine.name} tiene ${replacing.folio} en producción. ¿Cambiar a ${hit.folio}?`)
                      )
                        return
                      props.onRun({
                        fn: () =>
                          productionApi.setMachineState(props.machine.resource_id, {
                            status: 'working',
                            concept_id: hit.id,
                            label: cleanLabel(),
                          }),
                        done: `${hit.folio} en producción en ${props.machine.name}`,
                      })
                    }}
                  >
                    <Play class="h-4 w-4" />
                    Correr ahora
                  </Button>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
