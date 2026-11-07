// Precios de material — what each material costs per kg, for quoting (Daniel, 2026-11-07:
// "deberías tener información de costos de materiales por las facturas que tenemos"). The
// prices come from the supplier invoices downloaded from the SAT ("Leer facturas": preview,
// then save) or are typed by hand. Admin only: it is money.
import { A } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import { type CfdiPrices, listMaterialPrices, pricesFromInvoices, setMaterialPrice } from '../lib/api/quoting'

const money = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 })
const day = (iso: string) => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })

export default function MaterialPrices(): JSX.Element {
  const qc = useQueryClient()
  const prices = createQuery(() => ({ queryKey: ['material-prices'], queryFn: listMaterialPrices }))
  const [preview, setPreview] = createSignal<CfdiPrices | null>(null)
  const [query, setQuery] = createSignal('')
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase()
    return [...(prices.data ?? [])]
      .filter((p) => !q || p.material.toLowerCase().includes(q))
      .sort((a, b) => a.material.localeCompare(b.material, 'es', { numeric: true }))
  })

  const read = createMutation(() => ({
    mutationFn: (apply: boolean) => pricesFromInvoices(apply),
    onSuccess: (r, apply) => {
      if (apply) {
        toast.success('Precios guardados', `${r.updated ?? 0} materiales tomaron el precio de su factura más reciente`)
        setPreview(null)
        void qc.invalidateQueries({ queryKey: ['material-prices'] })
      } else {
        setPreview(r)
      }
    },
    onError: (err) => toast.error('No se pudieron leer las facturas', humanizeError(err, '')),
  }))

  const [newName, setNewName] = createSignal('')
  const [newPrice, setNewPrice] = createSignal('')
  const save = createMutation(() => ({
    mutationFn: (v: { material: string; price: number | null }) => setMaterialPrice(v.material, v.price),
    onSuccess: () => {
      toast.success('Precio guardado')
      setNewName('')
      setNewPrice('')
      void qc.invalidateQueries({ queryKey: ['material-prices'] })
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, '')),
  }))

  const field = 'h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  return (
    <div class="space-y-5">
      <PageHeader
        title="Precios de material"
        breadcrumb={['Cotizaciones', 'Precios de material']}
        subtitle="Precio por kg de cada material para cotizar: de las facturas de proveedores o capturado a mano"
        actions={
          <div class="flex flex-wrap gap-2">
            <A href="/cotizaciones">
              <Button variant="outline">Volver a cotizaciones</Button>
            </A>
            <Button disabled={read.isPending} onClick={() => read.mutate(false)}>
              {read.isPending && !preview() ? 'Leyendo facturas…' : 'Leer facturas del SAT'}
            </Button>
          </div>
        }
      />

      <Show when={preview()}>
        {(r) => (
          <div class="space-y-3 rounded-xl border-2 border-primary/50 bg-card p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="text-base font-semibold text-foreground">Lo que dicen las facturas</h3>
                <p class="text-xs text-muted-foreground">
                  {r().lines.length} renglones de material en las facturas de proveedores. Cada material toma el precio de su factura
                  más reciente, salvo que tenga uno capturado a mano después.
                </p>
              </div>
              <div class="flex gap-2">
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  Cancelar
                </Button>
                <Button
                  disabled={read.isPending || !r().materials.length}
                  onClick={() => window.confirm(`¿Guardar los precios de ${r().materials.length} materiales?`) && read.mutate(true)}
                >
                  {read.isPending ? 'Guardando…' : 'Guardar estos precios'}
                </Button>
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th class="py-1 pr-3">Material</th>
                    <th class="py-1 pr-3 text-right">$/kg (última)</th>
                    <th class="py-1 pr-3">Factura</th>
                    <th class="py-1 pr-3 text-right">Rango</th>
                    <th class="py-1 text-right">Renglones</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={r().materials}>
                    {(m) => (
                      <tr class="border-t border-border">
                        <td class="py-1.5 pr-3 font-medium text-foreground">{m.material}</td>
                        <td class="tnum py-1.5 pr-3 text-right font-semibold text-foreground">{money(m.price_per_kg)}</td>
                        <td class="py-1.5 pr-3 text-muted-foreground">
                          {m.supplier} {m.folio} · {day(m.date)}
                        </td>
                        <td class="tnum py-1.5 pr-3 text-right text-muted-foreground">
                          {money(m.min)} – {money(m.max)}
                        </td>
                        <td class="tnum py-1.5 text-right text-muted-foreground">{m.lines}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Show>

      <div class="flex flex-wrap items-end gap-2">
        <input class={`${field} w-56`} placeholder="Buscar material" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <form
          class="ml-auto flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const p = Number(newPrice().replace(',', '.'))
            if (!newName().trim() || !(p > 0)) return
            save.mutate({ material: newName().trim(), price: p })
          }}
        >
          <input class={`${field} w-44`} placeholder="Material (ej. A36)" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} />
          <input class={`${field} w-28`} inputmode="decimal" placeholder="$/kg" value={newPrice()} onInput={(e) => setNewPrice(e.currentTarget.value)} />
          <Button type="submit" variant="outline" disabled={save.isPending}>
            Agregar a mano
          </Button>
        </form>
      </div>

      <Show when={!prices.isLoading} fallback={<Spinner />}>
        <Show
          when={shown().length}
          fallback={<p class="text-sm text-muted-foreground">Todavía no hay precios. Toca "Leer facturas del SAT" para sacarlos de las facturas.</p>}
        >
          <div class="overflow-x-auto rounded-xl border border-border bg-card">
            <table class="w-full text-sm">
              <thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th class="px-3 py-2">Material</th>
                  <th class="px-3 py-2 text-right">$/kg</th>
                  <th class="px-3 py-2">De dónde</th>
                  <th class="px-3 py-2">Antes</th>
                </tr>
              </thead>
              <tbody>
                <For each={shown()}>
                  {(p) => (
                    <tr class="border-t border-border align-top">
                      <td class="px-3 py-2 font-medium text-foreground">{p.material}</td>
                      <td class="px-3 py-2 text-right">
                        <PriceCell material={p.material} price={p.price_per_kg} onSave={(v) => save.mutate({ material: p.material, price: v })} />
                      </td>
                      <td class="px-3 py-2 text-muted-foreground">
                        {p.source === 'factura' ? (p.note ?? 'Factura') : 'Capturado a mano'} · {day(p.as_of)}
                      </td>
                      <td class="tnum px-3 py-2 text-xs text-muted-foreground">
                        {p.history
                          .slice(0, 4)
                          .map((h) => `${money(h.price_per_kg)} (${day(h.at)})`)
                          .join(' · ')}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </div>
  )
}

/** The price, editable in place: typing one marks it as captured by hand today. */
function PriceCell(props: { material: string; price: number; onSave: (v: number) => void }): JSX.Element {
  const [draft, setDraft] = createSignal<string | null>(null)
  const commit = () => {
    const d = draft()
    setDraft(null)
    if (d == null) return
    const v = Number(d.replace(',', '.').replace('$', ''))
    if (v > 0 && v !== props.price) props.onSave(v)
  }
  return (
    <input
      class="tnum h-8 w-28 rounded-md border border-transparent bg-transparent px-2 text-right font-semibold text-foreground hover:border-border focus:border-border"
      aria-label={`Precio por kg de ${props.material}`}
      value={draft() ?? props.price.toFixed(2)}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}
