// CFDIs — read-only list of imported SAT invoices with client-computed
// KPIs/charts, plus an admin-only "download from SAT" panel that starts async
// backend jobs (chunked per month) and polls until done. Faithful port of
// frontend/src/pages/cfdi.rs — see docs/solid-migration/pages-part1.md
// "CfdiPage".
//
// Bug fix (PLAN §13, called out in the task brief): the Leptos version polls
// via a self-recursing `set_timeout` every 4s with NO unmount cleanup, so it
// keeps hitting the API forever once started, even after navigating away.
// Here the poll is a solid-query `refetchInterval` that only re-arms itself
// while a job is queued/running (computed from the query's own data) — and
// because it is owned by a `createQuery` bound to this component, TanStack
// Query tears the interval down automatically via its own observer cleanup
// when Cfdi unmounts, so it can never leak past navigation.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import type { Query } from '@tanstack/solid-query'
import { Landmark } from 'lucide-solid'
import { type JSX, Show, createEffect, createMemo, createSignal } from 'solid-js'

import { Donut } from '../components/charts/Donut'
import { LineArea } from '../components/charts/LineArea'
import { Badge, type BadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { Input } from '../components/ui/Input'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { humanizeError } from '../lib/api/client'
import * as fiscalApi from '../lib/api/fiscal'
import type { Cfdi, CfdiDownloadType, CfdiJob } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { money, rfc3339ToDate } from '../lib/format'

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function yearsAgoJan(years: number): string {
  return `${new Date().getFullYear() - years}-01-01`
}

const DOWNLOAD_TYPES: { value: CfdiDownloadType; label: string }[] = [
  { value: 'both', label: 'Emitidos y recibidos' },
  { value: 'issued', label: 'Solo emitidos' },
  { value: 'received', label: 'Solo recibidos' },
]

/** Mirrors `status_badge` in cfdi.rs — job-status pill uses theme tokens via
 * the shared Badge (PLAN §13 flagged the old CFDI pill as light-only). */
const JOB_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  queued: { label: 'En cola', tone: 'neutral' },
  running: { label: '● Descargando', tone: 'info' },
  done: { label: '✓ Listo', tone: 'success' },
  failed: { label: '✗ Error', tone: 'danger' },
}

function jobStatusBadge(status: string): JSX.Element {
  const meta = JOB_STATUS_META[status] ?? { label: status, tone: 'neutral' as BadgeTone }
  return <Badge tone={meta.tone}>{meta.label}</Badge>
}

function isActiveStatus(status: string): boolean {
  return status === 'queued' || status === 'running'
}

/** KPIs + monthly emitidos/recibidos series, ported from `cfdi_charts` in
 * cfdi.rs. Skips payment-complement CFDIs (tipo "P") and non-positive totals. */
function buildCfdiAnalytics(items: Cfdi[]) {
  const monthly = new Map<string, { emitidos: number; recibidos: number }>()
  let emitidos = 0
  let recibidos = 0
  for (const c of items) {
    if (c.tipo === 'P' || c.total <= 0) continue
    const month = (c.fecha ?? '').slice(0, 7)
    const bucket = monthly.get(month) ?? { emitidos: 0, recibidos: 0 }
    if (c.es_emitido) {
      bucket.emitidos += c.total
      emitidos += c.total
    } else {
      bucket.recibidos += c.total
      recibidos += c.total
    }
    monthly.set(month, bucket)
  }
  const series = [...monthly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, v]) => ({ label, income: v.emitidos, expense: v.recibidos }))
  return { emitidos, recibidos, series }
}

