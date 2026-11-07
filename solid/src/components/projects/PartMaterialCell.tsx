// The material of a part in Seguimiento: what it is cut from, the blank per piece and where
// it stands (Pendiente → Pedido → Recibido → Cortado). The admin edits it; measures accept
// fractions as the shop writes them ("1 1/4", "1/8", ".625"). openspec add-part-material.
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { Scissors } from 'lucide-solid'
import { type JSX, Show, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Drawer } from '../ui/Drawer'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { queuePartToSaw, setPartMaterial } from '../../lib/api/material'
import type { CutListItem, MaterialStatus, PartMaterial } from '../../lib/api/types'
import { useAuth } from '../../lib/auth/AuthContext'

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

export type LengthUnit = 'in' | 'mm'

/** A measure in `unit` (or with its own "mm" / "in" / '"' suffix), always back in inches:
 * "50.8" mm → 2, "1 1/4" in → 1.25. Empty → null; invalid → NaN. */
export function parseLength(text: string, unit: LengthUnit): number | null {
  let t = text.trim().toLowerCase()
  let u = unit
  if (t.endsWith('mm')) {
    u = 'mm'
    t = t.slice(0, -2)
  } else if (t.endsWith('in') || t.endsWith('"') || t.endsWith('”')) {
    u = 'in'
    t = t.replace(/(in|["”])$/, '')
  }
  const v = parseInches(t.replace(',', '.'))
  if (v == null || Number.isNaN(v)) return v
  return u === 'mm' ? +(v / 25.4).toFixed(4) : v
}

/** A typed measure shown in another unit when the toggle changes ("2" in → "50.8" mm). */
export function convertField(text: string, from: LengthUnit, to: LengthUnit): string {
  if (from === to) return text
  const inches = parseLength(text, from)
  if (inches == null || Number.isNaN(inches)) return text
  return to === 'mm' ? String(+(inches * 25.4).toFixed(2)) : num(inches)
}

export function blankLabel(m: PartMaterial): string {
  const round = m.shape?.toLowerCase() === 'redondo'
  const dims = [m.thickness, round ? null : m.width, m.length].filter((d) => d != null).map((d) => num(d))
  if (!dims.length) return ''
  return `${round && m.thickness != null ? 'Ø' : ''}${dims.join(' × ')}"`
}

export function PartMaterialCell(props: {
  conceptId: string
  partName: string
  material: PartMaterial | null | undefined
  status: MaterialStatus | null | undefined
  projectId: string
  canEdit: boolean
  /** Its row in the cut list (place in the saw queue, cut done). */
  cut?: CutListItem
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
      <Show when={m()?.length != null && props.cut && !props.cut.cut_done}>
        <SendToSaw conceptId={props.conceptId} partName={props.partName} position={props.cut?.saw_position ?? null} />
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

/** "Pasar a corte": into the Sierra cinta queue; once there, its place in it. */
export function SendToSaw(props: { conceptId: string; partName: string; position: number | null }): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()
  const canSend = () =>
    auth.isAdmin() || auth.hasPermission('take_work_orders') || auth.hasPermission('manage_production_board')
  const send = createMutation(() => ({
    mutationFn: () => queuePartToSaw(props.conceptId),
    onSuccess: () => {
      toast.success('En la fila de la sierra', props.partName)
      void qc.invalidateQueries({ queryKey: ['cut-list'] })
      void qc.invalidateQueries({ queryKey: ['production'] })
    },
    onError: (err) => toast.error('No se pudo pasar a corte', humanizeError(err, 'Intenta de nuevo')),
  }))
  return (
    <Show
      when={props.position == null}
      fallback={<p class="mt-0.5 text-xs text-sky-700 dark:text-sky-300">✂ En fila de la sierra · #{props.position}</p>}
    >
      <Show when={canSend()}>
        <button
          type="button"
          class="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:underline disabled:opacity-50"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          <Scissors class="h-3.5 w-3.5" />
          {send.isPending ? 'Enviando…' : 'Pasar a corte'}
        </button>
      </Show>
    </Show>
  )
}

export function MaterialEditor(props: {
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
  // Measures may be typed in mm; they are saved in inches.
  const [unit, setUnit] = createSignal<LengthUnit>('in')

  const save = createMutation(() => ({
    mutationFn: (m: PartMaterial | null) => setPartMaterial(props.conceptId, m),
    onSuccess: () => {
      toast.success('Material guardado', props.partName)
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      void qc.invalidateQueries({ queryKey: ['production'] })
      void qc.invalidateQueries({ queryKey: ['cut-list'] })
      props.onClose()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa las medidas')),
  }))

  // A round bar is asked for by diameter and length; it has no width.
  const round = () => shape() === 'redondo'

  const submit = () => {
    const dims = [t(), round() ? '' : w(), l()].map((v) => parseLength(v, unit()))
    if (dims.some((d) => Number.isNaN(d))) {
      toast.error('Medida inválida', unit() === 'mm' ? 'Usa milímetros: 50.8 o 12' : 'Usa pulgadas: 1 1/4, 1/8 o .625')
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
    <Drawer open onOpenChange={(o) => !o && props.onClose()} title={`Material · ${props.partName}`} subtitle="Medidas del tocho por pieza; en mm se guardan en pulgadas">
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
        <UnitToggle
          unit={unit()}
          onChange={(u) => {
            const from = unit()
            setT((v) => convertField(v, from, u))
            setW((v) => convertField(v, from, u))
            setL((v) => convertField(v, from, u))
            setUnit(u)
          }}
        />
        <div class={`grid gap-2 ${round() ? 'grid-cols-2' : 'grid-cols-3'}`}>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">{round() ? 'Diámetro' : 'Espesor'}</span>
            <input class={field} placeholder={round() ? '1 1/4' : '1/8'} value={t()} onInput={(e) => setT(e.currentTarget.value)} />
          </label>
          <Show when={!round()}>
            <label class="space-y-1">
              <span class="text-xs text-muted-foreground">Ancho</span>
              <input class={field} placeholder="1.75" value={w()} onInput={(e) => setW(e.currentTarget.value)} />
            </label>
          </Show>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Largo de corte</span>
            <input class={field} placeholder="5" value={l()} onInput={(e) => setL(e.currentTarget.value)} />
          </label>
        </div>
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">Barra a pedir</span>
          <input class={field} placeholder={round() ? 'Ø1.25" x 144"' : '0.125" x 1.75" x 175"'} value={bar()} onInput={(e) => setBar(e.currentTarget.value)} />
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

/** "in | mm": the unit the measures are typed in; they are always saved in inches. */
export function UnitToggle(props: { unit: LengthUnit; onChange: (u: LengthUnit) => void; disabled?: boolean }): JSX.Element {
  const btn = (u: LengthUnit) =>
    `px-2.5 py-1 text-xs font-medium ${props.unit === u ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`
  return (
    <div class="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span>Medidas en</span>
      <div class="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label="Unidad de las medidas">
        <button type="button" class={btn('in')} disabled={props.disabled} aria-pressed={props.unit === 'in'} onClick={() => props.onChange('in')}>
          in
        </button>
        <button type="button" class={btn('mm')} disabled={props.disabled} aria-pressed={props.unit === 'mm'} onClick={() => props.onChange('mm')}>
          mm
        </button>
      </div>
    </div>
  )
}
