// Nueva cotización — before there is a project (Daniel, 2026-11-06: "porque pones el cotizado
// en el proyecto que ya está aprobado??"). The client asks, Daniel picks the client (its saved
// values fill the terms), writes the lines (part number, quantity, material and blank) and
// gets the suggested price by his method: blank weight × $/kg × multiplier (3.5 unless set).
// The price stays his. "?rev=<id>" opens a quote to make its next revision. Admin only.
import { A, useNavigate, useSearchParams } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowLeft, Plus, Trash2 } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'

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
const SHAPES = ['solera', 'placa', 'redondo', 'barra', 'tubo']

interface Line {
  description: string
  quantity: string
  material: string
  shape: string
  thickness: string
  width: string
  length: string
  weight: string
  multiplier: string
  price: string
}

const emptyLine = (): Line => ({
  description: '', quantity: '1', material: '', shape: '', thickness: '', width: '', length: '', weight: '', multiplier: '', price: '',
})
const num = (s: string) => {
  const t = s.trim()
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}
const str = (v: number | null | undefined) => (v == null ? '' : String(v))

function materialOf(l: Line): PartMaterial | null {
  const m: PartMaterial = {
    material: l.material.trim() || null,
    shape: l.shape || null,
    thickness: num(l.thickness),
    width: l.shape === 'redondo' ? null : num(l.width),
    length: num(l.length),
  }
  return Object.values(m).some((v) => v != null) ? m : null
}

export default function QuoteEditor(): JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [search] = useSearchParams<{ rev?: string }>()
  const revOf = () => search.rev || null

  const contacts = createQuery(() => ({ queryKey: ['contacts'], queryFn: financeApi.listContacts }))
  const clients = createQuery(() => ({ queryKey: ['client-quote-defaults'], queryFn: quotesApi.listClientQuoteDefaults }))
  const prices = createQuery(() => ({ queryKey: ['material-prices'], queryFn: quotingApi.listMaterialPrices }))
  const previous = createQuery(() => ({
    queryKey: ['quote', revOf()],
    queryFn: () => quotesApi.getQuote(revOf()!),
    enabled: !!revOf(),
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
        material: l.material?.material ?? '',
        shape: l.material?.shape ?? '',
        thickness: str(l.material?.thickness),
        width: str(l.material?.width),
        length: str(l.material?.length),
        weight: str(l.weight_kg),
        multiplier: str(l.multiplier),
        price: String(l.unit_price),
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
    lines.map((l) => ({ material: materialOf(l), weight_kg: num(l.weight), multiplier: num(l.multiplier) })),
  )
  const suggestions = createQuery(() => ({
    queryKey: ['quote-suggest', JSON.stringify(suggestInput())],
    queryFn: () => quotesApi.suggestLines(suggestInput()),
    placeholderData: (prev: quotesApi.SuggestedLine[] | undefined) => prev,
    staleTime: 30_000,
  }))
  // "Acero 1045" and "1045" (as the invoice names it) are one material, like on the server.
  const materials = createMemo(() => {
    const seen = new Map<string, string>()
    for (const l of lines) if (l.material.trim() && !seen.has(matKey(l.material))) seen.set(matKey(l.material), l.material.trim())
    return [...seen.values()]
  })
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
    mutationFn: () => {
      const person = client()?.people.find((p) => p.name === attention())
      return quotesApi.createQuote({
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
          })),
      })
    },
    onSuccess: (q) => {
      toast.success(`Cotización ${q.folio}`)
      void qc.invalidateQueries({ queryKey: ['quotes'] })
      navigate(`/cotizaciones/${q.id}`)
    },
    onError: (err) => toast.error('No se pudo crear la cotización', humanizeError(err, 'Revisa los datos')),
  }))
  const submit = () => {
    const filled = lines.filter((l) => l.description.trim())
    if (!contactId()) return toast.error('Falta el cliente', 'Escoge a quién va la cotización')
    if (filled.length === 0) return toast.error('Sin partidas', 'Escribe al menos un número de parte')
    if (filled.some((l) => !(num(l.quantity)! > 0) || num(l.price) == null)) {
      return toast.error('Faltan datos', 'Cada partida necesita cantidad y precio unitario')
    }
    create.mutate()
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
        title={revOf() ? `Nueva revisión de ${previous.data?.folio ?? '…'}` : 'Nueva cotización'}
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
              Sugerido = peso del tocho (o el de SolidWorks) × $/kg × multiplicador (3.5 si lo dejas vacío). Medidas en pulgadas.
            </p>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1100px] text-sm">
              <thead class="text-left text-xs text-muted-foreground">
                <tr>
                  <th class="w-6 py-1">#</th>
                  <th class="py-1">No. de parte / descripción</th>
                  <th class="w-16 py-1">Cant.</th>
                  <th class="w-32 py-1">Material</th>
                  <th class="w-24 py-1">Forma</th>
                  <th class="w-48 py-1">Tocho (esp × ancho × largo)</th>
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
                          <input class={`${cell} text-right`} inputmode="decimal" value={l.quantity} onInput={(e) => set(i(), 'quantity', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={cell} list="quote-materials" value={l.material} onInput={(e) => set(i(), 'material', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <select class={cell} value={l.shape} onChange={(e) => set(i(), 'shape', e.currentTarget.value)}>
                            <option value="">—</option>
                            <For each={SHAPES}>{(sh) => <option value={sh} selected={l.shape === sh}>{sh}</option>}</For>
                          </select>
                        </td>
                        <td class="py-1.5 pr-1">
                          <div class="flex gap-1">
                            <input class={`${cell} text-right`} inputmode="decimal" placeholder={l.shape === 'redondo' ? 'Ø' : 'esp'} value={l.thickness} onInput={(e) => set(i(), 'thickness', e.currentTarget.value)} />
                            <Show when={l.shape !== 'redondo'}>
                              <input class={`${cell} text-right`} inputmode="decimal" placeholder="ancho" value={l.width} onInput={(e) => set(i(), 'width', e.currentTarget.value)} />
                            </Show>
                            <input class={`${cell} text-right`} inputmode="decimal" placeholder="largo" value={l.length} onInput={(e) => set(i(), 'length', e.currentTarget.value)} />
                          </div>
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" value={l.weight} onInput={(e) => set(i(), 'weight', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1">
                          <input class={`${cell} text-right`} inputmode="decimal" placeholder="3.5" value={l.multiplier} onInput={(e) => set(i(), 'multiplier', e.currentTarget.value)} />
                        </td>
                        <td class="py-1.5 pr-1 text-right">
                          <Show
                            when={s()?.suggested_unit_price != null}
                            fallback={<span class="text-xs text-muted-foreground">{s()?.missing.length ? `Falta ${s()!.missing.join(', ')}` : '—'}</span>}
                          >
                            <button
                              type="button"
                              class="tabular-nums text-sky-600 hover:underline"
                              title={`Peso ${s()!.weight_kg?.toFixed(3)} kg × $${s()!.price_per_kg}/kg × ${s()!.multiplier}. Toca para usarlo.`}
                              onClick={() => set(i(), 'price', String(s()!.suggested_unit_price))}
                            >
                              {money(s()!.suggested_unit_price!)}
                            </button>
                          </Show>
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
            <datalist id="quote-materials">
              <For each={prices.data ?? []}>{(p) => <option value={p.material} />}</For>
            </datalist>
          </div>
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
        <Button disabled={create.isPending} onClick={submit}>
          {create.isPending ? 'Generando…' : revOf() ? 'Generar revisión' : 'Generar cotización'}
        </Button>
      </div>
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
