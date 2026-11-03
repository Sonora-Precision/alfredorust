// Clicking a programmer anywhere (board, plant view, quality, weekly pieces) opens a side
// panel with the part numbers assigned to them and a preview of each drawing, so the shop
// knows which piece is which without memorizing numbers (Daniel, 2026-11-03). No money.
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, Show, createSignal } from 'solid-js'

import { Drawer } from '../ui/Drawer'
import { PartDrawingThumb, PartName } from './PartName'
import * as productionApi from '../../lib/api/production'

const QUEUE_LABEL: Record<string, string> = {
  programming: 'Programación',
  setup: 'Setup',
  machining: 'Máquina',
  finishing: 'Acabado',
}

export function ProgrammerDrawer(props: {
  /** User id of the programmer; null keeps the panel closed. */
  memberId: string | null
  onClose: () => void
}): JSX.Element {
  const members = createQuery(() => ({
    queryKey: ['production', 'members'],
    queryFn: productionApi.listBoardMembers,
    enabled: props.memberId !== null,
  }))
  const member = () => members.data?.find((m) => m.id === props.memberId)
  const orders = () => member()?.orders ?? []

  return (
    <Drawer
      open={props.memberId !== null}
      onOpenChange={(open) => !open && props.onClose()}
      title={member()?.name ?? 'Programador'}
      subtitle={`${orders().length} ${orders().length === 1 ? 'parte asignada' : 'partes asignadas'}`}
    >
      <div class="space-y-3 p-4">
        <Show when={members.isLoading}>
          <p class="text-sm text-muted-foreground">Cargando…</p>
        </Show>
        <Show when={members.isError}>
          <p class="text-sm text-muted-foreground">No tienes acceso a las asignaciones del tablero.</p>
        </Show>
        <Show when={member() && orders().length === 0}>
          <p class="text-sm text-muted-foreground">Sin partes asignadas.</p>
        </Show>
        <For each={orders()}>
          {(o) => {
            return (
              <div class="overflow-hidden rounded-xl border border-border bg-card">
                <div class="px-3 py-2">
                  <p class="truncate text-sm">
                    <span class="font-semibold tabular-nums text-foreground">{o.folio}</span>{' '}
                    <PartName conceptId={o.id} part={o.part} class="text-foreground" />
                  </p>
                  <p class="truncate text-xs text-muted-foreground">
                    {QUEUE_LABEL[o.queue] ?? o.queue} · {o.operation} · {o.client ?? o.project} ·{' '}
                    {o.completed_quantity}/{o.quantity} pzas
                  </p>
                </div>
                <div class="border-t border-border">
                  <PartDrawingThumb conceptId={o.id} part={o.part} />
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </Drawer>
  )
}

/** A programmer's name that opens their panel when clicked. */
export function ProgrammerName(props: { id: string | null | undefined; name: string; class?: string }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  return (
    <Show when={props.id} fallback={<span class={props.class}>{props.name}</span>}>
      <button
        type="button"
        class={`underline decoration-dotted underline-offset-2 hover:text-primary ${props.class ?? ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        {props.name}
      </button>
      <ProgrammerDrawer memberId={open() ? props.id! : null} onClose={() => setOpen(false)} />
    </Show>
  )
}
