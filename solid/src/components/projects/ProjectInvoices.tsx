// Invoices of a project (Daniel, 2026-11-20): the PO or approved quote goes to the accountant,
// who issues the invoice; here it is kept with the project, XML and PDF, every payment
// complement (REP) and what is still owed, so all the paperwork is found in one place.
// Admin only: it is money.
import { A } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { Receipt } from 'lucide-solid'
import { type JSX, For, Show } from 'solid-js'

import { Badge, type BadgeTone } from '../ui/Badge'
import { FILE_KIND_LABEL, type InvoiceDetail, type InvoiceState, STATE_LABEL, listProjectInvoices } from '../../lib/api/invoices'
import { money } from '../../lib/format'

const fmt = (n: number, currency: string) => (currency === 'USD' ? `US${money(n)}` : money(n))
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'America/Hermosillo' }) : '—'
const folioOf = (i: { serie: string; folio: string }) => (i.serie ? `${i.serie} ${i.folio}` : i.folio)
const TONE: Record<InvoiceState, BadgeTone> = {
  pendiente: 'warning',
  parcial: 'info',
  pagada: 'success',
  cancelada: 'neutral',
  sustituida: 'neutral',
}
const SOURCE: Record<string, string> = { rep: 'REP', nota_credito: 'Nota de crédito', manual: 'Capturado, falta REP' }

function InvoiceBlock(props: { inv: InvoiceDetail }): JSX.Element {
  const i = () => props.inv
  return (
    <li class="space-y-2 py-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <A href="/facturas" class="font-semibold tabular-nums text-sky-600 hover:underline">
          Factura {folioOf(i())}
        </A>
        <Badge tone={TONE[i().state]}>{STATE_LABEL[i().state]}</Badge>
        <span class="text-xs text-muted-foreground">
          {day(i().issued_at)} · {i().customer_name}
        </span>
        <span class="ml-auto text-sm tabular-nums">
          <span class="text-muted-foreground">Total </span>
          <span class="font-semibold">{fmt(i().total, i().currency)}</span>
          <span class="text-muted-foreground"> · Pagado </span>
          <span class="font-semibold text-emerald-600">{fmt(i().paid, i().currency)}</span>
          <span class="text-muted-foreground"> · Debe </span>
          <span class={`font-semibold ${i().balance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{fmt(i().balance, i().currency)}</span>
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <For each={i().files} fallback={<span class="text-xs text-muted-foreground">Sin archivos.</span>}>
          {(f) => (
            <a
              href={f.url}
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted"
              title={f.filename}
            >
              <span class="font-medium">{FILE_KIND_LABEL[f.kind] ?? 'Archivo'}</span>
            </a>
          )}
        </For>
      </div>

      <Show when={i().payments.length > 0}>
        <ul class="space-y-0.5 text-xs">
          <For each={i().payments}>
            {(p) => (
              <li class="flex flex-wrap items-center gap-x-3 text-muted-foreground">
                <span class="w-20 tabular-nums">{day(p.paid_on)}</span>
                <span class="font-medium text-foreground">{SOURCE[p.source] ?? p.source}</span>
                <span class="tabular-nums">abonó {fmt(p.applied, i().currency)}</span>
                <Show when={p.balance_after != null}>
                  <span class="tabular-nums">· quedaron {fmt(p.balance_after as number, i().currency)}</span>
                </Show>
                <Show when={p.cfdi_uuid}>
                  {/* The REP's own file, labeled in the invoice's list above. */}
                  <span class="truncate text-[11px]">· {p.cfdi_uuid?.slice(0, 8)}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  )
}

export function ProjectInvoices(props: { projectId: string }): JSX.Element {
  const invoices = createQuery(() => ({
    queryKey: ['project-invoices', props.projectId],
    queryFn: () => listProjectInvoices(props.projectId),
  }))
  return (
    <div class="rounded-lg border border-border px-3 py-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Receipt class="h-4 w-4" /> Facturas y pagos
        </p>
        <A href="/facturas" class="text-xs text-sky-600 hover:underline">
          Ver todas las facturas
        </A>
      </div>
      <Show
        when={(invoices.data ?? []).length}
        fallback={
          <p class="mt-1 text-xs text-muted-foreground">
            {invoices.isLoading ? 'Cargando…' : 'Sin facturas. Vincúlalas desde Facturas, en el detalle de cada una.'}
          </p>
        }
      >
        <ul class="mt-1 divide-y divide-border">
          <For each={invoices.data}>{(inv) => <InvoiceBlock inv={inv} />}</For>
        </ul>
      </Show>
    </div>
  )
}
