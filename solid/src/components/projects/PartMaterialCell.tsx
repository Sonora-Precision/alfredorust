// The material of a part in Seguimiento: what it is cut from, the blank per piece and where
// it stands (Pendiente → Pedido → Recibido → Cortado). The admin edits it; measures accept
// fractions as the shop writes them ("1 1/4", "1/8", ".625"). openspec add-part-material.
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { type JSX, Show, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Drawer } from '../ui/Drawer'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { setPartMaterial } from '../../lib/api/material'
import type { MaterialStatus, PartMaterial } from '../../lib/api/types'

export const MATERIAL_STATUS: Record<MaterialStatus, { label: string; class: string }> = {
  surtido_por_cliente: { label: 'Surtido por cliente', class: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  cortado: { label: 'Cortado', class: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  recibido: { label: 'Recibido', class: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  pedido: { label: 'Pedido', class: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  pendiente: { label: 'Pendiente', class: 'bg-rose-500/10 text-rose-600 dark:text-rose-300' },
}

const num = (v: number | null | undefined) =>
  v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.')

/** "1 1/4" → 1.25, "1/8" → 0.125, ".625" → 0.625; empty → null; invalid → NaN. */
export function parseInches(text: string): number | null {
  const t = text.replace(/["”]/g, '').trim()
  if (!t) return null
  let total = 0
  for (const part of t.split(/\s+/)) {
    const frac = part.match(/^(\d+)\/(\d+)$/)
    if (frac) total += +frac[1]! / +frac[2]!
    else if (/^\d*\.?\d+$/.test(part)) total += +part
    else return NaN
  }
  return total
}

export function blankLabel(m: PartMaterial): string {
  const dims = [m.thickness, m.width, m.length].filter((d) => d != null).map((d) => num(d))
  return dims.length ? `${dims.join(' × ')}"` : ''
}

export function PartMaterialCell(props: {
  conceptId: string
  partName: string
  material: PartMaterial | null | undefined
  status: MaterialStatus | null | undefined
  projectId: string
  canEdit: boolean
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const m = () => props.material
  return (
    <div class="mt-0.5 text-xs">
      <Show
        when={m()}
        fallback={
          <Show when={props.canEdit} fallback={<span class="text-muted-foreground">Sin material</span>}>
            <button type="button" class="text-muted-foreground underline decoration-dotted hover:text-foreground" onClick={() => setOpen(true)}>
              + Material
            </button>
          </Show>
        }
      >
        {(mat) => (
          <button
            type="button"
            class="flex max-w-[18rem] flex-wrap items-center gap-1 text-left text-muted-foreground disabled:cursor-default"
            disabled={!props.canEdit}
            title={mat().bar_to_order ? `Barra a pedir: ${mat().bar_to_order}` : undefined}
            onClick={() => setOpen(true)}
          >
            <span class="truncate">
              {[mat().material, mat().shape].filter(Boolean).join(' ')}
              <Show when={blankLabel(mat())}> · {blankLabel(mat())}</Show>
            </span>
            <Show when={props.status}>
              {(s) => <span class={`rounded px-1.5 py-px text-[11px] font-medium ${MATERIAL_STATUS[s()].class}`}>{MATERIAL_STATUS[s()].label}</span>}
            </Show>
          </button>
        )}
      </Show>
      <Show when={open()}>
        <MaterialEditor
          conceptId={props.conceptId}
          partName={props.partName}
          projectId={props.projectId}
          material={m() ?? {}}
          onClose={() => setOpen(false)}
        />
      </Show>
    </div>
  )
}

function MaterialEditor(props: {
  conceptId: string
  partName: string
  projectId: string
  material: PartMaterial
  onClose: () => void
}): JSX.Element {
  const qc = useQueryClient()
  const [material, setMaterial] = createSignal(props.material.material ?? '')
  const [shape, setShape] = createSignal(props.material.shape ?? 'solera')
  const [t, setT] = createSignal(num(props.material.thickness))
  const [w, setW] = createSignal(num(props.material.width))
  const [l, setL] = createSignal(num(props.material.length))
  const [bar, setBar] = createSignal(props.material.bar_to_order ?? '')
  const [ordered, setOrdered] = createSignal(props.material.ordered ?? false)
  const [supplied, setSupplied] = createSignal(props.material.customer_supplied ?? false)
  const [notes, setNotes] = createSignal(props.material.notes ?? '')

  const save = createMutation(() => ({
    mutationFn: (m: PartMaterial | null) => setPartMaterial(props.conceptId, m),
    onSuccess: () => {
      toast.success('Material guardado', props.partName)
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      props.onClose()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa las medidas')),
  }))

  const submit = () => {
    const dims = [t(), w(), l()].map(parseInches)
    if (dims.some((d) => Number.isNaN(d))) {
      toast.error('Medida inválida', 'Usa pulgadas: 1 1/4, 1/8 o .625')
      return
    }
    save.mutate({
      material: material().trim() || null,
      shape: shape().trim() || null,
      thickness: dims[0],
      width: dims[1],
      length: dims[2],
      bar_to_order: bar().trim() || null,
      ordered: ordered(),
      customer_supplied: supplied(),
      notes: notes().trim() || null,
    })
  }

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  return (
    <Drawer open onOpenChange={(o) => !o && props.onClose()} title={`Material · ${props.partName}`} subtitle="Medidas del tocho por pieza, en pulgadas">
      <form
        class="space-y-3 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div class="grid grid-cols-2 gap-2">
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Material</span>
            <input class={field} list="material-names" placeholder="Aluminio 6061" value={material()} onInput={(e) => setMaterial(e.currentTarget.value)} />
            <datalist id="material-names">
              {['Aluminio 6061', '4140', '1018', 'Delrin', 'Delrin negro', 'Delrin blanco', 'G10', 'Nylamid'].map((n) => (
                <option value={n} />
              ))}
            </datalist>
          </label>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Forma</span>
            <select class={field} value={shape()} onChange={(e) => setShape(e.currentTarget.value)}>
              {['solera', 'placa', 'redondo', 'barra', 'tubo'].map((s) => (
                <option value={s} selected={shape() === s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">{shape() === 'redondo' ? 'Diámetro' : 'Espesor'}</span>
            <input class={field} placeholder='1/8' value={t()} onInput={(e) => setT(e.currentTarget.value)} />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Ancho</span>
            <input class={field} placeholder='1.75' disabled={shape() === 'redondo'} value={w()} onInput={(e) => setW(e.currentTarget.value)} />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Largo de corte</span>
            <input class={field} placeholder='5' value={l()} onInput={(e) => setL(e.currentTarget.value)} />
          </label>
        </div>
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">Barra a pedir</span>
          <input class={field} placeholder='0.125" x 1.75" x 175"' value={bar()} onInput={(e) => setBar(e.currentTarget.value)} />
        </label>
        <div class="flex flex-wrap gap-4">
          <label class="inline-flex items-center gap-2">
            <input type="checkbox" checked={ordered()} onChange={(e) => setOrdered(e.currentTarget.checked)} />
            Ya se pidió
          </label>
          <label class="inline-flex items-center gap-2">
            <input type="checkbox" checked={supplied()} onChange={(e) => setSupplied(e.currentTarget.checked)} />
            Surtido por el cliente
          </label>
        </div>
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">Notas</span>
          <textarea class={`${field} h-16 py-1`} value={notes()} onInput={(e) => setNotes(e.currentTarget.value)} />
        </label>
        <div class="flex justify-between gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => window.confirm(`¿Quitar el material de ${props.partName}?`) && save.mutate(null)}
          >
            Quitar material
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
