// Taller ahora (Daniel, 2026-11-08): the shop at a glance. What is wrong first (machines
// stopped with work waiting, people in with nothing to do, who has not arrived, held-up
// parts, states nobody updated), then every machine with what it runs and who runs it, then
// every person with what they are doing. Tapping a machine opens its panel to start, stop or
// finish a job, so the phone at the machine is the way to keep it true. A few dozen rows:
// plain DOM (CLAUDE.md rendering guide). Never money.
import { A } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal, onCleanup } from 'solid-js'

import { MachinePanel } from '../components/production/MachinePanel'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import {
  type MachineKind,
  type MachineRow,
  PERSON_ORDER,
  type PersonKind,
  type PersonRow,
  agoText,
  machineRow,
  personRow,
} from '../components/floor/floorLogic'
import { partView } from '../components/traveler/travelerLogic'
import { getFloor, getPlant, getTraveler } from '../lib/api/production'
import { useAuth } from '../lib/auth/AuthContext'

const REFRESH_MS = 30_000

const MACHINE_PILL: Record<MachineKind, { label: string; cls: string }> = {
  working: { label: 'Trabajando', cls: 'bg-emerald-500/15 text-emerald-500' },
  setup: { label: 'En setup', cls: 'bg-sky-500/15 text-sky-500' },
  stopped: { label: 'Parada', cls: 'bg-red-500/15 text-red-500' },
  none: { label: 'Sin dato', cls: 'bg-muted text-muted-foreground' },
}

const PERSON_PILL: Record<PersonKind, { label: string; cls: string }> = {
  machine: { label: 'En máquina', cls: 'bg-emerald-500/15 text-emerald-500' },
  assigned: { label: 'Con trabajo', cls: 'bg-sky-500/15 text-sky-500' },
  idle: { label: 'Sin trabajo', cls: 'bg-amber-500/20 text-amber-500' },
  not_in: { label: 'No ha llegado', cls: 'bg-red-500/15 text-red-500' },
  later: { label: 'Entra más tarde', cls: 'bg-muted text-muted-foreground' },
  left: { label: 'Salió', cls: 'bg-muted text-muted-foreground' },
  absent: { label: 'Faltó', cls: 'bg-red-500/15 text-red-500' },
  off: { label: 'Descansa', cls: 'bg-muted text-muted-foreground' },
  unknown: { label: 'Nada asignado', cls: 'bg-muted text-muted-foreground' },
}

interface Alert {
  tone: 'red' | 'amber'
  text: string
  machine?: string
  href?: string
}

