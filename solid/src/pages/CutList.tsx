// Lista de cortes — for the shop floor: per part number, which material and bar to take,
// the cut length and how many cuts from each bar, with the drawing at hand (Daniel,
// 2026-11-03: "que los muchachos entren y sepan qué material le corresponde a cada número
// de parte y en medazos de cuánto tendrían que irlo cortando"). openspec add-part-material
// §3. Bars come from what the admin assigned in Material recibido. No prices.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { PartDrawingThumb, PartName } from '../components/production/PartName'
import { MATERIAL_STATUS, blankLabel } from '../components/projects/PartMaterialCell'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as materialApi from '../lib/api/material'
import type { CutListItem } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const inch = (v: number | null | undefined) => (v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.'))

export default function CutList(): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()
  const canCut = () =>
    auth.isAdmin() || auth.hasPermission('take_work_orders') || auth.hasPermission('manage_production_board')
  const list = createQuery(() => ({ queryKey: ['cut-list'], queryFn: materialApi.getCutList, refetchInterval: 60_000 }))
  const [material, setMaterial] = createSignal<string | null>(null)
  const [showDone, setShowDone] = createSignal(false)
  const [query, setQuery] = createSignal('')

  const materials = createMemo(() => [...new Set((list.data ?? []).map((i) => i.material.material ?? 'Sin material'))])
  const visible = createMemo(() => {
    const q = query().trim().toLowerCase()
    return (list.data ?? []).filter(
      (i) =>
        (showDone() || !i.cut_done) &&
        (!material() || (i.material.material ?? 'Sin material') === material()) &&
        (!q || i.part.toLowerCase().includes(q) || i.folio.toLowerCase().includes(q)),
    )
  })

  const mark = createMutation(() => ({
    mutationFn: (v: { item: CutListItem; done: boolean }) => materialApi.setCutDone(v.item.concept_id, v.done),
    onSuccess: (_d, v) => {
      toast.success(v.done ? `Corte terminado: ${v.item.folio}` : `Corte reabierto: ${v.item.folio}`)
      void qc.invalidateQueries({ queryKey: ['cut-list'] })
      void qc.invalidateQueries({ queryKey: ['project-concepts'] })
      void qc.invalidateQueries({ queryKey: ['production'] })
    },
    onError: (err) => toast.error('No se pudo marcar', humanizeError(err, 'Intenta de nuevo')),
  }))

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${active ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`

  return (
    <div class="space-y-4">
      <PageHeader title="Lista de cortes" subtitle={'Qué barra usar y en cuántos cortes, con 1/16" de ancho de sierra'} />
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class={chip(material() === null)} onClick={() => setMaterial(null)}>
          Todos
        </button>
        <For each={materials()}>
          {(m) => (
            <button type="button" class={chip(material() === m)} onClick={() => setMaterial(m)}>
              {m}
            </button>
          )}
        </For>
        <input
          type="search"
          class="ml-auto h-9 w-56 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
          placeholder="Buscar OT o número de parte"
          aria-label="Buscar en la lista de cortes"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <label class="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showDone()} onChange={(e) => setShowDone(e.currentTarget.checked)} />
          Ver ya cortadas
        </label>
      </div>

      <Show when={list.isLoading}>
        <Spinner />
      </Show>
      <Show when={list.data && visible().length === 0}>
        <p class="text-sm text-muted-foreground">No hay cortes pendientes con este filtro.</p>
      </Show>

      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <For each={visible()}>
          {(i) => (
            <div class={`overflow-hidden rounded-xl border bg-card ${i.cut_done ? 'border-emerald-500/50 opacity-70' : 'border-border'}`}>
              <div class="space-y-1 px-3 pt-3 text-sm">
                <div class="flex items-start justify-between gap-2">
                  <p class="min-w-0 truncate">
                    <span class="tnum font-semibold text-foreground">{i.folio}</span>{' '}
                    <PartName conceptId={i.concept_id} part={i.part} class="font-medium text-foreground" />
                  </p>
                  <Show when={i.status}>
                    {(s) => (
                      <span class={`shrink-0 rounded px-1.5 py-px text-[11px] font-medium ${MATERIAL_STATUS[s()].class}`}>
                        {MATERIAL_STATUS[s()].label}
                      </span>
                    )}
                  </Show>
                </div>
                <p class="text-xs text-muted-foreground">
                  {[i.material.material, i.material.shape].filter(Boolean).join(' ')} · tocho {blankLabel(i.material)} ·{' '}
                  {i.needed} pz
                </p>
              </div>

              <div class="px-3 py-2">
                <Show
                  when={i.bars.length > 0}
                  fallback={
                    <p class="rounded-lg bg-muted/50 px-2 py-2 text-sm text-muted-foreground">
                      Material pendiente: todavía no hay barra asignada
                      <Show when={i.material.bar_to_order}> (se pidió {i.material.bar_to_order})</Show>.
                    </p>
                  }
                >
                  <ul class="space-y-1">
                    <For each={i.bars}>
                      {(b) => (
                        <li class="rounded-lg bg-muted/40 px-2 py-1.5 text-sm">
                          <p class="text-foreground">
                            Barra {[b.thickness, b.width, b.length].filter((v) => v != null).map(inch).join('" × ')}"
                            {' → '}
                            <span class="font-semibold">
                              {b.cuts} {b.cuts === 1 ? 'corte' : 'cortes'} de {inch(i.material.length)}"
                            </span>
                          </p>
                          <p class="text-xs text-muted-foreground">
                            sobran {inch(b.leftover)}" · {b.folio ?? 'factura'} renglón {b.line}
                            <Show when={b.note}> · 🟡 {b.note}</Show>
                          </p>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={i.planned < i.needed}>
                    <p class="mt-1 text-xs font-medium text-rose-600">
                      Faltan {i.needed - i.planned} pz: las barras asignadas no alcanzan.
                    </p>
                  </Show>
                </Show>
              </div>

              <PartDrawingThumb conceptId={i.concept_id} part={i.part} class="h-40 border-t border-border" />

              <Show when={canCut() && i.bars.length > 0}>
                <div class="border-t border-border px-3 py-2">
                  <Button
                    variant={i.cut_done ? 'outline' : 'primary'}
                    disabled={mark.isPending}
                    onClick={() => mark.mutate({ item: i, done: !i.cut_done })}
                  >
                    {i.cut_done ? 'Reabrir corte' : 'Corte terminado'}
                  </Button>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
