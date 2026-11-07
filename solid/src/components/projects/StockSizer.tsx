// Part size → stock to order (Daniel, 2026-11-06): the finished part is typed as on the
// drawing, in mm or in, and shown in inches; below, the stock to order is suggested in
// inches (a little over the part, up to the next 1/4") and stays editable:
// 19 × 50 × 60 mm → .748 × 1.969 × 2.362" → 1" × 2" × 2.5".
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { type LengthUnit, UnitToggle, convertField, parseInches, parseLength } from './PartMaterialCell'
import { NestingView } from './NestingView'
import type { PartMaterial, SheetSpec } from '../../lib/api/types'
import { CUT_PROCESSES, type NestSheet, SHEET_SIZES, isGuillotine, nest } from '../../lib/nesting'

/** Cleanup over the part on each dimension before rounding up. */
export const STOCK_ALLOWANCE = 1 / 32
/** Stock sizes go in quarter inches. */
export const STOCK_STEP = 0.25

const inch = (v: number | null | undefined) => (v == null ? '' : String(+v.toFixed(4)).replace(/^0\./, '.'))

/** The stock suggested for one part dimension, in inches. */
/** Shapes to pick from; a new part starts "Sin asignar" (Daniel, 2026-11-06). */
export const SHAPES = ['redondo', 'solera', 'placa', 'barra', 'cuadrado', 'hexagonal', 'tubo']

/** What the saw takes per piece unless the part says otherwise. */
export const DEFAULT_KERF = 0.125

/** Bar length to order: every piece takes its cut length plus what the saw takes. */
export function barLength(pieces: number, cut: number, kerf: number): number {
  return Math.max(0, Math.ceil(pieces)) * (cut + kerf)
}

export function suggestStock(part: number): number {
  return Math.ceil((part + STOCK_ALLOWANCE) / STOCK_STEP - 1e-6) * STOCK_STEP
}

export type SizerValue = Pick<
  PartMaterial,
  'thickness' | 'width' | 'length' | 'part_thickness' | 'part_width' | 'part_length' | 'saw_kerf' | 'bar_to_order'
>

export interface SizerApi {
  /** The measures in inches with the saw cut and bar to order, or the name of the first invalid field. */
  read: () => SizerValue | string
  dirty: () => boolean
  /** Length per piece being typed (inches), for the "to order" preview. */
  cutLength: () => number | null
  /** Saw cut per piece being typed (inches). */
  kerf: () => number
  /** After a save: show what was saved, in inches. */
  saved: () => void
}

/** Comparable form of a sheet (the server leaves out a missing process). */
const sheetKey = (s: SheetSpec | null | undefined) =>
  s ? [s.width, s.length, s.kerf, s.margin, s.process ?? ''].join('|') : ''

