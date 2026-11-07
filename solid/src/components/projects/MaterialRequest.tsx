// Material a pedir — per part number the programmer picks the stock it is cut from (material,
// shape, section) and the cut length per piece; with several pieces each one takes .125" more
// for the cut. The parts still to order become one request, grouped by stock, to send by
// WhatsApp or copy (Daniel, 2026-11-06). No prices: programmers use it.
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { Check, Copy, MessageCircle } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { folioOf } from '../production/WorkOrderSearch'
import { MATERIAL_STATUS } from './PartMaterialCell'
import { type SizerApi, StockSizer } from './StockSizer'
import { humanizeError } from '../../lib/api/client'
import { setPartMaterial } from '../../lib/api/material'
import type { PartMaterial, ProjectConcept } from '../../lib/api/types'

/** Extra length per piece for the saw cut when there are several pieces. */
export const CUT_ALLOWANCE = 0.125

const SHAPES = ['redondo', 'solera', 'placa', 'barra', 'cuadrado', 'hexagonal', 'tubo']
const MATERIALS = ['Aluminio 6061', 'Aluminio 7075', '1018', '1045', '4140', 'Inoxidable 304', 'Delrin', 'Delrin negro', 'Delrin blanco', 'G10', 'Nylamid', 'Latón']

