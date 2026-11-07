// Costing a part from Seguimiento with the quoting method (Daniel, 2026-11-07): weight
// (SolidWorks, or the blank) × $/kg of its material = material cost; × multiplier =
// suggested price per piece, his to adjust and save. Admin only: it is money.
import { A } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Drawer } from '../ui/Drawer'
import { toast } from '../ui/Toast'
import { PartDrawingPanel } from '../production/PartName'
import { humanizeError } from '../../lib/api/client'
import { type QuoteLine, setPartQuote, setUnitPrice } from '../../lib/api/quoting'
import { partReferences } from '../../lib/api/quotes'

const money = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 })
const num = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ''))
  return v.trim() === '' ? null : Number.isFinite(n) ? n : NaN
}
/** "PU cotización $585" written in the description when the project came from Notion. */
export function priceInDescription(description?: string | null): number | null {
  const m = description?.match(/PU[^$]*\$\s*([\d,]+(?:\.\d+)?)/i)
  return m ? Number(m[1]!.replace(/,/g, '')) : null
}

export function PartCost(props: {
  projectId: string
  conceptId: string
  partName: string
  description?: string | null
  unitPrice?: number | null
  line: QuoteLine | undefined
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <Show
        when={props.unitPrice != null}
        fallback={
          <button
            type="button"
            class="mt-0.5 block rounded bg-amber-500/15 px-1.5 py-px text-xs font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
            onClick={() => setOpen(true)}
          >
            Sin precio · Costear
          </button>
        }
      >
        <button type="button" class="tnum mt-0.5 block text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)} title="Costear">
          {money(props.unitPrice!)} / pz
        </button>
      </Show>
      <Show when={open()}>
        <CostDrawer {...props} onClose={() => setOpen(false)} />
      </Show>
    </>
  )
}

