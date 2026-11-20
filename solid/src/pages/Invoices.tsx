// Facturas — registro de facturas emitidas (Daniel, 2026-11-19). Lo que se facturó, lo que
// se ha cobrado y lo que falta por cobrar, factura por factura, con su PDF/XML y cada
// complemento de pago (REP). Los montos salen del XML, no de porcentajes a ojo: 100% es que
// te deben toda la factura y 0% que ya se pagó. Dinero: sólo administradores.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { FileDown, FileText, RefreshCw, Trash2, Upload } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Badge, type BadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Drawer } from '../components/ui/Drawer'
import { Input } from '../components/ui/Input'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as api from '../lib/api/invoices'
import { FILE_KIND_LABEL, type ImportReport, type InvoiceDetail, type InvoiceRow, type InvoiceState, STATE_LABEL } from '../lib/api/invoices'
import { cn } from '../lib/cn'
import { money } from '../lib/format'

const fmt = (n: number, currency: string) => (currency === 'USD' ? `US${money(n)}` : money(n))
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'America/Hermosillo' }) : '—'
const pct = (n: number) => `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`
const folioOf = (i: { serie: string; folio: string }) => (i.serie ? `${i.serie} ${i.folio}` : i.folio)

const STATE_TONE: Record<InvoiceState, BadgeTone> = {
  pendiente: 'warning',
  parcial: 'info',
  pagada: 'success',
  cancelada: 'neutral',
  sustituida: 'neutral',
}