const inch = (v: number | null | undefined) => (v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.'))
const isRound = (shape?: string | null) => ['redondo', 'hexagonal'].includes((shape ?? '').toLowerCase())

/** Length to order for one part: n × (L + .125") with several pieces, L for a single one. */
export function lengthToOrder(pieces: number, cut: number): number {
  const n = Math.max(0, Math.ceil(pieces))
  return n > 1 ? n * (cut + CUT_ALLOWANCE) : n * cut
}

/** "Aluminio 6061 solera 1/8 × 1.75" — what the supplier is asked for, without length. */
export function stockLabel(m: PartMaterial): string {
  const round = isRound(m.shape)
  const dims = [m.thickness, round ? null : m.width].filter((d) => d != null).map((d) => `${inch(d)}"`)
  const section = dims.length ? `${round && m.shape?.toLowerCase() === 'redondo' ? 'Ø' : ''}${dims.join(' × ')}` : ''
  return [m.material, m.shape, section].filter(Boolean).join(' ')
}

interface Line {
  concept: ProjectConcept
  material: PartMaterial
  pieces: number
  total: number
}

interface Group {
  stock: string
  lines: Line[]
  total: number
}

export function requestText(projectTitle: string, groups: Group[], date = new Date()): string {
  const day = date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
  const out = ['*Solicitud de material — Sonora Precision*', `Proyecto: ${projectTitle}`, `Fecha: ${day}`, '']
  groups.forEach((g, i) => {
    out.push(`${i + 1}. *${g.stock}*`)
    // Same cut length in several parts goes together: "30 pzas de 5.125""
    const byCut = new Map<number, number>()
    for (const l of g.lines) {
      const cut = l.pieces > 1 ? l.material.length! + CUT_ALLOWANCE : l.material.length!
      byCut.set(cut, (byCut.get(cut) ?? 0) + Math.ceil(l.pieces))
    }
    for (const [cut, n] of byCut) out.push(`   • ${n} ${n === 1 ? 'pza' : 'pzas'} de ${inch(cut)}"`)
    out.push(`   Total: ${inch(+g.total.toFixed(3))}" (${(g.total / 12).toFixed(2)} ft)`)
  })
  out.push('', `Medidas en pulgadas; con varias piezas cada una lleva ${inch(CUT_ALLOWANCE)}" para el corte.`)
  return out.join('\n')
}

export function MaterialRequest(props: {
  projectId: string
  projectTitle: string
  concepts: ProjectConcept[]
  canEdit: boolean
}): JSX.Element {
  const qc = useQueryClient()
  // Parts picked for the request; by default those with stock and not yet ordered.
  const [skip, setSkip] = createSignal<Set<string>>(new Set())

  const pending = (c: ProjectConcept) => {
    const m = c.material
    return !!m && m.length != null && !m.ordered && !m.customer_supplied && c.material_status !== 'recibido' && c.material_status !== 'cortado'
  }
  const lines = createMemo<Line[]>(() =>
    props.concepts
      .filter((c) => pending(c) && !skip().has(c.id))
      .map((c) => ({ concept: c, material: c.material!, pieces: c.quantity, total: lengthToOrder(c.quantity, c.material!.length!) })),
  )
  const groups = createMemo<Group[]>(() => {
    const map = new Map<string, Group>()
    for (const l of lines()) {
      const stock = stockLabel(l.material) || 'Sin material'
      const key = stock.toLowerCase()
      const g = map.get(key) ?? { stock, lines: [], total: 0 }
      g.lines.push(l)
      g.total += l.total
      map.set(key, g)
    }
    return [...map.values()]
  })
  const text = () => requestText(props.projectTitle, groups())

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text())
      toast.success('Solicitud copiada', 'Pégala en WhatsApp o en un correo')
    } catch {
      toast.error('No se pudo copiar', 'Selecciona el texto y cópialo a mano')
    }
  }
  const whatsapp = () => window.open(`https://wa.me/?text=${encodeURIComponent(text())}`, '_blank', 'noopener')

  const markOrdered = createMutation(() => ({
    mutationFn: async () => {
      for (const g of groups())
        for (const l of g.lines)
          await setPartMaterial(l.concept.id, {
            ...l.material,
            ordered: true,
            bar_to_order: `${g.stock} · ${inch(+l.total.toFixed(3))}"`.slice(0, 120),
          })
    },
    onSuccess: () => {
      toast.success('Material marcado como pedido')
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      void qc.invalidateQueries({ queryKey: ['cut-list'] })
    },
    onError: (err) => toast.error('No se pudo marcar', humanizeError(err, 'Intenta de nuevo')),
  }))

  return (
    <div class="space-y-4 pt-4">
      <p class="text-sm text-muted-foreground">
        Escoge de qué stock sale cada número de parte y el largo de corte por pieza. Con varias piezas se suma{' '}
        {inch(CUT_ALLOWANCE)}" por corte a cada una.
      </p>
      <datalist id="stock-materials">
        <For each={MATERIALS}>{(n) => <option value={n} />}</For>
      </datalist>
      <div class="space-y-2">
        <For each={props.concepts}>
          {(c) => (
            <PartStockRow
              concept={c}
              projectId={props.projectId}
              canEdit={props.canEdit}
              included={pending(c) && !skip().has(c.id)}
              canInclude={pending(c)}
              onToggle={(on) =>
                setSkip((s) => {
                  const n = new Set(s)
                  if (on) n.delete(c.id)
                  else n.add(c.id)
                  return n
                })
              }
            />
          )}
        </For>
      </div>

      <div class="rounded-xl border-2 border-primary/40 bg-card p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-base font-semibold text-foreground">Solicitud de material</h3>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!groups().length} onClick={() => void copy()}>
              <Copy class="mr-1.5 h-4 w-4" /> Copiar
            </Button>
            <Button disabled={!groups().length} onClick={whatsapp}>
              <MessageCircle class="mr-1.5 h-4 w-4" /> Enviar por WhatsApp
            </Button>
            <Show when={props.canEdit}>
              <Button
                variant="secondary"
                disabled={!groups().length || markOrdered.isPending}
                onClick={() => window.confirm('¿Marcar estas partes como material pedido?') && markOrdered.mutate()}
              >
                <Check class="mr-1.5 h-4 w-4" /> {markOrdered.isPending ? 'Marcando…' : 'Ya lo pedí'}
              </Button>
            </Show>
          </div>
        </div>
        <Show
          when={groups().length}
          fallback={<p class="mt-3 text-sm text-muted-foreground">No hay material por pedir: captura el stock y el largo de corte de cada parte.</p>}
        >
          <pre class="mt-3 whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-sans text-sm text-foreground">{text()}</pre>
        </Show>
      </div>
    </div>
  )
}

