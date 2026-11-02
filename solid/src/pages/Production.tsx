// Tablero de Producción — Cola de Programación CNC (entrega A de
// openspec/changes/add-production-board). Every open part number is a work order (OT)
// in production sequence. Whoever manages the board assigns orders and moves them up or
// down; programmers see "Tu siguiente programa", mark it done, release it, take the next
// free one or group a similar part. Tens of cards at most, so plain DOM (CLAUDE.md
// rendering guide). Never shows money or the part description.
import { A } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Hand,
  Layers,
  Map as MapIcon,
  Pin,
  PinOff,
  Undo2,
} from 'lucide-solid'
import { type JSX, For, Show, createMemo } from 'solid-js'

import { Badge, type BadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as productionApi from '../lib/api/production'
import type { BoardMemberLoad, SequenceMovePayload, WorkOrder } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const REFRESH_MS = 30_000
/** At or above this many assigned programs a person shows as saturated. */
const LOAD_LIMIT = 5

const PRIORITY_TONE: Record<WorkOrder['priority'], BadgeTone> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'neutral',
  low: 'neutral',
}

/** Part family: everything before the last "-" ("ZBL149-17" → "ZBL149"). */
const partFamily = (part: string) => (part.includes('-') ? part.slice(0, part.lastIndexOf('-')) : part)

function loadTone(count: number): BadgeTone {
  if (count === 0) return 'warning'
  if (count >= LOAD_LIMIT) return 'danger'
  return 'success'
}

function loadLabel(count: number): string {
  if (count === 0) return 'Libre'
  if (count >= LOAD_LIMIT) return `${count} · saturado`
  return `${count} en fila`
}

export default function Production(): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()
  const canManage = () => auth.isAdmin() || auth.hasPermission('manage_production_board')
  const canTake = () => auth.isAdmin() || auth.hasPermission('take_work_orders')

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

  const orders = () => boardQuery.data ?? []
  const me = () => auth.user()
  const mine = createMemo(() => orders().filter((o) => o.assignee?.username === me()))
  const free = createMemo(() => orders().filter((o) => !o.assignee))

  const refresh = () => void qc.invalidateQueries({ queryKey: ['production'] })
  const run = createMutation(() => ({
    mutationFn: (fn: () => Promise<void>) => fn(),
    onSuccess: refresh,
    onError: (err) => {
      toast.error('No se pudo actualizar', humanizeError(err, 'Intenta de nuevo'))
      refresh()
    },
  }))
  const act = (fn: () => Promise<void>) => run.mutate(fn)

  const move = (o: WorkOrder, payload: SequenceMovePayload) =>
    act(() => productionApi.moveWorkOrder(o.id, payload))
  const moveUp = (index: number) => {
    const list = orders()
    if (index > 0) move(list[index], { before_id: list[index - 1].id })
  }
  const moveDown = (index: number) => {
    const list = orders()
    if (index < list.length - 1) move(list[index], { after_id: list[index + 1].id })
  }

  return (
    <div class="space-y-6">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="Tablero de Producción"
          subtitle="Cola de Programación CNC · se actualiza cada 30 s"
        />
        <A
          href="/produccion/planta"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <MapIcon class="h-4 w-4" />
          Vista de planta
        </A>
      </div>

      <Show when={boardQuery.isLoading}>
        <div class="flex justify-center py-10">
          <Spinner />
        </div>
      </Show>

      <Show when={!boardQuery.isLoading && canTake() && (!canManage() || mine().length > 0)}>
        <NextProgram
          mine={mine()}
          free={free()}
          busy={run.isPending}
          onComplete={(o) => act(() => productionApi.completeWorkOrder(o.id))}
          onRelease={(o) => act(() => productionApi.releaseWorkOrder(o.id))}
          onTakeNext={(o) => act(() => productionApi.takeWorkOrder(o.id))}
          onGroup={(o, related, reason) =>
            act(() => productionApi.takeWorkOrder(o.id, { related_to: related.id, reason }))
          }
        />
      </Show>

      <Show when={(membersQuery.data?.length ?? 0) > 0}>
        <MembersStrip members={membersQuery.data ?? []} />
      </Show>

      <Show when={!boardQuery.isLoading}>
        <section class="space-y-2">
          <div class="flex items-baseline justify-between">
            <h2 class="text-sm font-semibold text-foreground">Secuencia de producción</h2>
            <span class="text-xs text-muted-foreground">
              {orders().length} OT · {free().length} sin asignar
            </span>
          </div>
          <Show
            when={orders().length > 0}
            fallback={
              <Card glass>
                <CardContent class="p-5 text-sm text-muted-foreground">
                  No hay órdenes en la Cola de Programación. Aparecen aquí los números de parte de
                  proyectos abiertos cuyo siguiente paso es "Programa".
                </CardContent>
              </Card>
            }
          >
            <ol class="space-y-2">
              <For each={orders()}>
                {(o, i) => (
                  <li>
                    <OrderCard
                      order={o}
                      position={i() + 1}
                      members={membersQuery.data ?? []}
                      canManage={canManage()}
                      isFirst={i() === 0}
                      isLast={i() === orders().length - 1}
                      busy={run.isPending}
                      onAssign={(userId) => act(() => productionApi.assignWorkOrder(o.id, userId))}
                      onUp={() => moveUp(i())}
                      onDown={() => moveDown(i())}
                      onUnpin={() => move(o, { unpin: true })}
                    />
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </section>
      </Show>
    </div>
  )
}

function PriorityBadge(props: { order: WorkOrder }): JSX.Element {
  return <Badge tone={PRIORITY_TONE[props.order.priority]}>{props.order.priority_label}</Badge>
}

function OrderSummary(props: { order: WorkOrder }): JSX.Element {
  return (
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.order.pinned}>
          <Pin class="h-3.5 w-3.5 text-primary" aria-label="Fijada" />
        </Show>
        <span class="font-semibold tabular-nums text-foreground">{props.order.folio}</span>
        <span class="truncate text-foreground">{props.order.part}</span>
        <PriorityBadge order={props.order} />
      </div>
      <p class="mt-0.5 truncate text-xs text-muted-foreground">
        {props.order.project}
        <Show when={props.order.client}> · {props.order.client}</Show>
        {' · '}
        {props.order.quantity} {props.order.unit ?? 'pzas'}
      </p>
    </div>
  )
}

