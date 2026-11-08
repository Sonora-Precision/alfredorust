// Traveler (Daniel, 2026-11-08): where every part of every open project is, in levels.
// Level 1: projects with their progress in pieces × stages and delivery; level 2: their
// parts grouped by the stage that holds them; level 3: one part, stage by stage. Or every
// project together by stage ("¿qué hay para cortar?"). What is urgent comes first, as chips
// that filter. Phone first: no dragging, taps only. A hundred-odd rows: plain DOM (CLAUDE.md
// rendering guide). Never money.
import { A } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { Drawer } from '../components/ui/Drawer'
import { SetupProgress } from '../components/projects/SetupProgress'
import { type PartPlace, placesByPart } from '../components/projects/PartMachines'
import { GAP_LABEL, gapsOf } from '../components/projects/PartGaps'
import {
  BUCKETS,
  type Bucket,
  type PartView,
  type Stage,
  daysLeft,
  partView,
  summarize,
} from '../components/traveler/travelerLogic'
import { getPlant, getTraveler } from '../lib/api/production'
import type { ProcessOperation, TravelerProject } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

type Alert = 'atrasadas' | 'programa' | 'material' | 'detenidas' | 'datos'
const ALERTS: { key: Alert; label: string; tone: 'red' | 'amber' | 'muted' }[] = [
  { key: 'atrasadas', label: 'atrasadas', tone: 'red' },
  { key: 'detenidas', label: 'detenidas', tone: 'red' },
  { key: 'programa', label: 'sin programa', tone: 'amber' },
  { key: 'material', label: 'esperando material', tone: 'amber' },
  { key: 'datos', label: 'les faltan datos', tone: 'muted' },
]
const VIEW_KEY = 'sp-traveler-view'

