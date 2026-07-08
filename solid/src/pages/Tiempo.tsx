// Tiempo — financial timeline. NATIVE Solid rebuild of the pre-Leptos vanilla-JS
// widget (frontend/src/pages/tiempo.rs), NOT a port. Behaviour parity with the
// original: a horizontal, infinite-scroll timeline (day/week/month/year) of
// cumulative real-vs-plan cash flow, a cumulative SVG chart, per-bucket
// transaction/planned-entry breakdown, and a bulk-pay flow.
//
// Rebuilt idiomatically: signals + <For> over a virtualized window of bucket
// cells (only the visible range + buffer is rendered, absolutely positioned in
// a fixed virtual coordinate space), the chart is a real Solid <svg> component,
// and data is fetched via @tanstack/solid-query keyed by (mode, from, to).
//
// Bucket-key computation matches the server's UTC bucketing exactly (see
// src/routes/tiempo.rs `bucket_start`/`next_bucket`): each cell computes its
// bucket-start Date in UTC and looks the server bucket up by `.toISOString()`,
// which is byte-identical to the server's `fmt_iso` (RFC3339, millis, Z).
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import {
  type JSX,
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js'

import { Badge, type BadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { getTimeline } from '../lib/api/misc'
import { bulkPayPlannedEntries, listAccounts } from '../lib/api/finance'
import type { PlannedItem, TimelineBucket, TimelineMode } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { dateToRfc3339, money } from '../lib/format'

// --- virtualization / fetch tuning ----------------------------------------------------
const CELL_WIDTH = 360
const CHART_H = 176
const HALF = 1500 // virtual buckets each side of the anchor
const TOTAL = HALF * 2 + 1 // total virtual cells in the scroll space
const CENTER = HALF // array index that maps to virtual bucket index 0 (the anchor)
const TOTAL_W = TOTAL * CELL_WIDTH
const RENDER_BUFFER = 3 // extra cells rendered each side of the viewport
const PAGE = 60 // buckets fetched beyond the visible window each side
const MARGIN = 20 // re-fetch when visible gets within MARGIN buckets of the fetched edge

// --- UTC bucketing (must match src/routes/tiempo.rs exactly) ---------------------------

/** Align a Date to the start of its bucket in UTC (Monday-based weeks). */
function bucketStart(date: Date, mode: TimelineMode): Date {
  const d = new Date(date.getTime())
  switch (mode) {
    case 'day':
      d.setUTCHours(0, 0, 0, 0)
      return d
    case 'week': {
      const weekday = (d.getUTCDay() + 6) % 7 // 0 = Monday
      d.setUTCDate(d.getUTCDate() - weekday)
      d.setUTCHours(0, 0, 0, 0)
      return d
    }
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  }
}

/** Bucket start `n` steps away from an already-aligned anchor bucket. */
function bucketAtIndex(anchor: Date, mode: TimelineMode, n: number): Date {
  const d = new Date(anchor.getTime())
  switch (mode) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + n)
      return d
    case 'week':
      d.setUTCDate(d.getUTCDate() + n * 7)
      return d
    case 'month':
      // anchor day is 1; Date.UTC normalizes month overflow safely (no Jan-31 bug).
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear() + n, 0, 1))
  }
}

// --- labels ---------------------------------------------------------------------------