function PartStockRow(props: {
  concept: ProjectConcept
  projectId: string
  canEdit: boolean
  included: boolean
  canInclude: boolean
  onToggle: (on: boolean) => void
}): JSX.Element {
  const qc = useQueryClient()
  const m = () => props.concept.material ?? {}
  const [material, setMaterial] = createSignal(m().material ?? '')
  const [shape, setShape] = createSignal(m().shape ?? 'redondo')
  const round = () => isRound(shape())
  const firstLabel = () => (round() ? (shape() === 'hexagonal' ? 'Entre caras' : 'Diámetro') : 'Espesor')
  // Part size (mm or in) → stock to order (in), suggested and editable.
  const [sizer, setSizer] = createSignal<SizerApi>()

  const dirty = () =>
    material() !== (m().material ?? '') || shape() !== (m().shape ?? 'redondo') || (sizer()?.dirty() ?? false)

  const save = createMutation(() => ({
    mutationFn: (pm: PartMaterial) => setPartMaterial(props.concept.id, pm),
    onSuccess: () => {
      toast.success('Stock guardado', props.concept.name)
      sizer()?.saved()
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      void qc.invalidateQueries({ queryKey: ['cut-list'] })
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa las medidas')),
  }))
  const submit = () => {
    const v = sizer()?.read()
    if (!v || typeof v === 'string') {
      toast.error('Medida inválida', `${v ?? ''}: usa 2.5, 1 1/4, .625 o 63.5 en mm`)
      return
    }
    // Keep what else the part has (notes…); a different stock has to be ordered again.
    const stockChanged =
      material() !== (m().material ?? '') ||
      shape() !== (m().shape ?? '') ||
      v.thickness !== (m().thickness ?? null) ||
      v.width !== (m().width ?? null)
    save.mutate({
      ...m(),
      ...v,
      material: material().trim() || null,
      shape: shape(),
      ordered: stockChanged ? false : (m().ordered ?? false),
    })
  }

  const preview = () => {
    const le = sizer()?.cutLength() ?? null
    return le == null ? null : lengthToOrder(props.concept.quantity, le)
  }

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground disabled:opacity-70'
  return (
    <div class={`rounded-xl border-2 bg-card p-3 ${props.included ? 'border-primary/50' : 'border-border'}`}>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input
          type="checkbox"
          aria-label={`Incluir ${props.concept.name} en la solicitud`}
          checked={props.included}
          disabled={!props.canInclude}
          onChange={(e) => props.onToggle(e.currentTarget.checked)}
        />
        <Show when={props.concept.work_order_number != null}>
          <span class="tnum text-xs text-muted-foreground">{folioOf(props.concept.work_order_number)}</span>
        </Show>
        <span class="font-medium text-foreground">{props.concept.name}</span>
        <span class="tnum text-xs text-muted-foreground">{props.concept.quantity} pzas</span>
        <Show when={props.concept.material_status}>
          {(s) => <span class={`rounded px-1.5 py-px text-[11px] font-medium ${MATERIAL_STATUS[s()].class}`}>{MATERIAL_STATUS[s()].label}</span>}
        </Show>
        <Show when={preview() != null && preview()! > 0}>
          <span class="tnum ml-auto text-sm text-foreground">
            A pedir: <b>{inch(+preview()!.toFixed(3))}"</b>
            <span class="text-xs text-muted-foreground"> ({(preview()! / 12).toFixed(2)} ft)</span>
          </span>
        </Show>
      </div>
      <form
        class="mt-2 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div class="grid grid-cols-3 gap-2">
          <label class="col-span-2 space-y-1">
            <span class="text-xs text-muted-foreground">Material</span>
            <input class={field} list="stock-materials" placeholder="1045" disabled={!props.canEdit} value={material()} onInput={(e) => setMaterial(e.currentTarget.value)} />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Forma</span>
            <select class={field} disabled={!props.canEdit} value={shape()} onChange={(e) => setShape(e.currentTarget.value)}>
              <For each={SHAPES.includes(shape()) ? SHAPES : [shape(), ...SHAPES]}>{(s) => <option value={s} selected={shape() === s}>{s}</option>}</For>
            </select>
          </label>
        </div>
        <StockSizer
          material={m()}
          round={round()}
          firstLabel={firstLabel()}
          disabled={!props.canEdit}
          ref={(api) => setSizer(() => api)}
        />
        <Show when={props.canEdit && dirty()}>
          <div class="flex justify-end">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Guardando…' : 'Guardar stock'}
            </Button>
          </div>
        </Show>
      </form>
    </div>
  )
}
