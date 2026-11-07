// Material recibido — a supplier invoice read as bars and matched against the blank each
// part needs (openspec add-part-material, corte 2): ✅ como se pidió · 🟡 otra medida que
// sirve · ⚪ sin parte. The admin confirms which part each bar goes to. Only the admin sees
// "Precios de la factura": the amount of each line and its $/kg, which keep the material
// prices of Cotizaciones current (Daniel, 2026-11-06).
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createSignal } from 'solid-js'

import { PartName } from '../components/production/PartName'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as materialApi from '../lib/api/material'
import type { MaterialReceiptDetail, ReceiptLineView, ReceiptSuggestion } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const inch = (v: number | null) => (v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.'))
const dims = (l: ReceiptLineView) => [l.thickness, l.width, l.length].filter((d) => d != null).map(inch).join(' × ')
const day = (iso: string) => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })

export default function MaterialReceipts(): JSX.Element {
  const auth = useAuth()
  const canManage = () => auth.isAdmin() || auth.hasPermission('manage_production_board')
  const list = createQuery(() => ({ queryKey: ['material-receipts'], queryFn: materialApi.listMaterialReceipts }))
  const [selected, setSelected] = createSignal<string | null>(null)
  const current = () => selected() ?? list.data?.[0]?.id ?? null

  return (
    <div class="space-y-4">
      <PageHeader title="Material recibido" subtitle="Factura del proveedor contra lo que pide cada número de parte" />
      <div class="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div class="space-y-3">
          <Show when={canManage()}>
            <NewReceipt onCreated={setSelected} />
          </Show>
          <Show when={list.isLoading}>
            <Spinner />
          </Show>
          <For each={list.data}>
            {(r) => (
              <button
                type="button"
                class={`block w-full rounded-xl border p-3 text-left text-sm ${current() === r.id ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-muted/50'}`}
                onClick={() => setSelected(r.id)}
              >
                <p class="truncate font-medium text-foreground">{r.supplier}</p>
                <p class="text-xs text-muted-foreground">
                  {r.folio ?? 'Sin folio'} · {day(r.received_at)} · {r.assigned_lines}/{r.lines} barras asignadas
                </p>
              </button>
            )}
          </For>
          <Show when={list.data?.length === 0}>
            <p class="text-sm text-muted-foreground">Todavía no hay recepciones.</p>
          </Show>
        </div>
        <Show when={current()} fallback={<span />}>
          {(id) => <ReceiptDetail id={id()} canManage={canManage() || auth.hasPermission('take_work_orders')} isAdmin={auth.isAdmin()} />}
        </Show>
      </div>
    </div>
  )
}

function NewReceipt(props: { onCreated: (id: string) => void }): JSX.Element {
  const qc = useQueryClient()
  const [open, setOpen] = createSignal(false)
  const [uuid, setUuid] = createSignal('')
  const [supplier, setSupplier] = createSignal('')
  const [folio, setFolio] = createSignal('')
  const [text, setText] = createSignal('')
  const create = createMutation(() => ({
    mutationFn: () =>
      materialApi.createMaterialReceipt(
        uuid().trim()
          ? { cfdi_uuid: uuid().trim() }
          : {
              supplier: supplier().trim(),
              folio: folio().trim() || undefined,
              lines: text()
                .split('\n')
                .map((d) => d.trim())
                .filter(Boolean)
                .map((description) => ({ description })),
            },
      ),
    onSuccess: (r) => {
      toast.success('Recepción creada')
      void qc.invalidateQueries({ queryKey: ['material-receipts'] })
      setOpen(false)
      props.onCreated(r.id)
    },
    onError: (err) => toast.error('No se pudo crear', humanizeError(err, 'Revisa los datos')),
  }))
  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  return (
    <Show when={open()} fallback={<Button onClick={() => setOpen(true)}>+ Nueva recepción</Button>}>
      <Card glass glow={false}>
        <CardContent class="space-y-2 p-3 text-sm">
          <label class="block space-y-1">
            <span class="text-xs text-muted-foreground">UUID del CFDI (si ya se bajó del SAT)</span>
            <input class={field} placeholder="0E39A7C7-5C3E-…" value={uuid()} onInput={(e) => setUuid(e.currentTarget.value)} />
          </label>
          <Show when={!uuid().trim()}>
            <p class="text-xs text-muted-foreground">O captura los renglones de la factura, uno por línea:</p>
            <input class={field} placeholder="Proveedor" value={supplier()} onInput={(e) => setSupplier(e.currentTarget.value)} />
            <input class={field} placeholder="Folio (F86241)" value={folio()} onInput={(e) => setFolio(e.currentTarget.value)} />
            <textarea
              class={`${field} h-32 py-1 font-mono text-xs`}
              placeholder={'Aluminio solera 6061 de 1/8" X 2" X 144" ( 1 pz )'}
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
          </Show>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Leyendo…' : 'Crear'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </Show>
  )
}

