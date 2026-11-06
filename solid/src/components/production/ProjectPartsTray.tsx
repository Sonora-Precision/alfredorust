// Under the plant map (Daniel, 2026-11-06): the open projects, each on its own row ("que se
// vea claramente dónde empieza un proyecto y dónde termina"). Tap a project to open it: its
// part numbers with pieces still to make show up inside its own box, each with its drawing.
// Drag a part onto a machine on the map (or onto the open machine's list) to put it in that
// machine's queue — or tap the part, then the machine. Plain DOM: a few dozen cards. No money.
import { createQuery } from '@tanstack/solid-query'
import { ChevronDown, GripVertical } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { PartDrawingThumb, PartName } from './PartName'
import { placesByPart } from '../projects/PartMachines'
import * as operationsApi from '../../lib/api/operations'
import type { PlantMachine, ProjectConcept, ProjectRow, ProjectStatus } from '../../lib/api/types'

/** dataTransfer type of a part dragged from this tray, so programmers and orders ignore it. */
export const PART_DRAG_TYPE = 'application/x-sp-part'

/** Projects that are ordered and not yet shipped. */
const ON_THE_FLOOR: ProjectStatus[] = ['pedidos', 'orden_de_compra_mandada', 'ingenieria', 'produccion', 'calidad']

const folio = (n?: number | null) => (n ? `OT-${String(n).padStart(4, '0')}` : '')

export interface PickedPart {
  id: string
  name: string
}

type Places = ReturnType<typeof placesByPart>

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
  const cancelled = createMemo(() => new Set((statuses.data ?? []).filter((s) => s.is_cancelled).map((s) => s.id)))
  const places = createMemo(() => placesByPart(props.machines))
  const [onlyFree, setOnlyFree] = createSignal(false)
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const toggle = (id: string) => {
    const next = new Set(expanded())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
    props.onPick(null)
  }

  return (
    <section class="mt-4 space-y-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold text-foreground">Proyectos</h2>
        <div class="flex flex-wrap items-center gap-4">
          <Show when={props.canEdit}>
            <p class="text-xs text-muted-foreground">
              Abre un proyecto y arrastra un número de parte a una máquina del plano, o tócalo y luego toca la máquina.
            </p>
          </Show>
          <label class="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyFree()} onChange={(e) => setOnlyFree(e.currentTarget.checked)} />
            Solo los que no están en ninguna máquina
          </label>
        </div>
      </div>
      <For each={open()} fallback={<p class="text-sm text-muted-foreground">No hay proyectos abiertos.</p>}>
        {(p) => (
          <ProjectBlock
            project={p}
            expanded={expanded().has(p.id)}
            onToggle={() => toggle(p.id)}
            cancelled={cancelled()}
            places={places()}
            onlyFree={onlyFree()}
            canEdit={props.canEdit}
            picked={props.picked}
            onPick={props.onPick}
          />
        )}
      </For>
    </section>
  )
}

function ProjectBlock(props: {
  project: ProjectRow
  expanded: boolean
  onToggle: () => void
  cancelled: Set<string>
  places: Places
  onlyFree: boolean
  canEdit: boolean
  picked: PickedPart | null
  onPick: (part: PickedPart | null) => void
}): JSX.Element {
  const concepts = createQuery(() => ({
    queryKey: ['project-concepts', props.project.id],
    queryFn: () => operationsApi.listProjectConcepts(props.project.id),
    refetchInterval: 60_000,
  }))
  const pending = createMemo(() =>
    (concepts.data ?? [])
      .filter((c) => !props.cancelled.has(c.status_id) && c.completed_quantity < c.quantity)
      .sort((a, b) => (a.work_order_number ?? 0) - (b.work_order_number ?? 0)),
  )
  const unassigned = createMemo(() => pending().filter((c) => !props.places.has(c.id)).length)
  const pieces = createMemo(() => pending().reduce((s, c) => s + (c.quantity - c.completed_quantity), 0))
  const shown = createMemo(() => (props.onlyFree ? pending().filter((c) => !props.places.has(c.id)) : pending()))

  return (
    <div
      class={`overflow-hidden rounded-xl border-2 bg-card transition-colors ${
        props.expanded ? 'border-primary/60 shadow-sm' : 'border-border'
      }`}
    >
      <button
        type="button"
        class={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-muted/50 ${
          props.expanded ? 'border-b-2 border-primary/30 bg-primary/5' : ''
        }`}
        aria-expanded={props.expanded}
        onClick={() => props.onToggle()}
      >
        <ChevronDown class={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${props.expanded ? '' : '-rotate-90'}`} />
        <span class="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{props.project.title}</span>
        <Show when={props.project.status_label}>
          <span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{props.project.status_label}</span>
        </Show>
        <Show when={concepts.data} fallback={<span class="text-xs text-muted-foreground">Cargando…</span>}>
          <span class="text-sm tabular-nums text-foreground">
            {pending().length} {pending().length === 1 ? 'número de parte' : 'números de parte'}
            <span class="text-muted-foreground"> · {pieces().toLocaleString('es-MX')} pzas</span>
          </span>
          <Show when={unassigned() > 0}>
            <span class="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              {unassigned()} sin máquina
            </span>
          </Show>
        </Show>
      </button>

      <Show when={props.expanded}>
        <ul class="grid max-h-[70vh] gap-2 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-3">
          <For
            each={shown()}
            fallback={
              <li class="text-sm text-muted-foreground">
                {props.onlyFree && pending().length > 0 ? 'Todo ya está en alguna máquina.' : 'Nada pendiente en este proyecto.'}
              </li>
            }
          >
            {(c) => <PartCard part={c} places={props.places} canEdit={props.canEdit} picked={props.picked} onPick={props.onPick} />}
          </For>
        </ul>
        <p class="border-t border-border px-4 py-1.5 text-right text-[11px] text-muted-foreground">Fin de {props.project.title}</p>
      </Show>
    </div>
  )
}

function PartCard(props: {
  part: ProjectConcept
  places: Places
  canEdit: boolean
  picked: PickedPart | null
  onPick: (part: PickedPart | null) => void
}): JSX.Element {
  const c = () => props.part
  const at = () => props.places.get(c().id) ?? []
  const isPicked = () => props.picked?.id === c().id
  return (
    <li
      draggable={props.canEdit}
      class={`flex gap-2 rounded-lg border bg-background p-2 text-sm transition-colors ${
        isPicked() ? 'border-primary ring-2 ring-primary/40' : 'border-border'
      } ${props.canEdit ? 'cursor-grab select-none' : ''}`}
      onDragStart={(e) => {
        e.dataTransfer?.setData(PART_DRAG_TYPE, JSON.stringify({ id: c().id, name: c().name }))
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => props.canEdit && props.onPick(isPicked() ? null : { id: c().id, name: c().name })}
    >
      <Show when={props.canEdit}>
        <span class="flex shrink-0 items-center text-muted-foreground">
          <GripVertical class="h-4 w-4" />
        </span>
      </Show>
      <div class="h-20 w-28 shrink-0 overflow-hidden rounded border border-border">
        <PartDrawingThumb conceptId={c().id} part={c().name} class="h-full" />
      </div>
      <div class="min-w-0 flex-1 space-y-0.5">
        <p class="truncate">
          <span class="font-semibold tabular-nums text-foreground">{folio(c().work_order_number)}</span>{' '}
          <PartName conceptId={c().id} part={c().name} class="text-foreground" />
        </p>
        <p class="text-xs text-muted-foreground">
          {c().completed_quantity.toLocaleString('es-MX')}/{c().quantity.toLocaleString('es-MX')} pzas
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
