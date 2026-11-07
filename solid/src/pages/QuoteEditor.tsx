// Nueva cotización — before there is a project (Daniel, 2026-11-06: "porque pones el cotizado
// en el proyecto que ya está aprobado??"). The client asks, Daniel picks the client (its saved
// values fill the terms), writes the lines (part number, quantity, material and blank) and
// gets the suggested price by his method: blank weight × $/kg × multiplier (3.5 unless set).
// The price stays his. "?rev=<id>" opens a quote to make its next revision. Admin only.
// "?draft=<id>" fills a draft made from the client's request (part numbers, quantities and
// drawings, no prices yet; Daniel, 2026-11-07): each "Guardar borrador" rewrites it, and
// "Generar cotización" turns it into the quote once every line has its price.
import { A, useNavigate, useSearchParams } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowLeft, FileText, Paperclip, Plus, Trash2 } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'

import { type Group, SheetLayouts, groupStock, requestText, stockLine } from '../components/projects/MaterialRequest'
import { MaterialEditor, blankLabel } from '../components/projects/PartMaterialCell'
import { PriceInput } from '../components/quotes/PriceInput'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as financeApi from '../lib/api/finance'
import * as quotesApi from '../lib/api/quotes'
import * as quotingApi from '../lib/api/quoting'
import type { PartMaterial } from '../lib/api/types'
import { money } from '../lib/format'

const SUGGESTED_NOTES = [
  'Todas las dimensiones son basadas en modelos y planos proporcionados por el cliente.',
  'Todas las dimensiones son basadas en pieza muestra proporcionada por el cliente.',
  'Material proporcionado por el cliente.',
]
interface Line {
  description: string
  quantity: string
  /** Same material as a part in Seguimiento (part size, stock, saw cut, sheet); it goes to
   * the part when the quote becomes a project (Daniel, 2026-11-07). */
  mat: PartMaterial | null
  weight: string
  multiplier: string
  price: string
  /** The PDF drawing of the part (a quote file), shown while the measures are taken. */
  drawingId: string | null
  drawingName: string | null
  /** Estimated time: programming (h, once per part number), setup (h, once per order) and
   * cycle (min per piece), for the time-based price (Daniel, 2026-11-07). */
  prog: string
  setup: string
  cycle: string
}

const emptyLine = (): Line => ({
  description: '', quantity: '1', mat: null, weight: '', multiplier: '', price: '', drawingId: null, drawingName: null, prog: '', setup: '', cycle: '',
})
const num = (s: string) => {
  const t = s.trim()
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}
const str = (v: number | null | undefined) => (v == null ? '' : String(v))

const materialOf = (l: Line): PartMaterial | null => (l.mat ? { ...l.mat, ordered: false } : null)