function ReceiptDetail(props: { id: string; canManage: boolean; isAdmin: boolean }): JSX.Element {
  const qc = useQueryClient()
  const detail = createQuery(() => ({
    queryKey: ['material-receipts', props.id],
    queryFn: () => materialApi.getMaterialReceipt(props.id),
  }))
  const assign = createMutation(() => ({
    mutationFn: (v: { line: number; ids: string[] }) => materialApi.assignReceiptLine(props.id, v.line, v.ids),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['material-receipts'] })
      void qc.invalidateQueries({ queryKey: ['project-concepts'] })
    },
    onError: (err) => toast.error('No se pudo asignar', humanizeError(err, 'Intenta de nuevo')),
  }))
  const toggle = (l: ReceiptLineView, conceptId: string) => {
    const ids = l.assigned.map((a) => a.concept_id)
    assign.mutate({ line: l.line, ids: ids.includes(conceptId) ? ids.filter((i) => i !== conceptId) : [...ids, conceptId] })
  }

  return (
    <Show when={detail.data} fallback={<Spinner />}>
      {(r) => (
        <div class="space-y-4">
          <Card glass glow={false}>
            <CardContent class="space-y-1 p-4">
              <p class="font-semibold text-foreground">
                {r().supplier} <span class="font-normal text-muted-foreground">· {r().folio ?? 'sin folio'} · {day(r().received_at)}</span>
              </p>
              <Coverage receipt={r()} />
            </CardContent>
          </Card>
          <Show when={props.isAdmin}>
            <ReceiptPrices receipt={r()} />
          </Show>
          <For each={r().lines}>
            {(l) => (
              <Card glass glow={false}>
                <CardContent class="space-y-2 p-3 text-sm">
                  <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <p class="text-foreground">
                      <span class="mr-1 text-xs text-muted-foreground">{l.line}.</span>
                      <span class="font-medium">{[l.material ?? 'Material ?', l.shape].filter(Boolean).join(' ')}</span>
                      <Show when={dims(l)}> · {dims(l)}"</Show>
                      <Show when={l.pieces > 1}> · {l.pieces} pz</Show>
                    </p>
                    <span class="truncate text-xs text-muted-foreground" title={l.description}>
                      {l.description}
                    </span>
                  </div>
                  <Show
                    when={l.suggestions.length > 0}
                    fallback={
                      <p class="text-xs text-muted-foreground">
                        ⚪ No le queda a ninguna parte con material capturado. Revisa a qué número de parte va.
                      </p>
                    }
                  >
                    <ul class="space-y-1">
                      <For each={l.suggestions}>
                        {(s) => {
                          const on = () => l.assigned.some((a) => a.concept_id === s.concept_id)
                          return (
                            <li class="flex flex-wrap items-center gap-2">
                              <input
                                type="checkbox"
                                checked={on()}
                                disabled={!props.canManage || assign.isPending}
                                aria-label={`Asignar a ${s.part}`}
                                onChange={() => toggle(l, s.concept_id)}
                              />
                              <span>{s.fit === 'exact' ? '✅' : '🟡'}</span>
                              <span class="tnum font-semibold text-foreground">{s.folio}</span>
                              <PartName conceptId={s.concept_id} part={s.part} class="text-foreground" />
                              <SuggestionPieces s={s} />
                              <Show when={s.note}>
                                <span class="text-xs text-muted-foreground">· {s.note}</span>
                              </Show>
                            </li>
                          )
                        }}
                      </For>
                    </ul>
                  </Show>
                </CardContent>
              </Card>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

/**
 * Pieces of a suggested bar counted with the part's other bars: "salen 28 + 7 (barra 3) =
 * 35 de 30 ✅", or, before assigning, "salen 28 de 30 · con la barra 3 (7) alcanza".
 */
function SuggestionPieces(props: { s: ReceiptSuggestion }): JSX.Element {
  const assigned = () => props.s.other_bars.filter((b) => b.assigned)
  const free = () => props.s.other_bars.filter((b) => !b.assigned)
  const total = () => props.s.pieces + assigned().reduce((n, b) => n + b.pieces, 0)
  // Fewest free bars that complete it, biggest first.
  const completing = () => {
    const picked: typeof props.s.other_bars = []
    let n = total()
    for (const b of [...free()].sort((a, c) => c.pieces - a.pieces)) {
      if (n >= props.s.needed) break
      picked.push(b)
      n += b.pieces
    }
    return n >= props.s.needed ? picked : null
  }
  const bars = (list: typeof props.s.other_bars) =>
    list.map((b) => `${b.pieces} (barra ${b.line})`).join(' + ')
  return (
    <span class="text-xs text-muted-foreground">
      salen {props.s.pieces}
      <Show when={assigned().length > 0}>
        {' '}+ {bars(assigned())} = {total()}
      </Show>{' '}
      de {props.s.needed} pz{' '}
      <Show
        when={total() >= props.s.needed}
        fallback={
          <Show
            when={completing()?.length}
            fallback={<span class="text-rose-600">· faltan {props.s.needed - total()}</span>}
          >
            · con {bars(completing()!)} alcanza
          </Show>
        }
      >
        ✅
      </Show>
    </span>
  )
}

/** Each part with bars assigned: pieces needed vs pieces its bars yield. */
function Coverage(props: { receipt: MaterialReceiptDetail }): JSX.Element {
  return (
    <Show
      when={props.receipt.parts.length > 0}
      fallback={<p class="text-sm text-muted-foreground">Marca a qué parte va cada barra; aquí verás si alcanza.</p>}
    >
      <ul class="grid gap-1 pt-1 text-sm sm:grid-cols-2">
        <For each={props.receipt.parts}>
          {(p) => (
            <li class="flex items-center gap-2">
              <span>{p.available >= p.needed ? '✅' : '🔴'}</span>
              <span class="tnum font-semibold">{p.folio}</span>
              <PartName conceptId={p.concept_id} part={p.part} />
              <span class="text-xs text-muted-foreground">
                {p.available} de {p.needed} pz
                <Show when={p.available < p.needed}> · faltan {p.needed - p.available}</Show>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/**
 * Admin only: the amount before tax of each invoice line. Billed by kg the quantity is the
 * kilos; billed by piece the kilos come from the bar (density × volume). Saving updates the
 * price per kg of each material, unless it already has a newer price.
 */
function ReceiptPrices(props: { receipt: MaterialReceiptDetail }): JSX.Element {
  const qc = useQueryClient()
  const [amounts, setAmounts] = createSignal<Record<number, string>>({})
  const valueOf = (l: ReceiptLineView) => amounts()[l.line] ?? (l.price ? String(l.price.amount) : '')
  const save = createMutation(() => ({
    mutationFn: () =>
      materialApi.setReceiptPrices(
        props.receipt.id,
        props.receipt.lines.map((l) => {
          const v = Number(valueOf(l).replace(/[$,\s]/g, ''))
          return { line: l.line, amount: valueOf(l).trim() && Number.isFinite(v) && v > 0 ? v : null }
        }),
      ),
    onSuccess: (r) => {
      toast.success(`Precios guardados`, `${r.priced} ${r.priced === 1 ? 'renglón' : 'renglones'} con precio por kg`)
      setAmounts({})
      void qc.invalidateQueries({ queryKey: ['material-receipts', props.receipt.id] })
      void qc.invalidateQueries({ queryKey: ['material-prices'] })
    },
    onError: (err) => toast.error('No se pudieron guardar', humanizeError(err, 'Revisa los importes')),
  }))
  const money = (v: number) => v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })
  return (
    <Card glass glow={false}>
      <CardContent class="space-y-2 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="text-sm font-semibold text-foreground">Precios de la factura</p>
          <p class="text-xs text-muted-foreground">Solo tú los ves. Importe sin IVA de cada renglón; el precio por kg pasa a Cotizaciones.</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[560px] text-sm">
            <thead class="text-left text-xs text-muted-foreground">
              <tr>
                <th class="py-1">#</th>
                <th class="py-1">Material</th>
                <th class="py-1 text-right">Cant.</th>
                <th class="w-36 py-1 text-right">Importe</th>
                <th class="py-1 text-right">kg</th>
                <th class="py-1 text-right">$/kg</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.receipt.lines}>
                {(l) => (
                  <tr class="border-t border-border">
                    <td class="py-1 text-xs text-muted-foreground">{l.line}</td>
                    <td class="py-1">
                      {[l.material ?? 'Material ?', l.shape].filter(Boolean).join(' ')}
                      <Show when={dims(l)}>
                        <span class="text-xs text-muted-foreground"> · {dims(l)}"</span>
                      </Show>
                    </td>
                    <td class="py-1 text-right tabular-nums text-muted-foreground">
                      {l.quantity} {l.unit}
                    </td>
                    <td class="py-1 pl-2">
                      <input
                        class="h-8 w-full rounded border border-border bg-background px-1 text-right tabular-nums"
                        inputmode="decimal"
                        placeholder="—"
                        aria-label={`Importe del renglón ${l.line}`}
                        value={valueOf(l)}
                        onInput={(e) => setAmounts({ ...amounts(), [l.line]: e.currentTarget.value })}
                      />
                    </td>
                    <td class="py-1 text-right tabular-nums">
                      <Show when={l.price} fallback={<span class="text-muted-foreground">—</span>}>
                        <span title={l.price!.kg_source === 'factura' ? 'Kilos de la factura' : 'Kilos calculados por medida y densidad'}>
                          {l.price!.kg.toFixed(2)}
                          {l.price!.kg_source === 'calculado' ? '*' : ''}
                        </span>
                      </Show>
                    </td>
                    <td class="py-1 text-right font-semibold tabular-nums">
                      <Show when={l.price} fallback={<span class="font-normal text-muted-foreground">—</span>}>
                        {money(l.price!.price_per_kg)}
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">* kilos calculados por medida y densidad (la factura no venía en kg).</p>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Guardando…' : 'Guardar importes'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
