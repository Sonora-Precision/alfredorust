// Cotización as the shop prints it (template V5, laid out like quote 261102-00-01: A4, black bars, header with logo and company data, striped lines,
// terms 1–5 plus notes and the totals with NETO. "Guardar PDF" prints it from the browser;
// the toolbar never prints. openspec add-quote-document. Admin only.
import { A, useNavigate, useParams } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowLeft, Copy, FileDown, FolderPlus, Globe, Mail, MapPin, Phone, Send, User } from 'lucide-solid'
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
    t3: (n: number, u: string, planos = false) =>
      `3.- Tiempo de entrega: ${n} ${u} a partir de ${planos ? 'la aprobación de planos y el anticipo' : 'entregada la orden de compra y anticipo'}.`,
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
    t3: (n: number, u: string, planos = false) =>
      `3.- Delivery time: ${n} ${u} from ${planos ? 'approval of the drawings and advance payment' : 'receipt of the purchase order and advance payment'}.`,
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

  // Approved: the quote becomes a project in Pedidos with its parts and prices.
  const toProject = createMutation(() => ({
    mutationFn: (title: string) => quotesApi.quoteToProject(params.id, title),
    onSuccess: (r) => {
      toast.success(`Proyecto ${r.title} creado`)
      void qc.invalidateQueries({ queryKey: ['quotes'] })
      void qc.invalidateQueries({ queryKey: ['quote'] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${r.project_id}`)
    },
    onError: (err) => toast.error('No se pudo crear el proyecto', humanizeError(err, 'Intenta de nuevo')),
  }))
  const convert = (d: Doc) => {
    const title = window.prompt(
      `Se crea el proyecto en Pedidos con ${d.lines.length} ${d.lines.length === 1 ? 'número de parte' : 'números de parte'} y sus precios.\n\nNombre del proyecto:`,
      `${d.client_abbreviation ?? d.client_name} ${d.folio}`,
    )
    if (title?.trim()) toProject.mutate(title.trim())
  }
  const sent = createMutation(() => ({
    mutationFn: () => quotesApi.markQuoteSent(params.id),
    onSuccess: () => {
      toast.success('Cotización marcada como enviada')
      void qc.invalidateQueries({ queryKey: ['quote', params.id] })
      void qc.invalidateQueries({ queryKey: ['quotes'] })
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
              <div class="flex flex-wrap items-center gap-3">
                <A href="/cotizaciones" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                  <ArrowLeft class="h-4 w-4" /> Cotizaciones
                </A>
                <Show when={d().project_id}>
                  <A href={`/projects/${d().project_id}`} class="rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 hover:underline dark:text-emerald-300">
                    Ya es proyecto: {d().project_title ?? 'abrir'}
                  </A>
                </Show>
              </div>
              <Show when={d().draft}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm text-amber-700 dark:text-amber-300">Borrador: faltan precios antes de enviarla.</span>
                  <Button onClick={() => navigate(`/cotizaciones/nueva?draft=${d().id}`)}>Seguir llenando</Button>
                </div>
              </Show>
              <div class={`flex flex-wrap gap-2 ${d().draft ? 'hidden' : ''}`}>
                <Show when={!d().project_id}>
                  <Button disabled={toProject.isPending} onClick={() => convert(d())}>
                    <FolderPlus class="h-4 w-4" /> {toProject.isPending ? 'Creando…' : 'Convertir en proyecto'}
                  </Button>
                </Show>
                <Button variant={d().project_id ? 'primary' : 'outline'} onClick={() => savePdf(d())}>
                  <FileDown class="h-4 w-4" /> Guardar PDF
                </Button>
                <Button variant="outline" onClick={() => navigate(`/cotizaciones/nueva?rev=${d().id}`)}>
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

// The sheet as Daniel's quote 261102-00-01 (cruceta) prints it: no ITEM column, each line's
// description in short rows (the first one carries quantity and price), the line's picture
// over the rows below it, icons by the company data and the contact, and the retention with
// its rate (Daniel, 2026-11-11).
const ROW_H = 21 // px, every row of the table
const MIN_ROWS = 17
const PIC_ROWS = 9 // rows a picture covers

interface Row {
  qty?: number
  desc?: string
  price?: number
  /** A picture starts at this row and covers the next PIC_ROWS. */
  image?: string
}

/** The table rows of the lines: price row, a blank row, the other description rows, the
 * picture, and a blank row before the next line. */
export function sheetRows(lines: Doc['lines']): Row[] {
  const rows: Row[] = []
  lines.forEach((l, i) => {
    if (i > 0) rows.push({})
    const [first, ...rest] = l.description.split('\n')
    rows.push({ qty: l.quantity, desc: first, price: l.unit_price })
    if (rest.length) {
      rows.push({})
      for (const r of rest) rows.push({ desc: r })
    }
    if (l.image_id) {
      rows.push({ image: quotesApi.quoteDrawingUrl(l.image_id) })
      for (let k = 1; k < PIC_ROWS; k++) rows.push({})
    }
  })
  while (rows.length < MIN_ROWS) rows.push({})
  return rows
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
  const rows = () => sheetRows(d().lines)
  const pics = () => rows().flatMap((r, i) => (r.image ? [{ src: r.image, top: i * ROW_H }] : []))
  const icon = 'h-5 w-5 shrink-0 text-neutral-600'
  const box = 'flex h-5 w-5 items-center justify-center rounded bg-neutral-600 text-white'
  return (
    <div class="quote-sheet mx-auto flex flex-col bg-white pt-7 text-[11px] text-neutral-900 shadow-lg" style={{ width: '210mm', height: '297mm' }}>
      <div class="h-3.5 bg-black" />
      <div class="flex items-start gap-4 bg-neutral-100 px-2 pb-3.5 pt-3">
        <Show when={c().logo_data_url} fallback={<div class="h-32 w-36 bg-black" />}>
          <img src={c().logo_data_url!} alt={c().company_name} class="h-32 w-36 bg-black object-cover" />
        </Show>
        <div class="flex-1 space-y-0.5 pt-3.5 text-[11.5px] leading-snug text-neutral-600">
          <p class="ml-8 text-lg text-neutral-800">{c().company_name}</p>
          <p class="flex gap-2">
            <MapPin class={icon} />
            <span>
              {c().address1}
              <br />
              {c().address2}
            </span>
          </p>
          <p class="flex items-center gap-2">
            <Phone class={icon} />
            {c().phone}
          </p>
          <p class="flex items-center gap-2">
            <Mail class={icon} />
            <span class="text-blue-700 underline">{c().email}</span>
          </p>
          <p class="flex items-center gap-2">
            <Globe class={icon} />
            <span class="text-blue-700 underline">{c().web}</span>
          </p>
        </div>
        <div class="mr-4 w-48 text-center">
          <p class="mb-6 mt-0.5 text-[31px] text-neutral-500">{t().title}</p>
          <p class="border-b border-neutral-300 text-[12.5px] font-bold text-sky-900">{t().date}</p>
          <p class="pb-1 pt-0.5">{date()}</p>
          <p class="border-b border-neutral-300 text-[12.5px] font-bold text-sky-900">{t().number}</p>
          <p class="pt-0.5 text-sky-700">{d().folio}</p>
        </div>
      </div>
      <div class="flex items-start gap-3 px-6 pt-10">
        <div class="flex flex-col gap-px">
          <span class={box}><User class="h-3.5 w-3.5" /></span>
          <span class={box}><Phone class="h-3.5 w-3.5" /></span>
          <span class={box}><Mail class="h-3.5 w-3.5" /></span>
        </div>
        <p class="flex-1 border-b border-neutral-300 pl-1.5 pt-1.5 text-[12.5px] font-bold text-sky-900">{d().attention ?? ''}</p>
        <div class="w-10" />
        <p class="flex-1 border-b border-neutral-300 pl-1.5 pt-1.5 text-[12.5px] font-bold text-sky-900">{d().client_name}</p>
      </div>
      <div class="relative ml-[108px] mr-6 mt-16">
        <table class="w-full border-collapse border border-neutral-500">
          <thead>
            <tr class="bg-black text-[13px] text-white">
              <th class="w-20 py-0.5">{t().qty}</th>
              <th>{t().desc}</th>
              <th class="w-28">{t().pu}</th>
              <th class="w-36">{t().total}</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r, i) => (
                <tr class={i() % 2 ? 'bg-neutral-300/70' : ''} style={{ height: `${ROW_H}px` }}>
                  <td class="border-x border-neutral-500 text-center">{r.qty ?? ''}</td>
                  <td class="border-x border-neutral-500 px-1 text-center">{r.desc ?? ''}</td>
                  <td class="border-x border-neutral-500 text-center">{r.price != null ? money(r.price) : ''}</td>
                  <td class="border-x border-neutral-500 text-center">{r.price != null && r.qty != null ? money(r.qty * r.price) : ''}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <For each={pics()}>
          {(p) => (
            <img
              src={p.src}
              alt=""
              class="absolute left-1/2 -translate-x-1/2 bg-white object-contain ring-[6px] ring-white"
              style={{ top: `${p.top + 26}px`, height: `${PIC_ROWS * ROW_H - 12}px`, 'max-width': '60%' }}
            />
          )}
        </For>
      </div>
      <div class="flex justify-between gap-6 px-6 pl-8 pt-1.5">
        <div class="space-y-1.5 leading-snug">
          <p class="pl-20 text-sm font-bold text-neutral-700">{t().terms}</p>
          <p>{t().t1(d().validity_days)}</p>
          <p>{t().t2(+pct(d().advance_pct))}</p>
          <p>{t().t3(d().delivery_time, d().delivery_unit === 'semanas' ? t().weeks : t().days, d().delivery_from === 'planos')}</p>
          <p class="text-[9.5px] text-neutral-600">{t().t4(+pct(d().remaining_pct))}</p>
          <p class="text-[9.5px] text-neutral-600">{t().t5(t()[d().currency])}</p>
          <For each={d().notes}>{(n, i) => <p class="text-[9.5px] text-neutral-600">{`${i() + 6}.- ${n}`}</p>}</For>
        </div>
        <table class="w-[262px] shrink-0 self-start text-[12px]">
          <tbody>
            <tr>
              <td class="whitespace-nowrap py-0.5 pr-2 text-right font-bold">{t().subtotal}</td>
              <td class="w-32 border-b border-neutral-300 text-center font-bold">{money(d().subtotal)}</td>
            </tr>
            <Show
              when={d().discount > 0}
              fallback={
                <tr>
                  <td />
                  <td class="border-b border-neutral-300 bg-neutral-100">&nbsp;</td>
                </tr>
              }
            >
              <tr>
                <td class="whitespace-nowrap py-0.5 pr-2 text-right font-bold">{t().discount}</td>
                <td class="border-b border-neutral-300 text-center">{money(d().discount)}</td>
              </tr>
            </Show>
            <tr>
              <td class="whitespace-nowrap py-0.5 pr-2 text-right font-bold">{t().iva}</td>
              <td class="border-b border-neutral-300 text-center">{money(d().iva_amount)}</td>
            </tr>
            <Show when={d().retention}>
              <tr>
                <td class="whitespace-nowrap py-0.5 pr-2 text-right font-bold">{`${t().retention} (${+(d().retention_rate * 100).toFixed(2)}%)`}</td>
                <td class="border-b border-neutral-300 text-center">{money(d().retention_amount)}</td>
              </tr>
            </Show>
            <tr class="border-2 border-black">
              <td class="py-2 text-center text-lg font-bold">{t().net}</td>
              <td class="border-l-2 border-black bg-green-200 text-center text-[17px] font-bold">{money(d().net)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex-1" />
      <p class="text-center text-neutral-700">{t().thanks}</p>
      <div class="mb-20 h-5 bg-black" />
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