export default function QuoteEditor(): JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams<{ rev?: string; draft?: string }>()
  const revOf = () => search.rev || null
  /** The draft being filled ("?draft=<id>"), saved in place until it is generated. */
  const draftOf = () => search.draft || null

  const contacts = createQuery(() => ({ queryKey: ['contacts'], queryFn: financeApi.listContacts }))
  const clients = createQuery(() => ({ queryKey: ['client-quote-defaults'], queryFn: quotesApi.listClientQuoteDefaults }))
  const prices = createQuery(() => ({ queryKey: ['material-prices'], queryFn: quotingApi.listMaterialPrices }))
  const previous = createQuery(() => ({
    queryKey: ['quote', revOf() ?? draftOf()],
    queryFn: () => quotesApi.getQuote((revOf() ?? draftOf())!),
    enabled: !!(revOf() ?? draftOf()),
  }))

  const sortedContacts = createMemo(() =>
    [...(contacts.data ?? [])].sort((a, b) => Number(b.kind === 'customer') - Number(a.kind === 'customer') || a.name.localeCompare(b.name)),
  )
  const [contactId, setContactId] = createSignal('')
  const client = () => clients.data?.find((c) => c.contact_id === contactId())
  const [attention, setAttention] = createSignal('')
  const [currency, setCurrency] = createSignal<'MXN' | 'USD'>('MXN')
  const [language, setLanguage] = createSignal<'es' | 'en'>('es')
  const [iva, setIva] = createSignal(true)
  const [retention, setRetention] = createSignal(true)
  const [discount, setDiscount] = createSignal('0')
  const [delivery, setDelivery] = createSignal('10')
  const [unit, setUnit] = createSignal<'dias' | 'semanas'>('dias')
  const [validity, setValidity] = createSignal('15')
  const [advance, setAdvance] = createSignal('50')
  const [notes, setNotes] = createSignal<string[]>([])
  const [lines, setLines] = createStore<Line[]>([emptyLine()])

  // A new revision starts from the quote it revises, once.
  let filledFrom: string | null = null
  createEffect(() => {
    const q = previous.data
    if (!q || filledFrom === q.id) return
    filledFrom = q.id
    setContactId(q.contact_id ?? '')
    setAttention(q.attention ?? '')
    setCurrency(q.currency)
    setLanguage(q.language)
    setIva(q.iva)
    setRetention(q.retention)
    setDiscount(String(q.discount))
    setDelivery(String(q.delivery_time))
    setUnit(q.delivery_unit)
    setValidity(String(q.validity_days))
    setAdvance(String(q.advance_pct))
    setNotes(q.notes)
    setLines(
      q.lines.map((l) => ({
        description: l.description,
        quantity: String(l.quantity),
        mat: l.material ?? null,
        weight: str(l.weight_kg),
        multiplier: str(l.multiplier),
        price: l.unit_price > 0 ? String(l.unit_price) : '',
        drawingId: l.drawing_id ?? null,
        drawingName: l.drawing_name ?? null,
        prog: str(l.programming_h),
        setup: str(l.setup_h),
        cycle: str(l.cycle_min),
      })),
    )
  })

  // Picking a client brings its saved values (the template's CLIENTES sheet).
  const pickClient = (id: string) => {
    setContactId(id)
    const c = clients.data?.find((x) => x.contact_id === id)
    if (!c) return
    setCurrency(c.currency)
    setLanguage(c.language)
    setIva(c.iva)
    setRetention(c.retention)
    setValidity(String(c.validity_days))
    setAdvance(String(c.advance_pct))
    setAttention(c.people[0]?.name ?? '')
  }

  // Suggested price per line, recomputed by the server when the material data changes.
  const suggestInput = createMemo(() =>
    lines.map((l) => ({
      material: materialOf(l),
      weight_kg: num(l.weight),
      multiplier: num(l.multiplier),
      quantity: num(l.quantity),
      programming_h: num(l.prog),
      setup_h: num(l.setup),
      cycle_min: num(l.cycle),
    })),
  )
  const suggestions = createQuery(() => ({
    queryKey: ['quote-suggest', currency(), JSON.stringify(suggestInput())],
    queryFn: () => quotesApi.suggestLines(suggestInput(), currency()),
    placeholderData: (prev: quotesApi.SuggestedLine[] | undefined) => prev,
    staleTime: 30_000,
  }))
  // "Acero 1045" and "1045" (as the invoice names it) are one material, like on the server.
  const materials = createMemo(() => {
    const seen = new Map<string, string>()
    for (const l of lines) {
      const name = l.mat?.material?.trim()
      if (name && !seen.has(matKey(name))) seen.set(matKey(name), name)
    }
    return [...seen.values()]
  })
  // The material to order for the whole quote, grouped as in Seguimiento, with its cost.
  const stock = createMemo(() =>
    lines.flatMap((l, i) =>
      l.mat && l.mat.length != null && !l.mat.customer_supplied && (num(l.quantity) ?? 0) > 0
        ? [stockLine(String(i), l.description.trim() || `Partida ${i + 1}`, l.mat, num(l.quantity)!)]
        : [],
    ),
  )
  const stockGroups = createMemo(() => groupStock(stock()))
  /** Material cost of a group (blank weight × $/kg × pieces), or null if a line has no price. */
  const groupCost = (g: Group) => {
    let sum = 0
    for (const l of g.lines) {
      const c = suggestions.data?.[+l.id]?.material_cost
      if (c == null) return null
      sum += c * l.pieces
    }
    return sum
  }
  const materialTotal = createMemo(() => stockGroups().reduce<number | null>((s, g) => (s == null || groupCost(g) == null ? null : s + groupCost(g)!), 0))
  const [editing, setEditing] = createSignal<number | null>(null)

  // When a line's material comes from the client, the note says so (once; it can be unticked).
  const CLIENT_MATERIAL = 'Material proporcionado por el cliente.'
  const anySupplied = createMemo(() => lines.some((l) => l.mat?.customer_supplied))
  createEffect((before: boolean) => {
    const now = anySupplied()
    if (now && !before && !notes().includes(CLIENT_MATERIAL) && notes().length < 3) setNotes([...notes(), CLIENT_MATERIAL])
    return now
  }, true)
  const priceOf = (m: string) => prices.data?.find((p) => matKey(p.material) === matKey(m))

  // Daniel, 2026-11-06: remember each part, and what it was sold or quoted for, as a reference.
  const partNames = createQuery(() => ({ queryKey: ['quote-part-names'], queryFn: quotesApi.listPartNames, staleTime: 60_000 }))
  const lineNames = createMemo(() => lines.map((l) => l.description.trim()))
  const references = createQuery(() => ({
    queryKey: ['quote-references', JSON.stringify(lineNames())],
    queryFn: () => quotesApi.partReferences(lineNames()),
    placeholderData: (prev: quotesApi.PartReference[][] | undefined) => prev,
    staleTime: 60_000,
  }))
  const savePrice = createMutation(() => ({
    mutationFn: (v: { material: string; price: number | null }) => quotingApi.setMaterialPrice(v.material, v.price),
    onSuccess: (_d, v) => {
      toast.success(`${v.material}: precio guardado`)
      void qc.invalidateQueries({ queryKey: ['material-prices'] })
      void qc.invalidateQueries({ queryKey: ['quote-suggest'] })
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa el precio')),
  }))

  const subtotal = createMemo(() => lines.reduce((s, l) => s + (num(l.quantity) ?? 0) * (num(l.price) ?? 0), 0))
  const set = (i: number, key: keyof Line, value: string) => setLines(i, key, value)

  const create = createMutation(() => ({
    mutationFn: (draft: boolean) => {
      const person = client()?.people.find((p) => p.name === attention())
      const payload: quotesApi.QuoteCreatePayload = {
        draft,
        contact_id: contactId() || null,
        revision_of: revOf(),
        attention: attention().trim() || null,
        attention_initials: person?.initials ?? initialsOf(attention()),
        currency: currency(),
        language: language(),
        iva: iva(),
        retention: retention(),
        discount: num(discount()) ?? 0,
        delivery_time: num(delivery()) ?? 0,
        delivery_unit: unit(),
        validity_days: num(validity()) ?? 0,
        advance_pct: num(advance()) ?? 0,
        notes: notes(),
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description.trim(),
            quantity: num(l.quantity) ?? 0,
            unit_price: num(l.price) ?? 0,
            material: materialOf(l),
            weight_kg: num(l.weight),
            multiplier: num(l.multiplier),
            drawing_id: l.drawingId,
            programming_h: num(l.prog),
            setup_h: num(l.setup),
            cycle_min: num(l.cycle),
          })),
      }
      return draftOf() ? quotesApi.updateDraftQuote(draftOf()!, payload) : quotesApi.createQuote(payload)
    },
    onSuccess: (q) => {
      void qc.invalidateQueries({ queryKey: ['quotes'] })
      void qc.invalidateQueries({ queryKey: ['quote', q.id] })
      if (q.draft) {
        toast.success(`Borrador ${q.folio} guardado`, 'Puedes seguir llenándolo aquí o desde Cotizaciones')
        // Further saves rewrite this draft.
        if (draftOf() !== q.id) setSearch({ draft: q.id, rev: undefined }, { replace: true })
        return
      }
      toast.success(`Cotización ${q.folio}`)
      navigate(`/cotizaciones/${q.id}`)
    },
    onError: (err) => toast.error('No se pudo guardar la cotización', humanizeError(err, 'Revisa los datos')),
  }))
  const submit = (draft: boolean) => {
    const filled = lines.filter((l) => l.description.trim())
    if (!contactId()) return toast.error('Falta el cliente', 'Escoge a quién va la cotización')
    if (filled.length === 0) return toast.error('Sin partidas', 'Escribe al menos un número de parte')
    if (filled.some((l) => !(num(l.quantity)! > 0))) return toast.error('Faltan datos', 'Cada partida necesita su cantidad')
    if (!draft && filled.some((l) => !(num(l.price)! > 0))) {
      return toast.error('Faltan precios', 'Ponle precio a cada partida, o guárdala como borrador')
    }
    create.mutate(draft)
  }
  const missingPrices = () => lines.filter((l) => l.description.trim() && !(num(l.price)! > 0)).length

  // The drawing of a line: uploaded once, it goes to the part when the quote becomes a project.
  const [uploading, setUploading] = createSignal<number | null>(null)
  const attach = async (i: number, file: File) => {
    setUploading(i)
    try {
      const f = await quotesApi.uploadQuoteDrawing(file)
      setLines(i, { drawingId: f.id, drawingName: f.filename })
      // A line without a part number takes it from the drawing's name ("PA-1001 Rev A.pdf").
      if (!lines[i]!.description.trim()) setLines(i, 'description', f.filename.replace(/\.pdf$/i, ''))
    } catch (err) {
      toast.error('No se pudo subir el plano', humanizeError(err, 'Debe ser un PDF'))
    } finally {
      setUploading(null)
    }
  }

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  const cell = 'h-8 w-full rounded border border-border bg-background px-1 text-sm tabular-nums'
  const label = 'space-y-1 text-xs text-muted-foreground'
  return (
    <div class="space-y-4">
      <A href="/cotizaciones" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="h-4 w-4" /> Cotizaciones
      </A>
      <PageHeader
        title={
          revOf()
            ? `Nueva revisión de ${previous.data?.folio ?? '…'}`
            : draftOf()
              ? `Borrador ${previous.data?.folio ?? '…'}`
              : 'Nueva cotización'
        }
        breadcrumb={['Cotizaciones']}
      />

      <Card glass glow={false}>
        <CardContent class="space-y-3 p-4">
          <div class="grid gap-2 sm:grid-cols-3">
            <label class={label}>
              Cliente
              <select class={field} value={contactId()} onChange={(e) => pickClient(e.currentTarget.value)}>
                <option value="">Escoge el cliente…</option>
                <For each={sortedContacts()}>
                  {(c) => (
                    <option value={c.id} selected={c.id === contactId()}>
                      {c.name}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class={label}>
              Atención a
              <input class={field} list="quote-people" value={attention()} onInput={(e) => setAttention(e.currentTarget.value)} />
              <datalist id="quote-people">
                <For each={client()?.people ?? []}>{(p) => <option value={p.name} />}</For>
              </datalist>
            </label>
            <label class={label}>
              Moneda · idioma
              <div class="flex gap-1">
                <select class={field} value={currency()} onChange={(e) => setCurrency(e.currentTarget.value as 'MXN' | 'USD')}>
                  <option value="MXN" selected={currency() === 'MXN'}>MXN</option>
                  <option value="USD" selected={currency() === 'USD'}>USD</option>
                </select>
                <select class={field} value={language()} onChange={(e) => setLanguage(e.currentTarget.value as 'es' | 'en')}>
                  <option value="es" selected={language() === 'es'}>Español</option>
                  <option value="en" selected={language() === 'en'}>Inglés</option>
                </select>
              </div>
            </label>
            <label class={label}>
              Tiempo de entrega
              <div class="flex gap-1">
                <input class={`${field} w-20`} inputmode="numeric" value={delivery()} onInput={(e) => setDelivery(e.currentTarget.value)} />
                <select class={field} value={unit()} onChange={(e) => setUnit(e.currentTarget.value as 'dias' | 'semanas')}>
                  <option value="dias" selected={unit() === 'dias'}>días hábiles</option>
                  <option value="semanas" selected={unit() === 'semanas'}>semanas</option>
                </select>
              </div>
            </label>
            <label class={label}>
              Validez (días) · Anticipo %
              <div class="flex gap-1">
                <input class={field} inputmode="numeric" value={validity()} onInput={(e) => setValidity(e.currentTarget.value)} />
                <input class={field} inputmode="decimal" value={advance()} onInput={(e) => setAdvance(e.currentTarget.value)} />
              </div>
            </label>
            <label class={label}>
              Descuento $
              <input class={field} inputmode="decimal" value={discount()} onInput={(e) => setDiscount(e.currentTarget.value)} />
            </label>
          </div>
          <div class="flex flex-wrap gap-4 text-sm">
            <label class="flex items-center gap-2">
              <input type="checkbox" checked={iva()} onChange={(e) => setIva(e.currentTarget.checked)} /> Aplica IVA
            </label>
            <label class="flex items-center gap-2">
              <input type="checkbox" checked={retention()} onChange={(e) => setRetention(e.currentTarget.checked)} /> Retención ISR
            </label>
            <Show when={contactId() && !client()}>
              <span class="text-xs text-muted-foreground">Este cliente no tiene valores de cotización guardados; se usan los de la plantilla.</span>
            </Show>
          </div>
        </CardContent>
      </Card>

      <Card glass glow={false}>
        <CardContent class="space-y-3 p-4">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="text-sm font-semibold text-foreground">Partidas</p>
            <p class="text-xs text-muted-foreground">
              Sugerido Mat. = material × multiplicador (3.5 si lo dejas vacío). Sugerido Tiempo = material + ciclo × tarifa de maquinado + (preparación × maquinado + programación × ingeniería) ÷ cantidad. Medidas en pulgadas.
            </p>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1320px] text-sm">
              <thead class="text-left text-xs text-muted-foreground">
                <tr>
                  <th class="w-6 py-1">#</th>
                  <th class="py-1">No. de parte / descripción</th>
                  <th class="w-20 py-1">Plano</th>
                  <th class="w-16 py-1">Cant.</th>
                  <th class="w-72 py-1">Material y tocho</th>
                  <th class="w-16 py-1" title="Programación / ingeniería, una vez por número de parte">Prog. h</th>
                  <th class="w-16 py-1" title="Preparación de la máquina, una vez por pedido">Prep. h</th>
                  <th class="w-16 py-1" title="Ciclo de máquina por pieza">Ciclo min</th>
                  <th class="w-20 py-1">Peso SW kg</th>
                  <th class="w-14 py-1">×</th>
                  <th class="w-28 py-1 text-right">Sugerido</th>
                  <th class="w-28 py-1 text-right">P. unitario</th>
                  <th class="w-28 py-1 text-right">Total</th>
                  <th class="w-8" />
                </tr>
              </thead>
              <tbody>
                <For each={lines}>
                  {(l, i) => {
                    const s = () => suggestions.data?.[i()]
                    return (
                      <tr class="border-t border-border align-top">
                        <td class="py-1.5 text-xs text-muted-foreground">{i() + 1}</td>
                        <td class="py-1.5 pr-1">
                          <input
                            class={cell}
                            list="quote-parts"
                            value={l.description}
                            onInput={(e) => set(i(), 'description', e.currentTarget.value)}
                          />
                          <PastPrices refs={references.data?.[i()] ?? []} onUse={(p) => set(i(), 'price', String(p))} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <DrawingButton
                            id={l.drawingId}
                            name={l.drawingName}
                            busy={uploading() === i()}
                            disabled={uploading() != null}
                            onFile={(f) => void attach(i(), f)}
                          />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" value={l.quantity} onInput={(e) => set(i(), 'quantity', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <button
                            type="button"
                            class="w-full rounded border border-dashed border-border px-2 py-1 text-left text-xs hover:bg-muted"
                            onClick={() => setEditing(i())}
                          >
                            <Show when={l.mat} fallback={<span class="text-muted-foreground">+ Material</span>}>
                              {(m) => (
                                <>
                                  <span class="block truncate text-foreground">
                                    {[m().material, m().shape].filter(Boolean).join(' ') || 'Sin material'}
                                    <Show when={blankLabel(m())}> · {blankLabel(m())}</Show>
                                  </span>
                                  <span class="block truncate text-muted-foreground">
                                    {m().customer_supplied ? 'Surtido por el cliente' : m().bar_to_order ? `A pedir: ${m().bar_to_order}` : 'Falta el stock'}
                                  </span>
                                </>
                              )}
                            </Show>
                          </button>
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" aria-label="Programación en horas" value={l.prog} onInput={(e) => set(i(), 'prog', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" aria-label="Preparación en horas" value={l.setup} onInput={(e) => set(i(), 'setup', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" aria-label="Ciclo en minutos por pieza" value={l.cycle} onInput={(e) => set(i(), 'cycle', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" value={l.weight} onInput={(e) => set(i(), 'weight', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" placeholder="3.5" value={l.multiplier} onInput={(e) => set(i(), 'multiplier', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1 text-right">
                          <Suggested s={s()} onUse={(p) => set(i(), 'price', String(p))} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" value={l.price} onInput={(e) => set(i(), 'price', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1 text-right tabular-nums">{money((num(l.quantity) ?? 0) * (num(l.price) ?? 0))}</td>
                        <td class="py-1.5">
                          <button
                            type="button"
                            class="text-muted-foreground hover:text-destructive"
                            aria-label="Quitar partida"
                            onClick={() => setLines(produce((ls) => (ls.length > 1 ? ls.splice(i(), 1) : ls.splice(0, 1, emptyLine()))))}
                          >
                            <Trash2 class="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
            <datalist id="quote-parts">
              <For each={partNames.data ?? []}>{(n) => <option value={n} />}</For>
            </datalist>
          </div>
          <Show when={editing() != null && lines[editing()!]}>
            {(l) => (
              <MaterialEditor
                partName={l().description.trim() || `Partida ${editing()! + 1}`}
                material={l().mat ?? {}}
                pieces={num(l().quantity) ?? 1}
                onClose={() => setEditing(null)}
                onSave={(m) => setLines(editing()!, 'mat', m)}
                aside={
                  <QuoteDrawingPanel
                    id={l().drawingId}
                    name={l().drawingName}
                    part={l().description.trim()}
                    busy={uploading() === editing()}
                    onFile={(f) => void attach(editing()!, f)}
                  />
                }
              />
            )}
          </Show>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <Button variant="outline" onClick={() => setLines(lines.length, emptyLine())}>
              <Plus class="h-4 w-4" /> Agregar partida
            </Button>
            <p class="text-sm">
              <span class="text-muted-foreground">Subtotal: </span>
              <span class="font-semibold tabular-nums">{money(subtotal())}</span>
              <span class="text-xs text-muted-foreground"> · el IVA y la retención salen en el documento</span>
            </p>
          </div>
        </CardContent>
      </Card>

      <Show when={stockGroups().length > 0}>
        <Card glass glow={false}>
          <CardContent class="space-y-3 p-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-sm font-semibold text-foreground">Material a cotizar</p>
              <p class="text-xs text-muted-foreground">
                Lo mismo que se pedirá en el proyecto. Costo = peso del tocho × $/kg × piezas (sin el corte de sierra).
              </p>
            </div>
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-muted-foreground">
                <tr>
                  <th class="py-1">Stock</th>
                  <th class="py-1">Partidas</th>
                  <th class="w-32 py-1 text-right">A pedir</th>
                  <th class="w-32 py-1 text-right">Costo material</th>
                </tr>
              </thead>
              <tbody>
                <For each={stockGroups()}>
                  {(g) => (
                    <tr class="border-t border-border align-top">
                      <td class="py-1.5 pr-2 text-foreground">{g.stock}</td>
                      <td class="py-1.5 pr-2 text-xs text-muted-foreground">{g.lines.map((l) => `${l.name} (${l.pieces})`).join(', ')}</td>
                      <td class="py-1.5 text-right tabular-nums">
                        {g.sheet || g.cutToSize ? `${g.total} ${g.total === 1 ? 'pz' : 'pzs'}` : `${+g.total.toFixed(3)}"`}
                      </td>
                      <td class="py-1.5 text-right tabular-nums">
                        <Show when={groupCost(g) != null} fallback={<span class="text-xs text-muted-foreground">Falta precio o peso</span>}>
                          {money(groupCost(g)!)}
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
              <tfoot>
                <tr class="border-t-2 border-border">
                  <td colspan={3} class="py-1.5 text-right text-xs text-muted-foreground">Material de la cotización</td>
                  <td class="py-1.5 text-right font-semibold tabular-nums">{materialTotal() == null ? '—' : `${money(materialTotal()!)}${currency() === 'USD' ? ' USD' : ''}`}</td>
                </tr>
              </tfoot>
            </table>
            <For each={stockGroups().filter((g) => g.layout)}>{(g) => <SheetLayouts group={g} />}</For>
            <details class="text-xs">
              <summary class="cursor-pointer text-muted-foreground">Ver solicitud para el proveedor</summary>
              <pre class="mt-2 whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-sans text-sm text-foreground">
                {requestText(client()?.abbreviation ?? sortedContacts().find((c) => c.id === contactId())?.name ?? 'Nueva cotización', stockGroups(), new Date(), 'Cotización')}
              </pre>
            </details>
          </CardContent>
        </Card>
      </Show>

      <Show when={materials().length > 0}>
        <Card glass glow={false}>
          <CardContent class="space-y-2 p-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-sm font-semibold text-foreground">Precio por kg del material</p>
              <p class="text-xs text-muted-foreground">Se actualiza solo con cada factura de Material recibido; puedes cambiarlo aquí.</p>
            </div>
            <div class="flex flex-wrap gap-3">
              <For each={materials()}>
                {(m) => {
                  const p = () => priceOf(m)
                  // The price before the current one, if it changed.
                  const before = () => p()?.history.find((h) => h.price_per_kg !== p()!.price_per_kg)
                  return (
                    <div class="space-y-0.5">
                      <PriceInput
                        material={m}
                        current={p()?.price_per_kg ?? null}
                        note={p()?.note ?? null}
                        busy={savePrice.isPending}
                        onSave={(price) => savePrice.mutate({ material: m, price })}
                      />
                      <p class="px-1 text-[11px] text-muted-foreground">
                        <Show when={p()} fallback="Sin precio todavía">
                          {p()!.source === 'factura' ? `Factura ${p()!.note ?? ''}` : `A mano · ${shortDay(p()!.as_of)}`}
                          <Show when={before()}>
                            {' '}· antes {money(before()!.price_per_kg)} ({before()!.folio ?? shortDay(before()!.at)})
                          </Show>
                        </Show>
                      </p>
                    </div>
                  )
                }}
              </For>
            </div>
          </CardContent>
        </Card>
      </Show>

      <Card glass glow={false}>
        <CardContent class="space-y-1 p-4">
          <p class="text-xs text-muted-foreground">Notas (6 a 8 de la plantilla, hasta 3)</p>
          <For each={SUGGESTED_NOTES}>
            {(n) => (
              <label class="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={notes().includes(n)}
                  disabled={!notes().includes(n) && notes().length >= 3}
                  onChange={(e) => setNotes(e.currentTarget.checked ? [...notes(), n] : notes().filter((x) => x !== n))}
                />
                {n}
              </label>
            )}
          </For>
        </CardContent>
      </Card>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => navigate('/cotizaciones')}>
          Cancelar
        </Button>
        <Show when={!revOf()}>
          <Button variant="outline" disabled={create.isPending} onClick={() => submit(true)}>
            Guardar borrador
            <Show when={missingPrices() > 0}>
              <span class="ml-1 text-xs text-muted-foreground">({missingPrices()} sin precio)</span>
            </Show>
          </Button>
        </Show>
        <Button disabled={create.isPending} onClick={() => submit(false)}>
          {create.isPending ? 'Guardando…' : revOf() ? 'Generar revisión' : 'Generar cotización'}
        </Button>
      </div>
    </div>
  )
}

/** The two suggested prices of a line: by material (× multiplier) and by time at the company's
 * rates; tap one to use it. Both leave out the material when the client supplies it. */
function Suggested(props: { s: quotesApi.SuggestedLine | undefined; onUse: (price: number) => void }): JSX.Element {
  const cur = () => (props.s?.currency === 'USD' ? ' USD' : '')
  const less = () => (props.s?.customer_supplied ? ' − material del cliente' : '')
  const byMaterial = () => props.s?.suggested_unit_price ?? null
  const t = () => props.s?.time ?? null
  return (
    <div class="space-y-0.5 text-xs">
      <Show
        when={byMaterial() != null}
        fallback={<p class="text-muted-foreground">{props.s?.missing.length ? `Falta ${props.s.missing.join(', ')}` : '—'}</p>}
      >
        <button
          type="button"
          class="block w-full text-right tabular-nums text-sky-600 hover:underline"
          title={`Material ${money(props.s!.material_cost ?? 0)}${cur()} (${props.s!.weight_kg?.toFixed(3)} kg × $${props.s!.price_per_kg}/kg) × ${props.s!.multiplier}${less()}. Toca para usarlo.`}
          onClick={() => props.onUse(byMaterial()!)}
        >
          <span class="text-muted-foreground">Mat. </span>
          {money(byMaterial()!)}
        </button>
      </Show>
      <Show when={t()}>
        {(tp) => (
          <button
            type="button"
            class="block w-full text-right font-medium tabular-nums text-emerald-700 hover:underline dark:text-emerald-300"
            title={[
              `Material ${money(tp().material)}`,
              `Ciclo ${money(tp().cycle)}`,
              `Preparación ${money(tp().setup)}`,
              `Programación ${money(tp().programming)}`,
              `= ${money(tp().unit_price)}${cur()} por pieza · ${tp().hours} h en total. Toca para usarlo.`,
            ].join('\n')}
            onClick={() => props.onUse(tp().unit_price)}
          >
            <span class="font-normal text-muted-foreground">Tiempo </span>
            {money(tp().unit_price)}
          </button>
        )}
      </Show>
    </div>
  )
}

/** A link-looking control that picks one PDF. */
function PdfPicker(props: { busy: boolean; disabled?: boolean; label: string; onFile: (f: File) => void; class: string }): JSX.Element {
  return (
    <label class={`cursor-pointer ${props.class} ${props.disabled ? 'pointer-events-none opacity-50' : ''}`}>
      <Paperclip class="inline h-3.5 w-3.5" /> {props.busy ? 'Subiendo…' : props.label}
      <input
        type="file"
        accept="application/pdf,.pdf"
        class="hidden"
        disabled={props.busy || props.disabled}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (f) props.onFile(f)
        }}
      />
    </label>
  )
}

/** The "Plano" column of a line: upload the drawing, or open the one it has. */
function DrawingButton(props: {
  id: string | null
  name: string | null
  busy: boolean
  disabled: boolean
  onFile: (f: File) => void
}): JSX.Element {
  return (
    <Show
      when={props.id}
      fallback={
        <PdfPicker
          busy={props.busy}
          disabled={props.disabled}
          label="Plano"
          onFile={props.onFile}
          class="inline-flex h-8 items-center gap-1 rounded border border-dashed border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        />
      }
    >
      {(id) => (
        <div class="space-y-0.5">
          <a
            href={quotesApi.quoteDrawingUrl(id())}
            target="_blank"
            rel="noopener"
            title={props.name ?? 'Abrir el plano'}
            class="inline-flex h-8 items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 text-xs text-emerald-700 hover:underline dark:text-emerald-300"
          >
            <FileText class="h-3.5 w-3.5" /> Ver
          </a>
          <PdfPicker busy={props.busy} disabled={props.disabled} label="Cambiar" onFile={props.onFile} class="block text-[11px] text-muted-foreground hover:text-foreground" />
        </div>
      )}
    </Show>
  )
}

/** The drawing of a quote line beside the material form, to take the measures from it. */
function QuoteDrawingPanel(props: {
  id: string | null
  name: string | null
  part: string
  busy: boolean
  onFile: (f: File) => void
}): JSX.Element {
  return (
    <div class="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm">
        <span class="inline-flex min-w-0 items-center gap-2 font-semibold text-foreground">
          <FileText class="h-4 w-4 shrink-0" />
          <span class="truncate">Plano{props.name || props.part ? ` · ${props.name ?? props.part}` : ''}</span>
        </span>
        <span class="flex shrink-0 items-center gap-3 text-xs">
          <PdfPicker busy={props.busy} label={props.id ? 'Cambiar plano' : 'Subir plano'} onFile={props.onFile} class="text-sky-600 hover:underline" />
          <Show when={props.id}>
            {(id) => (
              <a href={quotesApi.quoteDrawingUrl(id())} target="_blank" rel="noopener" class="text-sky-600 hover:underline">
                Abrir en otra pestaña
              </a>
            )}
          </Show>
        </span>
      </div>
      <Show
        when={props.id}
        fallback={
          <div class="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
            <div class="space-y-3">
              <p>Esta partida todavía no tiene plano.</p>
              <PdfPicker
                busy={props.busy}
                label="Subir plano (PDF)"
                onFile={props.onFile}
                class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              />
            </div>
          </div>
        }
      >
        {(id) => <iframe src={`${quotesApi.quoteDrawingUrl(id())}#navpanes=0&view=Fit`} title={`Plano de ${props.part}`} class="h-full w-full flex-1 bg-white" />}
      </Show>
    </div>
  )
}

function initialsOf(name: string): string | null {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts.length ? parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') : null
}

/** Same material key as the server: the alloy when there is one ("Acero 1045" = "1045"). */
function matKey(s: string): string {
  const t = s.trim().toLowerCase().replace('acetal', 'delrin')
  const alloy = t.match(/\b(6061|7075|6063|5052|2024|4140|1018|1045|4340|d2|a2|o1)\b/)
  return alloy ? alloy[1]! : t
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: '2-digit' })

const KIND: Record<quotesApi.PartReference['kind'], { label: string; class: string }> = {
  vendida: { label: 'vendida', class: 'text-emerald-700 dark:text-emerald-300' },
  aprobada: { label: 'aprobada', class: 'text-emerald-700 dark:text-emerald-300' },
  cotizada: { label: 'cotizada', class: 'text-muted-foreground' },
}

/** What this part was sold or quoted for before; tap the price to use it. */
function PastPrices(props: { refs: quotesApi.PartReference[]; onUse: (price: number) => void }): JSX.Element {
  const last = () => props.refs[0]
  const others = () =>
    props.refs
      .slice(1)
      .map((r) => `${money(r.unit_price)} ${r.kind} · ${r.client_name ?? ''} · ${r.folio ?? ''} · ${shortDay(r.date)}`)
      .join('\n')
  return (
    <Show when={last()}>
      {(r) => (
        <p class="mt-0.5 truncate text-[11px] text-muted-foreground" title={others() || undefined}>
          Antes:{' '}
          <button type="button" class="font-semibold tabular-nums text-sky-600 hover:underline" title="Usar este precio" onClick={() => props.onUse(r().unit_price)}>
            {money(r().unit_price)}
          </button>{' '}
          {r().currency !== 'MXN' ? `${r().currency} ` : ''}
          <span class={KIND[r().kind].class}>{KIND[r().kind].label}</span>
          {' · '}
          {[r().client_name, r().folio, `${r().quantity} pzas`, shortDay(r().date)].filter(Boolean).join(' · ')}
          <Show when={props.refs.length > 1}> · +{props.refs.length - 1} más</Show>
        </p>
      )}
    </Show>
  )
}
