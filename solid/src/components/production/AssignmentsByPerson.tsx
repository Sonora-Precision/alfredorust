// Admin overview: everything assigned to each programmer, across every queue (Daniel,
// 2026-11-02: "Daniel tiene que poder ver TODO lo asignado a cada programador"). No money.
import { type JSX, For, Show, createSignal } from 'solid-js'
import { ChevronDown, ChevronRight } from 'lucide-solid'

import { Card, CardContent } from '../ui/Card'
import type { BoardMemberLoad } from '../../lib/api/types'
import { matchesWorkOrder } from './WorkOrderSearch'

const QUEUE_LABEL: Record<string, string> = {
  programming: 'Programación',
  setup: 'Setup',
  machining: 'Máquina',
  finishing: 'Acabado',
}

export function AssignmentsByPerson(props: { members: BoardMemberLoad[]; query: string }): JSX.Element {
  const [open, setOpen] = createSignal<Set<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const visible = (m: BoardMemberLoad) => m.orders.filter((o) => matchesWorkOrder(o, props.query))

  return (
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-foreground">Asignaciones por programador</h2>
      <For each={props.members}>
        {(m) => (
          <Card glass glow={false}>
            <CardContent class="p-0">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                aria-expanded={open().has(m.id) || props.query !== ''}
                onClick={() => toggle(m.id)}
              >
                <span class="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Show when={open().has(m.id) || props.query !== ''} fallback={<ChevronRight class="h-4 w-4" />}>
                    <ChevronDown class="h-4 w-4" />
                  </Show>
                  {m.name}
                </span>
                <span class="text-xs text-muted-foreground">{m.orders.length} OT</span>
              </button>
              <Show when={(open().has(m.id) || props.query !== '') && visible(m).length > 0}>
                <ul class="divide-y divide-border border-t border-border">
                  <For each={visible(m)}>
                    {(o) => (
                      <li class="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                        <span class="min-w-0 truncate">
                          <span class="font-semibold tabular-nums text-foreground">{o.folio}</span>{' '}
                          <span class="text-foreground">{o.part}</span>
                          <span class="text-xs text-muted-foreground">
                            {' · '}
                            {o.project}
                            <Show when={o.client}> · {o.client}</Show>
                          </span>
                        </span>
                        <span class="text-xs text-muted-foreground">
                          {o.operation} · {QUEUE_LABEL[o.queue] ?? o.queue} ·{' '}
                          {o.completed_quantity.toLocaleString('es-MX')}/{o.quantity.toLocaleString('es-MX')} pzas
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </CardContent>
          </Card>
        )}
      </For>
    </section>
  )
}
