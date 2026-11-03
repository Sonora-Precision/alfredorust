// Vista de planta — the shop drawn from above with the real layout (design §9 of
// openspec/changes/add-production-board). Each machine shows a traffic light (DNC run or a
// state set by hand), the order it runs and who programmed it. On the side, programmers
// with their load and the pending orders: drag an order onto a person (or tap the order,
// then the person) to assign it. A few dozen shapes, so SVG + DOM (CLAUDE.md rendering
// guide). Never shows money.
import { A } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowLeft } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { WeeklyPiecesCard } from '../components/production/WeeklyPiecesCard'
import { WorkOrderSearch, matchesWorkOrder } from '../components/production/WorkOrderSearch'

import { Badge, type BadgeTone } from '../components/ui/Badge'
import { Card, CardContent } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as productionApi from '../lib/api/production'
import type {
  BoardMemberLoad,
  MachineStatus,
  PlacedMachine,
  PlantMachine,
  WorkOrder,
} from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { PartName } from '../components/production/PartName'
import { ProgrammerDrawer } from '../components/production/ProgrammerPanel'
import { MachinePanel } from '../components/production/MachinePanel'

const REFRESH_MS = 30_000
const LOAD_LIMIT = 5

const STATUS_COLOR: Record<MachineStatus, string> = {
  working: '#639922',
  setup: '#EF9F27',
  stopped: '#E24B4A',
}
const UNKNOWN_COLOR = '#888780'

const STATUS_LABEL: Record<MachineStatus, string> = {
  working: 'Trabajando',
  setup: 'En setup',
  stopped: 'Parada',
}

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')

