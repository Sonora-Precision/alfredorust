// Cotizaciones of a project (openspec add-quote-document): "Nueva cotización" prefilled with
// the client's values (moneda, idioma, IVA, retención, validez, anticipo, personas) and the
// list of quotes with their folio, net and whether they were sent. Admin only.
import { A, useNavigate } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createEffect, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Card, CardContent } from '../ui/Card'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import * as quotesApi from '../../lib/api/quotes'
import { money } from '../../lib/format'

const SUGGESTED_NOTES = [
  'Todas las dimensiones son basadas en modelos y planos proporcionados por el cliente.',
  'Todas las dimensiones son basadas en pieza muestra proporcionada por el cliente.',
  'Material proporcionado por el cliente.',
]

export function ProjectQuotes(props: { projectId: string; contactId: string | null | undefined }): JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const quotes = createQuery(() => ({
    queryKey: ['project-quotes', props.projectId],
    queryFn: () => quotesApi.listProjectQuotes(props.projectId),
  }))
  const clients = createQuery(() => ({ queryKey: ['client-quote-defaults'], queryFn: quotesApi.listClientQuoteDefaults }))
  const client = () => clients.data?.find((c) => c.contact_id === props.contactId)

  const [open, setOpen] = createSignal(false)
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

  // The client's values, once loaded (the template's CLIENTES sheet).
  createEffect(() => {
    const c = client()
    if (!c) return
    setCurrency(c.currency)
    setLanguage(c.language)
    setIva(c.iva)
    setRetention(c.retention)
    setValidity(String(c.validity_days))
    setAdvance(String(c.advance_pct))
    if (c.people[0] && !attention()) setAttention(c.people[0].name)
  })

  const create = createMutation(() => ({
    mutationFn: () => {
      const person = client()?.people.find((p) => p.name === attention())
      return quotesApi.createQuote(props.projectId, {
        attention: attention().trim() || null,
        attention_initials: person?.initials ?? initialsOf(attention()),
        currency: currency(),
        language: language(),
        iva: iva(),
        retention: retention(),
        discount: Number(discount()) || 0,
        delivery_time: Number(delivery()) || 0,
        delivery_unit: unit(),
        validity_days: Number(validity()) || 0,
        advance_pct: Number(advance()) || 0,
        notes: notes(),
      })
    },
    onSuccess: (q) => {
      toast.success(`Cotización ${q.folio}`)
      void qc.invalidateQueries({ queryKey: ['project-quotes', props.projectId] })
      setOpen(false)
      navigate(`/cotizaciones/${q.id}`)
    },
    onError: (err) => toast.error('No se pudo crear la cotización', humanizeError(err, 'Revisa los datos')),
  }))

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  const label = 'space-y-1 text-xs text-muted-foreground'
  return (
    <Card glass glow={false}>
      <CardContent class="space-y-3 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-semibold text-foreground">Cotizaciones</p>
          <Show when={!open()}>
            <Button onClick={() => setOpen(true)}>+ Nueva cotización</Button>
          </Show>
        </div>

        <Show when={open()}>
          <div class="space-y-3 rounded-lg border border-border p-3 text-sm">
            <p class="text-xs text-muted-foreground">
              Las partidas salen de las piezas con precio cotizado.
              <Show when={!client()}> Este cliente no tiene valores de cotización guardados; se usan los de la plantilla.</Show>
            </p>
            <div class="grid gap-2 sm:grid-cols-3">
              <label class={label}>
                Atención a
                <input class={field} list="quote-people" value={attention()} onInput={(e) => setAttention(e.currentTarget.value)} />
                <datalist id="quote-people">
                  <For each={client()?.people ?? []}>{(p) => <option value={p.name} />}</For>
                </datalist>
              </label>
              <label class={label}>
                Moneda
                <select class={field} value={currency()} onChange={(e) => setCurrency(e.currentTarget.value as 'MXN' | 'USD')}>
                  <option value="MXN" selected={currency() === 'MXN'}>MXN</option>
                  <option value="USD" selected={currency() === 'USD'}>USD</option>
                </select>
              </label>
              <label class={label}>
                Idioma
                <select class={field} value={language()} onChange={(e) => setLanguage(e.currentTarget.value as 'es' | 'en')}>
                  <option value="es" selected={language() === 'es'}>Español</option>
                  <option value="en" selected={language() === 'en'}>Inglés</option>
                </select>
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
                Validez (días)
                <input class={field} inputmode="numeric" value={validity()} onInput={(e) => setValidity(e.currentTarget.value)} />
              </label>
              <label class={label}>
                Anticipo %
                <input class={field} inputmode="decimal" value={advance()} onInput={(e) => setAdvance(e.currentTarget.value)} />
              </label>
              <label class={label}>
                Descuento $
                <input class={field} inputmode="decimal" value={discount()} onInput={(e) => setDiscount(e.currentTarget.value)} />
              </label>
              <label class="flex items-center gap-2 pt-5 text-sm">
                <input type="checkbox" checked={iva()} onChange={(e) => setIva(e.currentTarget.checked)} /> Aplica IVA
              </label>
              <label class="flex items-center gap-2 pt-5 text-sm">
                <input type="checkbox" checked={retention()} onChange={(e) => setRetention(e.currentTarget.checked)} /> Retención ISR
              </label>
            </div>
            <div class="space-y-1">
              <p class="text-xs text-muted-foreground">Notas (6 a 8)</p>
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
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? 'Generando…' : 'Generar cotización'}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={(quotes.data?.length ?? 0) > 0} fallback={<p class="text-xs text-muted-foreground">Todavía no hay cotizaciones de este proyecto.</p>}>
          <ul class="divide-y divide-border text-sm">
            <For each={quotes.data}>
              {(q) => (
                <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                  <A href={`/cotizaciones/${q.id}`} class="font-semibold tabular-nums text-sky-600 hover:underline">
                    {q.folio}
                  </A>
                  <span class="text-xs text-muted-foreground">
                    {q.client_name}
                    <Show when={q.attention}> · {q.attention}</Show> · {new Date(q.date).toLocaleDateString('es-MX')}
                  </span>
                  <span class="tabular-nums">
                    {money(q.net)} {q.currency}
                  </span>
                  <span class={`rounded px-1.5 text-[11px] ${q.sent_at ? 'bg-emerald-500/15 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>
                    {q.sent_at ? 'Enviada' : 'Borrador'}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </CardContent>
    </Card>
  )
}

function initialsOf(name: string): string | null {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts.length ? parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') : null
}
