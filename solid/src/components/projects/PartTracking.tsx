// Shop-floor tracking for a project's part numbers: finished pieces per part, a checklist of the
// company's process operations (✔ / pending / N/A), and the project progress
// (Σ finished ÷ Σ ordered, cancelled parts excluded). Plain DOM: a few hundred cells at most.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Card, CardContent } from '../ui/Card'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../ui/Table'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import {
  createProcessOperation,
  deleteProcessOperation,
  listProcessOperations,
  updatePartProgress,
  updateProcessOperation,
} from '../../lib/api/operations'
import { assignWorkOrder, getPlant, listBoardMembers } from '../../lib/api/production'
import { PartMachines, placesByPart } from './PartMachines'
import { folioOf, matchesWorkOrder } from '../production/WorkOrderSearch'
import { type PartFile, listProjectPartFiles } from '../../lib/api/partFiles'
import { PartDrawing } from './PartDrawing'
import { PartMaterialCell } from './PartMaterialCell'
import { getCutList } from '../../lib/api/material'
import type { ConceptStatusFull, PartProgressPayload, ProcessOperation, ProjectConcept, StepState } from '../../lib/api/types'
import { cn } from '../../lib/cn'

/** The shop's Excel tracking sheet, offered as a starting catalog. */
const DEFAULT_OPERATIONS = [
  'Material',
  'Material habilitado',
  'Programa',
  'Setup 1',
  'Setup 2',
  'Setup 3',
  'Setup 4',
  'Machueleado / Rimado',
  'Rebabeado / Limpieza',
]

const NEXT_STATE: Record<StepState, StepState> = {
  pending: 'done',
  done: 'not_applicable',
  not_applicable: 'pending',
}

const STATE_LABEL: Record<StepState, string> = {
  pending: 'Pendiente',
  done: 'Hecho',
  not_applicable: 'No aplica',
}

