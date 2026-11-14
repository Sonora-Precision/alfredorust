// Proveedores de maquila (Daniel, 2026-11-13): per supplier, the part numbers they have,
// what we pay, what we sell those pieces for and the margin, plus on-time deliveries.
// Whole parts show a margin; parts where they do only some steps show what share of the
// sale goes to the supplier. Money, so admins only.
import { A } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { ChevronDown, ChevronRight, Truck } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Card, CardContent } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { humanizeError } from '../lib/api/client'
import { STATUS_LABEL, type SupplierJobRow, type SupplierSummary, listOutsourcingSuppliers } from '../lib/api/outsourcing'
import { useAuth } from '../lib/auth/AuthContext'
import { cn } from '../lib/cn'
import { money } from '../lib/format'

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'America/Hermosillo' }) : '—'
const pieces = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} pz${n === 1 ? '' : 's'}`

function Stat(props: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }): JSX.Element {
  return (
    <div class="min-w-0">
      <div class="text-[11px] uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div
        class={cn(
          'mt-0.5 truncate text-[17px] font-semibold tabular-nums',
          props.tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
          props.tone === 'bad' && 'text-red-600 dark:text-red-400',
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

function statusClass(job: SupplierJobRow): string {
  if (job.late && job.status !== 'received') return 'bg-red-500/10 text-red-700 dark:text-red-300'
  switch (job.status) {
    case 'sent':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'received':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'cancelled':
      return 'bg-muted text-muted-foreground line-through'
    default:
      return 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
  }
}

function JobsTable(props: { jobs: SupplierJobRow[] }): JSX.Element {
  return (
    <div class="overflow-x-auto">
      <Table>
        <TableHead>
          <TableRow>
            <TableHeadCell>Número de parte</TableHeadCell>
            <TableHeadCell>Qué hace</TableHeadCell>
            <TableHeadCell class="text-right">Piezas</TableHeadCell>
            <TableHeadCell class="text-right">Pagamos</TableHeadCell>
            <TableHeadCell class="text-right">Vendemos</TableHeadCell>
            <TableHeadCell class="text-right">Margen</TableHeadCell>
            <TableHeadCell>Entrega</TableHeadCell>
            <TableHeadCell>Estado</TableHeadCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <For each={props.jobs}>
            {(job) => {
              const margin = () =>
                job.whole && job.cost_total != null && job.sale_total != null ? job.sale_total - job.cost_total : null
              return (
                <TableRow class={cn(job.status === 'cancelled' && 'opacity-60')}>
                  <TableCell>
                    <A href={`/projects/${job.project_id}`} class="font-medium hover:underline">
                      {job.part || '—'}
                    </A>
                    <div class="text-[11px] text-muted-foreground">{job.project_title}</div>
                  </TableCell>
                  <TableCell class="text-[13px]">{job.whole ? 'Pieza completa' : job.steps.join(', ') || 'Algunos pasos'}</TableCell>
                  <TableCell class="text-right tabular-nums">
                    {job.status === 'received' ? `${job.received_quantity}/${job.quantity}` : job.quantity}
                  </TableCell>
                  <TableCell class="text-right tabular-nums">
                    <Show when={job.cost_total != null} fallback={<span class="text-muted-foreground">sin precio</span>}>
                      {money(job.cost_total!)}
                      <div class="text-[11px] text-muted-foreground">{money(job.unit_cost ?? 0)}/pz</div>
                    </Show>
                  </TableCell>
                  <TableCell class="text-right tabular-nums">
                    <Show when={job.sale_total != null} fallback={<span class="text-muted-foreground">—</span>}>
                      {money(job.sale_total!)}
                    </Show>
                  </TableCell>
                  <TableCell class="text-right tabular-nums">
                    <Show
                      when={margin() != null}
                      fallback={
                        <span class="text-[12px] text-muted-foreground">
                          {!job.whole && job.cost_total != null && job.sale_total
                            ? `${pct(job.cost_total, job.sale_total)} de la venta`
                            : '—'}
                        </span>
                      }
                    >
                      <span class={margin()! < 0 ? 'text-red-600 dark:text-red-400' : ''}>{money(margin()!)}</span>
                      <div class="text-[11px] text-muted-foreground">{pct(margin()!, job.sale_total!)}</div>
                    </Show>
                  </TableCell>
                  <TableCell class="whitespace-nowrap text-[13px]">
                    {day(job.due_date)}
                    <Show when={job.received_at}>
                      <div class="text-[11px] text-muted-foreground">llegó {day(job.received_at)}</div>
                    </Show>
                  </TableCell>
                  <TableCell>
                    <span class={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', statusClass(job))}>
                      {job.late ? (job.status === 'received' ? 'Llegó tarde' : 'Atrasada') : STATUS_LABEL[job.status]}
                    </span>
                  </TableCell>
                </TableRow>
              )
            }}
          </For>
        </TableBody>
      </Table>
    </div>
  )
}

function SupplierCard(props: { s: SupplierSummary }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const s = () => props.s
  const delivered = () => s().on_time + s().late
  const contact = () => [s().contact_person, s().phone, s().email].filter(Boolean).join(' · ')
  return (
    <Card>
      <CardContent class="space-y-4 p-4 sm:p-5">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="text-[16px] font-semibold">{s().name}</div>
            <div class="text-[12px] text-muted-foreground">
              {s().legal_name !== s().name ? s().legal_name : ''}
              <Show when={s().rfc}>
                {s().legal_name !== s().name ? ' · ' : ''}RFC {s().rfc}
              </Show>
            </div>
            <Show when={contact()}>
              <div class="text-[12px] text-muted-foreground">{contact()}</div>
            </Show>
          </div>
          <div class="flex flex-wrap gap-1">
            <For each={s().processes}>
              {(p) => <span class="rounded-full bg-muted px-2 py-0.5 text-[11px]">{p}</span>}
            </For>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="Números de parte"
            value={String(s().parts)}
            hint={`${s().open_jobs} con el proveedor · ${s().received_jobs} recibidas`}
          />
          <Stat
            label="Pagamos"
            value={money(s().cost)}
            hint={s().jobs_without_cost ? `${s().jobs_without_cost} sin precio` : pieces(s().pieces_sent)}
          />
          <Stat
            label="Vendemos (pieza completa)"
            value={s().whole_cost > 0 || s().whole_sale > 0 ? money(s().whole_sale) : '—'}
            hint={s().whole_cost > 0 ? `pagamos ${money(s().whole_cost)}` : undefined}
          />
          <Stat
            label="Margen (pieza completa)"
            value={s().whole_sale > 0 ? money(s().whole_margin) : '—'}
            hint={s().whole_sale > 0 ? pct(s().whole_margin, s().whole_sale) : undefined}
            tone={s().whole_sale > 0 ? (s().whole_margin < 0 ? 'bad' : 'good') : undefined}
          />
          <Stat
            label="Solo algunos pasos"
            value={s().partial_cost > 0 ? money(s().partial_cost) : '—'}
            hint={s().partial_sale > 0 ? `${pct(s().partial_cost, s().partial_sale)} de ${money(s().partial_sale)} de venta` : undefined}
          />
          <Stat
            label="Entregas a tiempo"
            value={delivered() ? pct(s().on_time, delivered()) : '—'}
            hint={
              [s().late ? `${s().late} tarde` : '', s().short ? `${s().short} incompletas` : ''].filter(Boolean).join(' · ') ||
              undefined
            }
            tone={s().late ? 'bad' : undefined}
          />
        </div>

        <Show when={s().jobs.length}>
          <button
            type="button"
            class="flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
            onClick={() => setOpen(!open())}
          >
            <Show when={open()} fallback={<ChevronRight class="h-4 w-4" />}>
              <ChevronDown class="h-4 w-4" />
            </Show>
            {open() ? 'Ocultar piezas' : `Ver piezas (${s().jobs.length})`}
          </button>
          <Show when={open()}>
            <JobsTable jobs={s().jobs} />
          </Show>
        </Show>
      </CardContent>
    </Card>
  )
}

export default function OutsourcingSuppliers(): JSX.Element {
  const auth = useAuth()
  const query = createQuery(() => ({
    queryKey: ['outsourcing', 'suppliers'],
    queryFn: listOutsourcingSuppliers,
    enabled: auth.isAdmin(),
  }))
  const withJobs = createMemo(() => (query.data ?? []).filter((s) => s.jobs.length > 0))
  const idle = createMemo(() => (query.data ?? []).filter((s) => s.jobs.length === 0))
  const totals = createMemo(() =>
    withJobs().reduce(
      (t, s) => ({
        cost: t.cost + s.cost,
        wholeSale: t.wholeSale + s.whole_sale,
        wholeMargin: t.wholeMargin + s.whole_margin,
        open: t.open + s.open_jobs,
        late: t.late + s.late,
      }),
      { cost: 0, wholeSale: 0, wholeMargin: 0, open: 0, late: 0 },
    ),
  )

  return (
    <div class="space-y-6">
      <PageHeader
        title="Proveedores de maquila"
        breadcrumb={['Producción', 'Maquila']}
        subtitle="Qué tiene cada proveedor, cuánto les pagamos y cuánto vendemos esas piezas."
      />
      <Show when={auth.isAdmin()} fallback={<p class="text-[13px] text-muted-foreground">Solo el administrador ve esta pantalla.</p>}>
        <Show when={!query.isLoading} fallback={<Spinner />}>
          <Show when={!query.error} fallback={<p class="text-[13px] text-red-600">{humanizeError(query.error, 'No se pudo cargar la maquila')}</p>}>
            <Card>
              <CardContent class="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
                <Stat label="Pagamos en maquila" value={money(totals().cost)} />
                <Stat label="Vendemos (pieza completa)" value={money(totals().wholeSale)} />
                <Stat
                  label="Margen (pieza completa)"
                  value={totals().wholeSale > 0 ? money(totals().wholeMargin) : '—'}
                  hint={totals().wholeSale > 0 ? pct(totals().wholeMargin, totals().wholeSale) : undefined}
                  tone={totals().wholeSale > 0 ? (totals().wholeMargin < 0 ? 'bad' : 'good') : undefined}
                />
                <Stat
                  label="Con proveedores ahora"
                  value={String(totals().open)}
                  hint={totals().late ? `${totals().late} atrasadas` : 'ninguna atrasada'}
                  tone={totals().late ? 'bad' : undefined}
                />
              </CardContent>
            </Card>

            <Show
              when={withJobs().length}
              fallback={
                <Card>
                  <CardContent class="flex flex-col items-center gap-2 p-8 text-center text-[13px] text-muted-foreground">
                    <Truck class="h-8 w-8" />
                    Todavía no hay piezas en maquila. Se mandan desde el proyecto → Seguimiento → "Mandar a maquila".
                  </CardContent>
                </Card>
              }
            >
              <div class="space-y-4">
                <For each={withJobs()}>{(s) => <SupplierCard s={s} />}</For>
              </div>
            </Show>

            <Show when={idle().length}>
              <div>
                <div class="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                  Sin piezas todavía
                </div>
                <div class="flex flex-wrap gap-2">
                  <For each={idle()}>
                    {(s) => (
                      <A href="/contacts" class="rounded-full border px-3 py-1 text-[13px] hover:bg-muted">
                        {s.name}
                        <Show when={s.processes.length}>
                          <span class="text-muted-foreground"> · {s.processes.join(', ')}</span>
                        </Show>
                      </A>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