export default function Cfdi(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  // MeResponse doesn't carry a bare company id — derive it from the active
  // entry in `companies` (CompanySummary has id/slug/active), same source
  // Dashboard/CompanySwitcher already use for tenant identity.
  const companyId = createMemo(() => auth.companies().find((c) => c.active)?.id ?? '')
  const qc = useQueryClient()

  const cfdisQuery = createQuery(() => ({
    queryKey: ['cfdis'],
    queryFn: fiscalApi.listCfdis,
  }))

  const configsQuery = createQuery(() => ({
    queryKey: ['sat-configs'],
    queryFn: fiscalApi.listSatConfigs,
    enabled: isAdmin(),
  }))

  // --- download form state ---------------------------------------------------
  const [satConfigId, setSatConfigId] = createSignal('')
  const [start, setStart] = createSignal(yearsAgoJan(5))
  const [end, setEnd] = createSignal(todayStr())
  const [downloadType, setDownloadType] = createSignal<CfdiDownloadType>('both')
  const [autoPay, setAutoPay] = createSignal(false)
  const [dlError, setDlError] = createSignal<string | null>(null)

  // Auto-select the first SAT config once configs load — mirrors the Leptos
  // `if let Some(first) = list.first() { sat_config.set(first.id) }`.
  createEffect(() => {
    const list = configsQuery.data
    if (list && list.length > 0 && satConfigId() === '') {
      setSatConfigId(list[0].id)
    }
  })

  // --- job polling (the bug-fix target) ---------------------------------------
  // Runs on mount (admin only) so jobs still in flight from a previous visit
  // surface immediately; refetchInterval re-arms itself only while the latest
  // fetched data contains an active job, and disables (returns false) once
  // every job is done/failed — no manual `set_timeout`/cleanup bookkeeping.
  const jobsQuery = createQuery(() => ({
    queryKey: ['cfdi-jobs', companyId()],
    queryFn: () => fiscalApi.listCfdiJobs(companyId()),
    enabled: isAdmin() && companyId() !== '',
    refetchInterval: (query: Query<CfdiJob[]>) => {
      const data = query.state.data
      return data?.some((j) => isActiveStatus(j.status.status)) ? 4000 : false
    },
  }))

  const busy = createMemo(() => (jobsQuery.data ?? []).some((j) => isActiveStatus(j.status.status)))

  const downloadMutation = createMutation(() => ({
    mutationFn: () =>
      fiscalApi.startCfdiDownload(companyId(), {
        sat_config_id: satConfigId(),
        start: start(),
        end: end(),
        download_type: downloadType(),
        auto_create_payments: autoPay(),
      }),
    onSuccess: () => {
      setDlError(null)
      void qc.invalidateQueries({ queryKey: ['cfdi-jobs', companyId()] })
    },
    onError: (err) => {
      setDlError(humanizeError(err, 'No se pudo iniciar la descarga'))
    },
  }))

  const startDownload = (ev: SubmitEvent) => {
    ev.preventDefault()
    if (satConfigId() === '') {
      setDlError('Selecciona una configuración SAT')
      return
    }
    setDlError(null)
    downloadMutation.mutate()
  }

  const analytics = createMemo(() => buildCfdiAnalytics(cfdisQuery.data?.items ?? []))
  const hasCfdis = () => (cfdisQuery.data?.items.length ?? 0) > 0

  return (
    <div class="space-y-6">
      <h1 class="text-xl font-semibold text-foreground">CFDIs</h1>

      <Show when={isAdmin()}>
        <Card class="max-w-3xl">
          <CardHeader>
            <CardTitle>Descargar del SAT</CardTitle>
          </CardHeader>
          <CardContent>
            <Show
              when={!configsQuery.isLoading}
              fallback={
                <div class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Spinner />
                  <span>Cargando configuraciones…</span>
                </div>
              }
            >
              <Show
                when={configsQuery.data && configsQuery.data.length > 0}
                fallback={
                  <p class="text-sm text-amber-600">
                    No hay configuraciones SAT. Agrega una en Config. SAT para descargar.
                  </p>
                }
              >
                <form onSubmit={startDownload} class="grid gap-3 sm:grid-cols-2">
                  <div class="space-y-1">
                    <label class="block text-sm font-medium text-foreground">Configuración SAT</label>
                    <Select value={satConfigId()} onChange={setSatConfigId}>
                      {(configsQuery.data ?? []).map((c) => {
                        const label = c.label && c.label !== '' ? c.label : c.rfc
                        return (
                          <option value={c.id}>
                            {label} ({c.rfc})
                          </option>
                        )
                      })}
                    </Select>
                  </div>
                  <div class="space-y-1">
                    <label class="block text-sm font-medium text-foreground">Tipo</label>
                    <Select value={downloadType()} onChange={(v) => setDownloadType(v as CfdiDownloadType)}>
                      {DOWNLOAD_TYPES.map((t) => (
                        <option value={t.value}>{t.label}</option>
                      ))}
                    </Select>
                  </div>
                  <div class="space-y-1">
                    <label class="block text-sm font-medium text-foreground">Desde</label>
                    <Input value={start()} onInput={setStart} type="date" />
                  </div>
                  <div class="space-y-1">
                    <label class="block text-sm font-medium text-foreground">Hasta</label>
                    <Input value={end()} onInput={setEnd} type="date" />
                  </div>
                  <div class="flex items-center sm:col-span-2">
                    <Checkbox checked={autoPay()} onChange={setAutoPay} label="Crear pagos automáticamente" />
                  </div>
                  <div class="flex items-center gap-2 sm:col-span-2">
                    <Button type="submit" disabled={busy()}>
                      {busy() ? 'Descargando…' : 'Descargar CFDIs'}
                    </Button>
                    <Show when={dlError()}>
                      <span class="text-sm text-destructive">{dlError()}</span>
                    </Show>
                  </div>
                </form>
              </Show>
            </Show>

            <Show when={(jobsQuery.data ?? []).length > 0}>
              <div class="mt-4 overflow-x-auto">
                <p class="mb-1 text-sm font-medium text-foreground">Descargas</p>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeadCell>Período</TableHeadCell>
                      <TableHeadCell>Estado</TableHeadCell>
                      <TableHeadCell>Encontrados</TableHeadCell>
                      <TableHeadCell>Creados</TableHeadCell>
                      <TableHeadCell>Actualizados</TableHeadCell>
                      <TableHeadCell>Omitidos</TableHeadCell>
                      <TableHeadCell>Errores</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(jobsQuery.data ?? []).map((j) => {
                      const s = j.status
                      const errCount = s.errors.length + (s.error ? 1 : 0)
                      const errTitle = [...(s.error ? [s.error] : []), ...s.errors].join('\n')
                      return (
                        <TableRow>
                          <TableCell>{j.label ?? j.chunk_start ?? ''}</TableCell>
                          <TableCell>{jobStatusBadge(s.status)}</TableCell>
                          <TableCell>{s.imported}</TableCell>
                          <TableCell>{s.transactions_created}</TableCell>
                          <TableCell>{s.transactions_updated}</TableCell>
                          <TableCell>{s.transactions_skipped}</TableCell>
                          <TableCell>
                            <span title={errTitle}>{errCount}</span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </Show>
          </CardContent>
        </Card>
      </Show>

      <Show when={hasCfdis()}>
        <div class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardContent class="p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Emitidos</p>
                <p class="mt-1 text-2xl font-bold text-emerald-600">{money(analytics().emitidos)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent class="p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recibidos</p>
                <p class="mt-1 text-2xl font-bold text-rose-600">{money(analytics().recibidos)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent class="p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Neto</p>
                <p class="mt-1 text-2xl font-bold text-sky-600">
                  {money(analytics().emitidos - analytics().recibidos)}
                </p>
              </CardContent>
            </Card>
          </div>
          <div class="grid gap-3 lg:grid-cols-3">
            <Card class="lg:col-span-2">
              <CardHeader>
                <CardTitle class="text-base">Mensual (emitidos vs recibidos)</CardTitle>
              </CardHeader>
              <CardContent class="h-40">
                <LineArea data={analytics().series} class="h-full w-full text-muted-foreground" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle class="text-base">Dirección</CardTitle>
              </CardHeader>
              <CardContent class="flex items-center justify-center">
                <div class="mx-auto h-40 w-40">
                  <Donut
                    segments={[
                      { label: 'Emitidos', value: analytics().emitidos, color: '#10b981' },
                      { label: 'Recibidos', value: analytics().recibidos, color: '#f43f5e' },
                    ]}
                    centerValue={money(analytics().emitidos - analytics().recibidos)}
                    centerLabel="neto"
                    class="text-foreground"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </Show>

      <Card>
        <Show
          when={!cfdisQuery.isLoading}
          fallback={
            <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Spinner />
              <span>Cargando…</span>
            </CardContent>
          }
        >
          <Show
            when={!cfdisQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los CFDIs.
              </CardContent>
            }
          >
            <Show
              when={hasCfdis()}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Landmark class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin CFDIs.</p>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Folio</TableHeadCell>
                    <TableHeadCell>Tipo</TableHeadCell>
                    <TableHeadCell>Fecha</TableHeadCell>
                    <TableHeadCell>Emisor</TableHeadCell>
                    <TableHeadCell>Receptor</TableHeadCell>
                    <TableHeadCell>Total</TableHeadCell>
                    <TableHeadCell>Dirección</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(cfdisQuery.data?.items ?? []).map((c) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{c.folio ?? ''}</TableCell>
                      <TableCell>{c.tipo ?? ''}</TableCell>
                      <TableCell class="text-muted-foreground">{c.fecha ? rfc3339ToDate(c.fecha) : ''}</TableCell>
                      <TableCell class="text-muted-foreground">{c.emisor_nombre ?? ''}</TableCell>
                      <TableCell class="text-muted-foreground">{c.receptor_nombre ?? ''}</TableCell>
                      <TableCell>
                        {money(c.total)} {c.moneda ?? ''}
                      </TableCell>
                      <TableCell>
                        <Badge tone={c.es_emitido ? 'success' : 'info'}>{c.es_emitido ? 'Emitido' : 'Recibido'}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Show>
          </Show>
        </Show>
      </Card>
    </div>
  )
}