export default function Floor(): JSX.Element {
  const auth = useAuth()
  const canEdit = () => auth.isAdmin() || auth.hasPermission('manage_production_board') || auth.hasPermission('take_work_orders')
  const plant = createQuery(() => ({ queryKey: ['production', 'plant'], queryFn: getPlant, refetchInterval: REFRESH_MS }))
  const floor = createQuery(() => ({ queryKey: ['production', 'floor'], queryFn: getFloor, refetchInterval: REFRESH_MS }))
  const traveler = createQuery(() => ({ queryKey: ['traveler'], queryFn: getTraveler, refetchInterval: 60_000 }))

  // Durations ("parada hace 3 h") move on their own between refreshes.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(tick))

  const machines = createMemo<MachineRow[]>(() => (plant.data?.machines ?? []).map((m) => machineRow(m, now())))
  const withAttendance = () => floor.data?.with_attendance ?? false
  const people = createMemo<PersonRow[]>(() =>
    (floor.data?.people ?? [])
      .map((p) => personRow(p, plant.data?.machines ?? [], withAttendance(), now()))
      .sort((a, b) => PERSON_ORDER.indexOf(a.kind) - PERSON_ORDER.indexOf(b.kind) || a.p.name.localeCompare(b.p.name)),
  )
  const blocked = createMemo(() => {
    const ops = traveler.data?.operations ?? []
    const out: { part: string; project: string; projectId: string; step: string; note: string | null }[] = []
    for (const p of traveler.data?.projects ?? []) {
      for (const part of p.parts) {
        for (const b of partView(part, ops).blocked) {
          out.push({ part: part.name, project: p.title, projectId: p.id, step: b.name, note: b.note })
        }
      }
    }
    return out
  })

  const alerts = createMemo<Alert[]>(() => {
    const out: Alert[] = []
    for (const r of machines()) {
      if (r.idleWithQueue) {
        const n = r.m.queue.length
        out.push({
          tone: 'red',
          machine: r.m.resource_id,
          text: `${r.m.name} ${r.kind === 'none' ? 'sin dato' : `parada${r.hours != null ? ` hace ${agoText(r.hours)}` : ''}`} con ${n} ${n === 1 ? 'trabajo' : 'trabajos'} en cola`,
        })
      }
    }
    for (const r of people()) {
      if (r.kind === 'idle') out.push({ tone: 'red', text: `${r.p.name} está en el taller (${r.clock}) y no tiene nada asignado` })
      if (r.kind === 'not_in') out.push({ tone: 'red', text: `${r.p.name} ${r.clock}` })
    }
    for (const b of blocked()) {
      out.push({ tone: 'red', href: `/projects/${b.projectId}`, text: `${b.part} detenida en ${b.step}${b.note ? `: ${b.note}` : ''} (${b.project})` })
    }
    for (const r of machines()) {
      if (r.stale) {
        out.push({
          tone: 'amber',
          machine: r.m.resource_id,
          text: `${r.m.name} dice "${MACHINE_PILL[r.kind].label.toLowerCase()}" desde hace ${agoText(r.hours)} sin que nadie lo actualice. ¿Sigue así?`,
        })
      }
    }
    return out
  })

  const working = () => machines().filter((r) => r.kind === 'working' || r.kind === 'setup').length
  const idleQueue = () => machines().filter((r) => r.idleWithQueue).length
  const idlePeople = () => people().filter((r) => r.kind === 'idle').length
  const checkedIn = () => people().filter((r) => r.p.in_clock && (r.p.attendance?.checks.length ?? 0) > 0).length
  const inClock = () => people().filter((r) => r.p.in_clock).length

  const [selected, setSelected] = createSignal<string | null>(null)
  const selectedMachine = () => plant.data?.machines.find((m) => m.resource_id === selected())
  const pick = (id: string) => setSelected(selected() === id ? null : id)

  const loading = () => plant.isPending || floor.isPending

  return (
    <div class="space-y-4">
      <PageHeader title="Taller ahora" subtitle="Qué corre cada máquina, en qué está cada quien y qué está detenido · se actualiza cada 30 s" />

      <Show when={!loading()} fallback={<Spinner />}>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi value={`${working()} de ${machines().length}`} label="máquinas trabajando" />
          <Kpi value={String(idleQueue())} label="paradas con trabajo en cola" tone={idleQueue() ? 'red' : undefined} />
          <Show
            when={withAttendance()}
            fallback={<Kpi value={String(people().filter((r) => r.kind === 'machine' || r.kind === 'assigned').length)} label="personas con trabajo" />}
          >
            <Kpi value={String(idlePeople())} label="personas sin trabajo" tone={idlePeople() ? 'amber' : undefined} />
            <Kpi value={`${checkedIn()} de ${inClock()}`} label="checaron hoy" />
          </Show>
        </div>

        <Show
          when={alerts().length}
          fallback={<p class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500">Todo en orden: ninguna máquina parada con trabajo, nadie sin trabajo y nada detenido.</p>}
        >
          <ul class="space-y-1.5">
            <For each={alerts()}>
              {(a) => (
                <li
                  class={`rounded-lg border px-3 py-2 text-sm ${a.tone === 'red' ? 'border-red-500/40 bg-red-500/10 text-red-500' : 'border-amber-500/40 bg-amber-500/10 text-amber-500'}`}
                >
                  <Show when={a.machine} fallback={<Show when={a.href} fallback={a.text}>{(h) => <A href={h()} class="hover:underline">{a.text}</A>}</Show>}>
                    {(id) => (
                      <button type="button" class="text-left hover:underline" onClick={() => setSelected(id())}>
                        {a.text}
                      </button>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <section class="space-y-2">
          <h2 class="text-sm font-semibold text-foreground">Máquinas</h2>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <For each={machines()}>{(r) => <MachineCard row={r} selected={selected() === r.m.resource_id} onPick={() => pick(r.m.resource_id)} />}</For>
          </div>
          <Show when={selectedMachine()}>
            <MachinePanel machine={selectedMachine()} canEdit={canEdit()} onClose={() => setSelected(null)} />
          </Show>
          <Show when={!selected()}>
            <p class="text-xs text-muted-foreground">Toca una máquina para decir qué corre, pausarla o terminar el trabajo.</p>
          </Show>
        </section>

        <section class="space-y-2">
          <h2 class="text-sm font-semibold text-foreground">Personas hoy</h2>
          <div class="divide-y divide-border rounded-lg border border-border">
            <For each={people()}>{(r) => <PersonLine row={r} />}</For>
          </div>
          <Show when={!withAttendance()}>
            <p class="text-xs text-muted-foreground">Las checadas solo las ve un administrador.</p>
          </Show>
        </section>
      </Show>
    </div>
  )
}

function Kpi(props: { value: string; label: string; tone?: 'red' | 'amber' }): JSX.Element {
  return (
    <div class="rounded-lg bg-muted/60 px-3 py-2">
      <div
        class={`tnum text-2xl font-semibold ${props.tone === 'red' ? 'text-red-500' : props.tone === 'amber' ? 'text-amber-500' : 'text-foreground'}`}
      >
        {props.value}
      </div>
      <div class="text-xs text-muted-foreground">{props.label}</div>
    </div>
  )
}

function MachineCard(props: { row: MachineRow; selected: boolean; onPick: () => void }): JSX.Element {
  const m = () => props.row.m
  const pill = () => MACHINE_PILL[props.row.kind]
  const next = () => m().queue[0]
  return (
    <button
      type="button"
      onClick={() => props.onPick()}
      class={`w-full rounded-xl border bg-card p-3 text-left text-sm transition-colors hover:bg-muted/40 ${props.selected ? 'border-primary ring-1 ring-primary' : props.row.idleWithQueue ? 'border-red-500/50' : props.row.stale ? 'border-amber-500/50' : 'border-border'}`}
    >
      <div class="flex items-center justify-between gap-2">
        <span class="font-semibold text-foreground">{m().name}</span>
        <span class={`rounded-md px-2 py-0.5 text-xs font-medium ${pill().cls}`}>
          {pill().label}
          <Show when={props.row.hours != null}> · {agoText(props.row.hours)}</Show>
        </span>
      </div>
      <Show when={props.row.stale}>
        <div class="mt-1 text-xs font-medium text-amber-500">¿Sigue así? Nadie lo ha actualizado</div>
      </Show>
      <div class="mt-2">
        <Show
          when={m().order}
          fallback={
            <span class="text-muted-foreground">
              {m().program && (props.row.kind === 'working' || props.row.kind === 'setup') ? `Programa ${m().program} · sin orden ligada` : 'Sin orden'}
            </span>
          }
        >
          {(o) => (
            <>
              <div class="font-medium text-foreground">
                {o().part}
                <Show when={m().label}> · {m().label}</Show>
              </div>
              <div class="text-xs text-muted-foreground">
                {o().project} · {o().completed_quantity} de {o().quantity} piezas
              </div>
            </>
          )}
        </Show>
      </div>
      <Show when={m().note && props.row.kind === 'stopped'}>
        <div class="mt-1 text-xs text-muted-foreground">Nota: {m().note}</div>
      </Show>
      <div class="mt-2 text-xs text-muted-foreground">
        Opera: <span class="text-foreground">{m().running_by?.name ?? (props.row.kind === 'working' || props.row.kind === 'setup' ? 'sin dato' : 'nadie')}</span>
      </div>
      <div class="text-xs text-muted-foreground">
        Sigue:{' '}
        <Show when={next()} fallback="nada en cola">
          {(e) => (
            <span class="text-foreground">
              {e().order.part}
              <Show when={e().label}> {e().label}</Show>
              <Show when={m().queue.length > 1}> (+{m().queue.length - 1})</Show>
            </span>
          )}
        </Show>
      </div>
    </button>
  )
}

function PersonLine(props: { row: PersonRow }): JSX.Element {
  const r = () => props.row
  const pill = () => PERSON_PILL[r().kind]
  const doing = () => {
    const parts: string[] = []
    for (const m of r().machines) parts.push(`${m.name}${m.order ? ` · ${m.order.part}${m.label ? ` ${m.label}` : ''}` : ''}`)
    const orders = r().p.orders
    if (orders.length) {
      const first = orders[0]
      parts.push(`${first.step} ${first.part}${orders.length > 1 ? ` (+${orders.length - 1})` : ''}`)
    }
    return parts.join(' · ')
  }
  return (
    <div class="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div>
        <span class="font-medium text-foreground">{r().p.name}</span>
        <Show when={r().clock}>
          <span class="text-xs text-muted-foreground"> · {r().clock}</span>
        </Show>
        <Show when={!r().p.in_clock}>
          <span class="text-xs text-muted-foreground"> · no está en el checador</span>
        </Show>
      </div>
      <div class="flex items-center gap-2">
        <Show when={doing()}>
          <span class="text-xs text-foreground">{doing()}</span>
        </Show>
        <span class={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${pill().cls}`}>{pill().label}</span>
      </div>
    </div>
  )
}