export function StockSizer(props: {
  material: PartMaterial
  /** Round and hexagonal bars have no width. */
  round: boolean
  /** "Diámetro" / "Entre caras" / "Espesor". */
  firstLabel: string
  disabled?: boolean
  /** Pieces of the part: the bar to order is pieces × (length + saw cut). */
  pieces: number
  /** Plates come cut to size from the supplier: ordered as pieces, without saw cut. */
  cutToSize?: boolean
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
  const [kerf, setKerf] = createSignal(inch(m().saw_kerf ?? DEFAULT_KERF))
  const [bar, setBar] = createSignal(m().bar_to_order ?? '')

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

  const kerfIn = () => parseInches(kerf()) ?? 0

  // A plate is bought cut to size or as whole sheets the blanks are nested on (G10 comes
  // 12 × 24 in a given thickness; Daniel, 2026-11-06).
  const s0 = m().sheet
  const [sheetOn, setSheetOn] = createSignal(s0 != null)
  const [sheetW, setSheetW] = createSignal(inch(s0?.width ?? 12))
  const [sheetL, setSheetL] = createSignal(inch(s0?.length ?? 24))
  const [process, setProcess] = createSignal(s0?.process ?? CUT_PROCESSES[0]!.name)
  const [sheetKerf, setSheetKerf] = createSignal(inch(s0?.kerf ?? CUT_PROCESSES[0]!.kerf))
  const [margin, setMargin] = createSignal(inch(s0?.margin ?? 0.25))
  const nested = () => props.cutToSize && sheetOn()
  /** The sheet as typed, or null when off or not valid. */
  const sheet = createMemo<NestSheet | null>(() => {
    if (!nested()) return null
    const [w, l, k, mg] = [sheetW(), sheetL(), sheetKerf(), margin()].map(parseInches)
    if ([w, l, k, mg].some((v) => v == null || Number.isNaN(v)) || !(w! > 0 && l! > 0)) return null
    return { width: w!, length: l!, kerf: k!, margin: mg! }
  })
  const layout = createMemo(() => {
    const sh = sheet()
    const w = stockIn(sw())
    const l = stockIn(sl())
    if (!sh || w == null || l == null || Number.isNaN(w) || Number.isNaN(l)) return null
    return nest([{ id: 'p', label: '', width: w, length: l, quantity: props.pieces }], sh, { guillotine: isGuillotine(process()) })
  })
  const sheetValue = (): SheetSpec | null => {
    const sh = sheet()
    return sh ? { ...sh, process: process() || null } : null
  }

  /** "1.25\" × 3\" × 31.125\"": the stock section by pieces × (length + saw cut). */
  const autoBar = () => {
    const t = stockIn(st())
    const w = props.round ? null : stockIn(sw())
    const l = stockIn(sl())
    const k = kerfIn()
    if (t == null || l == null || [t, l, k, w ?? 0].some(Number.isNaN)) return ''
    const sh = sheet()
    if (sh) {
      const n = layout()?.sheets.length ?? 0
      return `Placa ${inch(t)}" x ${inch(sh.width)}" x ${inch(sh.length)}" - ${n} ${n === 1 ? 'pz' : 'pzs'}`
    }
    if (props.cutToSize) {
      const n = Math.max(0, Math.ceil(props.pieces))
      return `Corte de placa ${inch(t)}" x ${w == null ? '?' : inch(w)}" x ${inch(l)}" - ${n} ${n === 1 ? 'pz' : 'pzs'}`
    }
    const section = props.round ? `Ø${inch(t)}"` : `${inch(t)}" × ${w == null ? '?' : inch(w)}"`
    return `${section} × ${inch(+barLength(props.pieces, l, k).toFixed(3))}"`
  }
  // The bar always opens calculated (Daniel, 2026-11-06: an old one typed by hand hid the
  // calculation); typing in it keeps what is typed until "Calcular".
  const [barTouched, setBarTouched] = createSignal(false)
  const savedBar = () => m().bar_to_order ?? null
  const barValue = () => (barTouched() ? bar() : autoBar() || savedBar() || '')

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
        ['Corte de sierra', parseInches(kerf())],
      ]
      const bad = vals.find(([, v]) => v != null && Number.isNaN(v))
      if (bad) return bad[0]
      if (nested() && !sheet()) return 'Medidas de la placa'
      const [a, b, c, d, e, f, k] = vals.map(([, v]) => v)
      return {
        part_thickness: a,
        part_width: b,
        part_length: c,
        thickness: d,
        width: e,
        length: f,
        saw_kerf: k ?? DEFAULT_KERF,
        sheet: sheetValue(),
        bar_to_order: barValue().trim() || null,
      }
    },
    dirty: () =>
      !same(partIn(pt()), m().part_thickness) ||
      (!props.round && !same(partIn(pw()), m().part_width)) ||
      !same(partIn(pl()), m().part_length) ||
      !same(stockIn(st()), m().thickness) ||
      (!props.round && !same(stockIn(sw()), m().width)) ||
      !same(stockIn(sl()), m().length) ||
      kerfIn() !== (m().saw_kerf ?? DEFAULT_KERF) ||
      sheetKey(sheetValue()) !== sheetKey(m().sheet) ||
      (barValue().trim() || null) !== savedBar(),
    kerf: kerfIn,
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
        {partField(props.firstLabel, pt, setPt, 't', 'in|mm')}
        <Show when={!props.round}>{partField('Ancho', pw, setPw, 'w', 'in|mm')}</Show>
        {partField('Largo', pl, setPl, 'l', 'in|mm')}
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
      <Show when={props.cutToSize}>
        <SheetFields
          on={sheetOn()}
          setOn={setSheetOn}
          disabled={props.disabled}
          sheetW={sheetW}
          setSheetW={setSheetW}
          sheetL={sheetL}
          setSheetL={setSheetL}
          process={process}
          setProcess={setProcess}
          kerf={sheetKerf}
          setKerf={setSheetKerf}
          margin={margin}
          setMargin={setMargin}
          sheet={sheet()}
          layout={layout()}
          pieces={props.pieces}
        />
      </Show>
      <div class="grid grid-cols-3 gap-2 pt-1">
        <Show when={!props.cutToSize}>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Corte de sierra (in)</span>
            <input class={field} placeholder=".125" disabled={props.disabled} value={kerf()} onInput={(e) => setKerf(e.currentTarget.value)} />
          </label>
        </Show>
        <label class={`${props.cutToSize ? 'col-span-3' : 'col-span-2'} space-y-1`}>
          <span class="flex items-center justify-between text-xs text-muted-foreground">
            {nested() ? 'Placas a pedir (completas)' : props.cutToSize ? 'Placas a pedir (cortadas a la medida)' : 'Barra a pedir'}
            <Show when={!barTouched() && savedBar() && savedBar() !== autoBar() && !props.disabled}>
              <button
                type="button"
                class="truncate text-muted-foreground hover:underline"
                title="Lo que estaba guardado antes"
                onClick={() => {
                  setBar(savedBar() ?? '')
                  setBarTouched(true)
                }}
              >
                Antes: {savedBar()}
              </button>
            </Show>
            <Show when={barTouched() && autoBar() && autoBar() !== bar() && !props.disabled}>
              <button type="button" class="text-sky-600 hover:underline" onClick={() => setBarTouched(false)}>
                Calcular: {autoBar()}
              </button>
            </Show>
          </span>
          <input
            class={field}
            placeholder="Se calcula con el stock"
            disabled={props.disabled}
            value={barValue()}
            onInput={(e) => {
              setBar(e.currentTarget.value)
              setBarTouched(true)
            }}
          />
        </label>
      </div>
      <Show when={!props.cutToSize && stockIn(sl()) != null && !Number.isNaN(stockIn(sl())!)}>
        <p class="tnum text-[11px] text-muted-foreground">
          {Math.ceil(props.pieces)} {Math.ceil(props.pieces) === 1 ? 'pza' : 'pzas'} × ({inch(stockIn(sl()))}" + {inch(kerfIn())}" de sierra) ={' '}
          <b class="text-foreground">{inch(+barLength(props.pieces, stockIn(sl())!, kerfIn()).toFixed(3))}"</b> de largo
        </p>
      </Show>
    </div>
  )
}

