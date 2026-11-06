// Under the plant map (Daniel, 2026-11-06): the open projects; pick one and its part numbers
// with pieces still to make show up, each with its drawing. Drag a part onto a machine on the
// map (or onto the open machine's list) to put it in that machine's queue — or tap the part,
// then the machine. Plain DOM: a few dozen cards. No money.
import { createQuery } from '@tanstack/solid-query'
import { GripVertical } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createMemo, createSignal } from 'solid-js'

import { PartDrawingThumb, PartName } from './PartName'
import { placesByPart } from '../projects/PartMachines'
import * as operationsApi from '../../lib/api/operations'
import type { PlantMachine, ProjectStatus } from '../../lib/api/types'

/** dataTransfer type of a part dragged from this tray, so programmers and orders ignore it. */
export const PART_DRAG_TYPE = 'application/x-sp-part'

/** Projects that are ordered and not yet shipped. */
const ON_THE_FLOOR: ProjectStatus[] = ['pedidos', 'orden_de_compra_mandada', 'ingenieria', 'produccion', 'calidad']

const folio = (n?: number | null) => (n ? `OT-${String(n).padStart(4, '0')}` : '')

export interface PickedPart {
  id: string
  name: string
}

export function ProjectPartsTray(props: {
  machines: PlantMachine[]
  canEdit: boolean
  picked: PickedPart | null
  onPick: (part: PickedPart | null) => void
}): JSX.Element {
  const projects = createQuery(() => ({
    queryKey: ['projects', 'list'],
    queryFn: operationsApi.listProjects,
    refetchInterval: 60_000,
  }))
  const statuses = createQuery(() => ({
    queryKey: ['concept-statuses'],
    queryFn: operationsApi.listConceptStatuses,
  }))
  const open = createMemo(() => (projects.data ?? []).filter((p) => ON_THE_FLOOR.includes(p.status)))

  const [projectId, setProjectId] = createSignal<string | null>(null)
  // Only one open project: show it right away.
  createEffect(() => {
    if (!projectId() && open().length === 1) setProjectId(open()[0]!.id)
  })

  const concepts = createQuery(() => ({
    queryKey: ['project-concepts', projectId()],
    queryFn: () => operationsApi.listProjectConcepts(projectId()!),
    enabled: !!projectId(),
    refetchInterval: 60_000,
  }))
  const cancelled = createMemo(() => new Set((statuses.data ?? []).filter((s) => s.is_cancelled).map((s) => s.id)))
  const places = createMemo(() => placesByPart(props.machines))
  const [onlyFree, setOnlyFree] = createSignal(false)
  const left = createMemo(() =>
    (concepts.data ?? [])
      .filter((c) => !cancelled().has(c.status_id) && c.completed_quantity < c.quantity)
      .filter((c) => !onlyFree() || !places().has(c.id))
      .sort((a, b) => (a.work_order_number ?? 0) - (b.work_order_number ?? 0)),
  )

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'
    }`

  return (
    <section class="mt-4 overflow-hidden rounded-xl border border-border bg-card/70">
      <header class="space-y-2 border-b border-border px-4 py-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-base font-semibold text-foreground">Proyectos</h2>
          <Show when={props.canEdit}>
            <p class="text-xs text-muted-foreground">
              Arrastra un número de parte a una máquina del plano, o tócalo y luego toca la máquina.
            </p>
          </Show>
        </div>
        <div class="flex flex-wrap gap-2">
          <For each={open()} fallback={<p class="text-sm text-muted-foreground">No hay proyectos abiertos.</p>}>
            {(p) => (
              <button
                type="button"
                class={chip(projectId() === p.id)}
                onClick={() => {
                  setProjectId(projectId() === p.id ? null : p.id)
                  props.onPick(null)
                }}
              >
                {p.title}
              </button>
            )}
          </For>
        </div>
      </header>

      <Show when={projectId()}>
        <div class="flex items-center justify-between gap-2 px-4 pt-3">
          <p class="text-xs text-muted-foreground">
            {left().length} números de parte con piezas por hacer
          </p>
          <label class="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyFree()} onChange={(e) => setOnlyFree(e.currentTarget.checked)} />
            Solo los que no están en ninguna máquina
          </label>
        </div>
        <ul class="grid max-h-[70vh] gap-2 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-3">
          <For each={left()} fallback={<li class="text-sm text-muted-foreground">Nada pendiente en este proyecto.</li>}>
            {(c) => {
              const at = () => places().get(c.id) ?? []
              const isPicked = () => props.picked?.id === c.id
              return (
                <li
                  draggable={props.canEdit}
                  class={`flex gap-2 rounded-lg border bg-card p-2 text-sm transition-colors ${
                    isPicked() ? 'border-primary ring-2 ring-primary/40' : 'border-border'
                  } ${props.canEdit ? 'cursor-grab select-none' : ''}`}
                  onDragStart={(e) => {
                    e.dataTransfer?.setData(PART_DRAG_TYPE, JSON.stringify({ id: c.id, name: c.name }))
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => props.canEdit && props.onPick(isPicked() ? null : { id: c.id, name: c.name })}
                >
                  <Show when={props.canEdit}>
                    <span class="flex shrink-0 items-center text-muted-foreground">
                      <GripVertical class="h-4 w-4" />
                    </span>
                  </Show>
                  <div class="h-20 w-28 shrink-0 overflow-hidden rounded border border-border">
                    <PartDrawingThumb conceptId={c.id} part={c.name} class="h-full" />
                  </div>
                  <div class="min-w-0 flex-1 space-y-0.5">
                    <p class="truncate">
                      <span class="font-semibold tabular-nums text-foreground">{folio(c.work_order_number)}</span>{' '}
                      <PartName conceptId={c.id} part={c.name} class="text-foreground" />
                    </p>
                    <p class="text-xs text-muted-foreground">
                      {c.completed_quantity.toLocaleString('es-MX')}/{c.quantity.toLocaleString('es-MX')} pzas
                    </p>
                    <For each={at()}>
                      {(p) => (
                        <p class={`truncate text-xs ${p.running ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'}`}>
                          {p.running ? `▶ Corriendo en ${p.machine}` : `#${p.position} en fila de ${p.machine}`}
                          {p.label ? ` · ${p.label}` : ''}
                        </p>
                      )}
                    </For>
                  </div>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </section>
  )
}

/** The part a drop carries, if it came from the tray. */
export function droppedPart(e: DragEvent): PickedPart | null {
  const raw = e.dataTransfer?.getData(PART_DRAG_TYPE)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PickedPart
  } catch {
    return null
  }
}

/** Whether a drag in progress carries a tray part (data is unreadable until the drop). */
export const carriesPart = (e: DragEvent) => !!e.dataTransfer?.types.includes(PART_DRAG_TYPE)