function CostDrawer(props: {
  projectId: string
  conceptId: string
  partName: string
  description?: string | null
  unitPrice?: number | null
  line: QuoteLine | undefined
  onClose: () => void
}): JSX.Element {
  const qc = useQueryClient()
  const l = () => props.line
  const [weight, setWeight] = createSignal(l()?.entered_weight_kg != null ? String(l()!.entered_weight_kg) : '')
  const [mult, setMult] = createSignal(String(l()?.entered_multiplier ?? l()?.multiplier ?? 3.5))
  const kg = () => {
    const w = num(weight())
    return w == null ? (l()?.weight_kg ?? null) : Number.isNaN(w) ? null : w
  }
  const cost = () => {
    const w = kg()
    const p = l()?.price_per_kg
    return w != null && p != null ? w * p : null
  }
  const suggested = () => {
    const c = cost()
    const m = num(mult())
    return c != null && m != null && !Number.isNaN(m) ? Math.ceil(c * m) : null
  }
  const fromText = priceInDescription(props.description)
  const [price, setPrice] = createSignal(props.unitPrice != null ? String(props.unitPrice) : '')
  const refs = createQuery(() => ({
    queryKey: ['part-references', props.partName],
    queryFn: () => partReferences([props.partName]).then((r) => r[0] ?? []),
    staleTime: 60_000,
  }))
  const shownPrice = createMemo(() => num(price()) ?? suggested())

  const save = createMutation(() => ({
    mutationFn: async () => {
      const w = num(weight())
      const m = num(mult())
      if (Number.isNaN(w) || Number.isNaN(m)) throw new Error('El peso y el multiplicador van en números')
      const p = num(price()) ?? suggested()
      if (p == null || Number.isNaN(p)) throw new Error('Escribe el precio por pieza o completa el costeo')
      const quoteChanged = w !== (l()?.entered_weight_kg ?? null) || m !== (l()?.entered_multiplier ?? null)
      if (quoteChanged && (w != null || m != null)) await setPartQuote(props.conceptId, { weight_kg: w, multiplier: m })
      await setUnitPrice(props.conceptId, p)
    },
    onSuccess: () => {
      toast.success('Precio guardado', props.partName)
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      void qc.invalidateQueries({ queryKey: ['project-quote', props.projectId] })
      props.onClose()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, '')),
  }))

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  const row = 'flex items-center justify-between gap-3 py-1'
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && props.onClose()}
      title={`Costear · ${props.partName}`}
      subtitle="Peso × $/kg del material × multiplicador = precio sugerido"
      aside={<PartDrawingPanel conceptId={props.conceptId} part={props.partName} />}
    >
      <form
        class="space-y-4 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div class="rounded-lg border border-border p-3">
          <p class="text-xs text-muted-foreground">Material</p>
          <Show
            when={l()?.material}
            fallback={<p class="text-amber-700 dark:text-amber-300">Sin material: captúralo en Seguimiento o en Material a pedir para calcular el peso.</p>}
          >
            <p class="font-medium text-foreground">
              {[l()!.material, l()!.shape].filter(Boolean).join(' ')}
              <Show when={l()!.thickness != null}>
                {' · '}
                {[l()!.thickness, l()!.shape === 'redondo' ? null : l()!.width, l()!.length].filter((d) => d != null).join(' × ')}"
              </Show>
            </p>
          </Show>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Peso por pieza (kg, SolidWorks)</span>
            <input
              class={field}
              inputmode="decimal"
              placeholder={l()?.weight_kg != null && l()?.weight_source === 'tocho' ? `${l()!.weight_kg!.toFixed(3)} del tocho` : 'kg'}
              value={weight()}
              onInput={(e) => setWeight(e.currentTarget.value)}
            />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Multiplicador</span>
            <input class={field} inputmode="decimal" value={mult()} onInput={(e) => setMult(e.currentTarget.value)} />
          </label>
        </div>

        <div class="rounded-lg bg-muted/40 p-3">
          <div class={row}>
            <span class="text-muted-foreground">Peso</span>
            <span class="tnum">{kg() != null ? `${kg()!.toFixed(3)} kg ${num(weight()) == null ? '(del tocho)' : '(SolidWorks)'}` : '—'}</span>
          </div>
          <div class={row}>
            <span class="text-muted-foreground">Precio del material</span>
            <Show
              when={l()?.price_per_kg != null}
              fallback={
                <A href="/cotizaciones/materiales" class="text-xs text-sky-600 hover:underline">
                  Sin precio por kg: agrégalo
                </A>
              }
            >
              <span class="tnum">{money(l()!.price_per_kg!)} / kg</span>
            </Show>
          </div>
          <div class={row}>
            <span class="text-muted-foreground">Costo de material por pieza</span>
            <span class="tnum">{cost() != null ? money(cost()!) : '—'}</span>
          </div>
          <div class={`${row} border-t border-border pt-2`}>
            <span class="font-medium text-foreground">Precio sugerido</span>
            <span class="tnum text-base font-semibold text-foreground">{suggested() != null ? money(suggested()!) : '—'}</span>
          </div>
        </div>

        <Show when={fromText != null || (refs.data ?? []).length}>
          <div class="space-y-1">
            <p class="text-xs text-muted-foreground">Referencias</p>
            <Show when={fromText != null}>
              <button type="button" class="block text-left text-xs text-sky-600 hover:underline" onClick={() => setPrice(String(fromText))}>
                En la descripción: {money(fromText!)} · usar
              </button>
            </Show>
            <For each={(refs.data ?? []).slice(0, 4)}>
              {(r) => (
                <button type="button" class="block text-left text-xs text-sky-600 hover:underline" onClick={() => setPrice(String(r.unit_price))}>
                  Antes: {money(r.unit_price)} · {r.kind} · {r.client_name ?? r.project_title ?? ''} {r.folio ?? ''} · usar
                </button>
              )}
            </For>
          </div>
        </Show>

        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">Precio de venta por pieza</span>
          <input
            class={`${field} tnum text-base font-semibold`}
            inputmode="decimal"
            placeholder={suggested() != null ? String(suggested()) : '$'}
            value={price()}
            onInput={(e) => setPrice(e.currentTarget.value)}
          />
          <span class="text-[11px] text-muted-foreground">Vacío = el sugerido. Solo tú ves los precios.</span>
        </label>

        <div class="flex justify-end">
          <Button type="submit" disabled={save.isPending || shownPrice() == null || Number.isNaN(shownPrice()!)}>
            {save.isPending ? 'Guardando…' : `Guardar ${shownPrice() != null && !Number.isNaN(shownPrice()!) ? money(shownPrice()!) : ''}`}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