interface OrderCardProps {
  order: WorkOrder
  position: number
  members: BoardMemberLoad[]
  canManage: boolean
  isFirst: boolean
  isLast: boolean
  busy: boolean
  onAssign: (userId: string | null) => void
  onUp: () => void
  onDown: () => void
  onUnpin: () => void
}

function OrderCard(props: OrderCardProps): JSX.Element {
  return (
    <Card glass glow={false}>
      <CardContent class="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
        <span class="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {props.position}
        </span>
        <div class="min-w-0 flex-1">
          <OrderSummary order={props.order} />
        </div>
        <Show
          when={props.canManage}
          fallback={
            <span class="text-sm text-muted-foreground">
              {props.order.assignee ? props.order.assignee.name : 'Sin asignar'}
            </span>
          }
        >
          <label class="sr-only" for={`assign-${props.order.id}`}>
            Asignar {props.order.folio}
          </label>
          <select
            id={`assign-${props.order.id}`}
            class="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
            disabled={props.busy}
            onChange={(e) => props.onAssign(e.currentTarget.value || null)}
          >
            {/* `selected` per option: a `value` on the select is applied before <For> renders. */}
            <option value="" selected={!props.order.assignee}>
              Sin asignar
            </option>
            <For each={props.members}>
              {(m) => (
                <option value={m.id} selected={props.order.assignee?.id === m.id}>
                  {m.name}
                </option>
              )}
            </For>
          </select>
          <div class="flex gap-1">
            <Button
              variant="ghost"
              aria-label={`Subir ${props.order.folio}`}
              disabled={props.busy || props.isFirst}
              onClick={props.onUp}
            >
              <ArrowUp class="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              aria-label={`Bajar ${props.order.folio}`}
              disabled={props.busy || props.isLast}
              onClick={props.onDown}
            >
              <ArrowDown class="h-4 w-4" />
            </Button>
            <Show when={props.order.pinned}>
              <Button
                variant="ghost"
                aria-label={`Quitar fijado de ${props.order.folio}`}
                disabled={props.busy}
                onClick={props.onUnpin}
              >
                <PinOff class="h-4 w-4" />
              </Button>
            </Show>
          </div>
        </Show>
      </CardContent>
    </Card>
  )
}

