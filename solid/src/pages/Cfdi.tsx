// CFDIs — "space glass" redesign (Fase 1). Two tabs: Explorar (KPIs + charts +
// filterable/sortable table + detail drawer) and Sincronización (admin-only
// SAT download form + daily-cron card + persistent job history + error modal).
//
// All data logic is preserved from the previous port: solid-query for the CFDI
// list, SAT configs and download jobs; the job poll re-arms only while a job is
// active (refetchInterval driven by the query's own data, torn down with the
// component — no set_timeout leak). Analytics/KPIs are computed client-side over
// the *filtered* set. Fields the API doesn't expose yet (subtotal/IVA/RFC/
// estatus, job origen, cron run stats, archived-XML count) are omitted rather
// than faked — see BACKEND_REQUESTS.md.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import type { Query } from '@tanstack/solid-query'
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CloudDownload,
  Download,
  FileText,
  History,
  Info,
  Landmark,
  Radio,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  UploadCloud,
} from 'lucide-solid'
import { type JSX, Show, createEffect, createMemo, createSignal, For } from 'solid-js'

import { Donut } from '../components/charts/Donut'
import { LineArea } from '../components/charts/LineArea'
import { Badge, type BadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { DateField } from '../components/ui/DateField'
import { Drawer } from '../components/ui/Drawer'
import { Dropzone } from '../components/ui/Dropzone'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Pagination } from '../components/ui/Pagination'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { humanizeError } from '../lib/api/client'
import * as fiscalApi from '../lib/api/fiscal'
import type { Cfdi, CfdiDownloadType, CfdiJob } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { money, rfc3339ToDate } from '../lib/format'
import { createCountUp } from '../lib/motion'

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}
function yearsAgoJan(years: number): string {
  return `${new Date().getFullYear() - years}-01-01`
}
const int = (n: number): string => Math.round(n).toLocaleString('es-MX')

// --- quick-range presets (local-date math; injectable `now`) ----------------
function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}
interface QuickRange {
  label: string
  start: string
  end: string
}
function buildQuickRanges(now: Date): QuickRange[] {
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  const today = ymd(now)
  const lastDays = (n: number) => ymd(new Date(y, m, d - n))
  const q = Math.floor(m / 3)
  const prevQY = q === 0 ? y - 1 : y
  const prevQ = q === 0 ? 3 : q - 1
  const h = m < 6 ? 0 : 1
  const prevHY = h === 0 ? y - 1 : y
  const prevH = h === 0 ? 1 : 0
  return [
    { label: 'Últimos 7 días', start: lastDays(7), end: today },
    { label: 'Últimos 14 días', start: lastDays(14), end: today },
    { label: 'Mes actual', start: ymd(new Date(y, m, 1)), end: today },
    { label: 'Mes anterior', start: ymd(new Date(y, m - 1, 1)), end: ymd(new Date(y, m, 0)) },
    { label: 'Trimestre actual', start: ymd(new Date(y, q * 3, 1)), end: today },
    {
      label: 'Trimestre anterior',
      start: ymd(new Date(prevQY, prevQ * 3, 1)),
      end: ymd(new Date(prevQY, prevQ * 3 + 3, 0)),
    },
    { label: 'Semestre actual', start: ymd(new Date(y, h * 6, 1)), end: today },
    {
      label: 'Semestre anterior',
      start: ymd(new Date(prevHY, prevH * 6, 1)),
      end: ymd(new Date(prevHY, prevH * 6 + 6, 0)),
    },
  ]
}

/** Client-side table page size — the endpoint returns up to 5000 rows. */
const PAGE_SIZE = 50

const DOWNLOAD_TYPES: { value: CfdiDownloadType; label: string }[] = [
  { value: 'both', label: 'Emitidos y recibidos' },
  { value: 'issued', label: 'Solo emitidos' },
  { value: 'received', label: 'Solo recibidos' },
]

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
function isDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}
function jobErrors(job: CfdiJob): string[] {
  const s = job.status
  if (s.status === 'done') return s.errors
  if (s.status === 'failed') return [s.error]
  return []
}

type SortCol = 'fecha' | 'total' | 'folio' | 'emisor'

/** KPIs + monthly series + per-currency totals + top counterparties, all
 * client-computed. Skips payment-complement CFDIs (tipo "P") and non-positive
 * totals for the money aggregates. */
function buildCfdiAnalytics(items: Cfdi[]) {
  const monthly = new Map<string, { emitidos: number; recibidos: number }>()
  const currency = new Map<string, { emit: number; rec: number }>()
  const emisores = new Map<string, number>()
  const receptores = new Map<string, number>()
  let emitidos = 0
  let recibidos = 0
  for (const c of items) {
    if (c.tipo === 'P' || c.total <= 0) continue
    const month = (c.fecha ?? '').slice(0, 7)
    const bucket = monthly.get(month) ?? { emitidos: 0, recibidos: 0 }
    const cur = currency.get(c.moneda ?? '—') ?? { emit: 0, rec: 0 }
    if (c.es_emitido) {
      bucket.emitidos += c.total
      emitidos += c.total
      cur.emit += c.total
      const name = c.receptor_nombre ?? '—'
      receptores.set(name, (receptores.get(name) ?? 0) + c.total)
    } else {
      bucket.recibidos += c.total
      recibidos += c.total
      cur.rec += c.total
      const name = c.emisor_nombre ?? '—'
      emisores.set(name, (emisores.get(name) ?? 0) + c.total)
    }
    monthly.set(month, bucket)
    currency.set(c.moneda ?? '—', cur)
  }
  const series = [...monthly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, v]) => ({ label, income: v.emitidos, expense: v.recibidos }))
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  return {
    emitidos,
    recibidos,
    series,
    currencies: [...currency.entries()].sort(([a], [b]) => a.localeCompare(b)),
    topEmisores: top(emisores),
    topReceptores: top(receptores),
  }
}

