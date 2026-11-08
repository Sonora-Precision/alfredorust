// What each part is still missing (Daniel, 2026-11-08): the projects loaded before quotes
// lived in the platform have parts without price, material or sizes. Seguimiento says what
// is missing, filters to it, and lets the prices be typed one after another.
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createSignal } from 'solid-js'

import { Drawer } from '../ui/Drawer'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { setUnitPrice } from '../../lib/api/quoting'
import type { ProjectConcept } from '../../lib/api/types'

export type Gap = 'precio' | 'material' | 'medidas' | 'plano'

export const GAP_LABEL: Record<Gap, string> = {
  precio: 'sin precio',
  material: 'sin material',
  medidas: 'faltan medidas',
  plano: 'sin plano',
}

/** What the part still needs. Price only for whoever sees money; material the client brings
 * needs nothing. */
export function gapsOf(c: ProjectConcept, opts: { money: boolean; hasDrawing: boolean }): Gap[] {
  const out: Gap[] = []
  if (opts.money && c.unit_price == null) out.push('precio')
  const m = c.material
  if (!m?.customer_supplied) {
    if (!m?.material?.trim()) out.push('material')
    else {
      const round = ['redondo', 'hexagonal'].includes((m.shape ?? '').toLowerCase())
      if (m.thickness == null || m.length == null || (!round && m.width == null)) out.push('medidas')
    }
  }
  if (!opts.hasDrawing) out.push('plano')
  return out
}

/** "Faltan datos: 43 sin precio · 16 faltan medidas": each one filters the table. */
export function GapBar(props: {
  counts: Record<Gap, number>
  active: Gap | null
  onPick: (g: Gap | null) => void
  onQuickPrices?: () => void
}): JSX.Element {
  const gaps = () => (Object.keys(GAP_LABEL) as Gap[]).filter((g) => props.counts[g] > 0)
  const chip = (on: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs ${
      on ? 'border-amber-500 bg-amber-500/15 text-amber-800 dark:text-amber-200' : 'border-border text-muted-foreground hover:bg-muted'
    }`
  return (
    <Show when={gaps().length}>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <span class="text-xs font-medium text-amber-700 dark:text-amber-300">Faltan datos:</span>
        <For each={gaps()}>
          {(g) => (
            <button type="button" class={chip(props.active === g)} onClick={() => props.onPick(props.active === g ? null : g)}>
              <span class="tnum font-semibold">{props.counts[g]}</span> {GAP_LABEL[g]}
            </button>
          )}
        </For>
        <Show when={props.active}>
          <button type="button" class="text-xs text-sky-600 hover:underline" onClick={() => props.onPick(null)}>
            Ver todas
          </button>
        </Show>
        <Show when={props.onQuickPrices && props.counts.precio > 0}>
          <button type="button" class="ml-auto rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted" onClick={() => props.onQuickPrices!()}>
            Poner precios rápido
          </button>
        </Show>
      </div>
    </Show>
  )
}

const parsePrice = (v: string) => {
  const t = v.replace(/[$,\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/** Prices one after another: type, Enter, next. Admin only. */
export function QuickPrices(props: { projectId: string; parts: ProjectConcept[]; onClose: () => void }): JSX.Element {
  const qc = useQueryClient()
  const [saved, setSaved] = createSignal<Record<string, number>>({})
  const save = createMutation(() => ({
    mutationFn: (v: { id: string; price: number }) => setUnitPrice(v.id, v.price),
    onSuccess: (_d, v) => {
      setSaved((s) => ({ ...s, [v.id]: v.price }))
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
    },
    onError: (err, v) => {
      sent.delete(v.id)
      toast.error('No se guardó el precio', humanizeError(err, ''))
    },
  }))
  const inputs: HTMLInputElement[] = []
  const sent = new Map<string, number>()
  const commit = (c: ProjectConcept, i: number, el: HTMLInputElement, next: boolean) => {
    const p = parsePrice(el.value)
    if (p == null) {
      if (next) inputs[i + 1]?.focus()
      return
    }
    if (Number.isNaN(p) || p === 0) {
      toast.error('Precio no válido', 'Escribe el precio por pieza en números')
      return
    }
    // Enter and then leaving the field must not save twice.
    if (sent.get(c.id) !== p) {
      sent.set(c.id, p)
      save.mutate({ id: c.id, price: p })
    }
    if (next) inputs[i + 1]?.focus()
  }
  const money = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 })
  return (
    <Drawer open onOpenChange={(o) => !o && props.onClose()} title="Precios faltantes" subtitle={`${props.parts.length} números de parte · precio por pieza, sin IVA`}>
      <div class="space-y-1 p-4 text-sm">
        <p class="pb-2 text-xs text-muted-foreground">Escribe el precio y Enter para pasar al siguiente. Se guarda solo. Para calcularlo por peso, usa "Costear" en la parte.</p>
        <For each={props.parts}>
          {(c, i) => (
            <div class="flex items-center gap-2 border-t border-border py-1.5">
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium text-foreground">{c.name}</p>
                <p class="truncate text-xs text-muted-foreground" title={c.description ?? ''}>
                  {c.quantity} pzs{c.description ? ` · ${c.description}` : ''}
                </p>
              </div>
              <Show when={saved()[c.id] != null}>
                <span class="text-xs text-emerald-600 dark:text-emerald-400" title={`Guardado: ${money(saved()[c.id])}`}>
                  ✔
                </span>
              </Show>
              <input
                ref={(el) => (inputs[i()] = el)}
                class="tnum h-9 w-28 rounded-lg border border-border bg-background px-2 text-right text-foreground"
                inputmode="decimal"
                placeholder="$ por pieza"
                aria-label={`Precio de ${c.name}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commit(c, i(), e.currentTarget, true)
                  }
                }}
                onBlur={(e) => commit(c, i(), e.currentTarget, false)}
              />
            </div>
          )}
        </For>
        <Show when={!props.parts.length}>
          <p class="text-muted-foreground">Todas las partes tienen precio.</p>
        </Show>
      </div>
    </Drawer>
  )
}