function MembersStrip(props: { members: BoardMemberLoad[] }): JSX.Element {
  return (
    <section class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <For each={props.members}>
        {(m) => (
          <Card glass glow={false}>
            <CardContent class="flex items-center justify-between gap-2 p-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-foreground">{m.name}</p>
                <p class="truncate text-xs text-muted-foreground">
                  {m.assigned[0] ? `Haciendo ${m.assigned[0]}` : 'Sin programa'}
                </p>
              </div>
              <Badge tone={loadTone(m.assigned.length)}>{loadLabel(m.assigned.length)}</Badge>
            </CardContent>
          </Card>
        )}
      </For>
    </section>
  )
}

interface NextProgramProps {
  mine: WorkOrder[]
  free: WorkOrder[]
  busy: boolean
  onComplete: (o: WorkOrder) => void
  onRelease: (o: WorkOrder) => void
  onTakeNext: (o: WorkOrder) => void
  onGroup: (o: WorkOrder, related: WorkOrder, reason: string) => void
}

function NextProgram(props: NextProgramProps): JSX.Element {
  const next = () => props.mine[0]
  /** Free orders that look like the current one: same project or same part family. */
  const similar = createMemo(() => {
    const current = next()
    if (!current) return []
    return props.free
      .filter(
        (o) => o.project_id === current.project_id || partFamily(o.part) === partFamily(current.part),
      )
      .slice(0, 5)
  })

  return (
    <Card glass>
      <CardContent class="space-y-4 p-5">
        <Show
          when={next()}
          fallback={
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p class="text-base font-semibold text-foreground">Sin programas asignados</p>
                <p class="text-sm text-muted-foreground">
                  Toma la siguiente orden libre de la cola, según las prioridades.
                </p>
              </div>
              <Show when={props.free[0]}>
                {(first) => (
                  <Button disabled={props.busy} onClick={() => props.onTakeNext(first())}>
                    <Hand class="mr-1.5 h-4 w-4" />
                    Tomar {first().folio}
                  </Button>
                )}
              </Show>
            </div>
          }
        >
          {(current) => (
            <>
              <div>
                <p class="text-xs font-medium uppercase tracking-wide text-primary">
                  Tu siguiente programa
                </p>
                <div class="mt-2 text-lg">
                  <OrderSummary order={current()} />
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button disabled={props.busy} onClick={() => props.onComplete(current())}>
                  <Check class="mr-1.5 h-4 w-4" />
                  Marcar terminado
                </Button>
                <Button
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => props.onRelease(current())}
                >
                  <Undo2 class="mr-1.5 h-4 w-4" />
                  Soltar
                </Button>
                <span class="text-sm text-muted-foreground">
                  {props.mine.length > 1
                    ? `Siguen ${props.mine.length - 1}: ${props.mine
                        .slice(1)
                        .map((o) => o.folio)
                        .join(', ')}`
                    : 'Es la última de tu fila'}
                </span>
              </div>
              <Show when={similar().length > 0}>
                <div class="space-y-2 border-t border-border pt-3">
                  <p class="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Layers class="h-4 w-4" />
                    Partes parecidas libres
                  </p>
                  <For each={similar()}>
                    {(o) => (
                      <div class="flex items-center justify-between gap-2">
                        <OrderSummary order={o} />
                        <Button
                          variant="outline"
                          disabled={props.busy}
                          onClick={() =>
                            props.onGroup(
                              o,
                              current(),
                              o.project_id === current().project_id
                                ? 'mismo proyecto'
                                : 'misma familia de parte',
                            )
                          }
                        >
                          Agrupar
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </CardContent>
    </Card>
  )
}
