// Cotización as the shop's template prints it (00-PLANTILLA COTIZACIONES SONORA PRECISION V5,
// quote 261103-01-00): A4, black bars, header with logo and company data, striped lines,
// terms 1–5 plus notes and the totals with NETO. "Guardar PDF" prints it from the browser;
// the toolbar never prints. openspec add-quote-document. Admin only.
import { A, useNavigate, useParams } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowLeft, FileDown, Send, Copy } from 'lucide-solid'
import { type JSX, For, Show } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as quotesApi from '../lib/api/quotes'
import type { QuoteDocument as Doc } from '../lib/api/quotes'

const TXT = {
  es: {
    title: 'COTIZACIÓN', date: 'Fecha', number: 'Nº de Cotización', attention: 'Atención a:', client: 'Cliente:',
    item: 'ITEM', qty: 'CANT.', desc: 'DESCRIPCIÓN', pu: 'P. UNITARIO', total: 'TOTAL', terms: 'Términos y Condiciones',
    subtotal: 'Total parcial', discount: 'Descuento', iva: 'Impuestos (IVA)', retention: 'Retención ISR', net: 'NETO',
    thanks: 'Gracias por su Preferencia!!!',
    t1: (d: number) => `1.- Duración de la Oferta ${d} días`,
    t2: (a: number) => `2.- Anticipo del ${a}% antes de la producción.`,
    t3: (n: number, u: string) => `3.- Tiempo de entrega: ${n} ${u} a partir de entregada la orden de compra y anticipo.`,
    t4: (r: number) => `4.- ${r}% restante contra entrega.`,
    t5: (m: string) => `5.- Precio en ${m}.`,
    days: 'días hábiles', weeks: 'semanas', MXN: 'Pesos Mexicanos (MXN)', USD: 'Dólares Americanos (USD)',
  },
  en: {
    title: 'QUOTATION', date: 'Date', number: 'Quotation No.', attention: 'Attention:', client: 'Customer:',
    item: 'ITEM', qty: 'QTY', desc: 'DESCRIPTION', pu: 'UNIT PRICE', total: 'TOTAL', terms: 'Terms & Conditions',
    subtotal: 'Subtotal', discount: 'Discount', iva: 'Taxes (VAT)', retention: 'Tax Retention', net: 'NET TOTAL',
    thanks: 'Thank you for your business!!!',
    t1: (d: number) => `1.- Offer validity: ${d} days`,
    t2: (a: number) => `2.- ${a}% down payment prior to production.`,
    t3: (n: number, u: string) => `3.- Delivery time: ${n} ${u} from receipt of the purchase order and advance payment.`,
    t4: (r: number) => `4.- The remaining ${r}% payable upon delivery.`,
    t5: (m: string) => `5.- Price in ${m}.`,
    days: 'business days', weeks: 'weeks', MXN: 'Mexican Pesos (MXN)', USD: 'United States Dollars (USD)',
  },
} as const

const pct = (v: number) => String(+v.toFixed(2))

