// Costo prospectado del material (Daniel, 2026-11-07): with the stock of each part set, the
// request (bars by total length, plates cut to size, whole sheets) × density × $/kg gives what
// the material should cost. A supplier's quote is saved next to it to see whether we costed
// well, line by line ($/kg it implies vs the one we have). Admin only: it is money.
import { A } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import {
  type MaterialQuote,
  type MaterialRate,
  createMaterialQuote,
  deleteMaterialQuote,
  getProjectQuote,
  DEFAULT_MULTIPLIER,
  projectMaterialQuotes,
  projectMaterialRates,
} from '../../lib/api/quoting'
import type { Group } from './MaterialRequest'

const CM3_PER_IN3 = 16.387064
/** Suppliers weigh about 8% over the theoretical weight (HG #17573, 2026-11-07); Daniel set 10%. */
export const SUPPLIER_FACTOR = 1.1
const mx = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })
const mx2 = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 })
const num = (v: string) => {
  const t = v.replace(/[$,\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/** Cubic inches the request asks for in one group; null when a size is missing. */
export function groupVolumeIn3(g: Group): number | null {
  const m = g.lines[0]?.material
  if (!m || !g.total) return null
  const t = m.thickness
  if (t == null) return null
  if (g.sheet) return t * g.sheet.width * g.sheet.length * g.total
  if (g.cutToSize) return m.width != null && m.length != null ? t * m.width * m.length * g.total : null
  const shape = (m.shape ?? '').toLowerCase()
  const area = shape === 'redondo' ? Math.PI * (t / 2) ** 2 : shape === 'hexagonal' ? (Math.sqrt(3) / 2) * t * t : m.width != null ? t * m.width : null
  return area == null ? null : area * g.total
}

export interface CostLine {
  stock: string
  material: string | null
  kg: number | null
  pricePerKg: number | null
  pricedAs: string | null
  estimate: number | null
  /** What keeps it from an estimate, in the shop's words. */
  missing: string | null
}

export function costLines(groups: Group[], rates: MaterialRate[]): CostLine[] {
  const byName = new Map(rates.map((r) => [r.material.trim().toLowerCase(), r]))
  return groups.map((g) => {
    const material = g.lines[0]?.material.material?.trim() || null
    const rate = material ? byName.get(material.toLowerCase()) : undefined
    const in3 = groupVolumeIn3(g)
    const kg = in3 != null && rate?.density_g_cm3 != null ? (in3 * CM3_PER_IN3 * rate.density_g_cm3 * SUPPLIER_FACTOR) / 1000 : null
    const pricePerKg = rate?.price_per_kg ?? null
    const missing = !material
      ? 'sin material'
      : in3 == null
        ? 'faltan medidas'
        : rate?.density_g_cm3 == null
          ? 'no sé su densidad'
          : pricePerKg == null
            ? 'sin precio por kg'
            : null
    return {
      stock: g.stock,
      material,
      kg,
      pricePerKg,
      pricedAs: rate?.priced_as ?? null,
      estimate: kg != null && pricePerKg != null ? kg * pricePerKg : null,
      missing,
    }
  })
}

/** Quoted vs expected, as Daniel reads it: + is the supplier above our estimate. */
function Diff(props: { quoted: number; estimate: number }): JSX.Element {
  const pct = () => (props.estimate > 0 ? ((props.quoted - props.estimate) / props.estimate) * 100 : null)
  const color = () => {
    const p = pct()
    if (p == null) return 'text-muted-foreground'
    if (p > 10) return 'text-red-600 dark:text-red-400'
    if (p < -10) return 'text-emerald-600 dark:text-emerald-400'
    return 'text-foreground'
  }
  return (
    <span class={`tnum font-semibold ${color()}`}>
      {props.quoted - props.estimate >= 0 ? '+' : '−'}
      {mx(Math.abs(props.quoted - props.estimate))}
      <Show when={pct() != null}> ({pct()! >= 0 ? '+' : ''}{pct()!.toFixed(0)}%)</Show>
    </span>
  )
}

export function MaterialCost(props: { projectId: string; requestGroups: Group[]; allGroups: Group[] }): JSX.Element {
  const qc = useQueryClient()
  const rates = createQuery(() => ({
    queryKey: ['material-rates', props.projectId],
    queryFn: () => projectMaterialRates(props.projectId),
    staleTime: 60_000,
  }))
  const quotes = createQuery(() => ({
    queryKey: ['material-quotes', props.projectId],
    queryFn: () => projectMaterialQuotes(props.projectId),
  }))
  // "Solicitud" = what is being asked for now; "Proyecto" = every part with its stock.
  const [scope, setScope] = createSignal<'solicitud' | 'proyecto'>(props.requestGroups.length ? 'solicitud' : 'proyecto')
  const groups = () => (scope() === 'solicitud' ? props.requestGroups : props.allGroups)
  const lines = createMemo(() => costLines(groups(), rates.data ?? []))
  const estimate = () => lines().reduce((s, l) => s + (l.estimate ?? 0), 0)
  const incomplete = () => lines().filter((l) => l.estimate == null).length
  // The valuation always looks at the whole project, whatever tab is open.
  const projectLines = createMemo(() => costLines(props.allGroups, rates.data ?? []))
  const projectEstimate = () => projectLines().reduce((s, l) => s + (l.estimate ?? 0), 0)
  const projectIncomplete = () => projectLines().filter((l) => l.estimate == null).length
  const projectQuote = createQuery(() => ({
    queryKey: ['project-quote', props.projectId],
    queryFn: () => getProjectQuote(props.projectId),
  }))
  // What the client pays for the parts that take material (bought items like screws aside).
  const sold = () =>
    (projectQuote.data?.lines ?? []).filter((l) => l.material && l.unit_price != null).reduce((s, l) => s + l.unit_price! * l.quantity, 0)

  const [supplier, setSupplier] = createSignal('')
  const [total, setTotal] = createSignal('')
  const [note, setNote] = createSignal('')
  const [lineQuoted, setLineQuoted] = createSignal<Record<string, string>>({})
  const quotedOf = (stock: string) => num(lineQuoted()[stock] ?? '')
  const linesQuotedSum = () => lines().reduce((s, l) => s + (quotedOf(l.stock) || 0), 0)
  const totalValue = () => num(total()) ?? (linesQuotedSum() || null)

  const save = createMutation(() => ({
    mutationFn: () => {
      const t = totalValue()
      if (!supplier().trim()) throw new Error('Escribe el proveedor')
      if (t == null || Number.isNaN(t) || t <= 0) throw new Error('Escribe lo que cotizó el proveedor')
      if (lines().some((l) => Number.isNaN(quotedOf(l.stock)))) throw new Error('Los montos por renglón van en números')
      return createMaterialQuote(props.projectId, {
        supplier: supplier().trim(),
        total: t,
        estimate_total: Math.round(estimate() * 100) / 100,
        note: note().trim() || null,
        lines: lines().map((l) => ({
          stock: l.stock,
          kg: l.kg != null ? Math.round(l.kg * 1000) / 1000 : null,
          estimate: l.estimate != null ? Math.round(l.estimate * 100) / 100 : null,
          quoted: quotedOf(l.stock),
        })),
      })
    },
    onSuccess: () => {
      toast.success('Cotización guardada', supplier())
      setSupplier('')
      setTotal('')
      setNote('')
      setLineQuoted({})
      void qc.invalidateQueries({ queryKey: ['material-quotes', props.projectId] })
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, '')),
  }))
  const remove = createMutation(() => ({
    mutationFn: (id: string) => deleteMaterialQuote(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['material-quotes', props.projectId] }),
    onError: (err) => toast.error('No se pudo borrar', humanizeError(err, '')),
  }))

  const field = 'h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  const tab = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`
  return (
    <div class="rounded-xl border-2 border-amber-500/40 bg-card p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="text-base font-semibold text-foreground">Costo prospectado del material</h3>
          <p class="text-xs text-muted-foreground">Peso del stock a pedir +10% (así pesa el proveedor) × precio por kg. Solo tú lo ves. Montos antes de IVA.</p>
        </div>
        <div class="flex gap-1.5">
          <button type="button" class={tab(scope() === 'solicitud')} onClick={() => setScope('solicitud')}>
            Esta solicitud
          </button>
          <button type="button" class={tab(scope() === 'proyecto')} onClick={() => setScope('proyecto')}>
            Todo el proyecto
          </button>
        </div>
      </div>

      <Show
        when={lines().length}
        fallback={<p class="mt-3 text-sm text-muted-foreground">Sin stock capturado {scope() === 'solicitud' ? 'en la solicitud' : 'en el proyecto'}.</p>}
      >
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-muted-foreground">
                <th class="py-1 pr-2 font-normal">Stock</th>
                <th class="py-1 pr-2 text-right font-normal">Kg (+10%)</th>
                <th class="py-1 pr-2 text-right font-normal">$/kg</th>
                <th class="py-1 pr-2 text-right font-normal">Prospectado</th>
                <th class="py-1 text-right font-normal">Cotizado</th>
              </tr>
            </thead>
            <tbody>
              <For each={lines()}>
                {(l) => (
                  <tr class="border-t border-border">
                    <td class="py-1.5 pr-2 text-foreground">{l.stock}</td>
                    <td class="tnum py-1.5 pr-2 text-right">{l.kg != null ? l.kg.toFixed(2) : '—'}</td>
                    <td class="tnum py-1.5 pr-2 text-right" title={l.pricedAs ? `Precio de "${l.pricedAs}"` : undefined}>
                      {l.pricePerKg != null ? mx2(l.pricePerKg) : '—'}
                    </td>
                    <td class="tnum py-1.5 pr-2 text-right font-medium text-foreground">
                      <Show when={l.estimate != null} fallback={<span class="text-xs text-amber-700 dark:text-amber-300">{l.missing}</span>}>
                        {mx(l.estimate!)}
                      </Show>
                    </td>
                    <td class="py-1 text-right">
                      <input
                        class={`${field} tnum w-24 text-right`}
                        inputmode="decimal"
                        placeholder="$"
                        aria-label={`Cotizado por ${l.stock}`}
                        value={lineQuoted()[l.stock] ?? ''}
                        onInput={(e) => setLineQuoted((s) => ({ ...s, [l.stock]: e.currentTarget.value }))}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
            <tfoot>
              <tr class="border-t-2 border-border">
                <td class="py-2 pr-2 font-medium text-foreground" colspan="3">
                  Total prospectado
                  <Show when={incomplete()}>
                    <span class="ml-2 text-xs font-normal text-amber-700 dark:text-amber-300">
                      {incomplete()} {incomplete() === 1 ? 'renglón' : 'renglones'} sin calcular ·{' '}
                      <A href="/cotizaciones/materiales" class="underline">
                        precios de material
                      </A>
                    </span>
                  </Show>
                </td>
                <td class="tnum py-2 pr-2 text-right text-base font-semibold text-foreground">{mx(estimate())}</td>
                <td class="tnum py-2 text-right text-xs text-muted-foreground">{linesQuotedSum() ? mx(linesQuotedSum()) : ''}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <form
          class="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <label class="space-y-1">
            <span class="block text-xs text-muted-foreground">Proveedor</span>
            <input class={`${field} w-40`} value={supplier()} onInput={(e) => setSupplier(e.currentTarget.value)} placeholder="HG Aceros" />
          </label>
          <label class="space-y-1">
            <span class="block text-xs text-muted-foreground">Total cotizado (sin IVA)</span>
            <input
              class={`${field} tnum w-32 text-right`}
              inputmode="decimal"
              value={total()}
              placeholder={linesQuotedSum() ? String(Math.round(linesQuotedSum())) : '$'}
              onInput={(e) => setTotal(e.currentTarget.value)}
            />
          </label>
          <label class="min-w-40 flex-1 space-y-1">
            <span class="block text-xs text-muted-foreground">Nota (opcional)</span>
            <input class={`${field} w-full`} value={note()} onInput={(e) => setNote(e.currentTarget.value)} placeholder="Folio, vigencia, entrega…" />
          </label>
          <Show when={totalValue() != null && !Number.isNaN(totalValue()!)}>
            <span class="pb-2 text-sm">
              vs prospectado: <Diff quoted={totalValue()!} estimate={estimate()} />
            </span>
          </Show>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar cotización'}
          </Button>
        </form>
      </Show>

      <Show when={(quotes.data ?? []).length}>
        <div class="mt-4 space-y-2">
          <p class="text-xs font-medium text-muted-foreground">Cotizaciones guardadas</p>
          <For each={quotes.data}>{(q) => <SavedQuote quote={q} onDelete={() => window.confirm(`¿Borrar la cotización de ${q.supplier}?`) && remove.mutate(q.id)} />}</For>
        </div>
      </Show>

      <Valuation
        sold={sold()}
        expected={projectEstimate()}
        expectedComplete={projectIncomplete() === 0}
        supplier={quotes.data?.[0]}
      />
    </div>
  )
}

/** Below this the material eats the margin (Daniel: "deberíamos estar 3.5 arriba"). */
const TARGET = DEFAULT_MULTIPLIER

function Times(props: { sold: number; cost: number }): JSX.Element {
  const x = () => props.sold / props.cost
  const color = () =>
    x() >= TARGET ? 'text-emerald-600 dark:text-emerald-400' : x() >= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
  return <span class={`tnum text-lg font-semibold ${color()}`}>{x().toFixed(1)}×</span>
}

/** Quick valuation: what the client pays for the machined parts against their material,
 * expected and quoted by the supplier. It should be about 3.5×. */
function Valuation(props: { sold: number; expected: number; expectedComplete: boolean; supplier?: MaterialQuote }): JSX.Element {
  const card = 'rounded-lg border border-border p-3'
  return (
    <div class="mt-4 rounded-lg bg-muted/40 p-3">
      <p class="text-sm font-semibold text-foreground">Valuación rápida</p>
      <p class="text-xs text-muted-foreground">
        Lo que cobramos por las piezas maquinadas entre lo que cuesta su material. Debería andar en {TARGET}× o más.
      </p>
      <Show
        when={props.sold > 0}
        fallback={<p class="mt-2 text-sm text-muted-foreground">Las partes con material todavía no tienen precio de venta.</p>}
      >
        <div class="mt-2 grid gap-2 sm:grid-cols-3">
          <div class={card}>
            <p class="text-xs text-muted-foreground">Cotizado al cliente</p>
            <p class="tnum text-lg font-semibold text-foreground">{mx(props.sold)}</p>
            <p class="text-[11px] text-muted-foreground">Partes con material, sin comprados</p>
          </div>
          <div class={card}>
            <p class="text-xs text-muted-foreground">Material prospectado (todo el proyecto)</p>
            <Show when={props.expected > 0} fallback={<p class="text-sm text-muted-foreground">—</p>}>
              <p class="tnum text-lg font-semibold text-foreground">{mx(props.expected)}</p>
              <p class="text-xs">
                Cliente / material: <Times sold={props.sold} cost={props.expected} />
              </p>
              <Show when={!props.expectedComplete}>
                <p class="text-[11px] text-amber-700 dark:text-amber-300">Faltan renglones por calcular</p>
              </Show>
            </Show>
          </div>
          <div class={card}>
            <p class="text-xs text-muted-foreground">Material cotizado por el proveedor</p>
            <Show when={props.supplier} fallback={<p class="text-sm text-muted-foreground">Sin cotización guardada</p>}>
              <p class="tnum text-lg font-semibold text-foreground">{mx(props.supplier!.total)}</p>
              <p class="text-xs">
                Cliente / material: <Times sold={props.sold} cost={props.supplier!.total} />
              </p>
              <p class="text-[11px] text-muted-foreground">{props.supplier!.supplier}, la más reciente</p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function SavedQuote(props: { quote: MaterialQuote; onDelete: () => void }): JSX.Element {
  const q = () => props.quote
  const day = () => new Date(q().created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
  return (
    <details class="rounded-lg border border-border p-3 text-sm">
      <summary class="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span class="font-medium text-foreground">{q().supplier}</span>
        <span class="text-xs text-muted-foreground">{day()}</span>
        <span class="tnum">Cotizado {mx(q().total)}</span>
        <span class="tnum text-muted-foreground">Prospectado {mx(q().estimate_total)}</span>
        <Diff quoted={q().total} estimate={q().estimate_total} />
      </summary>
      <Show when={q().note}>
        <p class="mt-2 text-xs text-muted-foreground">{q().note}</p>
      </Show>
      <table class="mt-2 w-full text-xs">
        <thead>
          <tr class="text-left text-muted-foreground">
            <th class="py-1 pr-2 font-normal">Stock</th>
            <th class="py-1 pr-2 text-right font-normal">Prospectado</th>
            <th class="py-1 pr-2 text-right font-normal">Cotizado</th>
            <th class="py-1 text-right font-normal">$/kg del proveedor</th>
          </tr>
        </thead>
        <tbody>
          <For each={q().lines}>
            {(l) => (
              <tr class="border-t border-border">
                <td class="py-1 pr-2 text-foreground">{l.stock}</td>
                <td class="tnum py-1 pr-2 text-right">{l.estimate != null ? mx(l.estimate) : '—'}</td>
                <td class="tnum py-1 pr-2 text-right">
                  {l.quoted != null ? mx(l.quoted) : '—'}
                  <Show when={l.quoted != null && l.estimate}>
                    {' '}
                    <Diff quoted={l.quoted!} estimate={l.estimate!} />
                  </Show>
                </td>
                <td class="tnum py-1 text-right">{l.quoted != null && l.kg ? mx2(l.quoted / l.kg) : '—'}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>Guardó {q().created_by}</span>
        <button type="button" class="text-red-600 hover:underline" onClick={() => props.onDelete()}>
          Borrar
        </button>
      </div>
    </details>
  )
}