interface Row extends PartView {
  project: TravelerProject
  days: number | null
  places: PartPlace[]
  gaps: string[]
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : null
const pctOf = (done: number, total: number) => (total > 0 ? Math.round((100 * done) / total) : 0)

const STAGE_CLASS: Record<Stage['state'], string> = {
  done: 'bg-emerald-500/15 text-emerald-500',
  active: 'bg-sky-500/15 text-sky-500',
  waiting: 'bg-amber-500/15 text-amber-500',
  blocked: 'bg-red-500/15 text-red-500',
  pending: 'bg-muted text-muted-foreground',
}

function dueClass(days: number | null, finished: boolean): string {
  if (days == null || finished) return 'text-muted-foreground'
  if (days < 0) return 'font-medium text-red-500'
  if (days <= 3) return 'font-medium text-amber-500'
  return 'text-muted-foreground'
}
function dueText(iso: string | null, days: number | null): string {
  const d = fmtDate(iso)
  if (!d || days == null) return 'sin fecha límite'
  if (days < 0) return `límite ${d} · ${-days} ${days === -1 ? 'día' : 'días'} tarde`
  if (days === 0) return `límite hoy`
  return `límite ${d} · faltan ${days} ${days === 1 ? 'día' : 'días'}`
}

export default function Traveler(): JSX.Element {
  const auth = useAuth()
  const canCount = () => auth.isAdmin() || auth.hasPermission('take_work_orders')
  const data = createQuery(() => ({ queryKey: ['traveler'], queryFn: getTraveler, refetchInterval: 60_000 }))
  const plant = createQuery(() => ({ queryKey: ['production', 'plant'], queryFn: getPlant, refetchInterval: 60_000 }))
  const ops = (): ProcessOperation[] => data.data?.operations ?? []

  const rows = createMemo<Row[]>(() => {
    const places = placesByPart(plant.data?.machines ?? [])
    const out: Row[] = []
    for (const p of data.data?.projects ?? []) {
      const days = daysLeft(p.scheduled_at)
      for (const part of p.parts) {
        const v = partView(part, ops())
        out.push({
          ...v,
          project: p,
          days,
          places: places.get(part.id) ?? [],
          gaps: gapsOf(part, { money: false, hasDrawing: true }).map((g) => GAP_LABEL[g]),
        })
      }
    }
    return out
  })

  const isAlert = (r: Row, a: Alert) =>
    a === 'atrasadas'
      ? r.days != null && r.days < 0 && r.bucket !== 'terminada'
      : a === 'programa'
        ? r.bucket === 'programa'
        : a === 'material'
          ? r.bucket === 'material'
          : a === 'detenidas'
            ? r.blocked.length > 0
            : r.gaps.length > 0
  const alertCounts = createMemo(() => Object.fromEntries(ALERTS.map((a) => [a.key, rows().filter((r) => isAlert(r, a.key)).length])) as Record<Alert, number>)

  const [alert, setAlert] = createSignal<Alert | null>(null)
  const [search, setSearch] = createSignal('')
  const readView = (): 'proyecto' | 'etapa' => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'etapa' ? 'etapa' : 'proyecto'
    } catch {
      return 'proyecto'
    }
  }
  const [view, setViewRaw] = createSignal(readView())
  const setView = (v: 'proyecto' | 'etapa') => {
    setViewRaw(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // Private window: still works now.
    }
  }
  const visible = createMemo(() => {
    const a = alert()
    const q = search().trim().toLowerCase()
    return rows().filter(
      (r) =>
        (!a || isAlert(r, a)) &&
        (!q ||
          r.part.name.toLowerCase().includes(q) ||
          r.project.title.toLowerCase().includes(q) ||
          (r.project.client ?? '').toLowerCase().includes(q) ||
          (r.part.work_order_number != null && `ot-${String(r.part.work_order_number).padStart(4, '0')}`.includes(q.replace(/\s/g, '')))),
    )
  })
  const filtering = () => !!alert() || !!search().trim()

  const [openPart, setOpenPart] = createSignal<string | null>(null)
  const [counting, setCounting] = createSignal<string | null>(null)
  const rowOf = (id: string | null) => (id ? rows().find((r) => r.part.id === id) : undefined)

  const tone = (t: 'red' | 'amber' | 'muted', on: boolean) =>
    on
      ? t === 'red'
        ? 'border-red-500 bg-red-500/15 text-red-500'
        : t === 'amber'
          ? 'border-amber-500 bg-amber-500/15 text-amber-500'
          : 'border-foreground/40 bg-muted text-foreground'
      : t === 'red'
        ? 'border-red-500/40 text-red-500'
        : t === 'amber'
          ? 'border-amber-500/40 text-amber-500'
          : 'border-border text-muted-foreground'
  const tab = (on: boolean) => `rounded-full border px-3 py-1.5 text-sm ${on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`

  return (
    <div class="space-y-4">
      <PageHeader title="Traveler" subtitle="Dónde va cada número de parte · se actualiza cada minuto" />

      <div class="flex flex-wrap items-center gap-2">
        <For each={ALERTS.filter((a) => alertCounts()[a.key] > 0)}>
          {(a) => (
            <button type="button" class={`rounded-full border px-3 py-1.5 text-sm ${tone(a.tone, alert() === a.key)}`} onClick={() => setAlert(alert() === a.key ? null : a.key)}>
              <span class="tnum font-semibold">{alertCounts()[a.key]}</span> {a.label}
            </button>
          )}
        </For>
        <Show when={alert()}>
          <button type="button" class="text-sm text-sky-600 hover:underline" onClick={() => setAlert(null)}>
            Ver todo
          </button>
        </Show>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class={tab(view() === 'proyecto')} onClick={() => setView('proyecto')}>
          Por proyecto
        </button>
        <button type="button" class={tab(view() === 'etapa')} onClick={() => setView('etapa')}>
          Por etapa
        </button>
        <input
          type="search"
          class="h-9 w-full min-w-0 basis-full rounded-lg border border-border bg-background px-3 text-sm text-foreground sm:max-w-xs sm:flex-1 sm:basis-auto"
          placeholder="Buscar parte, OT, proyecto o cliente"
          aria-label="Buscar"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      <Show when={!data.isLoading} fallback={<div class="flex justify-center py-12"><Spinner /></div>}>
        <Show when={data.isError}>
          <p class="text-sm text-red-600">No se pudo cargar el traveler. Intenta de nuevo.</p>
        </Show>
        <Show when={rows().length} fallback={<p class="text-sm text-muted-foreground">No hay proyectos abiertos.</p>}>
          <Show when={visible().length} fallback={<p class="text-sm text-muted-foreground">Ninguna parte coincide.</p>}>
            <Show when={view() === 'proyecto'} fallback={<ByStage rows={visible()} filtering={filtering()} onOpen={setOpenPart} />}>
              <ByProject rows={visible()} filtering={filtering()} onOpen={setOpenPart} />
            </Show>
          </Show>
        </Show>
      </Show>

      <Show when={rowOf(openPart())}>
        {(r) => <PartDetail row={r()} canCount={canCount()} onCount={() => setCounting(r().part.id)} onClose={() => setOpenPart(null)} />}
      </Show>
      <Show when={rowOf(counting())}>
        {(r) => (
          <SetupProgress projectId={r().project.id} concept={r().part} ops={ops().filter((o) => o.is_active)} canEdit={canCount()} onClose={() => setCounting(null)} />
        )}
      </Show>
    </div>
  )
}