function sinceLabel(iso: string | null): string {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} días`
}

function loadTone(count: number): BadgeTone {
  if (count === 0) return 'warning'
  if (count >= LOAD_LIMIT) return 'danger'
  return 'success'
}

export default function Plant(): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()
  const canManage = () => auth.isAdmin() || auth.hasPermission('manage_production_board')
  // Programmers pick the machine they work on and say what runs there (Daniel, 2026-11-03).
  const canEditMachines = () => canManage() || auth.hasPermission('take_work_orders')

  const plantQuery = createQuery(() => ({
    queryKey: ['production', 'plant'],
    queryFn: productionApi.getPlant,
    refetchInterval: REFRESH_MS,
  }))
  const boardQuery = createQuery(() => ({
    queryKey: ['production', 'board', 'programming'],
    queryFn: () => productionApi.listWorkOrders('programming'),
    refetchInterval: REFRESH_MS,
  }))
  const membersQuery = createQuery(() => ({
    queryKey: ['production', 'members'],
    queryFn: productionApi.listBoardMembers,
    refetchInterval: REFRESH_MS,
  }))

  const machines = createMemo(() => {
    const byId = new Map<string, PlantMachine>()
    for (const m of plantQuery.data?.machines ?? []) byId.set(m.resource_id, m)
    return byId
  })
  const [query, setQuery] = createSignal('')
  const pending = createMemo(() =>
    (boardQuery.data ?? []).filter((o) => !o.assignee && matchesWorkOrder(o, query())),
  )

  // Assigning: drag an order onto a person, or tap the order and then the person.
  const [picked, setPicked] = createSignal<string | null>(null)
  const [dropTarget, setDropTarget] = createSignal<string | null>(null)
  // Programmer whose parts and drawings are open in the side panel.
  const [panelFor, setPanelFor] = createSignal<string | null>(null)
  const [selectedMachine, setSelectedMachine] = createSignal<string | null>(null)

  const refresh = () => void qc.invalidateQueries({ queryKey: ['production'] })
  const run = createMutation(() => ({
    mutationFn: (fn: () => Promise<void>) => fn(),
    onSuccess: refresh,
    onError: (err) => {
      toast.error('No se pudo actualizar', humanizeError(err, 'Intenta de nuevo'))
      refresh()
    },
  }))

  const assign = (orderId: string, member: BoardMemberLoad) => {
    const order = pending().find((o) => o.id === orderId)
    setPicked(null)
    setDropTarget(null)
    run.mutate(() => productionApi.assignWorkOrder(orderId, member.id))
    if (order) toast.success(`${order.folio} → ${member.name}`)
  }

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="Vista de planta" subtitle="Se actualiza cada 30 s" />
        <A
          href="/produccion"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <ArrowLeft class="h-4 w-4" />
          Cola de programación
        </A>
      </div>

      <WeeklyPiecesCard compact />

      <Show when={plantQuery.isLoading}>
        <div class="flex justify-center py-10">
          <Spinner />
        </div>
      </Show>

      <Show when={plantQuery.data}>
        {(plant) => (
          <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <Card glass glow={false}>
              <CardContent class="p-3">
                <Show
                  when={plant().layout}
                  fallback={
                    <p class="p-4 text-sm text-muted-foreground">
                      Todavía no hay un plano del taller para esta empresa. El administrador lo
                      carga una vez con las paredes y la posición de cada máquina.
                    </p>
                  }
                >
                  {(layout) => (
                    <svg
                      viewBox={`0 0 ${layout().width} ${layout().height}`}
                      class="h-auto w-full"
                      role="img"
                      aria-label="Plano del taller con el estado de cada máquina"
                    >
                      <polygon
                        points={layout().walls.map((p) => p.join(',')).join(' ')}
                        fill="hsl(var(--muted) / 0.35)"
                        stroke="hsl(var(--foreground) / 0.6)"
                        stroke-width="3"
                        stroke-linejoin="round"
                      />
                      <For each={layout().rooms}>
                        {(room) => (
                          <polyline
                            points={room.map((p) => p.join(',')).join(' ')}
                            fill="none"
                            stroke="hsl(var(--foreground) / 0.6)"
                            stroke-width="2"
                          />
                        )}
                      </For>
                      <For each={layout().labels}>
                        {(l) => (
                          <text
                            x={l.x}
                            y={l.y}
                            text-anchor="middle"
                            font-size="12"
                            fill="hsl(var(--muted-foreground))"
                          >
                            {l.text}
                          </text>
                        )}
                      </For>
                      <For each={layout().machines}>
                        {(place) => (
                          <MachineShape
                            place={place}
                            machine={machines().get(place.resource_id)}
                            selected={selectedMachine() === place.resource_id}
                            onSelect={() =>
                              setSelectedMachine(
                                selectedMachine() === place.resource_id ? null : place.resource_id,
                              )
                            }
                          />
                        )}
                      </For>
                    </svg>
                  )}
                </Show>
                <Legend />
                <p class="mt-1 px-1 text-xs text-muted-foreground">
                  Toca una máquina para ver qué corre, lo que sigue y sus planos.
                </p>
                <MachinePanel
                  machine={machines().get(selectedMachine() ?? '')}
                  canEdit={canEditMachines()}
                  onClose={() => setSelectedMachine(null)}
                />
              </CardContent>
            </Card>

            <div class="space-y-4">
              <section class="space-y-2">
                <h2 class="text-sm font-semibold text-foreground">Programadores</h2>
                <For each={membersQuery.data ?? []}>
                  {(m) => (
                    <MemberDrop
                      member={m}
                      running={(plant().machines ?? [])
                        .filter((x) => x.programmer?.id === m.id && x.status === 'working')
                        .map((x) => x.name)}
                      active={dropTarget() === m.id}
                      canAssign={canManage() && (picked() !== null || dropTarget() !== null)}
                      onDragOver={() => canManage() && setDropTarget(m.id)}
                      onDragLeave={() => setDropTarget(null)}
                      onDrop={(orderId) => canManage() && assign(orderId, m)}
                      onTap={() => {
                        const p = picked()
                        if (p && canManage()) assign(p, m)
                        else setPanelFor(m.id)
                      }}
                    />
                  )}
                </For>
                <ProgrammerDrawer memberId={panelFor()} onClose={() => setPanelFor(null)} />
              </section>

              <section class="space-y-2">
                <div class="flex items-baseline justify-between">
                  <h2 class="text-sm font-semibold text-foreground">Órdenes pendientes</h2>
                  <span class="text-xs text-muted-foreground">{pending().length}</span>
                </div>
                <WorkOrderSearch onQuery={setQuery} placeholder="Buscar por OT o nombre del item" />
                <Show when={canManage() && pending().length > 0}>
                  <p class="text-xs text-muted-foreground">
                    Arrastra una OT sobre un programador, o tócala y luego toca a la persona.
                  </p>
                </Show>
                <Show
                  when={pending().length > 0}
                  fallback={<p class="text-sm text-muted-foreground">Todas las OT tienen responsable.</p>}
                >
                  <div class="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
                    <For each={pending()}>
                      {(o) => (
                        <PendingOrder
                          order={o}
                          draggable={canManage()}
                          picked={picked() === o.id}
                          onPick={() => canManage() && setPicked(picked() === o.id ? null : o.id)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function MachineShape(props: {
  place: PlacedMachine
  machine: PlantMachine | undefined
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const p = () => props.place
  const color = () => (props.machine?.status ? STATUS_COLOR[props.machine.status] : UNKNOWN_COLOR)
  const cx = () => p().x + p().w / 2
  const cy = () => p().y + p().h / 2
  const sub = () => {
    const m = props.machine
    if (!m) return 'Sin datos'
    const next = m.queue.length > 0 ? ` · +${m.queue.length} en fila` : ''
    if (m.order) return `${m.order.part}${next}`
    if (m.status) return `${STATUS_LABEL[m.status]} · ${sinceLabel(m.since)}${next}`
    return `Sin datos${next}`
  }
  const who = () => props.machine?.programmer?.name
  return (
    <g
      class="cursor-pointer"
      role="button"
      tabIndex={0}
      aria-label={`${props.machine?.name ?? 'Máquina'}: ${
        props.machine?.status ? STATUS_LABEL[props.machine.status] : 'sin datos'
      }`}
      onClick={() => props.onSelect()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && props.onSelect()}
    >
      <g transform={`translate(${cx()} ${cy()}) rotate(${p().rotation})`}>
        <rect
          x={-p().w / 2}
          y={-p().h / 2}
          width={p().w}
          height={p().h}
          rx="6"
          fill="hsl(var(--card))"
          stroke={color()}
          stroke-width={props.selected ? 4 : 2}
        />
      </g>
      <circle cx={cx() + p().w / 2 - 8} cy={cy() - p().h / 2 + 8} r="5" fill={color()} />
      <text
        x={cx()}
        y={cy() - (who() ? 10 : 2)}
        text-anchor="middle"
        font-size="13"
        font-weight="600"
        fill="hsl(var(--foreground))"
      >
        {props.machine?.name ?? '?'}
      </text>
      <text
        x={cx()}
        y={cy() + (who() ? 5 : 14)}
        text-anchor="middle"
        font-size="10"
        fill="hsl(var(--muted-foreground))"
      >
        {sub()}
      </text>
      <Show when={who()}>
        <rect
          x={cx() - 14}
          y={cy() + 10}
          width="28"
          height="15"
          rx="7.5"
          fill="hsl(var(--primary) / 0.2)"
        />
        <text
          x={cx()}
          y={cy() + 21}
          text-anchor="middle"
          font-size="10"
          font-weight="600"
          fill="hsl(var(--primary))"
        >
          {initials(who()!)}
        </text>
      </Show>
    </g>
  )
}

function Legend(): JSX.Element {
  return (
    <div class="mt-2 flex flex-wrap gap-4 px-1 text-xs text-muted-foreground">
      <For each={Object.entries(STATUS_LABEL) as [MachineStatus, string][]}>
        {([status, label]) => (
          <span class="inline-flex items-center gap-1.5">
            <span class="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[status] }} />
            {label}
          </span>
        )}
      </For>
      <span class="inline-flex items-center gap-1.5">
        <span class="h-2.5 w-2.5 rounded-full" style={{ background: UNKNOWN_COLOR }} />
        Sin datos
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="rounded-full bg-primary/20 px-1.5 text-[10px] font-semibold text-primary">JM</span>
        Programó
      </span>
    </div>
  )
}

function MemberDrop(props: {
  member: BoardMemberLoad
  running: string[]
  active: boolean
  canAssign: boolean
  onDragOver: () => void
  onDragLeave: () => void
  onDrop: (orderId: string) => void
  onTap: () => void
}): JSX.Element {
  const count = () => props.member.assigned.length
  return (
    <div
      class={`rounded-xl border p-3 transition-colors ${
        props.active ? 'border-primary bg-primary/10' : 'border-border bg-card'
      } cursor-pointer`}
      onDragOver={(e) => {
        e.preventDefault()
        props.onDragOver()
      }}
      onDragLeave={() => props.onDragLeave()}
      onDrop={(e) => {
        e.preventDefault()
        const id = e.dataTransfer?.getData('text/plain')
        if (id) props.onDrop(id)
      }}
      onClick={() => props.onTap()}
    >
      <div class="flex items-center gap-2">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
          {initials(props.member.name)}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-foreground">{props.member.name}</p>
          <p class="truncate text-xs text-muted-foreground">
            {props.running.length > 0
              ? `Corre en ${props.running.join(', ')}`
              : props.member.assigned[0]
                ? `Haciendo ${props.member.assigned[0]}`
                : 'Sin programa'}
          </p>
        </div>
        <Badge tone={loadTone(count())}>{count() === 0 ? 'Libre' : count()}</Badge>
      </div>
    </div>
  )
}

function PendingOrder(props: {
  order: WorkOrder
  draggable: boolean
  picked: boolean
  onPick: () => void
}): JSX.Element {
  const urgent = () => props.order.priority === 'urgent'
  return (
    <div
      class={`rounded-lg border px-3 py-2 text-sm ${
        props.picked ? 'border-primary ring-2 ring-primary/40' : urgent() ? 'border-rose-500/50' : 'border-border'
      } bg-card ${props.draggable ? 'cursor-grab select-none' : ''}`}
      draggable={props.draggable}
      onDragStart={(e) => e.dataTransfer?.setData('text/plain', props.order.id)}
      onClick={() => props.onPick()}
    >
      <div class="flex items-center justify-between gap-2">
        <span class="font-semibold tabular-nums text-foreground">{props.order.folio}</span>
        <span class={`text-xs ${urgent() ? 'text-rose-500' : 'text-muted-foreground'}`}>
          {props.order.priority_label}
        </span>
      </div>
      <p class="truncate text-xs text-muted-foreground">
        <PartName conceptId={props.order.id} part={props.order.part} /> · {props.order.client ?? props.order.project}
      </p>
    </div>
  )
}