const SOURCE_LABEL: Record<string, string> = { rep: 'REP', nota_credito: 'Nota de crédito', manual: 'Capturado (falta REP)' }

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(2, 4)}`

type Filter = 'abiertas' | 'todas' | 'pagada' | 'cancelada'

function Stat(props: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' | 'warn' }): JSX.Element {
  return (
    <div class="min-w-0">
      <div class="text-[11px] uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div
        class={cn(
          'mt-0.5 truncate text-[20px] font-semibold tabular-nums',
          props.tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
          props.tone === 'bad' && 'text-red-600 dark:text-red-400',
          props.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
        )}
      >
        {props.value}
      </div>
      <Show when={props.hint}>
        <div class="truncate text-[11px] text-muted-foreground">{props.hint}</div>
      </Show>
    </div>
  )
}

/** How much is still owed, as a bar and a number (100% = nothing paid). */
function PendingBar(props: { row: InvoiceRow }): JSX.Element {
  const r = () => props.row
  const dead = () => r().state === 'cancelada' || r().state === 'sustituida'
  return (
    <div class="flex min-w-[96px] items-center gap-2" title={`${pct(r().pending_pct)} por cobrar`}>
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          class={cn('h-full rounded-full', r().overdue ? 'bg-red-500' : r().state === 'parcial' ? 'bg-sky-500' : 'bg-amber-500')}
          style={{ width: dead() ? '0%' : `${Math.min(100, r().pending_pct)}%` }}
        />
      </div>
      <span class="w-10 text-right text-[12px] tabular-nums text-muted-foreground">{dead() ? '—' : pct(r().pending_pct)}</span>
    </div>
  )
}

export default function Invoices(): JSX.Element {
  const qc = useQueryClient()
  const [filter, setFilter] = createSignal<Filter>('abiertas')
  const [text, setText] = createSignal('')
  const [currency, setCurrency] = createSignal('')
  const [openId, setOpenId] = createSignal<string | null>(null)
  const [report, setReport] = createSignal<ImportReport | null>(null)
  let fileInput: HTMLInputElement | undefined

  const list = createQuery(() => ({
    queryKey: ['invoices', filter(), text(), currency()],
    queryFn: () => api.listInvoices({ state: filter() === 'todas' ? '' : filter(), q: text().trim(), currency: currency() }),
  }))
  const summary = createQuery(() => ({ queryKey: ['invoices-summary'], queryFn: api.invoiceSummary }))

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['invoices'] })
    void qc.invalidateQueries({ queryKey: ['invoices-summary'] })
  }

  const showReport = (r: ImportReport) => {
    setReport(r)
    refresh()
    toast.success(
      'Carga lista',
      `${r.invoices_new} facturas nuevas, ${r.payments_new} pagos nuevos${r.warnings.length ? `, ${r.warnings.length} avisos` : ''}`,
    )
  }
  const importMutation = createMutation(() => ({
    mutationFn: (files: File[]) => api.importInvoiceFiles(files),
    onSuccess: showReport,
    onError: (err: unknown) => toast.error('No se pudieron cargar los archivos', humanizeError(err, '')),
  }))
  const syncMutation = createMutation(() => ({
    mutationFn: () => api.syncInvoicesFromSat(),
    onSuccess: showReport,
    onError: (err: unknown) => toast.error('No se pudo sincronizar con el SAT', humanizeError(err, '')),
  }))

  const money_ = (cur: string) => summary.data?.totals.find((t) => t.currency === cur)
  const mxn = () => money_('MXN')
  const usd = () => money_('USD')
  const months = createMemo(() => {
    const by = new Map<string, { month: string; billed: number; collected: number }>()
    for (const m of summary.data?.by_month ?? []) {
      if (m.currency !== 'MXN') continue
      by.set(m.month, { month: m.month, billed: m.billed, collected: m.collected })
    }
    return [...by.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12)
  })
  const maxMonth = createMemo(() => Math.max(1, ...months().flatMap((m) => [m.billed, m.collected])))
  const aging = createMemo(() => {
    const out = new Map<string, number>()
    for (const a of summary.data?.aging ?? []) if (a.currency === 'MXN') out.set(a.bucket, a.balance)
    return ['0-30', '31-60', '61-90', '90+'].map((b) => ({ bucket: b, balance: out.get(b) ?? 0 }))
  })
  const customers = createMemo(() => (summary.data?.by_customer ?? []).filter((c) => c.currency === 'MXN' && c.balance > 0).slice(0, 8))

  const onPick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (files.length) importMutation.mutate(files)
  }

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'abiertas', label: 'Por cobrar' },
    { id: 'todas', label: 'Todas' },
    { id: 'pagada', label: 'Pagadas' },
    { id: 'cancelada', label: 'Canceladas' },
  ]

  return (
    <div class="space-y-6">
      <PageHeader
        title="Facturas"
        subtitle="Lo facturado, lo cobrado y lo que falta por cobrar, con su XML, PDF y complementos de pago"
        actions={
          <div class="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" multiple accept=".xml,.pdf,.zip" class="hidden" onChange={onPick} />
            <Button variant="outline" disabled={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
              <RefreshCw class={cn('mr-2 h-4 w-4', syncMutation.isPending && 'animate-spin')} /> Sincronizar SAT
            </Button>
            <Button disabled={importMutation.isPending} onClick={() => fileInput?.click()}>
              <Upload class="mr-2 h-4 w-4" /> {importMutation.isPending ? 'Cargando…' : 'Cargar XML / PDF'}
            </Button>
          </div>
        }
      />

      <Show when={report()}>
        {(r) => (
          <Card>
            <CardContent class="flex flex-wrap items-start justify-between gap-3 p-4 text-[13px]">
              <div>
                <div class="font-semibold">Última carga</div>
                <div class="text-muted-foreground">
                  {r().invoices_new} facturas nuevas · {r().invoices_updated} actualizadas · {r().payments_new} pagos nuevos ·{' '}
                  {r().credit_notes} notas de crédito · {r().pdfs} PDF ligados · {r().ignored} ignorados
                </div>
                <Show when={r().warnings.length}>
                  <ul class="mt-2 list-disc space-y-0.5 pl-5 text-amber-700 dark:text-amber-300">
                    <For each={r().warnings.slice(0, 12)}>{(w) => <li>{w}</li>}</For>
                    <Show when={r().warnings.length > 12}>
                      <li>… y {r().warnings.length - 12} avisos más</li>
                    </Show>
                  </ul>
                </Show>
              </div>
              <Button variant="ghost" onClick={() => setReport(null)}>
                Cerrar
              </Button>
            </CardContent>
          </Card>
        )}
      </Show>

      <Show when={summary.isLoading}>
        <Spinner />
      </Show>
      <Show when={summary.data}>
        <Card>
          <CardContent class="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Facturado" value={money(mxn()?.billed ?? 0)} hint={`${mxn()?.invoices ?? 0} facturas`} />
            <Stat label="Cobrado" value={money(mxn()?.paid ?? 0)} tone="good" />
            <Stat label="Por cobrar" value={money(mxn()?.balance ?? 0)} tone="warn" hint={`${mxn()?.open_invoices ?? 0} facturas abiertas`} />
            <Show when={usd()}>
              <Stat label="Por cobrar USD" value={fmt(usd()?.balance ?? 0, 'USD')} tone="warn" hint={`de ${fmt(usd()?.billed ?? 0, 'USD')} facturados`} />
            </Show>
            <Stat
              label="Falta REP"
              value={String(summary.data?.missing_rep ?? 0)}
              tone={(summary.data?.missing_rep ?? 0) > 0 ? 'bad' : undefined}
              hint="cobradas sin complemento"
            />
          </CardContent>
        </Card>

        <div class="grid gap-4 lg:grid-cols-3">
          <Card class="lg:col-span-2">
            <CardContent class="p-4">
              <div class="mb-3 flex items-center justify-between">
                <div class="text-[13px] font-semibold">Facturado y cobrado por mes</div>
                <div class="flex gap-3 text-[11px] text-muted-foreground">
                  <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-sky-500" /> Facturado</span>
                  <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-emerald-500" /> Cobrado</span>
                </div>
              </div>
              <div class="space-y-1.5">
                <For each={months()} fallback={<div class="text-[12px] text-muted-foreground">Sin facturas todavía.</div>}>
                  {(m) => (
                    <div class="grid grid-cols-[44px_1fr_96px] items-center gap-2 text-[12px]">
                      <span class="text-muted-foreground">{monthLabel(m.month)}</span>
                      <div class="space-y-0.5">
                        <div class="h-2 rounded-sm bg-sky-500" style={{ width: `${(m.billed / maxMonth()) * 100}%` }} />
                        <div class="h-2 rounded-sm bg-emerald-500" style={{ width: `${(m.collected / maxMonth()) * 100}%` }} />
                      </div>
                      <span class="text-right tabular-nums">{money(m.billed)}</span>
                    </div>
                  )}
                </For>
              </div>
            </CardContent>
          </Card>
          <div class="space-y-4">
            <Card>
              <CardContent class="p-4">
                <div class="mb-2 text-[13px] font-semibold">Antigüedad del saldo</div>
                <div class="space-y-1 text-[12px]">
                  <For each={aging()}>
                    {(a) => (
                      <div class="flex items-center justify-between">
                        <span class="text-muted-foreground">{a.bucket === '90+' ? 'Más de 90 días' : `${a.bucket} días`}</span>
                        <span class={cn('tabular-nums', a.bucket === '90+' && a.balance > 0 && 'font-semibold text-red-600 dark:text-red-400')}>
                          {money(a.balance)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent class="p-4">
                <div class="mb-2 text-[13px] font-semibold">Quién debe más</div>
                <div class="space-y-1 text-[12px]">
                  <For each={customers()} fallback={<div class="text-muted-foreground">Nadie debe nada.</div>}>
                    {(c) => (
                      <div class="flex items-center justify-between gap-2">
                        <span class="truncate text-muted-foreground">{c.customer_name}</span>
                        <span class="tabular-nums">{money(c.balance)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </Show>

      <div class="flex flex-wrap items-center gap-2">
        <div class="flex rounded-md border border-border p-0.5">
          <For each={FILTERS}>
            {(f) => (
              <button
                type="button"
                class={cn(
                  'rounded px-3 py-1.5 text-[13px] font-medium transition-colors',
                  filter() === f.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            )}
          </For>
        </div>
        <Input class="max-w-xs" placeholder="Buscar cliente, folio u orden de compra" value={text()} onInput={setText} />
        <div class="w-32">
          <Select value={currency()} onChange={setCurrency}>
            <option value="">Todas las monedas</option>
            <option value="MXN">MXN</option>
            <option value="USD">USD</option>
          </Select>
        </div>
        <span class="ml-auto text-[12px] text-muted-foreground">{list.data?.total ?? 0} facturas</span>
      </div>

      <Show when={list.isLoading}>
        <Spinner />
      </Show>
      <Show when={list.isError}>
        <p class="text-sm text-red-600">No se pudieron cargar las facturas.</p>
      </Show>
      <Show when={list.data}>
        <Card>
          <CardContent class="overflow-x-auto p-0">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Factura</TableHeadCell>
                  <TableHeadCell>Cliente</TableHeadCell>
                  <TableHeadCell>Emisión</TableHeadCell>
                  <TableHeadCell class="text-right">Total</TableHeadCell>
                  <TableHeadCell class="text-right">Pagado</TableHeadCell>
                  <TableHeadCell class="text-right">Saldo</TableHeadCell>
                  <TableHeadCell>% por cobrar</TableHeadCell>
                  <TableHeadCell>Estado</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <For each={list.data?.items} fallback={<tr><td colSpan={8} class="py-8 text-center text-muted-foreground">No hay facturas con este filtro.</td></tr>}>
                  {(i) => (
                    <tr class="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40" onClick={() => setOpenId(i.id)}>
                      <TableCell class="whitespace-nowrap font-medium">{folioOf(i)}</TableCell>
                      <TableCell class="max-w-[260px] truncate">{i.customer_name}</TableCell>
                      <TableCell class="whitespace-nowrap text-muted-foreground">{day(i.issued_at)}</TableCell>
                      <TableCell class="text-right tabular-nums">{fmt(i.total, i.currency)}</TableCell>
                      <TableCell class="text-right tabular-nums text-muted-foreground">{fmt(i.paid, i.currency)}</TableCell>
                      <TableCell class={cn('text-right tabular-nums', i.balance > 0 && 'font-semibold')}>{fmt(i.balance, i.currency)}</TableCell>
                      <TableCell><PendingBar row={i} /></TableCell>
                      <TableCell>
                        <div class="flex flex-wrap items-center gap-1">
                          <Badge tone={i.overdue ? 'danger' : STATE_TONE[i.state]}>{i.overdue ? 'Vencida' : STATE_LABEL[i.state]}</Badge>
                          <Show when={i.missing_rep}><Badge tone="danger">Falta REP</Badge></Show>
                          <Show when={i.files_count === 0}><Badge tone="neutral">Sin archivos</Badge></Show>
                        </div>
                      </TableCell>
                    </tr>
                  )}
                </For>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Show>

      <InvoiceDrawer id={openId()} onClose={() => setOpenId(null)} onChanged={refresh} />
    </div>
  )
}

function InvoiceDrawer(props: { id: string | null; onClose: () => void; onChanged: () => void }): JSX.Element {
  const qc = useQueryClient()
  const detail = createQuery(() => ({
    queryKey: ['invoice', props.id],
    queryFn: () => api.getInvoice(props.id as string),
    enabled: !!props.id,
  }))
  const inv = () => detail.data

  const saved = (d: InvoiceDetail) => {
    qc.setQueryData(['invoice', d.id], d)
    props.onChanged()
  }
  const fail = (title: string) => (err: unknown) => toast.error(title, humanizeError(err, ''))

  // Money received.
  const [payDate, setPayDate] = createSignal(new Date().toISOString().slice(0, 10))
  const [payAmount, setPayAmount] = createSignal('')
  const [payCurrency, setPayCurrency] = createSignal('')
  const [payRate, setPayRate] = createSignal('')
  const [payNote, setPayNote] = createSignal('')
  const cur = () => payCurrency() || inv()?.currency || 'MXN'
  const foreign = () => !!inv() && cur() !== inv()?.currency
  const payMutation = createMutation(() => ({
    mutationFn: () =>
      api.addInvoicePayment(props.id as string, {
        paid_on: payDate(),
        amount: Number(payAmount()),
        currency: cur(),
        exchange_rate: foreign() ? Number(payRate()) : undefined,
        note: payNote(),
      }),
    onSuccess: (d) => {
      saved(d)
      setPayAmount('')
      setPayNote('')
      toast.success('Pago registrado', 'Queda marcado "Falta REP" hasta que cargues el complemento.')
    },
    onError: fail('No se pudo registrar el pago'),
  }))
  const delPayment = createMutation(() => ({
    mutationFn: (paymentId: string) => api.deleteInvoicePayment(props.id as string, paymentId),
    onSuccess: saved,
    onError: fail('No se pudo quitar el pago'),
  }))

  // Data the XML does not carry.
  const [due, setDue] = createSignal<string | null>(null)
  const [po, setPo] = createSignal<string | null>(null)
  const [notes, setNotes] = createSignal<string | null>(null)
  const updateMutation = createMutation(() => ({
    mutationFn: (body: api.InvoiceUpdate) => api.updateInvoice(props.id as string, body),
    onSuccess: (d) => {
      saved(d)
      setDue(null)
      setPo(null)
      setNotes(null)
      toast.success('Guardado')
    },
    onError: fail('No se pudo guardar'),
  }))
  const dirty = () => due() !== null || po() !== null || notes() !== null

  // Files.
  const [fileKind, setFileKind] = createSignal('factura_pdf')
  let fileInput: HTMLInputElement | undefined
  const fileMutation = createMutation(() => ({
    mutationFn: (file: File) => api.addInvoiceFile(props.id as string, fileKind(), file),
    onSuccess: (d) => {
      saved(d)
      toast.success('Archivo agregado')
    },
    onError: fail('No se pudo agregar el archivo'),
  }))

  return (
    <Drawer
      open={!!props.id}
      onOpenChange={(o) => !o && props.onClose()}
      title={inv() ? `Factura ${folioOf(inv() as InvoiceRow)}` : 'Factura'}
      subtitle={inv()?.customer_name}
      class="w-full max-w-2xl"
    >
      <Show when={detail.isLoading}>
        <div class="p-6"><Spinner /></div>
      </Show>
      <Show when={inv()}>
        {(d) => (
          <div class="space-y-6 p-5 text-[13px]">
            <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Total" value={fmt(d().total, d().currency)} hint={`${fmt(d().subtotal, d().currency)} + IVA ${fmt(d().tax, d().currency)}${d().withholding ? ` − ret. ${fmt(d().withholding, d().currency)}` : ''}`} />
              <Stat label="Pagado" value={fmt(d().paid, d().currency)} tone="good" />
              <Stat label="Saldo" value={fmt(d().balance, d().currency)} tone={d().balance > 0 ? 'warn' : 'good'} hint={`${pct(d().pending_pct)} por cobrar`} />
              <div>
                <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Estado</div>
                <div class="mt-1 flex flex-wrap gap-1">
                  <Badge tone={d().overdue ? 'danger' : STATE_TONE[d().state]}>{d().overdue ? 'Vencida' : STATE_LABEL[d().state]}</Badge>
                  <Show when={d().missing_rep}><Badge tone="danger">Falta REP</Badge></Show>
                </div>
                <div class="mt-1 text-[11px] text-muted-foreground">
                  {d().payment_method} · {d().currency}
                  <Show when={d().currency !== 'MXN' && d().state !== 'pagada'}> · el saldo se lleva en {d().currency}</Show>
                </div>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="text-[11px] uppercase tracking-wide text-muted-foreground">Emisión</span>
                <div class="py-2">{day(d().issued_at)} · {d().customer_rfc}</div>
              </label>
              <label class="block">
                <span class="text-[11px] uppercase tracking-wide text-muted-foreground">Vence</span>
                <Input type="date" value={due() ?? (d().due_on ?? '').slice(0, 10)} onInput={setDue} />
              </label>
              <label class="block">
                <span class="text-[11px] uppercase tracking-wide text-muted-foreground">Orden de compra del cliente</span>
                <Input value={po() ?? d().purchase_order ?? ''} onInput={setPo} placeholder="OC-123" />
              </label>
              <label class="block">
                <span class="text-[11px] uppercase tracking-wide text-muted-foreground">Notas</span>
                <Input value={notes() ?? d().notes ?? ''} onInput={setNotes} />
              </label>
            </div>
            <div class="flex flex-wrap gap-2">
              <Show when={dirty()}>
                <Button
                  disabled={updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ due_on: due() ?? undefined, purchase_order: po() ?? undefined, notes: notes() ?? undefined })}
                >
                  Guardar cambios
                </Button>
              </Show>
              <Show when={d().state !== 'sustituida'}>
                <Button
                  variant="outline"
                  disabled={updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ status: d().state === 'cancelada' ? 'active' : 'cancelled' })}
                >
                  {d().state === 'cancelada' ? 'Reactivar factura' : 'Marcar como cancelada'}
                </Button>
              </Show>
            </div>

            <section>
              <h3 class="mb-2 text-[13px] font-semibold">Pagos y complementos (REP)</h3>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Fecha</TableHeadCell>
                    <TableHeadCell>Origen</TableHeadCell>
                    <TableHeadCell class="text-right">Recibido</TableHeadCell>
                    <TableHeadCell class="text-right">Aplicado</TableHeadCell>
                    <TableHeadCell class="text-right">Saldo según REP</TableHeadCell>
                    <TableHeadCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={d().payments} fallback={<tr><td colSpan={6} class="py-4 text-center text-muted-foreground">Sin pagos registrados.</td></tr>}>
                    {(p) => (
                      <TableRow>
                        <TableCell class="whitespace-nowrap">{day(p.paid_on)}</TableCell>
                        <TableCell>
                          <Badge tone={p.source === 'manual' ? 'danger' : p.source === 'nota_credito' ? 'info' : 'success'}>
                            {SOURCE_LABEL[p.source] ?? p.source}
                            {p.installment ? ` ${p.installment}` : ''}
                          </Badge>
                          <Show when={p.note}><div class="mt-0.5 text-[11px] text-muted-foreground">{p.note}</div></Show>
                        </TableCell>
                        <TableCell class="text-right tabular-nums">
                          {fmt(p.amount, p.currency)}
                          <Show when={p.currency !== d().currency}>
                            <div class="text-[11px] text-muted-foreground">TC {p.exchange_rate}</div>
                          </Show>
                        </TableCell>
                        <TableCell class="text-right tabular-nums">{fmt(p.applied, d().currency)}</TableCell>
                        <TableCell class="text-right tabular-nums text-muted-foreground">{p.balance_after == null ? '—' : fmt(p.balance_after, d().currency)}</TableCell>
                        <TableCell class="text-right">
                          <Show when={p.source === 'manual'}>
                            <button type="button" class="text-muted-foreground hover:text-red-600" aria-label="Quitar pago" onClick={() => delPayment.mutate(p.id)}>
                              <Trash2 class="h-4 w-4" />
                            </button>
                          </Show>
                        </TableCell>
                      </TableRow>
                    )}
                  </For>
                </TableBody>
              </Table>

              <Show when={d().state !== 'cancelada' && d().state !== 'sustituida'}>
                <div class="mt-3 rounded-md border border-border p-3">
                  <div class="mb-2 text-[12px] font-medium">Registrar un pago recibido (aún sin REP)</div>
                  <div class="grid gap-2 sm:grid-cols-4">
                    <Input type="date" value={payDate()} onInput={setPayDate} />
                    <Input type="number" step="0.01" placeholder="Monto" value={payAmount()} onInput={setPayAmount} />
                    <Select value={cur()} onChange={setPayCurrency}>
                      <option value={d().currency}>{d().currency}</option>
                      <Show when={d().currency === 'USD'}><option value="MXN">MXN (pesos)</option></Show>
                    </Select>
                    <Show when={foreign()} fallback={<div />}>
                      <Input type="number" step="0.0001" placeholder="TC del DOF" value={payRate()} onInput={setPayRate} />
                    </Show>
                  </div>
                  <div class="mt-2 flex gap-2">
                    <Input placeholder="Nota (opcional)" value={payNote()} onInput={setPayNote} />
                    <Button disabled={payMutation.isPending || !(Number(payAmount()) > 0) || (foreign() && !(Number(payRate()) > 0))} onClick={() => payMutation.mutate()}>
                      Registrar
                    </Button>
                  </div>
                </div>
              </Show>
            </section>

            <section>
              <h3 class="mb-2 text-[13px] font-semibold">Archivos</h3>
              <ul class="divide-y divide-border rounded-md border border-border">
                <For each={d().files} fallback={<li class="p-3 text-muted-foreground">Sin archivos todavía.</li>}>
                  {(f) => (
                    <li class="flex items-center justify-between gap-3 p-2.5">
                      <a href={f.url} target="_blank" rel="noopener" class="flex min-w-0 items-center gap-2 hover:underline">
                        {f.kind.endsWith('_pdf') ? <FileText class="h-4 w-4 shrink-0" /> : <FileDown class="h-4 w-4 shrink-0" />}
                        <span class="truncate">{FILE_KIND_LABEL[f.kind] ?? f.kind}</span>
                        <span class="truncate text-[11px] text-muted-foreground">{f.filename}</span>
                      </a>
                      <span class="shrink-0 text-[11px] text-muted-foreground">{Math.max(1, Math.round(f.size_bytes / 1024))} KB</span>
                    </li>
                  )}
                </For>
              </ul>
              <div class="mt-2 flex gap-2">
                <div class="w-56">
                  <Select value={fileKind()} onChange={setFileKind}>
                    <option value="factura_pdf">Factura PDF</option>
                    <option value="factura_xml">Factura XML</option>
                    <option value="rep_pdf">REP PDF</option>
                    <option value="rep_xml">REP XML</option>
                    <option value="nc_pdf">Nota de crédito PDF</option>
                    <option value="otro">Otro PDF</option>
                  </Select>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  class="hidden"
                  accept=".pdf,.xml"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0]
                    e.currentTarget.value = ''
                    if (file) fileMutation.mutate(file)
                  }}
                />
                <Button variant="outline" disabled={fileMutation.isPending} onClick={() => fileInput?.click()}>
                  <Upload class="mr-2 h-4 w-4" /> Agregar archivo
                </Button>
              </div>
            </section>

            <Show when={d().lines.length}>
              <section>
                <h3 class="mb-2 text-[13px] font-semibold">Conceptos</h3>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeadCell>Descripción</TableHeadCell>
                      <TableHeadCell class="text-right">Cant.</TableHeadCell>
                      <TableHeadCell class="text-right">Importe</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <For each={d().lines}>
                      {(l) => (
                        <TableRow>
                          <TableCell class="break-all">{l.description}</TableCell>
                          <TableCell class="text-right tabular-nums">{l.quantity}</TableCell>
                          <TableCell class="text-right tabular-nums">{fmt(l.amount, d().currency)}</TableCell>
                        </TableRow>
                      )}
                    </For>
                  </TableBody>
                </Table>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </Drawer>
  )
}
