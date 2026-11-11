// Liberación de calidad: parts with produced pieces waiting for quality. Quality
// (release_parts) and the admin release or reject them; only released pieces count as
// finished (Daniel, 2026-11-03). Everyone on the board sees the queue. No money.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ShieldCheck } from 'lucide-solid'
import { type JSX, For, Show, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Card, CardContent } from '../ui/Card'
import { Input } from '../ui/Input'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import * as productionApi from '../../lib/api/production'
import type { QualityItem, QualityPayload } from '../../lib/api/types'
import { matchesWorkOrder } from './WorkOrderSearch'
import { PartName } from './PartName'
import { ProgrammerName } from './ProgrammerPanel'

const n = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 2 })
const parse = (s: string) => {
  const v = Number.parseFloat(s.replace(/[\s,]/g, ''))
  return Number.isFinite(v) ? v : 0
}

export function QualityQueue(props: { canRelease: boolean; query?: string }): JSX.Element {
  const qc = useQueryClient()
  const q = createQuery(() => ({
    queryKey: ['production', 'quality'],
    queryFn: productionApi.listQualityQueue,
    refetchInterval: 30_000,
  }))
  const items = () => (q.data ?? []).filter((i) => matchesWorkOrder(i, props.query ?? ''))

  const record = createMutation(() => ({
    mutationFn: (v: { id: string; payload: QualityPayload }) => productionApi.recordQuality(v.id, v.payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['production'] })
      void qc.invalidateQueries({ queryKey: ['project-concepts'] })
    },
    onError: (err) => toast.error('No se pudo registrar', humanizeError(err, 'Intenta de nuevo')),
  }))

  return (
    <Show when={(q.data?.length ?? 0) > 0 || props.canRelease}>
      <section class="space-y-2">
        <div class="flex items-baseline justify-between">
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <ShieldCheck class="h-4 w-4 text-emerald-600" />
            Liberación de calidad
          </h2>
          <span class="text-xs text-muted-foreground">
            {items().length} OT · {n(items().reduce((s, i) => s + i.awaiting, 0))} pzas por liberar
          </span>
        </div>
        <Show
          when={items().length > 0}
          fallback={
            <Card glass>
              <CardContent class="p-4 text-sm text-muted-foreground">
                No hay piezas producidas esperando liberación.
              </CardContent>
            </Card>
          }
        >
          <ul class="space-y-2">
            <For each={items()}>
              {(item) => (
                <QualityRow
                  item={item}
                  canRelease={props.canRelease}
                  busy={record.isPending}
                  onRecord={(payload) => record.mutate({ id: item.id, payload })}
                />
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  )
}

function QualityRow(props: {
  item: QualityItem
  canRelease: boolean
  busy: boolean
  onRecord: (payload: QualityPayload) => void
}): JSX.Element {
  const it = () => props.item
  const [released, setReleased] = createSignal('')
  const [rejected, setRejected] = createSignal('')
  const [reason, setReason] = createSignal('')

  const submit = (payload: QualityPayload) => {
    if ((payload.rejected ?? 0) > 0 && !payload.reason?.trim()) {
      toast.error('Falta el motivo', 'Escribe por qué se rechazan las piezas')
      return
    }
    if ((payload.released ?? 0) + (payload.rejected ?? 0) > it().awaiting) {
      toast.error('Demasiadas piezas', `Solo hay ${n(it().awaiting)} producidas por liberar`)
      return
    }
    props.onRecord(payload)
    setReleased('')
    setRejected('')
    setReason('')
  }

  return (
    <li>
      <Card glass glow={false}>
        <CardContent class="space-y-2 p-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate">
                <span class="tnum font-semibold text-foreground">{it().folio}</span>{' '}
                <PartName conceptId={it().id} part={it().part} class="text-foreground" />
              </p>
              <p class="truncate text-xs text-muted-foreground">
                {it().project}
                <Show when={it().client}> · {it().client}</Show>
                <Show when={it().programmer}>{(p) => <> · programador <ProgrammerName id={p().id} name={p().name} /></>}</Show>
              </p>
            </div>
            <div class="tnum text-right text-xs text-muted-foreground">
              <p>
                <span class="text-base font-semibold text-amber-600">{n(it().awaiting)}</span> por liberar
              </p>
              <p>
                {n(it().produced)} producidas · ✔ {n(it().released)} liberadas · ✖ {n(it().rejected)} rechazadas · de{' '}
                {n(it().quantity)}
              </p>
            </div>
          </div>
          <Show when={props.canRelease}>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                class="h-8 px-3 text-sm"
                disabled={props.busy}
                onClick={() => submit({ released: it().awaiting })}
              >
                Liberar todas ({n(it().awaiting)})
              </Button>
              <Input
                class="h-8 w-24 text-center"
                inputmode="decimal"
                placeholder="Liberar"
                aria-label={`Piezas a liberar de ${it().part}`}
                value={released()}
                onInput={setReleased}
              />
              <Input
                class="h-8 w-24 text-center"
                inputmode="decimal"
                placeholder="Rechazar"
                aria-label={`Piezas a rechazar de ${it().part}`}
                value={rejected()}
                onInput={setRejected}
              />
              <Show when={parse(rejected()) > 0}>
                <Input
                  class="h-8 min-w-[12rem] flex-1"
                  placeholder="Motivo del rechazo"
                  aria-label="Motivo del rechazo"
                  value={reason()}
                  onInput={setReason}
                />
              </Show>
              <Button
                class="h-8 px-3 text-sm"
                disabled={props.busy || (parse(released()) <= 0 && parse(rejected()) <= 0)}
                onClick={() =>
                  submit({ released: parse(released()), rejected: parse(rejected()), reason: reason() || undefined })
                }
              >
                Registrar
              </Button>
            </div>
          </Show>
        </CardContent>
      </Card>
    </li>
  )
}
