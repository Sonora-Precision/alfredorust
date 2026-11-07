// Part size → stock to order (Daniel, 2026-11-06): the finished part is typed as on the
// drawing, in mm or in, and shown in inches; below, the stock to order is suggested in
// inches (a little over the part, up to the next 1/4") and stays editable:
// 19 × 50 × 60 mm → .748 × 1.969 × 2.362" → 1" × 2" × 2.5".
import { type JSX, Show, createSignal } from 'solid-js'

import { type LengthUnit, UnitToggle, convertField, parseInches, parseLength } from './PartMaterialCell'
import type { PartMaterial } from '../../lib/api/types'

/** Cleanup over the part on each dimension before rounding up. */
export const STOCK_ALLOWANCE = 1 / 32
/** Stock sizes go in quarter inches. */
export const STOCK_STEP = 0.25

const inch = (v: number | null | undefined) => (v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.'))

/** The stock suggested for one part dimension, in inches. */
export function suggestStock(part: number): number {
  return Math.ceil((part + STOCK_ALLOWANCE) / STOCK_STEP - 1e-6) * STOCK_STEP
}

export type SizerValue = Pick<
  PartMaterial,
  'thickness' | 'width' | 'length' | 'part_thickness' | 'part_width' | 'part_length'
>

export interface SizerApi {
  /** The six measures in inches, or the name of the first invalid field. */
  read: () => SizerValue | string
  dirty: () => boolean
  /** Length per piece being typed (inches), for the "to order" preview. */
  cutLength: () => number | null
  /** After a save: show what was saved, in inches. */
  saved: () => void
}

export function StockSizer(props: {
  material: PartMaterial
  /** Round and hexagonal bars have no width. */
  round: boolean
  /** "Diámetro" / "Entre caras" / "Espesor". */
  firstLabel: string
  disabled?: boolean
  ref: (api: SizerApi) => void
}): JSX.Element {
  const m = () => props.material
  const [unit, setUnit] = createSignal<LengthUnit>('in')
  const [pt, setPt] = createSignal(inch(m().part_thickness))
  const [pw, setPw] = createSignal(inch(m().part_width))
  const [pl, setPl] = createSignal(inch(m().part_length))
  const [st, setSt] = createSignal(inch(m().thickness))
  const [sw, setSw] = createSignal(inch(m().width))
  const [sl, setSl] = createSignal(inch(m().length))
  // A stock field follows the suggestion until it is typed in (or was already saved).
  const [touched, setTouched] = createSignal({ t: m().thickness != null, w: m().width != null, l: m().length != null })

  const partIn = (v: string) => parseLength(v, unit())
  const stockIn = (v: string) => parseInches(v)
  const suggestion = (v: string) => {
    const x = partIn(v)
    return x == null || Number.isNaN(x) ? '' : inch(suggestStock(x))
  }
  const follow = (key: 't' | 'w' | 'l', part: string) => {
    if (touched()[key]) return
    const s = suggestion(part)
    if (key === 't') setSt(s)
    else if (key === 'w') setSw(s)
    else setSl(s)
  }
  const changeUnit = (u: LengthUnit) => {
    const from = unit()
    setPt((v) => convertField(v, from, u))
    setPw((v) => convertField(v, from, u))
    setPl((v) => convertField(v, from, u))
    setUnit(u)
  }
  const resuggest = () => {
    setTouched({ t: false, w: false, l: false })
    follow('t', pt())
    follow('w', pw())
    follow('l', pl())
  }

  const same = (a: number | null, b: number | null | undefined) => (a ?? null) === (b ?? null)
  props.ref({
    read: () => {
      const vals: [string, number | null][] = [
        [`${props.firstLabel} de la pieza`, partIn(pt())],
        ['Ancho de la pieza', props.round ? null : partIn(pw())],
        ['Largo de la pieza', partIn(pl())],
        [`${props.firstLabel} del stock`, stockIn(st())],
        ['Ancho del stock', props.round ? null : stockIn(sw())],
        ['Largo por pieza', stockIn(sl())],
      ]
      const bad = vals.find(([, v]) => v != null && Number.isNaN(v))
      if (bad) return bad[0]
      const [a, b, c, d, e, f] = vals.map(([, v]) => v)
      return { part_thickness: a, part_width: b, part_length: c, thickness: d, width: e, length: f }
    },
    dirty: () =>
      !same(partIn(pt()), m().part_thickness) ||
      (!props.round && !same(partIn(pw()), m().part_width)) ||
      !same(partIn(pl()), m().part_length) ||
      !same(stockIn(st()), m().thickness) ||
      (!props.round && !same(stockIn(sw()), m().width)) ||
      !same(stockIn(sl()), m().length),
    cutLength: () => {
      const x = stockIn(sl())
      return x == null || Number.isNaN(x) ? null : x
    },
    saved: () => {
      if (unit() === 'mm') changeUnit('in')
      setTouched({ t: true, w: true, l: true })
    },
  })

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground disabled:opacity-70'
  const asInches = (v: string) => {
    const x = unit() === 'mm' ? partIn(v) : null
    return x == null || Number.isNaN(x) ? '' : `= ${inch(x)}"`
  }
  const partField = (label: string, value: () => string, set: (v: string) => void, key: 't' | 'w' | 'l', ph: string) => (
    <label class="space-y-1">
      <span class="text-xs text-muted-foreground">
        {label} <span class="tnum font-medium text-foreground">{asInches(value())}</span>
      </span>
      <input
        class={field}
        placeholder={unit() === 'mm' ? ph.split('|')[1] : ph.split('|')[0]}
        disabled={props.disabled}
        value={value()}
        onInput={(e) => {
          set(e.currentTarget.value)
          follow(key, e.currentTarget.value)
        }}
      />
    </label>
  )
  const stockField = (label: string, value: () => string, set: (v: string) => void, key: 't' | 'w' | 'l', part: () => string) => (
    <label class="space-y-1">
      <span class="text-xs text-muted-foreground">
        {label}
        <Show when={touched()[key] && suggestion(part()) && suggestion(part()) !== value()}>
          <span class="tnum"> · sugerido {suggestion(part())}"</span>
        </Show>
      </span>
      <input
        class={field}
        placeholder="in"
        disabled={props.disabled}
        value={value()}
        onInput={(e) => {
          set(e.currentTarget.value)
          setTouched((t) => ({ ...t, [key]: true }))
        }}
      />
    </label>
  )

  return (
    <div class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Medidas de la pieza</p>
        <Show when={!props.disabled}>
          <UnitToggle unit={unit()} onChange={changeUnit} />
        </Show>
      </div>
      <div class={`grid gap-2 ${props.round ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {partField(props.firstLabel, pt, setPt, 't', '.748|19')}
        <Show when={!props.round}>{partField('Ancho', pw, setPw, 'w', '1.969|50')}</Show>
        {partField('Largo', pl, setPl, 'l', '2.362|60')}
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
        <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stock a pedir por pieza (in)</p>
        <Show when={!props.disabled}>
          <button type="button" class="text-xs text-sky-600 hover:underline" onClick={resuggest}>
            Volver a sugerir
          </button>
        </Show>
      </div>
      <div class={`grid gap-2 ${props.round ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {stockField(props.firstLabel, st, setSt, 't', pt)}
        <Show when={!props.round}>{stockField('Ancho', sw, setSw, 'w', pw)}</Show>
        {stockField('Largo por pieza', sl, setSl, 'l', pl)}
      </div>
      <p class="text-[11px] text-muted-foreground">
        Sugerido: la pieza + 1/32" redondeado al siguiente 1/4". Puedes cambiarlo.
      </p>
    </div>
  )
}