/** Done (green) and under way (blue) in one bar. */
function ProgressBar(props: { done: number; total: number }): JSX.Element {
  const p = () => pctOf(props.done, props.total)
  return (
    <div class="h-2 overflow-hidden rounded-full bg-muted">
      <div class="h-full rounded-full bg-sky-500" style={{ width: `${p()}%` }} />
    </div>
  )
}

/** Level 1 and 2: each project, and inside it its parts by the stage that holds them. */
function ByProject(props: { rows: Row[]; filtering: boolean; onOpen: (id: string) => void }): JSX.Element {
  const projects = createMemo(() => {
    const map = new Map<string, { project: TravelerProject; days: number | null; rows: Row[] }>()
    for (const r of props.rows) {
      const e = map.get(r.project.id) ?? { project: r.project, days: r.days, rows: [] }
      e.rows.push(r)
      map.set(r.project.id, e)
    }
    return [...map.values()]
  })
  const [open, setOpen] = createSignal<Set<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return (
    <div class="space-y-3">
      <For each={projects()}>
        {(p) => {
          const s = () => summarize(p.rows)
          const finished = () => s().byBucket.terminada === p.rows.length
          // A search or an alert opens every project it found.
          const isOpen = () => props.filtering || open().has(p.project.id)
          return (
            <div class="rounded-xl border border-border bg-card">
              <button type="button" class="w-full p-4 text-left" onClick={() => toggle(p.project.id)} aria-expanded={isOpen()}>
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p class="font-semibold text-foreground">
                    {p.project.title}
                    <Show when={p.project.client}>
                      <span class="font-normal text-muted-foreground"> · {p.project.client}</span>
                    </Show>
                  </p>
                  <span class={`text-sm ${dueClass(p.days, finished())}`}>{dueText(p.project.scheduled_at, p.days)}</span>
                </div>
                <div class="mt-2 flex items-center gap-3">
                  <div class="flex-1">
                    <ProgressBar done={s().done} total={s().total} />
                  </div>
                  <span class="tnum text-sm font-semibold text-foreground">{pctOf(s().done, s().total)}%</span>
                </div>
                <p class="tnum mt-1 text-xs text-muted-foreground">
                  {p.rows.length} {p.rows.length === 1 ? 'parte' : 'partes'} · {s().pieces} pzs · {s().released} liberadas por calidad
                </p>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <For each={BUCKETS.filter((b) => s().byBucket[b.key] > 0)}>
                    {(b) => (
                      <span class={`rounded-md px-2 py-0.5 text-xs ${bucketChip(b.key)}`}>
                        <span class="tnum font-semibold">{s().byBucket[b.key]}</span> {b.label.toLowerCase()}
                      </span>
                    )}
                  </For>
                </div>
              </button>
              <Show when={isOpen()}>
                <div class="border-t border-border px-4 pb-3">
                  <Buckets rows={p.rows} showProject={false} onOpen={props.onOpen} />
                  <A href={`/projects/${p.project.id}`} class="mt-2 inline-block text-xs text-sky-600 hover:underline">
                    Abrir el proyecto (Seguimiento)
                  </A>
                </div>
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}

/** Every project together, stage by stage, most urgent delivery first. */
function ByStage(props: { rows: Row[]; filtering: boolean; onOpen: (id: string) => void }): JSX.Element {
  return (
    <div class="rounded-xl border border-border bg-card px-4 pb-3">
      <Buckets rows={[...props.rows].sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999))} showProject onOpen={props.onOpen} openAll />
    </div>
  )
}

function bucketChip(b: Bucket): string {
  return b === 'terminada'
    ? 'bg-emerald-500/15 text-emerald-500'
    : b === 'material' || b === 'programa'
      ? 'bg-amber-500/15 text-amber-500'
      : 'bg-sky-500/10 text-sky-500'
}

/** Level 2: the parts grouped by stage; finished ones folded. */
function Buckets(props: { rows: Row[]; showProject: boolean; onOpen: (id: string) => void; openAll?: boolean }): JSX.Element {
  const groups = createMemo(() =>
    BUCKETS.map((b) => ({ ...b, rows: props.rows.filter((r) => r.bucket === b.key) })).filter((g) => g.rows.length),
  )
  return (
    <For each={groups()}>
      {(g) => {
        const pieces = () => g.rows.reduce((s, r) => s + r.part.quantity, 0)
        const machines = () => {
          if (g.key !== 'maquina') return ''
          const n = new Map<string, number>()
          for (const r of g.rows) for (const p of r.places) n.set(p.machine, (n.get(p.machine) ?? 0) + 1)
          return [...n].map(([m, k]) => `${m}: ${k}`).join(' · ')
        }
        return (
          <details class="border-t border-border first:border-t-0" open={g.key !== 'terminada' && (props.openAll || g.rows.length <= 12)}>
            <summary class="flex cursor-pointer flex-wrap items-baseline gap-x-2 py-2.5 text-sm">
              <span class="font-semibold text-foreground">{g.label}</span>
              <span class="tnum text-muted-foreground">
                · {g.rows.length} {g.rows.length === 1 ? 'parte' : 'partes'} · {pieces()} pzs
              </span>
              <Show when={machines()}>
                <span class="text-xs text-muted-foreground">({machines()})</span>
              </Show>
            </summary>
            <div class="pb-2">
              <For each={g.rows}>{(r) => <PartRow row={r} showProject={props.showProject} onOpen={props.onOpen} />}</For>
            </div>
          </details>
        )
      }}
    </For>
  )
}

/** One part: its stages with counts, where it runs, what holds it. A tap opens it. */
function PartRow(props: { row: Row; showProject: boolean; onOpen: (id: string) => void }): JSX.Element {
  const r = () => props.row
  const folio = () => (r().part.work_order_number != null ? `OT-${String(r().part.work_order_number).padStart(4, '0')}` : '')
  return (
    <button type="button" class="block w-full rounded-lg px-2 py-2 text-left hover:bg-muted/60" onClick={() => props.onOpen(r().part.id)}>
      <div class="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span class="font-medium text-foreground">{r().part.name}</span>
        <span class="tnum text-xs text-muted-foreground">
          {folio()} · {r().part.quantity} pzs
        </span>
        <Show when={props.showProject}>
          <span class="text-xs text-muted-foreground">· {r().project.title}</span>
          <span class={`text-xs ${dueClass(r().days, r().bucket === 'terminada')}`}>· {fmtDate(r().project.scheduled_at) ?? 'sin fecha'}</span>
        </Show>
      </div>
      <div class="mt-1 flex flex-wrap gap-1">
        <For each={r().stages}>
          {(st) => (
            <span class={`tnum rounded-md px-1.5 py-0.5 text-[11px] leading-tight ${STAGE_CLASS[st.state]}`} title={st.note ?? ''}>
              {st.label} {st.state === 'done' ? '✔' : st.note && st.pieces === 0 ? `· ${st.note}` : st.state === 'pending' && st.pieces === 0 ? '' : `${st.pieces}/${st.total}`}
            </span>
          )}
        </For>
      </div>
      <Show when={r().places.length}>
        <p class="mt-1 text-xs text-sky-500">
          {r()
            .places.map((p) => (p.running ? `▶ corriendo en ${p.machine}` : `#${p.position} en fila de ${p.machine}`) + (p.label ? ` · ${p.label}` : ''))
            .join(' · ')}
        </p>
      </Show>
      <For each={r().blocked}>
        {(b) => (
          <p class="mt-0.5 text-xs font-medium text-red-500">
            ⏸ {b.name}: {b.note ?? 'detenido'}
          </p>
        )}
      </For>
    </button>
  )
}

/** Level 3: the part stage by stage, and what to do with it. */
function PartDetail(props: { row: Row; canCount: boolean; onCount: () => void; onClose: () => void }): JSX.Element {
  const r = () => props.row
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && props.onClose()}
      title={r().part.name}
      subtitle={`${r().project.title} · ${r().part.quantity} pzs · ${dueText(r().project.scheduled_at, r().days)}`}
    >
      <div class="space-y-4 p-4 text-sm">
        <div class="space-y-2">
          <For each={r().stages}>
            {(st) => (
              <div>
                <div class="flex items-baseline justify-between gap-2">
                  <span class="font-medium text-foreground">{st.label}</span>
                  <span class="tnum text-muted-foreground">
                    <Show when={st.note && st.state !== 'done'}>
                      <span class={st.state === 'blocked' ? 'text-red-500' : 'text-amber-500'}>{st.note} · </span>
                    </Show>
                    {st.pieces}/{st.total}
                  </span>
                </div>
                <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    class={`h-full rounded-full ${st.state === 'done' ? 'bg-emerald-500' : st.state === 'blocked' ? 'bg-red-500' : 'bg-sky-500'}`}
                    style={{ width: `${pctOf(st.pieces, st.total)}%` }}
                  />
                </div>
              </div>
            )}
          </For>
        </div>
        <Show when={r().places.length}>
          <div>
            <p class="text-xs font-medium text-muted-foreground">Máquinas</p>
            <For each={r().places}>
              {(p) => (
                <p class="text-sky-500">
                  {p.running ? `▶ Corriendo en ${p.machine}` : `#${p.position} en fila de ${p.machine}`}
                  {p.label ? ` · ${p.label}` : ''}
                </p>
              )}
            </For>
          </div>
        </Show>
        <Show when={r().gaps.length}>
          <p class="text-xs font-medium text-amber-500">Le falta: {r().gaps.join(' · ')}. Se llena en Seguimiento.</p>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={props.canCount}>
            <button type="button" class="rounded-lg border border-primary bg-primary/10 px-3 py-2 text-sm font-medium text-foreground" onClick={() => props.onCount()}>
              Contar piezas y programas
            </button>
          </Show>
          <A href={`/projects/${r().project.id}`} class="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
            Abrir en el proyecto
          </A>
        </div>
        <p class="text-xs text-muted-foreground">
          Una parte cuenta como terminada cuando calidad libera sus piezas. Los setups que la parte no lleva se marcan "No aplica" al contar.
        </p>
      </div>
    </Drawer>
  )
}