/** Cut to size or whole sheets: the sheet, how it is cut and the layout of this part. */
function SheetFields(props: {
  on: boolean
  setOn: (on: boolean) => void
  disabled?: boolean
  sheetW: () => string
  setSheetW: (v: string) => void
  sheetL: () => string
  setSheetL: (v: string) => void
  process: () => string
  setProcess: (v: string) => void
  kerf: () => string
  setKerf: (v: string) => void
  margin: () => string
  setMargin: (v: string) => void
  sheet: NestSheet | null
  layout: ReturnType<typeof nest> | null
  pieces: number
}): JSX.Element {
  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground disabled:opacity-70'
  const btn = (active: boolean) =>
    `flex-1 px-3 py-1.5 text-xs font-medium ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`
  const size = () => `${props.sheetW()}x${props.sheetL()}`
  const known = () => SHEET_SIZES.some(([w, l]) => `${w}x${l}` === size())
  const perSheet = () => props.layout?.sheets[0]?.length ?? 0
  return (
    <div class="space-y-2 rounded-lg border border-border p-2">
      <div class="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Cómo se compra la placa">
        <button type="button" class={btn(!props.on)} disabled={props.disabled} aria-pressed={!props.on} onClick={() => props.setOn(false)}>
          Cortada a la medida
        </button>
        <button type="button" class={btn(props.on)} disabled={props.disabled} aria-pressed={props.on} onClick={() => props.setOn(true)}>
          Placa completa (nesting)
        </button>
      </div>
      <Show when={props.on}>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label class="col-span-2 space-y-1">
            <span class="text-xs text-muted-foreground">Placa (in)</span>
            <div class="flex gap-1">
              <select
                class={field}
                disabled={props.disabled}
                value={known() ? size() : 'otra'}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  if (v === 'otra') return
                  const [w, l] = v.split('x')
                  props.setSheetW(w!)
                  props.setSheetL(l!)
                }}
              >
                <For each={SHEET_SIZES}>{([w, l]) => <option value={`${w}x${l}`}>{`${w} × ${l}`}</option>}</For>
                <option value="otra">Otra…</option>
              </select>
              <Show when={!known()}>
                <input class={field} aria-label="Ancho de la placa" disabled={props.disabled} value={props.sheetW()} onInput={(e) => props.setSheetW(e.currentTarget.value)} />
                <input class={field} aria-label="Largo de la placa" disabled={props.disabled} value={props.sheetL()} onInput={(e) => props.setSheetL(e.currentTarget.value)} />
              </Show>
            </div>
          </label>
          <label class="col-span-2 space-y-1">
            <span class="text-xs text-muted-foreground">Se corta con</span>
            <select
              class={field}
              disabled={props.disabled}
              value={props.process()}
              onChange={(e) => {
                const p = CUT_PROCESSES.find((c) => c.name === e.currentTarget.value)
                props.setProcess(e.currentTarget.value)
                if (p) props.setKerf(String(p.kerf).replace(/^0\./, '.'))
              }}
            >
              <For each={CUT_PROCESSES}>{(c) => <option value={c.name}>{c.name}</option>}</For>
            </select>
          </label>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Corte (in)</span>
            <input class={field} disabled={props.disabled} value={props.kerf()} onInput={(e) => props.setKerf(e.currentTarget.value)} />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-muted-foreground">Orilla (in)</span>
            <input class={field} disabled={props.disabled} value={props.margin()} onInput={(e) => props.setMargin(e.currentTarget.value)} />
          </label>
        </div>
        <Show
          when={props.sheet && props.layout}
          fallback={<p class="text-xs text-muted-foreground">Captura el ancho y largo del stock por pieza para acomodarlas.</p>}
        >
          {(_) => (
            <div class="space-y-1">
              <p class="text-sm text-foreground">
                <b>{perSheet()}</b> pzs por placa · <b>{props.layout!.sheets.length}</b>{' '}
                {props.layout!.sheets.length === 1 ? 'placa' : 'placas'} para {Math.ceil(props.pieces)} pzs
                <span class="text-xs text-muted-foreground"> · aprovechamiento {Math.round(props.layout!.usage * 100)}%</span>
              </p>
              <Show when={props.layout!.tooBig.length}>
                <p class="text-xs text-destructive">La pieza no cabe en esta placa.</p>
              </Show>
              <Show when={props.layout!.sheets[0]}>
                {(first) => <NestingView sheet={props.sheet!} placements={first()} ids={['p']} />}
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