export default function Cfdi(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const companyId = createMemo(() => auth.companies().find((c) => c.active)?.id ?? '')
  const qc = useQueryClient()

  const [tab, setTab] = createSignal<'explorar' | 'sincronizar'>('explorar')

  const cfdisQuery = createQuery(() => ({ queryKey: ['cfdis'], queryFn: fiscalApi.listCfdis }))
  const configsQuery = createQuery(() => ({
    queryKey: ['sat-configs'],
    queryFn: fiscalApi.listSatConfigs,
    enabled: isAdmin(),
  }))
  const jobsQuery = createQuery(() => ({
    queryKey: ['cfdi-jobs', companyId()],
    queryFn: () => fiscalApi.listCfdiJobs(companyId()),
    enabled: isAdmin() && companyId() !== '',
    refetchInterval: (query: Query<CfdiJob[]>) => {
      const data = query.state.data
      return data?.some((j) => isActiveStatus(j.status.status)) ? 4000 : false
    },
  }))

  // --- download form state ---------------------------------------------------
  const [satConfigId, setSatConfigId] = createSignal('')
  const [start, setStart] = createSignal(yearsAgoJan(5))
  const [end, setEnd] = createSignal(todayStr())
  const [downloadType, setDownloadType] = createSignal<CfdiDownloadType>('both')
  const [autoPay, setAutoPay] = createSignal(false)
  const [dlError, setDlError] = createSignal<string | null>(null)
  const [errorDetail, setErrorDetail] = createSignal<{ title: string; errors: string[] } | null>(null)

  createEffect(() => {
    const list = configsQuery.data
    if (list && list.length > 0 && satConfigId() === '') setSatConfigId(list[0].id)
  })

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
    onError: (err) => setDlError(humanizeError(err, 'No se pudo iniciar la descarga')),
  }))

  const activeJobs = createMemo(() => (jobsQuery.data ?? []).filter((j) => isActiveStatus(j.status.status)).length)
  const busy = createMemo(() => downloadMutation.isPending || activeJobs() > 0)

  const startDownload = (ev: SubmitEvent) => {
    ev.preventDefault()
    if (satConfigId() === '') return setDlError('Selecciona una configuración SAT')
    if (!isDateInput(start()) || !isDateInput(end())) return setDlError('Las fechas deben tener formato YYYY-MM-DD')
    if (start() > end()) return setDlError('Desde no puede ser mayor que Hasta')
    setDlError(null)
    downloadMutation.mutate()
  }
  const applyRange = (r: QuickRange) => {
    setStart(r.start)
    setEnd(r.end)
    setDlError(null)
  }

  // --- manual XML/ZIP upload -------------------------------------------------
  const [uploadResult, setUploadResult] = createSignal<fiscalApi.CfdiUploadResult | null>(null)
  const [uploadError, setUploadError] = createSignal<string | null>(null)
  const uploadMutation = createMutation(() => ({
    mutationFn: (files: File[]) => fiscalApi.uploadCfdis(companyId(), files),
    onSuccess: (res) => {
      setUploadError(null)
      setUploadResult(res)
      // Refresh the explorer list (and job history, for consistency).
      void qc.invalidateQueries({ queryKey: ['cfdis'] })
      void qc.invalidateQueries({ queryKey: ['cfdi-jobs', companyId()] })
    },
    onError: (err) => {
      setUploadResult(null)
      setUploadError(humanizeError(err, 'No se pudieron subir los CFDIs'))
    },
  }))
  const onDropCfdis = (files: File[]) => {
    if (!files.length) return
    setUploadResult(null)
    setUploadError(null)
    uploadMutation.mutate(files)
  }

  const jobAgg = createMemo(() =>
    (jobsQuery.data ?? []).reduce(
      (a, j) => {
        const s = j.status
        if (s.status === 'done') {
          a.found += s.imported
          a.created += s.transactions_created
          a.updated += s.transactions_updated
          a.skipped += s.transactions_skipped
          a.errors += s.errors.length
        } else if (s.status === 'failed') {
          a.errors += 1
        }
        return a
      },
      { found: 0, created: 0, updated: 0, skipped: 0, errors: 0 },
    ),
  )

  // --- explorer: filters + sort + pagination ---------------------------------
  const allCfdis = createMemo(() => cfdisQuery.data?.items ?? [])
  const hasCfdis = () => allCfdis().length > 0
  const monedas = createMemo(() => [...new Set(allCfdis().map((c) => c.moneda).filter((m): m is string => !!m))])

  const [search, setSearch] = createSignal('')
  const [dir, setDir] = createSignal<'all' | 'emit' | 'rec'>('all')
  const [moneda, setMoneda] = createSignal('all')
  const [sort, setSort] = createSignal<SortCol>('fecha')
  const [sortDir, setSortDir] = createSignal<'asc' | 'desc'>('desc')
  const [page, setPage] = createSignal(1)

  const toggleSort = (col: SortCol) => {
    if (sort() === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSort(col)
      setSortDir('desc')
    }
  }

  const filtered = createMemo(() => {
    let list = allCfdis().slice()
    const q = search().trim().toLowerCase()
    if (q) {
      list = list.filter(
        (c) =>
          (c.folio ?? '').toLowerCase().includes(q) ||
          (c.emisor_nombre ?? '').toLowerCase().includes(q) ||
          (c.receptor_nombre ?? '').toLowerCase().includes(q) ||
          c.uuid.toLowerCase().includes(q),
      )
    }
    if (dir() !== 'all') list = list.filter((c) => (dir() === 'emit' ? c.es_emitido : !c.es_emitido))
    if (moneda() !== 'all') list = list.filter((c) => (c.moneda ?? '') === moneda())
    const s = sort()
    const sd = sortDir() === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (s === 'folio') return sd * String(a.folio ?? '').localeCompare(String(b.folio ?? ''))
      if (s === 'emisor') return sd * String(a.emisor_nombre ?? '').localeCompare(String(b.emisor_nombre ?? ''))
      const av = s === 'total' ? a.total : new Date(a.fecha ?? 0).getTime()
      const bv = s === 'total' ? b.total : new Date(b.fecha ?? 0).getTime()
      return sd * (av - bv)
    })
    return list
  })

  // reset to page 1 whenever the filter inputs change
  createEffect(() => {
    search()
    dir()
    moneda()
    setPage(1)
  })
  const totalFiltered = createMemo(() => filtered().length)
  const totalPages = createMemo(() => Math.max(1, Math.ceil(totalFiltered() / PAGE_SIZE)))
  const pageItems = createMemo(() => {
    const p = Math.min(page(), totalPages())
    const from = (p - 1) * PAGE_SIZE
    return filtered().slice(from, from + PAGE_SIZE)
  })

  const analytics = createMemo(() => buildCfdiAnalytics(filtered()))
  const emitCount = createCountUp(() => analytics().emitidos)
  const recCount = createCountUp(() => analytics().recibidos)
  const netCount = createCountUp(() => analytics().emitidos - analytics().recibidos)

  // --- detail drawer ---------------------------------------------------------
  const [detailBase, setDetailBase] = createSignal<Cfdi | null>(null)
  const detailQuery = createQuery(() => ({
    queryKey: ['cfdi-detail', detailBase()?.uuid],
    queryFn: () => fiscalApi.getCfdi(detailBase()!.uuid),
    enabled: detailBase() !== null,
  }))
  const openDetail = (c: Cfdi) => setDetailBase(c)

  const exportCsv = () => {
    const header = ['Folio', 'Tipo', 'Fecha', 'Emisor', 'Receptor', 'Total', 'Moneda', 'Dirección']
    const rows = filtered().map((c) => [
      c.folio ?? '',
      c.tipo ?? '',
      c.fecha ? rfc3339ToDate(c.fecha) : '',
      c.emisor_nombre ?? '',
      c.receptor_nombre ?? '',
      String(c.total),
      c.moneda ?? '',
      c.es_emitido ? 'Emitido' : 'Recibido',
    ])
    const csv = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'cfdis.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const maxEmisor = () => analytics().topEmisores[0]?.[1] ?? 1
  const maxReceptor = () => analytics().topReceptores[0]?.[1] ?? 1

  const sortIcon = (col: SortCol) => (sort() !== col ? '↕' : sortDir() === 'asc' ? '↑' : '↓')

  return (
    <div class="space-y-6">
      <PageHeader
        breadcrumb={['Fiscal', 'CFDIs']}
        title="CFDIs"
        subtitle="Facturas del SAT importadas, sincronización y analítica."
        actions={
          <div
            class="flex items-center gap-2.5 rounded-xl border border-border bg-glass px-3.5 py-2.5"
            title="Todos los XML se archivan y deduplican por UUID"
          >
            <span class="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-600">
              <ShieldCheck class="h-5 w-5" />
            </span>
            <div class="leading-tight">
              <div class="text-[12px] font-semibold">Respaldo XML activo</div>
              <div class="text-[11px] text-muted-foreground">deduplicado por UUID</div>
            </div>
          </div>
        }
      />

      {/* Tabs */}
      <div class="border-b border-border">
        <nav class="-mb-px flex gap-1" role="tablist" aria-label="Secciones">
          <button
            type="button"
            role="tab"
            aria-selected={tab() === 'explorar'}
            onClick={() => setTab('explorar')}
            class="relative flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium transition"
            classList={{ 'text-foreground': tab() === 'explorar', 'text-muted-foreground': tab() !== 'explorar' }}
          >
            <FileText class="h-4 w-4" /> Explorar CFDIs
            <span class="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tnum text-muted-foreground">
              {int(allCfdis().length)}
            </span>
            <Show when={tab() === 'explorar'}>
              <span class="tab-underline" />
            </Show>
          </button>
          <Show when={isAdmin()}>
            <button
              type="button"
              role="tab"
              aria-selected={tab() === 'sincronizar'}
              onClick={() => setTab('sincronizar')}
              class="relative flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium transition"
              classList={{ 'text-foreground': tab() === 'sincronizar', 'text-muted-foreground': tab() !== 'sincronizar' }}
            >
              <RefreshCw class="h-4 w-4" /> Sincronización
              <Show when={activeJobs() > 0}>
                <span class="ml-0.5 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  <span class="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />
                  {activeJobs()}
                </span>
              </Show>
              <Show when={tab() === 'sincronizar'}>
                <span class="tab-underline" />
              </Show>
            </button>
          </Show>
        </nav>
      </div>

      {/* ============================ EXPLORAR ============================ */}
      <Show when={tab() === 'explorar'}>
        <Show
          when={!cfdisQuery.isLoading}
          fallback={
            <div class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Spinner />
              <span>Cargando…</span>
            </div>
          }
        >
          <Show
            when={hasCfdis()}
            fallback={
              <Card glass class="flex flex-col items-center gap-3 p-16 text-center">
                <Landmark class="h-8 w-8 text-muted-foreground" />
                <p class="text-sm text-muted-foreground">Sin CFDIs.</p>
              </Card>
            }
          >
            <div class="space-y-6">
              {/* KPIs */}
              <div class="grid gap-3 sm:grid-cols-3">
                <Card glass glow class="p-4">
                  <div class="flex items-start justify-between">
                    <div>
                      <div class="text-[12px] font-medium text-muted-foreground">Emitidos (ingresos)</div>
                      <div class="mt-1.5 text-[22px] font-bold tnum text-emerald-600">{money(emitCount())}</div>
                    </div>
                    <span class="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-600">
                      <ArrowUpRight class="h-5 w-5" />
                    </span>
                  </div>
                </Card>
                <Card glass glow class="p-4">
                  <div class="flex items-start justify-between">
                    <div>
                      <div class="text-[12px] font-medium text-muted-foreground">Recibidos (egresos)</div>
                      <div class="mt-1.5 text-[22px] font-bold tnum text-rose-600">{money(recCount())}</div>
                    </div>
                    <span class="grid h-9 w-9 place-items-center rounded-lg bg-rose-500/15 text-rose-600">
                      <ArrowDownLeft class="h-5 w-5" />
                    </span>
                  </div>
                </Card>
                <Card glass glow class="p-4">
                  <div class="flex items-start justify-between">
                    <div>
                      <div class="text-[12px] font-medium text-muted-foreground">Neto</div>
                      <div class="mt-1.5 text-[22px] font-bold tnum text-sky-600">{money(netCount())}</div>
                    </div>
                    <span class="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sky-600">
                      <Scale class="h-5 w-5" />
                    </span>
                  </div>
                  <div class="mt-2.5 text-[11px] text-muted-foreground">{int(totalFiltered())} CFDIs en el rango</div>
                </Card>
              </div>

              {/* Charts */}
              <div class="grid gap-3 lg:grid-cols-3">
                <Card glass glow class="p-4 lg:col-span-2">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 class="text-[14px] font-semibold">Mensual · emitidos vs recibidos</h3>
                      <p class="text-[12px] text-muted-foreground">Por mes en el rango</p>
                    </div>
                    <div class="flex items-center gap-3 text-[12px]">
                      <span class="flex items-center gap-1.5">
                        <span class="h-2.5 w-2.5 rounded-full bg-emerald-500" />Emitidos
                      </span>
                      <span class="flex items-center gap-1.5">
                        <span class="h-2.5 w-2.5 rounded-full bg-rose-500" />Recibidos
                      </span>
                    </div>
                  </div>
                  <div class="mt-3 h-48">
                    <LineArea data={analytics().series} class="h-full w-full text-muted-foreground" />
                  </div>
                </Card>
                <Card glass glow class="p-4">
                  <h3 class="text-[14px] font-semibold">Dirección</h3>
                  <div class="mx-auto mt-2 h-40 w-40">
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
                </Card>
              </div>

              {/* Currency totals + tops */}
              <div class="grid gap-3 lg:grid-cols-3">
                <Card glass glow class="p-4">
                  <h3 class="text-[14px] font-semibold">Totales por moneda</h3>
                  <div class="mt-3 space-y-3">
                    <For
                      each={analytics().currencies}
                      fallback={<p class="text-[12px] text-muted-foreground">Sin datos</p>}
                    >
                      {([cur, v]) => (
                        <div class="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5">
                          <span class="flex items-center gap-2 text-[13px] font-medium">
                            <span class="grid h-7 w-7 place-items-center rounded-md bg-primary/15 text-[11px] font-bold tnum text-primary">
                              {cur}
                            </span>
                          </span>
                          <div class="text-right">
                            <div class="text-[13px] font-semibold tnum text-emerald-600">{money(v.emit)}</div>
                            <div class="text-[11px] tnum text-rose-600">−{money(v.rec)}</div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Card>
                <Card glass glow class="p-4">
                  <h3 class="text-[14px] font-semibold">
                    Top emisores <span class="text-[11px] font-normal text-muted-foreground">(gastos)</span>
                  </h3>
                  <div class="mt-3 space-y-2.5">
                    <For
                      each={analytics().topEmisores}
                      fallback={<p class="text-[12px] text-muted-foreground">Sin datos</p>}
                    >
                      {([name, val]) => (
                        <div>
                          <div class="flex items-center justify-between gap-2">
                            <span class="truncate text-[12px] font-medium">{name}</span>
                            <span class="shrink-0 text-[12px] tnum text-muted-foreground">{money(val)}</span>
                          </div>
                          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div class="bar-grow h-full rounded-full bg-rose-500" style={{ width: `${((val / maxEmisor()) * 100).toFixed(1)}%` }} />
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Card>
                <Card glass glow class="p-4">
                  <h3 class="text-[14px] font-semibold">
                    Top receptores <span class="text-[11px] font-normal text-muted-foreground">(ingresos)</span>
                  </h3>
                  <div class="mt-3 space-y-2.5">
                    <For
                      each={analytics().topReceptores}
                      fallback={<p class="text-[12px] text-muted-foreground">Sin datos</p>}
                    >
                      {([name, val]) => (
                        <div>
                          <div class="flex items-center justify-between gap-2">
                            <span class="truncate text-[12px] font-medium">{name}</span>
                            <span class="shrink-0 text-[12px] tnum text-muted-foreground">{money(val)}</span>
                          </div>
                          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div class="bar-grow h-full rounded-full bg-emerald-500" style={{ width: `${((val / maxReceptor()) * 100).toFixed(1)}%` }} />
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Card>
              </div>

              {/* Toolbar + table */}
              <Card glass class="overflow-hidden">
                <div class="border-b border-border p-3 sm:p-4">
                  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div class="relative w-full lg:max-w-sm">
                      <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="search"
                        value={search()}
                        onInput={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Buscar folio, emisor, receptor o UUID…"
                        aria-label="Buscar CFDIs"
                        class="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-[13px] placeholder:text-muted-foreground focus:border-ring focus:outline-none"
                      />
                    </div>
                    <div class="flex flex-wrap items-center gap-3">
                      <div class="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
                        <span class="px-1.5 text-[11px] font-semibold uppercase text-muted-foreground">Dir</span>
                        <For
                          each={[
                            { v: 'all', l: 'Todos' },
                            { v: 'emit', l: 'Emitidos' },
                            { v: 'rec', l: 'Recibidos' },
                          ] as const}
                        >
                          {(opt) => (
                            <button
                              type="button"
                              class="rounded-lg px-2.5 py-1 text-[12px] font-medium transition"
                              classList={{
                                'bg-primary text-primary-foreground': dir() === opt.v,
                                'text-muted-foreground hover:text-foreground': dir() !== opt.v,
                              }}
                              onClick={() => setDir(opt.v)}
                            >
                              {opt.l}
                            </button>
                          )}
                        </For>
                      </div>
                      <Show when={monedas().length > 1}>
                        <Select value={moneda()} onChange={setMoneda}>
                          <option value="all">Todas las monedas</option>
                          <For each={monedas()}>{(m) => <option value={m}>{m}</option>}</For>
                        </Select>
                      </Show>
                      <Button type="button" variant="outline" class="h-8 gap-1.5 px-2.5 text-[13px]" onClick={exportCsv}>
                        <Download class="h-4 w-4" /> Exportar
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Desktop table */}
                <div class="hidden overflow-x-auto md:block">
                  <table class="w-full text-[13px]">
                    <thead class="bg-muted/40">
                      <tr class="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <th class="px-3 py-2.5">
                          <button class="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('folio')}>
                            Folio <span class="tnum">{sortIcon('folio')}</span>
                          </button>
                        </th>
                        <th class="px-3 py-2.5">Tipo</th>
                        <th class="px-3 py-2.5">
                          <button class="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('fecha')}>
                            Fecha <span class="tnum">{sortIcon('fecha')}</span>
                          </button>
                        </th>
                        <th class="px-3 py-2.5">
                          <button class="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('emisor')}>
                            Emisor <span class="tnum">{sortIcon('emisor')}</span>
                          </button>
                        </th>
                        <th class="px-3 py-2.5">Receptor</th>
                        <th class="px-3 py-2.5 text-right">
                          <button class="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('total')}>
                            Total <span class="tnum">{sortIcon('total')}</span>
                          </button>
                        </th>
                        <th class="px-3 py-2.5">Dirección</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For
                        each={pageItems()}
                        fallback={
                          <tr>
                            <td colspan="7" class="px-3 py-16 text-center text-muted-foreground">
                              Sin resultados
                            </td>
                          </tr>
                        }
                      >
                        {(c) => (
                          <tr
                            class="row-hover cursor-pointer border-b border-border/60 transition"
                            tabindex="0"
                            role="button"
                            aria-label={`Ver detalle folio ${c.folio ?? c.uuid}`}
                            onClick={() => openDetail(c)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                openDetail(c)
                              }
                            }}
                          >
                            <td class="px-3 py-2.5 font-medium tnum">{c.folio ?? ''}</td>
                            <td class="px-3 py-2.5 text-muted-foreground">{c.tipo ?? ''}</td>
                            <td class="whitespace-nowrap px-3 py-2.5 text-muted-foreground tnum">
                              {c.fecha ? rfc3339ToDate(c.fecha) : ''}
                            </td>
                            <td class="max-w-[180px] truncate px-3 py-2.5">{c.emisor_nombre ?? ''}</td>
                            <td class="max-w-[180px] truncate px-3 py-2.5">{c.receptor_nombre ?? ''}</td>
                            <td class="whitespace-nowrap px-3 py-2.5 text-right font-semibold tnum">
                              {money(c.total)} <span class="text-[11px] font-normal text-muted-foreground">{c.moneda ?? ''}</span>
                            </td>
                            <td class="whitespace-nowrap px-3 py-2.5">
                              <Badge tone={c.es_emitido ? 'success' : 'info'}>{c.es_emitido ? 'Emitido' : 'Recibido'}</Badge>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div class="grid gap-2.5 p-3 md:hidden">
                  <For
                    each={pageItems()}
                    fallback={<p class="py-12 text-center text-muted-foreground">Sin resultados</p>}
                  >
                    {(c) => (
                      <button
                        type="button"
                        class="card glow-edge w-full rounded-xl p-3.5 text-left transition active:scale-[.99]"
                        onClick={() => openDetail(c)}
                      >
                        <div class="flex items-center justify-between gap-2">
                          <span class="font-semibold tnum">{c.folio ?? ''}</span>
                          <Badge tone={c.es_emitido ? 'success' : 'info'}>{c.es_emitido ? 'Emitido' : 'Recibido'}</Badge>
                        </div>
                        <div class="mt-2 text-[13px]">
                          <span class="text-muted-foreground">{c.es_emitido ? 'Para: ' : 'De: '}</span>
                          {c.es_emitido ? c.receptor_nombre ?? '' : c.emisor_nombre ?? ''}
                        </div>
                        <div class="mt-1.5 flex items-center justify-between">
                          <span class="text-[12px] text-muted-foreground tnum">{c.fecha ? rfc3339ToDate(c.fecha) : ''}</span>
                          <span class="font-bold tnum">
                            {money(c.total)} <span class="text-[11px] font-normal text-muted-foreground">{c.moneda ?? ''}</span>
                          </span>
                        </div>
                      </button>
                    )}
                  </For>
                </div>

                <Pagination
                  page={Math.min(page(), totalPages())}
                  totalPages={totalPages()}
                  onChange={setPage}
                  summary={
                    <span>
                      <span class="font-medium text-foreground tnum">{int(totalFiltered())}</span> CFDIs
                    </span>
                  }
                />
              </Card>
            </div>
          </Show>
        </Show>
      </Show>

      {/* ============================ SINCRONIZAR ============================ */}
      <Show when={tab() === 'sincronizar' && isAdmin()}>
        <div class="grid gap-6 lg:grid-cols-5">
          <div class="space-y-6 lg:col-span-2">
            {/* Download form */}
            <Card glass glow class="overflow-hidden">
              <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <div class="flex items-center gap-2">
                  <CloudDownload class="h-[18px] w-[18px] text-primary" />
                  <h2 class="text-[15px] font-semibold">Descargar del SAT</h2>
                </div>
                <Badge tone="neutral">Solo admin</Badge>
              </div>
              <div class="p-4">
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
                      <div class="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-600">
                        <Info class="mt-0.5 h-4 w-4 shrink-0" />
                        <span>No hay configuraciones de e.firma. Agrega una en Config. SAT para descargar.</span>
                      </div>
                    }
                  >
                    <form onSubmit={startDownload} class="space-y-4">
                      <div class="grid gap-3 sm:grid-cols-2">
                        <div class="space-y-1">
                          <label class="block text-[12px] font-medium">Configuración SAT</label>
                          <Select value={satConfigId()} onChange={setSatConfigId}>
                            <For each={configsQuery.data ?? []}>
                              {(c) => {
                                const label = c.label && c.label !== '' ? c.label : c.rfc
                                return (
                                  <option value={c.id}>
                                    {label} ({c.rfc})
                                  </option>
                                )
                              }}
                            </For>
                          </Select>
                        </div>
                        <div class="space-y-1">
                          <label class="block text-[12px] font-medium">Tipo</label>
                          <Select value={downloadType()} onChange={(v) => setDownloadType(v as CfdiDownloadType)}>
                            <For each={DOWNLOAD_TYPES}>{(t) => <option value={t.value}>{t.label}</option>}</For>
                          </Select>
                        </div>
                        <div class="space-y-1">
                          <label class="block text-[12px] font-medium">Desde</label>
                          <DateField value={start()} onChange={setStart} label="Fecha inicial" />
                        </div>
                        <div class="space-y-1">
                          <label class="block text-[12px] font-medium">Hasta</label>
                          <DateField value={end()} onChange={setEnd} label="Fecha final" />
                        </div>
                      </div>
                      <div>
                        <span class="mb-1.5 block text-[12px] font-medium text-muted-foreground">Rangos rápidos</span>
                        <div class="flex flex-wrap gap-1.5">
                          <For each={buildQuickRanges(new Date())}>
                            {(r) => (
                              <Button type="button" variant="outline" class="h-7 px-2 text-xs" onClick={() => applyRange(r)}>
                                {r.label}
                              </Button>
                            )}
                          </For>
                        </div>
                      </div>
                      <Checkbox checked={autoPay()} onChange={setAutoPay} label="Crear pagos automáticamente" />
                      <Show when={dlError()}>
                        <div class="text-[12px] text-destructive">{dlError()}</div>
                      </Show>
                      <Button type="submit" disabled={busy()} class="magnetic w-full gap-2">
                        <CloudDownload class="h-4 w-4" /> {busy() ? 'Descargando…' : 'Descargar CFDIs'}
                      </Button>
                    </form>
                  </Show>
                </Show>
              </div>
            </Card>

            {/* Manual upload card — drop XML/ZIP; same DB + file store as SAT
                download, deduped/updated by UUID. */}
            <Card glass class="overflow-hidden">
              <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <div class="flex items-center gap-2">
                  <UploadCloud class="h-[18px] w-[18px] text-primary" />
                  <h2 class="text-[15px] font-semibold">Subir CFDIs manualmente</h2>
                </div>
                <Badge tone="neutral">Solo admin</Badge>
              </div>
              <div class="space-y-3 p-4">
                <Dropzone
                  accept=".xml,.zip,text/xml,application/xml,application/zip"
                  multiple
                  disabled={uploadMutation.isPending || companyId() === ''}
                  onFiles={onDropCfdis}
                  label={
                    uploadMutation.isPending
                      ? 'Subiendo…'
                      : 'Arrastra XML o ZIP aquí, o haz clic para elegir'
                  }
                  hint="Se guardan igual que las descargas del SAT; si el UUID ya existe, se actualiza."
                />
                <Show when={uploadMutation.isPending}>
                  <div class="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <Spinner />
                    <span>Procesando archivos…</span>
                  </div>
                </Show>
                <Show when={uploadError()}>
                  <div class="text-[12px] text-destructive">{uploadError()}</div>
                </Show>
                <Show when={uploadResult()}>
                  {(res) => (
                    <div class="space-y-2 rounded-lg border border-border bg-glass p-3 text-[12px]">
                      <div class="flex flex-wrap items-center gap-2">
                        <Badge tone="success">{res().imported} importados/actualizados</Badge>
                        <Show when={res().failed > 0}>
                          <Badge tone="danger">{res().failed} con error</Badge>
                        </Show>
                        <span class="text-muted-foreground">de {res().files} archivo(s)</span>
                      </div>
                      <Show when={res().errors.length > 0}>
                        <ul class="list-disc space-y-0.5 pl-4 text-muted-foreground">
                          <For each={res().errors.slice(0, 8)}>{(e) => <li>{e}</li>}</For>
                          <Show when={res().errors.length > 8}>
                            <li>… y {res().errors.length - 8} más</li>
                          </Show>
                        </ul>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </Card>

            {/* Daily auto-update card */}
            <Card glass glow class="overflow-hidden">
              <div class="bg-gradient-to-br from-accent/10 to-transparent p-4">
                <div class="flex items-start gap-3">
                  <span class="grid h-10 w-10 place-items-center rounded-xl bg-accent/15 text-accent">
                    <Radio class="pulse-dot h-5 w-5" />
                  </span>
                  <div class="flex-1">
                    <div class="flex items-center gap-2">
                      <h3 class="text-[14px] font-semibold">Actualización automática</h3>
                      <Badge tone="success">● En línea</Badge>
                    </div>
                    <p class="mt-0.5 text-[12px] text-muted-foreground">
                      Se ejecuta todos los días a las <span class="font-medium text-foreground tnum">5:00 am</span> (hora
                      de México) y mantiene tus CFDIs al día.
                    </p>
                  </div>
                </div>
                <div class="mt-3 flex items-start gap-2 rounded-lg bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
                  <CalendarDays class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <b class="text-foreground">Lógica del cron:</b> día 1 → mes anterior completo · lunes → semana pasada
                    · resto → día anterior.
                  </span>
                </div>
              </div>
            </Card>
          </div>

          {/* History */}
          <div class="lg:col-span-3">
            <Card glass class="overflow-hidden">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div class="flex items-center gap-2">
                  <History class="h-[18px] w-[18px] text-muted-foreground" />
                  <h2 class="text-[15px] font-semibold">Historial de descargas</h2>
                  <span class="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    persistente
                  </span>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
                <div class="tile-glass rounded-lg p-3">
                  <div class="text-[11px] text-muted-foreground">Creados</div>
                  <div class="text-[22px] font-bold tnum text-emerald-600">{int(jobAgg().created)}</div>
                </div>
                <div class="tile-glass rounded-lg p-3">
                  <div class="text-[11px] text-muted-foreground">Encontrados</div>
                  <div class="text-[15px] font-semibold tnum text-muted-foreground">{int(jobAgg().found)}</div>
                </div>
                <div class="tile-glass rounded-lg p-3">
                  <div class="text-[11px] text-muted-foreground">Actualizados</div>
                  <div class="text-[15px] font-semibold tnum text-muted-foreground">{int(jobAgg().updated)}</div>
                </div>
                <div class="tile-glass rounded-lg p-3">
                  <div class="text-[11px] text-muted-foreground">Con errores</div>
                  <div
                    class="text-[15px] font-semibold tnum"
                    classList={{ 'text-destructive': jobAgg().errors > 0, 'text-muted-foreground': jobAgg().errors === 0 }}
                  >
                    {int(jobAgg().errors)}
                  </div>
                </div>
              </div>
              <div class="divide-y divide-border/60">
                <For
                  each={jobsQuery.data ?? []}
                  fallback={<div class="p-8 text-center text-[13px] text-muted-foreground">Sin descargas todavía.</div>}
                >
                  {(j) => {
                    const s = j.status
                    const errors = jobErrors(j)
                    return (
                      <div class="px-4 py-3.5">
                        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-[15px] font-semibold">{j.label ?? j.chunk_start ?? '—'}</span>
                            {jobStatusBadge(s.status)}
                          </div>
                          <Show when={j.started_at}>
                            <span class="text-[11px] text-muted-foreground tnum">{rfc3339ToDate(j.started_at!)}</span>
                          </Show>
                        </div>
                        <div class="mt-2.5 flex flex-wrap items-end gap-x-5 gap-y-2">
                          <Stat label="Creados" value={s.status === 'done' ? int(s.transactions_created) : '0'} big color="text-emerald-600" />
                          <Stat label="Encontrados" value={s.status === 'done' ? int(s.imported) : '0'} />
                          <Stat label="Actualiz." value={s.status === 'done' ? int(s.transactions_updated) : '0'} />
                          <Show when={s.status === 'done' && s.transactions_skipped > 0}>
                            <Stat label="Omitidos" value={s.status === 'done' ? int(s.transactions_skipped) : '0'} />
                          </Show>
                          <Show when={errors.length > 0}>
                            <div class="flex flex-col">
                              <span class="text-[10px] uppercase tracking-wide text-destructive/80">Errores</span>
                              <button
                                type="button"
                                class="inline-flex items-center gap-1 text-[12px] font-bold text-destructive hover:underline"
                                onClick={() => setErrorDetail({ title: `Errores · ${j.label ?? j.chunk_start ?? ''}`, errors })}
                              >
                                <AlertCircle class="h-3.5 w-3.5" />
                                {errors.length}
                              </button>
                            </div>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Card>
          </div>
        </div>
      </Show>

      {/* Detail drawer */}
      <Drawer
        open={detailBase() !== null}
        onOpenChange={(open) => !open && setDetailBase(null)}
        title={detailBase()?.folio ?? detailBase()?.uuid ?? 'CFDI'}
        subtitle={[detailBase()?.tipo, detailBase()?.fecha ? rfc3339ToDate(detailBase()!.fecha!) : undefined]
          .filter(Boolean)
          .join(' · ')}
      >
        <Show when={detailBase()}>
          {(base) => (
            <div class="space-y-5 p-5">
              <div class="rounded-xl border border-border bg-muted/30 p-4">
                <div class="text-[12px] text-muted-foreground">Total</div>
                <div
                  class="mt-1 text-[28px] font-bold tnum"
                  classList={{ 'text-emerald-600': base().es_emitido, 'text-rose-600': !base().es_emitido }}
                >
                  {money(base().total)} <span class="text-[15px] font-medium text-muted-foreground">{base().moneda ?? ''}</span>
                </div>
              </div>

              <div class="flex items-center gap-3 rounded-xl border border-border bg-emerald-500/[.06] p-3">
                <span class="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-600">
                  <ShieldCheck class="h-5 w-5" />
                </span>
                <div>
                  <div class="text-[12px] font-semibold">XML archivado</div>
                  <div class="text-[11px] text-muted-foreground">Fuente de verdad · deduplicado por UUID</div>
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="rounded-xl border border-border p-3">
                  <div class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Emisor</div>
                  <div class="mt-1 text-[13px] font-medium">{base().emisor_nombre ?? '—'}</div>
                </div>
                <div class="rounded-xl border border-border p-3">
                  <div class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Receptor</div>
                  <div class="mt-1 text-[13px] font-medium">{base().receptor_nombre ?? '—'}</div>
                </div>
              </div>

              <div>
                <h3 class="mb-2 text-[13px] font-semibold">Conceptos</h3>
                <Show
                  when={!detailQuery.isLoading}
                  fallback={
                    <div class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                      <Spinner />
                      <span>Cargando conceptos…</span>
                    </div>
                  }
                >
                  <Show
                    when={(detailQuery.data?.conceptos.length ?? 0) > 0}
                    fallback={<p class="text-[12px] text-muted-foreground">Sin conceptos.</p>}
                  >
                    <div class="space-y-2">
                      <For each={detailQuery.data?.conceptos ?? []}>
                        {(co) => (
                          <div class="flex items-start justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
                            <div class="min-w-0">
                              <div class="text-[13px] font-medium">{co.descripcion ?? '—'}</div>
                              <div class="text-[11px] text-muted-foreground tnum">Cantidad: {co.cantidad ?? 1}</div>
                            </div>
                            <div class="whitespace-nowrap text-[13px] font-semibold tnum">
                              {money(co.importe ?? 0)}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>

              <div>
                <h3 class="mb-1 text-[13px] font-semibold">Datos fiscales</h3>
                <dl class="divide-y divide-border/60">
                  <div class="flex items-start justify-between gap-3 py-2">
                    <dt class="text-[12px] text-muted-foreground">UUID (folio fiscal)</dt>
                    <dd class="break-all text-right text-[11px] font-medium tnum">{base().uuid}</dd>
                  </div>
                  <div class="flex items-start justify-between gap-3 py-2">
                    <dt class="text-[12px] text-muted-foreground">Moneda</dt>
                    <dd class="text-right text-[13px] font-medium tnum">{base().moneda ?? '—'}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </Show>
      </Drawer>

      {/* Error modal */}
      <Modal
        open={errorDetail() !== null}
        onOpenChange={(open) => !open && setErrorDetail(null)}
        title={errorDetail()?.title ?? 'Errores de descarga'}
        class="max-w-2xl"
      >
        <div class="max-h-[60vh] overflow-y-auto">
          <ol class="space-y-3">
            <For each={errorDetail()?.errors ?? []}>
              {(error, index) => (
                <li class="rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground">
                  <p class="mb-1 text-xs font-semibold uppercase text-muted-foreground">Error {index() + 1}</p>
                  <p class="whitespace-pre-wrap break-words">{error}</p>
                </li>
              )}
            </For>
          </ol>
        </div>
      </Modal>
    </div>
  )
}

function Stat(props: { label: string; value: string; big?: boolean; color?: string }): JSX.Element {
  const cls = () =>
    ['font-semibold tnum', props.big ? 'text-[16px]' : 'text-[12px] text-muted-foreground', props.color ?? '']
      .filter(Boolean)
      .join(' ')
  return (
    <div class="flex flex-col">
      <span class="text-[10px] uppercase tracking-wide text-muted-foreground/80">{props.label}</span>
      <span class={cls()}>{props.value}</span>
    </div>
  )
}