const fmt = (d: Date, opts: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('es-MX', { ...opts, timeZone: 'UTC' }).format(d)

const MODE_LABEL: Record<TimelineMode, string> = {
  day: 'Día',
  week: 'Semana',
  month: 'Mes',
  year: 'Año',
}

const MODES: TimelineMode[] = ['day', 'week', 'month', 'year']

function bucketValueLabel(mode: TimelineMode, start: Date): string {
  switch (mode) {
    case 'day':
      return `${fmt(start, { weekday: 'short' })} ${fmt(start, { day: '2-digit' })} ${fmt(start, { month: 'short' })} ${fmt(start, { year: 'numeric' })}`
    case 'week': {
      const end = new Date(start.getTime())
      end.setUTCDate(end.getUTCDate() + 6)
      return `Sem ${fmt(start, { day: '2-digit', month: 'short' })} - ${fmt(end, { day: '2-digit', month: 'short', year: 'numeric' })}`
    }
    case 'month':
      return `${fmt(start, { month: 'long' })} ${fmt(start, { year: 'numeric' })}`
    case 'year':
      return fmt(start, { year: 'numeric' })
  }
}

// --- amount pill ----------------------------------------------------------------------

function amountTone(value: number): BadgeTone {
  if (value === 0) return 'neutral'
  return value > 0 ? 'success' : 'danger'
}

function AmountBadge(props: { value: number }): JSX.Element {
  return <Badge tone={amountTone(props.value)}>{money(props.value)}</Badge>
}

const PLAN_COLOR = '#a855f7'
const REAL_COLOR = '#0ea5e9'

/** A rendered timeline cell: its virtual position + resolved bucket + cumulatives. */
interface Cell {
  j: number
  isToday: boolean
  value: string
  bucket: TimelineBucket | undefined
  cumReal: number
  cumPlan: number
}

export default function Tiempo(): JSX.Element {
  const auth = useAuth()
  const canView = () => auth.hasPermission('view_timeline')
  const qc = useQueryClient()

  const [mode, setMode] = createSignal<TimelineMode>('month')
  const [anchorMs, setAnchorMs] = createSignal<number>(Date.now())
  const [fetchLo, setFetchLo] = createSignal(-PAGE)
  const [fetchHi, setFetchHi] = createSignal(PAGE)
  const [scrollLeft, setScrollLeft] = createSignal(0)
  const [viewportW, setViewportW] = createSignal(0)

  let viewport: HTMLDivElement | undefined
  let scrollScheduled = false

  const anchorBucket = createMemo(() => bucketStart(new Date(anchorMs()), mode()))

  // Fetch window -> RFC3339 from/to (server treats `to` as exclusive bucket bound).
  const fromIso = createMemo(() => bucketAtIndex(anchorBucket(), mode(), fetchLo()).toISOString())
  const toIso = createMemo(() => bucketAtIndex(anchorBucket(), mode(), fetchHi() + 1).toISOString())

  const timelineQuery = createQuery(() => ({
    queryKey: ['tiempo', mode(), fromIso(), toIso()],
    queryFn: () => getTimeline(mode(), fromIso(), toIso()),
    // Keep the previous window visible while a wider/shifted window loads.
    placeholderData: (prev: TimelineBucket[] | undefined) => prev,
    staleTime: 30_000,
  }))

  const bucketMap = createMemo(() => {
    const m = new Map<string, TimelineBucket>()
    for (const b of timelineQuery.data ?? []) m.set(b.start, b)
    return m
  })

  // --- visible window ------------------------------------------------------------------
  const visible = createMemo(() => {
    const sl = scrollLeft()
    const vw = viewportW()
    const firstJ = Math.max(0, Math.floor(sl / CELL_WIDTH) - RENDER_BUFFER)
    const lastJ = Math.min(TOTAL - 1, Math.ceil((sl + vw) / CELL_WIDTH) + RENDER_BUFFER)
    return { firstJ, lastJ }
  })

  // Shift the fetch window to follow the viewport once it nears a fetched edge.
  createEffect(() => {
    const { firstJ, lastJ } = visible()
    if (viewportW() === 0) return
    const vLo = firstJ - CENTER
    const vHi = lastJ - CENTER
    if (vLo < fetchLo() + MARGIN || vHi > fetchHi() - MARGIN) {
      batch(() => {
        setFetchLo(vLo - PAGE)
        setFetchHi(vHi + PAGE)
      })
    }
  })

  // Resolve visible cells + carry-forward gap-fill of cumulative values.
  const cells = createMemo<Cell[]>(() => {
    const ab = anchorBucket()
    const m = mode()
    const map = bucketMap()
    const nowIso = bucketStart(new Date(), m).toISOString()
    const { firstJ, lastJ } = visible()

    const rows: { j: number; isToday: boolean; value: string; iso: string; bucket: TimelineBucket | undefined }[] = []
    for (let j = firstJ; j <= lastJ; j++) {
      const start = bucketAtIndex(ab, m, j - CENTER)
      const iso = start.toISOString()
      rows.push({
        j,
        isToday: iso === nowIso,
        value: bucketValueLabel(m, start),
        iso,
        bucket: map.get(iso),
      })
    }

    // Seed carry-forward from the first cell that has data (flat line into the
    // leading edge); trailing/empty cells carry the previous cumulative forward.
    const firstWithData = rows.find((r) => r.bucket)
    let lastReal = firstWithData?.bucket?.cumulative_real ?? 0
    let lastPlan = firstWithData?.bucket?.cumulative_planned ?? 0

    return rows.map((r) => {
      if (r.bucket) {
        lastReal = r.bucket.cumulative_real
        lastPlan = r.bucket.cumulative_planned
      }
      return {
        j: r.j,
        isToday: r.isToday,
        value: r.value,
        bucket: r.bucket,
        cumReal: lastReal,
        cumPlan: lastPlan,
      }
    })
  })

  // --- chart model ---------------------------------------------------------------------
  const chartModel = createMemo(() => {
    const cs = cells()
    if (cs.length === 0) return null
    const firstJ = cs[0].j
    const lastJ = cs[cs.length - 1].j
    const left = firstJ * CELL_WIDTH
    const spanW = (lastJ - firstJ + 1) * CELL_WIDTH
    const padY = 26
    const xs = cs.map((c) => (c.j - firstJ) * CELL_WIDTH + CELL_WIDTH / 2)
    const reals = cs.map((c) => c.cumReal)
    const plans = cs.map((c) => c.cumPlan)
    let minY = Math.min(...reals, ...plans)
    let maxY = Math.max(...reals, ...plans)
    if (minY === maxY) {
      minY -= 1
      maxY += 1
    }
    const span = maxY - minY || 1
    const scaleY = (v: number): number => CHART_H - padY - ((v - minY) / span) * (CHART_H - padY * 2)
    const pathOf = (ys: number[]): string =>
      ys.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${scaleY(v).toFixed(1)}`).join(' ')
    const tickCount = 4
    const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
      const v = minY + (span * i) / tickCount
      return { v, y: scaleY(v) }
    })
    const points = cs.map((_c, i) => ({
      x: xs[i],
      realY: scaleY(reals[i]),
      planY: scaleY(plans[i]),
      real: reals[i],
      plan: plans[i],
      realAbove: reals[i] >= plans[i],
    }))
    return { left, spanW, realPath: pathOf(reals), planPath: pathOf(plans), ticks, points }
  })

  // --- scroll / sizing wiring ----------------------------------------------------------
  const onScroll = (): void => {
    if (scrollScheduled) return
    scrollScheduled = true
    requestAnimationFrame(() => {
      scrollScheduled = false
      if (viewport) setScrollLeft(viewport.scrollLeft)
    })
  }

  const recenter = (): void => {
    if (!viewport) return
    const target = CENTER * CELL_WIDTH - viewport.clientWidth / 2 + CELL_WIDTH / 2
    viewport.scrollLeft = Math.max(0, target)
    setScrollLeft(viewport.scrollLeft)
  }

  const resetView = (nextMode: TimelineMode, nextAnchorMs: number): void => {
    batch(() => {
      setMode(nextMode)
      setAnchorMs(nextAnchorMs)
      setFetchLo(-PAGE)
      setFetchHi(PAGE)
    })
    requestAnimationFrame(recenter)
  }

  // Switch mode but keep the currently-centered bucket's date centered.
  const onSelectMode = (next: TimelineMode): void => {
    let aMs = anchorMs()
    if (viewport) {
      const centerN = Math.round((viewport.scrollLeft + viewport.clientWidth / 2) / CELL_WIDTH) - CENTER
      aMs = bucketAtIndex(anchorBucket(), mode(), centerN).getTime()
    }
    resetView(next, aMs)
  }

  const goToday = (): void => resetView(mode(), Date.now())

  onMount(() => {
    if (!viewport) return
    setViewportW(viewport.clientWidth)
    const ro = new ResizeObserver(() => {
      if (viewport) setViewportW(viewport.clientWidth)
    })
    ro.observe(viewport)
    onCleanup(() => ro.disconnect())
    requestAnimationFrame(recenter)
  })

  // Re-center whenever the timeline is re-anchored (mode/anchor change).
  createEffect(
    on([mode, anchorMs], () => requestAnimationFrame(recenter), { defer: true }),
  )

  // --- bulk pay ------------------------------------------------------------------------
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const selectedCount = createMemo(() => selected().size)

  const toggleSelected = (id: string, on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const [payOpen, setPayOpen] = createSignal(false)
  const [payAccount, setPayAccount] = createSignal('')
  const [payDate, setPayDate] = createSignal(new Date().toISOString().slice(0, 10))
  const [payNotes, setPayNotes] = createSignal('')

  const accountsQuery = createQuery(() => ({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: canView(),
  }))

  const openPayFor = (ids: string[]): void => {
    setSelected(new Set(ids))
    setPayAccount(accountsQuery.data?.[0]?.id ?? '')
    setPayNotes('')
    setPayDate(new Date().toISOString().slice(0, 10))
    setPayOpen(true)
  }

  const payMutation = createMutation(() => ({
    mutationFn: () =>
      bulkPayPlannedEntries({
        entry_ids: [...selected()],
        paid_at: dateToRfc3339(payDate()),
        account_id: payAccount(),
        notes: payNotes().trim() === '' ? null : payNotes().trim(),
      }),
    onSuccess: () => {
      toast.success('Pagos registrados')
      setPayOpen(false)
      setSelected(new Set<string>())
      void qc.invalidateQueries({ queryKey: ['tiempo'] })
      void qc.invalidateQueries({ queryKey: ['planned-entries'] })
    },
    onError: () => toast.error('No se pudieron registrar los pagos'),
  }))

  const submitPay = (ev: SubmitEvent): void => {
    ev.preventDefault()
    if (payAccount() === '') {
      toast.error('Selecciona una cuenta')
      return
    }
    payMutation.mutate()
  }

  const isPayable = (pe: PlannedItem): boolean =>
    pe.status !== 'covered' && pe.status !== 'cancelled'

  // -------------------------------------------------------------------------------------
  return (
    <Show
      when={canView()}
      fallback={
        <Card glass>
          <CardHeader>
            <CardTitle>Tiempo</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="text-sm text-muted-foreground">No tienes permiso para ver la línea de tiempo.</p>
          </CardContent>
        </Card>
      }
    >
      <div class="flex h-[calc(100vh-7rem)] w-full min-w-0 flex-col gap-4">
        <PageHeader
          title="Tiempo"
          subtitle="Línea de tiempo horizontal con navegación infinita."
          actions={
            <Show when={timelineQuery.isFetching}>
              <div class="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner class="h-4 w-4" />
                <span>Cargando…</span>
              </div>
            </Show>
          }
        />

        <div class="flex flex-wrap items-center gap-3">
          <div class="inline-flex overflow-hidden rounded-md border border-border bg-card shadow-sm">
            <For each={MODES}>
              {(m) => (
                <button
                  type="button"
                  onClick={() => onSelectMode(m)}
                  class="px-3 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  classList={{
                    'bg-primary text-primary-foreground': mode() === m,
                    'text-foreground hover:bg-muted': mode() !== m,
                  }}
                >
                  {MODE_LABEL[m]}
                </button>
              )}
            </For>
          </div>
          <Button variant="outline" onClick={goToday}>
            Ir a hoy
          </Button>
          <Show when={selectedCount() > 0}>
            <Button
              class="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => setPayOpen(true)}
            >
              {selectedCount() === 1 ? 'Pagar seleccionado' : `Pagar seleccionados (${selectedCount()})`}
            </Button>
          </Show>
        </div>

        <div class="card relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
          {/* Legend */}
          <div class="flex flex-wrap items-center gap-4 border-b border-border px-4 py-2.5">
            <span class="flex items-center gap-2 text-xs font-semibold text-foreground">
              <span class="h-2.5 w-4 rounded-sm" style={{ background: REAL_COLOR }} /> Real acumulado
            </span>
            <span class="flex items-center gap-2 text-xs font-semibold text-foreground">
              <span class="h-2.5 w-4 rounded-sm" style={{ background: PLAN_COLOR }} /> Plan acumulado
            </span>
          </div>

          {/* Viewport + pinned y-axis overlay */}
          <div class="relative min-h-0 flex-1">
            <div
              ref={viewport}
              onScroll={onScroll}
              class="absolute inset-0 overflow-x-auto overflow-y-hidden"
            >
              <div class="relative h-full" style={{ width: `${TOTAL_W}px` }}>
                {/* Chart band background */}
                <div
                  class="pointer-events-none absolute left-0 top-0 border-b border-border bg-card"
                  style={{ width: `${TOTAL_W}px`, height: `${CHART_H}px` }}
                />
                {/* Cumulative real vs plan chart */}
                <Show when={chartModel()}>
                  {(cm) => (
                    <svg
                      class="pointer-events-none absolute top-0"
                      style={{ left: `${cm().left}px`, width: `${cm().spanW}px`, height: `${CHART_H}px` }}
                      width={cm().spanW}
                      height={CHART_H}
                      preserveAspectRatio="none"
                    >
                      <For each={cm().ticks}>
                        {(t) => (
                          <line
                            x1="0"
                            x2={cm().spanW}
                            y1={t.y.toFixed(1)}
                            y2={t.y.toFixed(1)}
                            stroke="currentColor"
                            stroke-opacity="0.12"
                            stroke-width="1"
                            class="text-muted-foreground"
                          />
                        )}
                      </For>
                      <path d={cm().planPath} fill="none" stroke={PLAN_COLOR} stroke-width="2" />
                      <path d={cm().realPath} fill="none" stroke={REAL_COLOR} stroke-width="2" />
                      <For each={cm().points}>
                        {(p) => (
                          <>
                            <circle cx={p.x} cy={p.planY} r="3" fill={PLAN_COLOR} />
                            <circle cx={p.x} cy={p.realY} r="3" fill={REAL_COLOR} />
                            <text
                              x={p.x}
                              y={(p.realAbove ? p.planY + 14 : p.planY - 8).toFixed(1)}
                              text-anchor="middle"
                              font-size="10"
                              fill={PLAN_COLOR}
                            >
                              {money(p.plan)}
                            </text>
                            <text
                              x={p.x}
                              y={(p.realAbove ? p.realY - 8 : p.realY + 14).toFixed(1)}
                              text-anchor="middle"
                              font-size="10"
                              fill={REAL_COLOR}
                            >
                              {money(p.real)}
                            </text>
                          </>
                        )}
                      </For>
                    </svg>
                  )}
                </Show>

                {/* Bucket cells */}
                <For each={cells()}>
                  {(c) => (
                    <div
                      class="absolute flex flex-col overflow-y-auto border-r border-border px-4 py-3"
                      classList={{
                        'bg-sky-500/10 ring-1 ring-inset ring-sky-500/40': c.isToday,
                        'bg-card': !c.isToday && c.j % 2 === 0,
                        'bg-muted/40': !c.isToday && c.j % 2 !== 0,
                      }}
                      style={{ left: `${c.j * CELL_WIDTH}px`, top: `${CHART_H}px`, bottom: '0', width: `${CELL_WIDTH}px` }}
                    >
                      <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {MODE_LABEL[mode()]}
                      </div>
                      <div class="mt-0.5 text-sm font-semibold text-foreground">{c.value}</div>

                      {/* Metrics table: Real / Plan x Ingresos / Gastos / Total / Acumulado */}
                      <div class="mt-3 overflow-hidden rounded-md ring-1 ring-border">
                        <table class="w-full text-xs">
                          <thead class="bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                            <tr>
                              <th class="px-1.5 py-1 text-left">Tipo</th>
                              <th class="px-1.5 py-1 text-left">Ingresos</th>
                              <th class="px-1.5 py-1 text-left">Gastos</th>
                              <th class="px-1.5 py-1 text-left">Total</th>
                              <th class="px-1.5 py-1 text-left">Acum.</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td class="px-1.5 py-1 font-semibold text-foreground">Real</td>
                              <td class="px-1.5 py-1"><AmountBadge value={c.bucket?.real_income ?? 0} /></td>
                              <td class="px-1.5 py-1"><AmountBadge value={-(c.bucket?.real_expense ?? 0)} /></td>
                              <td class="px-1.5 py-1"><AmountBadge value={c.bucket?.net_real ?? 0} /></td>
                              <td class="px-1.5 py-1"><AmountBadge value={c.cumReal} /></td>
                            </tr>
                            <tr class="bg-muted/40">
                              <td class="px-1.5 py-1 font-semibold text-foreground">Plan</td>
                              <td class="px-1.5 py-1"><AmountBadge value={c.bucket?.planned_income ?? 0} /></td>
                              <td class="px-1.5 py-1"><AmountBadge value={-(c.bucket?.planned_expense ?? 0)} /></td>
                              <td class="px-1.5 py-1"><AmountBadge value={c.bucket?.net_planned ?? 0} /></td>
                              <td class="px-1.5 py-1"><AmountBadge value={c.cumPlan} /></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      {/* Line items */}
                      <div class="mt-3 space-y-1 text-sm">
                        <Show
                          when={(c.bucket?.transactions?.length ?? 0) + (c.bucket?.planned_entries?.length ?? 0) > 0}
                          fallback={<div class="text-xs text-muted-foreground">Sin items</div>}
                        >
                          <For each={c.bucket?.transactions ?? []}>
                            {(tx) => (
                              <div class="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1 text-xs">
                                <span
                                  class="shrink-0 font-semibold"
                                  classList={{
                                    'text-emerald-600': tx.type === 'income',
                                    'text-rose-600': tx.type === 'expense',
                                    'text-foreground': tx.type !== 'income' && tx.type !== 'expense',
                                  }}
                                >
                                  {tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : ''}
                                  {money(tx.amount)}
                                </span>
                                <span class="truncate text-foreground" title={tx.description}>
                                  {tx.description}
                                </span>
                              </div>
                            )}
                          </For>
                          <For each={c.bucket?.planned_entries ?? []}>
                            {(pe) => (
                              <div class="flex items-center justify-between gap-2 rounded border border-dashed border-border px-2 py-1 text-xs">
                                <Show when={isPayable(pe)}>
                                  <input
                                    type="checkbox"
                                    class="h-4 w-4 shrink-0 rounded border-input"
                                    checked={selected().has(pe.id)}
                                    onChange={(ev) => toggleSelected(pe.id, ev.currentTarget.checked)}
                                  />
                                </Show>
                                <span
                                  class="shrink-0 font-semibold"
                                  classList={{
                                    'text-emerald-600': pe.flow_type === 'income',
                                    'text-rose-600': pe.flow_type !== 'income',
                                  }}
                                >
                                  {pe.flow_type === 'income' ? '+' : '-'}
                                  {money(pe.amount_estimated)}
                                </span>
                                <span class="flex-1 truncate text-foreground" title={`${pe.name} · ${pe.status}`}>
                                  {pe.name} · {pe.status}
                                </span>
                                <Show when={isPayable(pe)}>
                                  <button
                                    type="button"
                                    onClick={() => openPayFor([pe.id])}
                                    class="shrink-0 rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 ring-1 ring-inset ring-emerald-500/30 transition hover:bg-emerald-500/25"
                                  >
                                    Pagar
                                  </button>
                                </Show>
                              </div>
                            )}
                          </For>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* Pinned y-axis (reflects the current visible y-scale) */}
            <div class="pointer-events-none absolute left-0 top-0 z-30" style={{ height: `${CHART_H}px` }}>
              <For each={chartModel()?.ticks ?? []}>
                {(t) => (
                  <span
                    class="absolute left-1 -translate-y-1/2 rounded bg-card/80 px-1 text-[10px] text-muted-foreground"
                    style={{ top: `${t.y}px` }}
                  >
                    {money(t.v)}
                  </span>
                )}
              </For>
            </div>

            <Show when={timelineQuery.isError}>
              <div class="absolute inset-x-0 bottom-2 mx-auto w-fit rounded bg-destructive/10 px-3 py-1 text-sm text-destructive">
                No se pudo cargar la línea de tiempo.
              </div>
            </Show>
          </div>
        </div>
      </div>

      {/* Bulk-pay modal (replaces the legacy full-page navigation) */}
      <Modal open={payOpen()} onOpenChange={setPayOpen} title="Registrar pago">
        <form onSubmit={submitPay} class="space-y-4">
          <p class="text-sm text-muted-foreground">
            Pagando {selectedCount()} entrada{selectedCount() === 1 ? '' : 's'} planificada
            {selectedCount() === 1 ? '' : 's'}.
          </p>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cuenta</label>
            <Select value={payAccount()} onChange={setPayAccount}>
              <option value="" disabled>
                Selecciona una cuenta
              </option>
              <For each={accountsQuery.data ?? []}>
                {(a) => <option value={a.id}>{a.name}</option>}
              </For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fecha de pago</label>
            <Input type="date" value={payDate()} onInput={setPayDate} />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Notas</label>
            <Input value={payNotes()} onInput={setPayNotes} placeholder="Opcional" />
          </div>
          <div class="flex items-center gap-2">
            <Button type="submit" disabled={payMutation.isPending || selectedCount() === 0}>
              {payMutation.isPending ? 'Registrando…' : 'Registrar pago'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPayOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>
    </Show>
  )
}
