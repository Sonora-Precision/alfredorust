// Cotizador — Daniel's method (openspec add-part-quoting): weight of the blank × price per kg
// of its material = material cost; × multiplier (3.5 unless set) = suggested unit price. The
// quoted price stays his: "Usar precio sugerido" copies it only when he asks. Admin only.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { PartName } from '../production/PartName'
import { Button } from '../ui/Button'
import { Card, CardContent } from '../ui/Card'
import { Spinner } from '../ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../ui/Table'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import * as quotingApi from '../../lib/api/quoting'
import type { QuoteLine } from '../../lib/api/quoting'
import { money } from '../../lib/format'

const inch = (v: number | null) => (v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.'))
const kg = (v: number | null) => (v == null ? '—' : `${v.toFixed(v < 1 ? 3 : 2)} kg`)

export function QuoteTab(props: { projectId: string }): JSX.Element {
  const qc = useQueryClient()
  const quote = createQuery(() => ({
    queryKey: ['project-quote', props.projectId],
    queryFn: () => quotingApi.getProjectQuote(props.projectId),
  }))
  const prices = createQuery(() => ({ queryKey: ['material-prices'], queryFn: quotingApi.listMaterialPrices }))
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['project-quote', props.projectId] })
    void qc.invalidateQueries({ queryKey: ['material-prices'] })
  }
  const run = createMutation(() => ({
    mutationFn: (v: { fn: () => Promise<unknown>; done?: string }) => v.fn(),
    onSuccess: (_d, v) => {
      if (v.done) toast.success(v.done)
      refresh()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa el dato')),
  }))

  // Materials of this project, with their current price per kg.
  const materials = createMemo(() => [
    ...new Set((quote.data?.lines ?? []).map((l) => l.material).filter((m): m is string => !!m)),
  ])
  const priceOf = (m: string) => prices.data?.find((p) => p.material.toLowerCase() === m.toLowerCase())

  const [picked, setPicked] = createSignal<Set<string> | null>(null)
  const withSuggestion = () => (quote.data?.lines ?? []).filter((l) => l.suggested_unit_price != null)
  const selected = () => picked() ?? new Set(withSuggestion().map((l) => l.concept_id))
  const toggle = (id: string) => {
    const next = new Set(selected())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  const apply = () => {
    const ids = [...selected()]
    if (ids.length === 0) return
    if (!window.confirm(`¿Usar el precio sugerido en ${ids.length} ${ids.length === 1 ? 'pieza' : 'piezas'}? Reemplaza su precio cotizado.`)) return
    run.mutate({
      fn: async () => {
        const r = await quotingApi.applySuggestedPrices(props.projectId, ids)
        void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
        if (r.skipped.length) toast.error('Sin precio sugerido', r.skipped.join(', '))
        setPicked(null)
        return r
      },
      done: 'Precios cotizados actualizados',
    })
  }

  return (
    <div class="space-y-4">
      <Card glass glow={false}>
        <CardContent class="space-y-2 p-4">
          <p class="text-sm font-semibold text-foreground">Precio por kg del material</p>
          <p class="text-xs text-muted-foreground">
            Costo de material = peso del tocho × precio por kg. Precio sugerido = costo × multiplicador.
          </p>
          <div class="flex flex-wrap gap-3">
            <For each={materials()}>
              {(m) => <PriceInput material={m} current={priceOf(m)?.price_per_kg ?? null} note={priceOf(m)?.note ?? null} busy={run.isPending} onSave={(p) => run.mutate({ fn: () => quotingApi.setMaterialPrice(m, p), done: `${m}: precio guardado` })} />}
            </For>
            <Show when={materials().length === 0}>
              <p class="text-xs text-muted-foreground">Captura el material de las piezas en Seguimiento.</p>
            </Show>
          </div>
        </CardContent>
      </Card>

      <Show when={quote.data} fallback={<Spinner />}>
        {(q) => (
          <>
            <div class="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell class="w-8" />
                    <TableHeadCell>Pieza</TableHeadCell>
                    <TableHeadCell class="text-right">Cant.</TableHeadCell>
                    <TableHeadCell>Material · tocho</TableHeadCell>
                    <TableHeadCell>Peso tocho</TableHeadCell>
                    <TableHeadCell class="text-right">Costo mat.</TableHeadCell>
                    <TableHeadCell>×</TableHeadCell>
                    <TableHeadCell class="text-right">Sugerido</TableHeadCell>
                    <TableHeadCell class="text-right">Cotizado</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={q().lines}>
                    {(l) => (
                      <QuoteRow
                        line={l}
                        checked={selected().has(l.concept_id)}
                        busy={run.isPending}
                        onToggle={() => toggle(l.concept_id)}
                        onSave={(v) => run.mutate({ fn: () => quotingApi.setPartQuote(l.concept_id, v) })}
                      />
                    )}
                  </For>
                </TableBody>
              </Table>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap gap-4 text-sm">
                <span>
                  <span class="text-muted-foreground">Material: </span>
                  <span class="font-semibold tabular-nums">{money(q().material_total)}</span>
                </span>
                <span>
                  <span class="text-muted-foreground">Sugerido: </span>
                  <span class="font-semibold tabular-nums">{money(q().suggested_total)}</span>
                </span>
                <span>
                  <span class="text-muted-foreground">Cotizado: </span>
                  <span class="font-semibold tabular-nums">{money(q().quoted_total)}</span>
                </span>
                <span class="text-xs text-muted-foreground">sin IVA · totales = precio × cantidad</span>
              </div>
              <Button disabled={run.isPending || selected().size === 0} onClick={apply}>
                Usar precio sugerido ({selected().size})
              </Button>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function PriceInput(props: {
  material: string
  current: number | null
  note: string | null
  busy: boolean
  onSave: (price: number | null) => void
}): JSX.Element {
  const [text, setText] = createSignal(props.current?.toString() ?? '')
  const save = () => {
    const t = text().trim()
    const p = t === '' ? null : Number(t)
    if (p !== null && (!Number.isFinite(p) || p <= 0)) {
      toast.error('Precio inválido', 'Escribe pesos por kg, ej. 250')
      return
    }
    if (p !== props.current) props.onSave(p)
  }
  return (
    <label class="flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-sm" title={props.note ?? undefined}>
      <span class="text-foreground">{props.material}</span>
      <span class="text-muted-foreground">$</span>
      <input
        class="h-8 w-20 rounded border border-border bg-background px-1 text-right tabular-nums"
        inputmode="decimal"
        placeholder="—"
        aria-label={`Precio por kg de ${props.material}`}
        value={text()}
        disabled={props.busy}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <span class="text-xs text-muted-foreground">/kg</span>
    </label>
  )
}

function QuoteRow(props: {
  line: QuoteLine
  checked: boolean
  busy: boolean
  onToggle: () => void
  onSave: (v: { weight_kg: number | null; multiplier: number | null }) => void
}): JSX.Element {
  const l = () => props.line
  const [weight, setWeight] = createSignal(l().entered_weight_kg?.toString() ?? '')
  const [mult, setMult] = createSignal(l().entered_multiplier?.toString() ?? '')
  const save = () => {
    const parse = (s: string) => (s.trim() === '' ? null : Number(s))
    const w = parse(weight())
    const m = parse(mult())
    if ([w, m].some((v) => v !== null && (!Number.isFinite(v) || v <= 0))) {
      toast.error('Dato inválido', 'El peso y el multiplicador deben ser mayores a 0')
      return
    }
    if (w !== l().entered_weight_kg || m !== l().entered_multiplier) props.onSave({ weight_kg: w, multiplier: m })
  }
  const cell = 'h-8 rounded border border-border bg-background px-1 text-right tabular-nums text-sm'
  const tocho = () => [l().thickness, l().width, l().length].filter((v) => v != null).map(inch).join(' × ')
  return (
    <TableRow>
      <TableCell>
        <input
          type="checkbox"
          checked={props.checked}
          disabled={l().suggested_unit_price == null}
          aria-label={`Usar sugerido en ${l().part}`}
          onChange={props.onToggle}
        />
      </TableCell>
      <TableCell>
        <p class="tnum text-xs text-muted-foreground">{l().folio}</p>
        <PartName conceptId={l().concept_id} part={l().part} class="font-medium text-foreground" />
      </TableCell>
      <TableCell class="text-right tabular-nums">{l().quantity}</TableCell>
      <TableCell class="text-xs">
        <p class="text-foreground">{l().material ?? '—'}</p>
        <Show when={tocho()}>
          <p class="text-muted-foreground">{tocho()}"</p>
        </Show>
      </TableCell>
      <TableCell>
        <input
          class={`${cell} w-20`}
          inputmode="decimal"
          placeholder={l().weight_source === 'tocho' ? l().weight_kg!.toFixed(3) : 'kg'}
          title="Peso del tocho de SolidWorks; vacío = calculado con las medidas"
          aria-label={`Peso del tocho de ${l().part}`}
          value={weight()}
          disabled={props.busy}
          onInput={(e) => setWeight(e.currentTarget.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <p class="mt-0.5 text-[11px] text-muted-foreground">
          {l().weight_source === 'solidworks' ? 'SolidWorks' : l().weight_source === 'tocho' ? `calculado · ${kg(l().weight_kg)}` : ''}
        </p>
      </TableCell>
      <TableCell class="text-right tabular-nums">
        <Show when={l().material_cost != null} fallback={<span class="text-xs text-rose-600">falta {l().missing.join(' y ')}</span>}>
          {money(l().material_cost!)}
          <p class="text-[11px] text-muted-foreground">${l().price_per_kg}/kg</p>
        </Show>
      </TableCell>
      <TableCell>
        <input
          class={`${cell} w-14`}
          inputmode="decimal"
          placeholder={String(l().multiplier)}
          aria-label={`Multiplicador de ${l().part}`}
          value={mult()}
          disabled={props.busy}
          onInput={(e) => setMult(e.currentTarget.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </TableCell>
      <TableCell class="text-right font-semibold tabular-nums">
        {l().suggested_unit_price != null ? money(l().suggested_unit_price!) : '—'}
      </TableCell>
      <TableCell class="text-right tabular-nums">
        <span class={l().unit_price != null && l().unit_price === l().suggested_unit_price ? 'text-emerald-600' : ''}>
          {l().unit_price != null ? money(l().unit_price!) : '—'}
        </span>
      </TableCell>
    </TableRow>
  )
}