const num = (n: number): string => n.toLocaleString('es-MX', { maximumFractionDigits: 2 })
const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`

const fecha = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

function stepState(concept: ProjectConcept, operationId: string): StepState {
  return concept.process_steps.find((s) => s.operation_id === operationId)?.state ?? 'pending'
}

function applyLocally(c: ProjectConcept, p: PartProgressPayload): ProjectConcept {
  let steps = c.process_steps
  if (p.operation_id && p.state) {
    const { operation_id, state } = p
    steps = steps.some((s) => s.operation_id === operation_id)
      ? steps.map((s) => (s.operation_id === operation_id ? { ...s, state } : s))
      : [...steps, { operation_id, name: '', state }]
  }
  return { ...c, completed_quantity: p.completed_quantity ?? c.completed_quantity, process_steps: steps }
}

/** Released by quality: only these count as finished (Daniel, 2026-11-03). */
const releasedOf = (c: ProjectConcept) => c.released_quantity ?? 0
const rejectedOf = (c: ProjectConcept) => c.rejected_quantity ?? 0
/** Produced pieces may range from what quality already saw to the order plus remakes. */
const producedBounds = (c: ProjectConcept) => ({
  min: releasedOf(c) + rejectedOf(c),
  max: c.quantity + rejectedOf(c),
})

/** Done ÷ applicable steps of the active catalog. */
function routeProgress(concept: ProjectConcept, ops: ProcessOperation[]): { done: number; applicable: number } {
  let done = 0
  let applicable = 0
  for (const op of ops) {
    const st = stepState(concept, op.id)
    if (st === 'not_applicable') continue
    applicable++
    if (st === 'done') done++
  }
  return { done, applicable }
}

function Bar(props: { ratio: number; class?: string }): JSX.Element {
  return (
    <div class={cn('h-2 w-full overflow-hidden rounded-full bg-muted', props.class)}>
      <div
        class={cn('h-full rounded-full transition-[width] duration-300', props.ratio >= 1 ? 'bg-emerald-500' : 'bg-primary')}
        style={{ width: `${Math.min(100, Math.max(0, props.ratio * 100))}%` }}
      />
    </div>
  )
}

interface PartTrackingProps {
  projectId: string
  concepts: ProjectConcept[]
  statuses: ConceptStatusFull[]
  /** Tick steps and finished pieces (programmers and admins). */
  canEdit: boolean
  /** Which parts this user may tick; programmers only their own. Default: all. */
  canTick?: (concept: ProjectConcept) => boolean
  /** Add, rename or remove the company's process steps (admins only). */
  canConfigure: boolean
  /** Show who holds each part (needs the production-board permission). */
  canSeeAssignees: boolean
  /** Assign or change who holds each part (whoever manages the board). */
  canAssign: boolean
  /** Upload, replace or remove part drawings (admins only). */
  canUploadFiles: boolean
}

export function PartTracking(props: PartTrackingProps): JSX.Element {
  const qc = useQueryClient()

  const opsQuery = createQuery(() => ({
    queryKey: ['process-operations'],
    queryFn: listProcessOperations,
  }))
  const activeOps = createMemo(() => (opsQuery.data ?? []).filter((o) => o.is_active))

  // Names of the people who can hold orders, to show who has each part.
  const membersQuery = createQuery(() => ({
    queryKey: ['production', 'members'],
    queryFn: listBoardMembers,
    enabled: props.canSeeAssignees,
  }))
  const nameOf = createMemo(() => {
    const names = new Map<string, string>()
    for (const m of membersQuery.data ?? []) names.set(m.id, m.name)
    return names
  })
  /** Id of who holds the part's current (first pending) step, else its last held step. */
  const holderIdOf = (concept: ProjectConcept): string | null => {
    // Same rule as the board: only steps that belong to a queue (Programa, …) are held;
    // "Material" and the like have no holder.
    const current = activeOps().find((op) => op.queue && stepState(concept, op.id) === 'pending')
    const step = current
      ? concept.process_steps.find((s) => s.operation_id === current.id && s.assignee_user_id)
      : [...concept.process_steps].reverse().find((s) => s.assignee_user_id)
    return step?.assignee_user_id ?? null
  }
  const holderOf = (concept: ProjectConcept): string | null => {
    const id = holderIdOf(concept)
    return id ? (nameOf().get(id) ?? 'Asignado') : null
  }

  // Assigning here is the same as on the board: it sets who holds the current step.
  const assignMutation = createMutation(() => ({
    mutationFn: (v: { id: string; userId: string | null }) => assignWorkOrder(v.id, v.userId),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      void qc.invalidateQueries({ queryKey: ['production'] })
      const name = v.userId ? nameOf().get(v.userId) : null
      toast.success(name ? `Asignado a ${name}` : 'Asignación quitada')
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      toast.error(
        'No se pudo asignar',
        humanizeError(err, 'Solo se asignan partes con un paso pendiente en un proyecto abierto.'),
      )
    },
  }))

  const cancelledIds = createMemo(() => new Set(props.statuses.filter((s) => s.is_cancelled).map((s) => s.id)))
  const counted = createMemo(() => props.concepts.filter((c) => !cancelledIds().has(c.status_id)))

  const totals = createMemo(() => {
    let ordered = 0
    let finished = 0
    let stepsDone = 0
    let stepsApplicable = 0
    let partsDone = 0
    for (const c of counted()) {
      ordered += c.quantity
      finished += releasedOf(c)
      if (releasedOf(c) >= c.quantity) partsDone++
      const r = routeProgress(c, activeOps())
      stepsDone += r.done
      stepsApplicable += r.applicable
    }
    return { ordered, finished, stepsDone, stepsApplicable, partsDone, parts: counted().length }
  })

  // Show the change at once, then replace the row with what the server stored (no 40-row refetch).
  const conceptsKey = () => ['project-concepts', props.projectId]
  const replaceConcept = (id: string, next: (c: ProjectConcept) => ProjectConcept) =>
    qc.setQueryData<ProjectConcept[]>(conceptsKey(), (old) => (old ?? []).map((c) => (c.id === id ? next(c) : c)))

  const progressMutation = createMutation(() => ({
    mutationFn: (v: { id: string; payload: PartProgressPayload }) => updatePartProgress(v.id, v.payload),
    onMutate: (v: { id: string; payload: PartProgressPayload }) => {
      const before = qc.getQueryData<ProjectConcept[]>(conceptsKey())?.find((c) => c.id === v.id)
      replaceConcept(v.id, (c) => applyLocally(c, v.payload))
      return { before }
    },
    onSuccess: (updated) => replaceConcept(updated.id, () => updated),
    onError: (err, v, context) => {
      const before = context?.before
      if (before) replaceConcept(v.id, () => before)
      toast.error('No se pudo guardar el avance', humanizeError(err, ''))
    },
  }))

  const tickable = (concept: ProjectConcept) =>
    props.canEdit && (props.canTick ? props.canTick(concept) : true)

  /** Steps still pending; pieces can only go up once this is empty (server enforces it). */
  const pendingSteps = (concept: ProjectConcept) =>
    activeOps()
      .filter((op) => stepState(concept, op.id) === 'pending')
      .map((op) => op.name)

  const toggleStep = (concept: ProjectConcept, op: ProcessOperation) => {
    if (!tickable(concept)) return
    progressMutation.mutate({
      id: concept.id,
      payload: { operation_id: op.id, state: NEXT_STATE[stepState(concept, op.id)] },
    })
  }

  const setFinished = (concept: ProjectConcept, value: number) => {
    const { min, max } = producedBounds(concept)
    const v = Math.min(max, Math.max(min, value))
    if (v === concept.completed_quantity) return
    progressMutation.mutate({ id: concept.id, payload: { completed_quantity: v } })
  }

  const [configOpen, setConfigOpen] = createSignal(false)
  // Newest PDF drawing per part.
  const filesQuery = createQuery(() => ({
    queryKey: ['part-files', props.projectId],
    queryFn: () => listProjectPartFiles(props.projectId),
  }))
  const drawingOf = createMemo(() => {
    const map = new Map<string, PartFile>()
    for (const f of filesQuery.data ?? []) {
      if (f.kind === 'drawing' && !map.has(f.concept_id)) map.set(f.concept_id, f)
    }
    return map
  })
  // Each part's row in the saw's cut list ("Pasar a corte" / place in the queue).
  const cutQuery = createQuery(() => ({ queryKey: ['cut-list'], queryFn: getCutList }))
  const cutOf = createMemo(() => new Map((cutQuery.data ?? []).map((i) => [i.concept_id, i])))
  // Machines: where each part runs or waits, and "Asignar a máquina".
  const plantQuery = createQuery(() => ({
    queryKey: ['production', 'plant'],
    queryFn: getPlant,
    enabled: props.canEdit,
    refetchInterval: 60_000,
  }))
  const machines = () => plantQuery.data?.machines ?? []
  const placesOf = createMemo(() => placesByPart(machines()))

  const [filter, setFilter] = createSignal('')
  const visibleConcepts = createMemo(() =>
    props.concepts.filter((c) => matchesWorkOrder({ folio: folioOf(c.work_order_number), part: c.name }, filter())),
  )

  return (
    <div class="space-y-4">
      <Card glass>
        <CardContent class="space-y-3 py-4">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p class="text-xs text-muted-foreground">Avance del proyecto (piezas liberadas por calidad)</p>
              <p class="tnum text-3xl font-semibold text-foreground">
                {totals().ordered > 0 ? pct(totals().finished / totals().ordered) : '—'}
              </p>
            </div>
            <div class="tnum text-right text-sm text-muted-foreground">
              <p>
                <span class="font-semibold text-foreground">{num(totals().finished)}</span> de {num(totals().ordered)} piezas liberadas
              </p>
              <p>
                {totals().partsDone} de {totals().parts} números de parte completos
              </p>
              <Show when={activeOps().length > 0}>
                <p>
                  Pasos de proceso: {totals().stepsDone} de {totals().stepsApplicable}
                </p>
              </Show>
            </div>
          </div>
          <Bar ratio={totals().ordered > 0 ? totals().finished / totals().ordered : 0} class="h-3" />
        </CardContent>
      </Card>

      <Show when={!opsQuery.isLoading && activeOps().length === 0}>
        <Card glass>
          <CardContent class="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
            <span class="text-muted-foreground">
              Aún no hay pasos de proceso configurados para el checklist.
            </span>
            <Show when={props.canConfigure}>
              <Button variant="outline" onClick={() => setConfigOpen(true)}>
                Configurar pasos
              </Button>
            </Show>
          </CardContent>
        </Card>
      </Show>

      <Card glass>
        <div class="flex items-center justify-between gap-2 px-4 pt-3 text-xs text-muted-foreground">
          <span>
            <Show when={props.canEdit} fallback="Solo lectura.">
              Clic en una casilla: pendiente → ✔ hecho → N/A → pendiente. Piezas: escribe el
              total o +N / −N.
              <Show when={props.canTick}> Solo puedes palomear tus números de parte.</Show>
            </Show>
          </span>
          <Show when={props.canConfigure && activeOps().length > 0}>
            <Button variant="ghost" class="px-2 py-1 text-xs" onClick={() => setConfigOpen(true)}>
              Configurar pasos
            </Button>
          </Show>
        </div>
        <div class="px-4 pt-2">
          <Input
            type="search"
            value={filter()}
            onInput={setFilter}
            placeholder="Filtrar por OT o nombre del item (ej. OT-12, 4471)"
            aria-label="Filtrar números de parte"
          />
        </div>
        <div class="overflow-x-auto">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell class="sticky left-0 z-10 bg-card">Número de parte</TableHeadCell>
                <Show when={props.canSeeAssignees}>
                  <TableHeadCell>Asignado a</TableHeadCell>
                </Show>
                <For each={activeOps()}>{(op) => (
                  <TableHeadCell class="px-1 text-center">
                    <span class="block max-w-[5.5rem] whitespace-normal text-[11px] leading-tight" title={op.name}>
                      {op.name}
                    </span>
                  </TableHeadCell>
                )}</For>
                <TableHeadCell class="text-center">Producidas / liberadas</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <Show when={filter() && visibleConcepts().length === 0}>
                <TableRow>
                  <TableCell class="text-sm text-muted-foreground">Ningún número de parte coincide.</TableCell>
                </TableRow>
              </Show>
              <For each={visibleConcepts()}>{(c) => {
                const cancelled = () => cancelledIds().has(c.status_id)
                const ratio = () => (c.quantity > 0 ? releasedOf(c) / c.quantity : 0)
                return (
                  <TableRow class={cn(cancelled() && 'opacity-50')}>
                    <TableCell class="sticky left-0 z-10 bg-card">
                      <p class="font-medium text-foreground">{c.name}</p>
                      <Show when={c.work_order_number != null}>
                        <p class="tnum text-xs text-muted-foreground">{folioOf(c.work_order_number)}</p>
                      </Show>
                      <PartDrawing
                        projectId={props.projectId}
                        conceptId={c.id}
                        partName={c.name}
                        file={drawingOf().get(c.id)}
                        canUpload={props.canUploadFiles}
                      />
                      <PartMaterialCell
                        conceptId={c.id}
                        partName={c.name}
                        projectId={props.projectId}
                        material={c.material}
                        pieces={c.quantity}
                        status={c.material_status}
                        canEdit={props.canEdit && !cancelled()}
                        cut={cutOf().get(c.id)}
                      />
                      <PartMachines
                        conceptId={c.id}
                        partName={c.name}
                        places={placesOf().get(c.id) ?? []}
                        machines={machines()}
                        canEdit={props.canEdit && !cancelled()}
                      />
                      <Show when={c.description}>
                        <p class="max-w-[16rem] truncate text-xs text-muted-foreground" title={c.description ?? ''}>
                          {c.description}
                        </p>
                      </Show>
                    </TableCell>
                    <Show when={props.canSeeAssignees}>
                      <TableCell class="whitespace-nowrap text-sm">
                        <Show
                          when={props.canAssign}
                          fallback={
                            <Show
                              when={holderOf(c)}
                              fallback={<span class="text-xs text-amber-600">Libre</span>}
                            >
                              {(name) => <span class="font-medium text-foreground">{name()}</span>}
                            </Show>
                          }
                        >
                          <label class="sr-only" for={`assign-part-${c.id}`}>
                            Asignar {c.name}
                          </label>
                          {/* `selected` per option: a select-level value applies before <For> renders. */}
                          <select
                            id={`assign-part-${c.id}`}
                            class="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                            disabled={assignMutation.isPending}
                            onChange={(e) =>
                              assignMutation.mutate({ id: c.id, userId: e.currentTarget.value || null })
                            }
                          >
                            <option value="" selected={!holderIdOf(c)}>
                              Libre
                            </option>
                            <For each={membersQuery.data ?? []}>
                              {(m) => (
                                <option value={m.id} selected={holderIdOf(c) === m.id}>
                                  {m.name}
                                </option>
                              )}
                            </For>
                          </select>
                        </Show>
                      </TableCell>
                    </Show>
                    <For each={activeOps()}>{(op) => (
                      <TableCell class="px-1 text-center">
                        <StepCell
                          concept={c}
                          op={op}
                          canEdit={tickable(c)}
                          onToggle={() => toggleStep(c, op)}
                        />
                      </TableCell>
                    )}</For>
                    <TableCell class="text-center">
                      <PiecesCell
                        concept={c}
                        canEdit={tickable(c)}
                        pending={pendingSteps(c)}
                        onCommit={(v) => setFinished(c, v)}
                      />
                      <div class="mt-1 flex items-center gap-2">
                        <Bar ratio={ratio()} />
                        <span class="tnum w-10 text-right text-xs text-muted-foreground">{pct(ratio())}</span>
                      </div>
                      <p class="tnum mt-0.5 text-[11px] text-muted-foreground">
                        ✔ {num(releasedOf(c))} liberadas
                        <Show when={rejectedOf(c) > 0}>
                          {' · '}
                          <span class="text-rose-500">✖ {num(rejectedOf(c))} rechazadas</span>
                        </Show>
                        <Show when={c.completed_quantity - releasedOf(c) - rejectedOf(c) > 0}>
                          {' · '}
                          <span class="text-amber-600">
                            {num(c.completed_quantity - releasedOf(c) - rejectedOf(c))} en liberación
                          </span>
                        </Show>
                      </p>
                    </TableCell>
                  </TableRow>
                )
              }}</For>
            </TableBody>
          </Table>
        </div>
      </Card>

      <ProcessOperationsModal open={configOpen()} onOpenChange={setConfigOpen} operations={opsQuery.data ?? []} />
    </div>
  )
}

function StepCell(props: {
  concept: ProjectConcept
  op: ProcessOperation
  canEdit: boolean
  onToggle: () => void
}): JSX.Element {
  const step = () => props.concept.process_steps.find((s) => s.operation_id === props.op.id)
  const state = (): StepState => step()?.state ?? 'pending'
  const title = () => {
    const s = step()
    const who = s?.updated_by ? `\n${s.updated_by} · ${fecha(s.updated_at)}` : ''
    return `${props.op.name}: ${STATE_LABEL[state()]}${who}`
  }
  return (
    <button
      type="button"
      title={title()}
      aria-label={title()}
      disabled={!props.canEdit}
      onClick={() => props.onToggle()}
      class={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-semibold transition-colors',
        'disabled:cursor-default',
        state() === 'done' && 'border-emerald-500 bg-emerald-500 text-white',
        state() === 'not_applicable' && 'border-border bg-muted text-muted-foreground',
        state() === 'pending' && 'border-input bg-background text-transparent',
        props.canEdit && state() === 'pending' && 'hover:border-emerald-400',
      )}
    >
      {state() === 'done' ? '✔' : state() === 'not_applicable' ? 'N/A' : '·'}
    </button>
  )
}

function PiecesCell(props: {
  concept: ProjectConcept
  canEdit: boolean
  /** Steps not yet ✔ or N/A: while any remain, pieces can only go down. */
  pending: string[]
  onCommit: (value: number) => void
}): JSX.Element {
  const blocked = () => props.pending.length > 0
  const [draft, setDraft] = createSignal<string | null>(null)
  // Type the total ("10,000") or a change ("+250", "-5"); thousands separators are
  // ignored and the result stays between 0 and the pieces ordered.
  const commit = () => {
    const d = draft()?.trim()
    setDraft(null)
    if (!d) return
    const relative = d.startsWith('+') || d.startsWith('-')
    const v = Number.parseFloat(d.replace(/[\s,]/g, ''))
    if (Number.isNaN(v)) return
    const total = relative ? props.concept.completed_quantity + v : v
    const { min, max } = producedBounds(props.concept)
    const clamped = Math.min(Math.max(total, min), max)
    if (clamped > props.concept.completed_quantity && blocked()) {
      toast.error(
        'Aún no se pueden registrar piezas',
        `Marca todos los pasos ✔ o N/A. Faltan: ${props.pending.join(', ')}`,
      )
      return
    }
    if (clamped !== props.concept.completed_quantity) props.onCommit(clamped)
  }
  return (
    <div class="tnum inline-flex items-center gap-1 whitespace-nowrap text-sm">
      <Show
        when={props.canEdit}
        fallback={<span class="font-medium text-foreground">{num(props.concept.completed_quantity)}</span>}
      >
        <button
          type="button"
          class="h-7 w-7 rounded-md border border-input text-muted-foreground hover:bg-muted disabled:opacity-40"
          disabled={props.concept.completed_quantity <= producedBounds(props.concept).min}
          aria-label="Una pieza menos"
          onClick={() => props.onCommit(props.concept.completed_quantity - 1)}
        >
          −
        </button>
        <Input
          class="h-7 w-20 px-1 py-0 text-center"
          inputmode="decimal"
          title='Escribe el total (ej. 10,000) o suma/resta (ej. +250, -5) y presiona Enter'
          value={draft() ?? num(props.concept.completed_quantity)}
          onInput={setDraft}
          onFocus={(ev) => ev.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') ev.currentTarget.blur()
            if (ev.key === 'Escape') {
              setDraft(null)
              ev.currentTarget.blur()
            }
          }}
          aria-label={`Piezas terminadas de ${props.concept.name}`}
        />
        <button
          type="button"
          class="h-7 w-7 rounded-md border border-input text-muted-foreground hover:bg-muted disabled:opacity-40"
          disabled={blocked() || props.concept.completed_quantity >= producedBounds(props.concept).max}
          title={blocked() ? `Faltan pasos: ${props.pending.join(', ')}` : undefined}
          aria-label="Una pieza más"
          onClick={() => props.onCommit(props.concept.completed_quantity + 1)}
        >
          +
        </button>
      </Show>
      <span class="text-muted-foreground">/ {num(props.concept.quantity)}</span>
      <Show when={props.canEdit && blocked()}>
        <span class="text-[11px] text-amber-600" title={`Faltan: ${props.pending.join(', ')}`}>
          ⚠
        </span>
      </Show>
    </div>
  )
}

function ProcessOperationsModal(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  operations: ProcessOperation[]
}): JSX.Element {
  const qc = useQueryClient()
  const [newName, setNewName] = createSignal('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['process-operations'] })
  const nextPosition = () => Math.max(0, ...props.operations.map((o) => o.position)) + 1

  const createMut = createMutation(() => ({
    mutationFn: (names: string[]) =>
      names.reduce<Promise<unknown>>(
        (p, name, i) => p.then(() => createProcessOperation({ name, position: nextPosition() + i, is_active: true })),
        Promise.resolve(),
      ),
    onSuccess: () => {
      setNewName('')
      void refresh()
    },
    onError: (err) => toast.error('No se pudo agregar el paso', humanizeError(err, '')),
  }))

  const updateMut = createMutation(() => ({
    mutationFn: (op: ProcessOperation) =>
      updateProcessOperation(op.id, { name: op.name, position: op.position, is_active: op.is_active }),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error('No se pudo guardar el paso', humanizeError(err, '')),
  }))

  const deleteMut = createMutation(() => ({
    mutationFn: (id: string) => deleteProcessOperation(id),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error('No se pudo eliminar el paso', humanizeError(err, '')),
  }))

  // Swap positions with the neighbour; positions may repeat, so renumber the pair explicitly.
  const move = (index: number, delta: number) => {
    const list = props.operations
    const a = list[index]
    const b = list[index + delta]
    if (!a || !b) return
    const pa = index + 1
    const pb = index + delta + 1
    updateMut.mutate({ ...a, position: pb })
    updateMut.mutate({ ...b, position: pa })
  }

  const add = (ev: SubmitEvent) => {
    ev.preventDefault()
    const name = newName().trim()
    if (name) createMut.mutate([name])
  }

  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title="Pasos del proceso">
      <div class="space-y-4">
        <p class="text-sm text-muted-foreground">
          Son las casillas de cada número de parte, en este orden. Al renombrar o quitar un paso, lo que ya se marcó en
          las piezas se conserva.
        </p>

        <Show when={props.operations.length === 0}>
          <Button variant="outline" disabled={createMut.isPending} onClick={() => createMut.mutate(DEFAULT_OPERATIONS)}>
            Usar los pasos de la hoja de seguimiento ({DEFAULT_OPERATIONS.length})
          </Button>
        </Show>

        <ul class="divide-y divide-border rounded-md border border-border">
          <For each={props.operations}>{(op, i) => (
            <OperationRow
              op={op}
              first={i() === 0}
              last={i() === props.operations.length - 1}
              onMove={(d) => move(i(), d)}
              onSave={(patch) => updateMut.mutate({ ...op, ...patch })}
              onDelete={() => deleteMut.mutate(op.id)}
            />
          )}</For>
        </ul>

        <form onSubmit={add} class="flex gap-2">
          <Input value={newName()} onInput={setNewName} placeholder="Nuevo paso, p. ej. Inspección" />
          <Button type="submit" disabled={createMut.isPending || newName().trim() === ''}>
            Agregar
          </Button>
        </form>
      </div>
    </Modal>
  )
}

function OperationRow(props: {
  op: ProcessOperation
  first: boolean
  last: boolean
  onMove: (delta: number) => void
  onSave: (patch: Partial<ProcessOperation>) => void
  onDelete: () => void
}): JSX.Element {
  // Draft of the name; a rename refetches the list and remounts the row with the new value.
  // eslint-disable-next-line solid/reactivity
  const [name, setName] = createSignal(props.op.name)
  const commitName = () => {
    const n = name().trim()
    if (n && n !== props.op.name) props.onSave({ name: n })
    else setName(props.op.name)
  }
  return (
    <li class={cn('flex items-center gap-2 px-2 py-1.5', !props.op.is_active && 'opacity-60')}>
      <div class="flex flex-col">
        <button type="button" class="px-1 text-xs text-muted-foreground disabled:opacity-30" disabled={props.first} aria-label="Subir" onClick={() => props.onMove(-1)}>
          ▲
        </button>
        <button type="button" class="px-1 text-xs text-muted-foreground disabled:opacity-30" disabled={props.last} aria-label="Bajar" onClick={() => props.onMove(1)}>
          ▼
        </button>
      </div>
      <Input class="h-8 py-1" value={name()} onInput={setName} onBlur={commitName} onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()} />
      <label class="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
        <input type="checkbox" checked={props.op.is_active} onChange={(ev) => props.onSave({ is_active: ev.currentTarget.checked })} />
        Activo
      </label>
      <Button variant="ghost" class="px-2 py-1 text-xs text-destructive hover:bg-destructive/10" onClick={() => props.onDelete()}>
        Quitar
      </Button>
    </li>
  )
}