export default function QuoteDocument(): JSX.Element {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const doc = createQuery(() => ({ queryKey: ['quote', params.id], queryFn: () => quotesApi.getQuote(params.id) }))

  const revise = createMutation(() => ({
    mutationFn: () => quotesApi.reviseQuote(params.id),
    onSuccess: (q) => {
      toast.success(`Revisión ${q.folio}`)
      void qc.invalidateQueries({ queryKey: ['project-quotes'] })
      navigate(`/cotizaciones/${q.id}`)
    },
    onError: (err) => toast.error('No se pudo crear la revisión', humanizeError(err, 'Intenta de nuevo')),
  }))
  const sent = createMutation(() => ({
    mutationFn: () => quotesApi.markQuoteSent(params.id),
    onSuccess: () => {
      toast.success('Cotización marcada como enviada')
      void qc.invalidateQueries({ queryKey: ['quote', params.id] })
      void qc.invalidateQueries({ queryKey: ['project-quotes'] })
    },
    onError: (err) => toast.error('No se pudo marcar', humanizeError(err, 'Intenta de nuevo')),
  }))

  // The PDF takes the file name the shop uses: 261103-01-00-AC-BRABA.
  const savePdf = (d: Doc) => {
    const before = document.title
    document.title = [d.folio, d.attention_initials, d.client_abbreviation].filter(Boolean).join('-')
    window.print()
    document.title = before
  }

  return (
    <div class="space-y-4">
      <style>{PRINT_CSS}</style>
      <Show when={doc.data} fallback={<Spinner />}>
        {(d) => (
          <>
            <div class="no-print flex flex-wrap items-center justify-between gap-2">
              <A href={`/projects/${d().project_id}`} class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft class="h-4 w-4" /> Proyecto
              </A>
              <div class="flex flex-wrap gap-2">
                <Button onClick={() => savePdf(d())}>
                  <FileDown class="h-4 w-4" /> Guardar PDF
                </Button>
                <Button variant="outline" disabled={revise.isPending} onClick={() => revise.mutate()}>
                  <Copy class="h-4 w-4" /> Nueva revisión
                </Button>
                <Button
                  variant="outline"
                  disabled={sent.isPending || !!d().sent_at}
                  onClick={() => window.confirm(`¿Marcar ${d().folio} como enviada?`) && sent.mutate()}
                >
                  <Send class="h-4 w-4" /> {d().sent_at ? `Enviada ${new Date(d().sent_at!).toLocaleDateString('es-MX')}` : 'Marcar como enviada'}
                </Button>
              </div>
            </div>
            <div class="overflow-x-auto">
              <Sheet d={d()} />
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function Sheet(props: { d: Doc }): JSX.Element {
  const d = () => props.d
  const t = () => TXT[d().language] ?? TXT.es
  const money = (v: number) =>
    v.toLocaleString(d().language === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency: d().currency, currencyDisplay: 'narrowSymbol' })
  const date = () => {
    const at = new Date(d().date)
    return `${at.getDate()}/${at.getMonth() + 1}/${at.getFullYear()}`
  }
  const c = () => d().company
  // At least 16 rows, like the printed template.
  const rows = () => {
    const lines = d().lines.map((l) => ({ ...l, empty: false }))
    const pad = Math.max(0, 16 - lines.length)
    return [...lines, ...Array.from({ length: pad }, (_, i) => ({ item: lines.length + i + 1, quantity: 0, description: '', unit_price: 0, empty: true }))]
  }
  return (
    <div class="quote-sheet mx-auto bg-white text-[11px] text-neutral-900 shadow-lg" style={{ width: '210mm', 'min-height': '297mm' }}>
      <div class="h-3 bg-black" />
      <div class="flex items-start gap-6 bg-neutral-100 px-6 py-4">
        <Show when={c().logo_data_url} fallback={<div class="h-28 w-36 bg-black" />}>
          <img src={c().logo_data_url!} alt={c().company_name} class="h-28 w-36 object-contain" />
        </Show>
        <div class="flex-1 space-y-0.5 pt-2 text-neutral-600">
          <p class="text-base text-neutral-800">{c().company_name}</p>
          <p>{c().address1}</p>
          <p>{c().address2}</p>
          <p class="pt-1">{c().phone}</p>
          <p class="text-sky-700 underline">{c().email}</p>
          <p class="text-sky-700 underline">{c().web}</p>
        </div>
        <div class="w-48 text-center">
          <p class="text-3xl font-light text-neutral-500">{t().title}</p>
          <p class="mt-5 border-b border-neutral-300 font-semibold text-sky-900">{t().date}</p>
          <p class="py-0.5">{date()}</p>
          <p class="border-b border-neutral-300 font-semibold text-sky-900">{t().number}</p>
          <p class="py-0.5">{d().folio}</p>
        </div>
      </div>
      <div class="grid grid-cols-2 px-24 pb-3 pt-2">
        <div>
          <p class="text-[10px] text-neutral-500">{t().attention}</p>
          <p class="font-semibold text-sky-900">{d().attention ?? ''}</p>
        </div>
        <div>
          <p class="text-[10px] text-neutral-500">{t().client}</p>
          <p class="font-semibold text-sky-900">{d().client_name}</p>
        </div>
      </div>
      <div class="px-6">
        <table class="w-full border-collapse border border-neutral-700">
          <thead>
            <tr class="bg-black text-white">
              <th class="w-14 py-1">{t().item}</th>
              <th class="w-24">{t().qty}</th>
              <th>{t().desc}</th>
              <th class="w-24">{t().pu}</th>
              <th class="w-28">{t().total}</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(l, i) => (
                <tr class={i() % 2 ? 'bg-neutral-200' : ''}>
                  <td class="border-x border-neutral-400 py-0.5 text-center">{l.item}</td>
                  <td class="border-x border-neutral-400 text-center">{l.empty ? '' : l.quantity}</td>
                  <td class="border-x border-neutral-400 text-center">{l.description}</td>
                  <td class="border-x border-neutral-400 text-center">{l.empty ? '' : money(l.unit_price)}</td>
                  <td class="border-x border-neutral-400 text-center">{l.empty ? '' : money(l.quantity * l.unit_price)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="mt-10 grid grid-cols-[1fr_15rem] gap-6 px-6">
        <div class="space-y-1.5">
          <p class="pl-16 text-sm font-semibold text-neutral-700">{t().terms}</p>
          <p>{t().t1(d().validity_days)}</p>
          <p>{t().t2(+pct(d().advance_pct))}</p>
          <p>{t().t3(d().delivery_time, d().delivery_unit === 'semanas' ? t().weeks : t().days)}</p>
          <p>{t().t4(+pct(d().remaining_pct))}</p>
          <p>{t().t5(t()[d().currency])}</p>
          <For each={d().notes}>{(n, i) => <p>{`${i() + 6}.- ${n}`}</p>}</For>
        </div>
        <table class="w-full self-start text-right">
          <tbody>
            <tr class="border-t border-neutral-300">
              <td class="py-1 pr-2 font-semibold">{t().subtotal}</td>
              <td class="w-28 border-b border-neutral-300 text-center font-semibold">{money(d().subtotal)}</td>
            </tr>
            <tr>
              <td class="pt-4 pr-2 font-semibold">{t().discount}</td>
              <td class="border-y border-neutral-300 pt-4 text-center">{money(d().discount)}</td>
            </tr>
            <tr>
              <td class="py-1 pr-2 font-semibold">{t().iva}</td>
              <td class="border-b border-neutral-300 text-center">{money(d().iva_amount)}</td>
            </tr>
            <tr>
              <td class="py-1 pr-2 font-semibold">{t().retention}</td>
              <td class="border-b border-neutral-300 bg-neutral-100 text-center">{money(d().retention_amount)}</td>
            </tr>
            <tr class="border-2 border-black">
              <td class="py-1.5 pr-2 text-lg font-bold">{t().net}</td>
              <td class="border-l-2 border-black bg-green-200 text-center text-base font-bold">{money(d().net)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mt-6 text-center text-neutral-700">{t().thanks}</p>
      <div class="mt-1 h-3 bg-black" />
    </div>
  )
}

// Only the sheet prints, on A4 without margins; the app around it and the toolbar never do.
const PRINT_CSS = `
@page { size: A4; margin: 0; }
@media print {
  body * { visibility: hidden !important; }
  .quote-sheet, .quote-sheet * { visibility: visible !important; }
  .quote-sheet { position: absolute; left: 0; top: 0; box-shadow: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .no-print { display: none !important; }
}
`
