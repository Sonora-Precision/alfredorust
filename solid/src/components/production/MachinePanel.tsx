// Clicking a machine in the plant view opens this panel: the part number it runs now and
// what is planned to run next, each with its drawing (Daniel, 2026-11-03: "saber qué
// número de parte se está corriendo y qué es lo que se planea correr a futuro"). The DNC's
// last program is a hint, not the whole story, so what runs is also set by hand: each
// programmer picks the machine they work on and finishes their job there. No money.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowDown, ArrowUp, Play, Plus, Square, X } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createSignal, onCleanup } from 'solid-js'

import { Button } from '../ui/Button'
import { Drawer } from '../ui/Drawer'
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

  return (
    <Drawer
      open={props.machine !== undefined}
      onOpenChange={(open) => !open && props.onClose()}
      title={m()?.name ?? 'Máquina'}
      subtitle={
        m()?.status
          ? `${STATUS_LABEL[m()!.status!]} · ${SOURCE_LABEL[m()!.source] ?? 'sin fuente'}`
          : 'Sin datos'
      }
    >
      <Show when={m()}>
        {(machine) => (
          <div class="space-y-5 p-4">
            <section class="space-y-2">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Corriendo ahora</h3>
              <Show
                when={machine().order}
                fallback={<p class="text-sm text-muted-foreground">Nada en producción.</p>}
              >
                {(o) => (
                  <div class="overflow-hidden rounded-xl border-2 border-emerald-500/60 bg-card">
                    <div class="space-y-0.5 px-3 py-2 text-sm">
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
                    <PartDrawingThumb conceptId={o().id} part={o().part} class="h-56 border-t border-border" />
                  </div>
                )}
              </Show>
              <Show when={machine().program}>
                <p class="text-xs text-muted-foreground">
                  DNC: último programa {machine().program}
                  <Show when={machine().part_number}> · parte {machine().part_number}</Show>
                </p>
              </Show>
              <Show when={machine().note}>
                <p class="text-xs text-muted-foreground">Nota: {machine().note}</p>
              </Show>
              <Show when={props.canEdit}>
                <div class="flex flex-wrap gap-2 pt-1">
                  <Show when={machine().order && machine().source === 'manual'}>
                    <Button
                      variant="primary"
                      disabled={run.isPending}
                      onClick={() => {
                        if (window.confirm(`¿Terminar el trabajo de ${machine().order!.folio} en ${machine().name}?`))
                          run.mutate({
                            fn: () => productionApi.finishMachineJob(machine().resource_id),
                            done: `Trabajo terminado en ${machine().name}`,
                          })
                      }}
                    >
                      <Square class="h-4 w-4" />
                      Terminar trabajo
                    </Button>
                  </Show>
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
                </div>
              </Show>
            </section>

            <section class="space-y-2">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Lo que sigue ({machine().queue.length})
              </h3>
              <Show when={machine().queue.length === 0}>
                <p class="text-sm text-muted-foreground">No hay trabajos en fila.</p>
              </Show>
              <For each={machine().queue}>
                {(e, i) => (
                  <div class="overflow-hidden rounded-xl border border-border bg-card">
                    <div class="flex items-start justify-between gap-2 px-3 py-2 text-sm">
                      <div class="min-w-0">
                        <p class="truncate">
                          <span class="mr-1 text-xs text-muted-foreground">{i() + 1}.</span>
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
                        <div class="flex shrink-0 gap-0.5">
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
                      </Show>
                    </div>
                    <PartDrawingThumb conceptId={e.order.id} part={e.order.part} class="h-40 border-t border-border" />
                    <Show when={props.canEdit}>
                      <div class="border-t border-border px-3 py-2">
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
                  </div>
                )}
              </For>
            </section>

            <Show when={props.canEdit}>
              <AddJob machine={machine()} busy={run.isPending} onRun={(v) => run.mutate(v)} />
            </Show>
          </div>
        )}
      </Show>
    </Drawer>
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
