// Mi turno (Daniel, 2026-11-09): what a programmer sees when they arrive. First what others
// did to their parts since their last look (assigned something new, finished or moved a
// step, recorded, released or rejected pieces), then their parts: at their step now, held
// up, and at someone else's step. A few dozen rows: plain DOM (CLAUDE.md rendering guide).
// Never money. An admin can pick a person to see their turn without spending their look.
import { A } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { ReadyBadge } from '../components/production/ReadyBadge'
import { WeeklyPiecesCard } from '../components/production/WeeklyPiecesCard'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { listCompanyPartDrawings } from '../lib/api/partFiles'
import { getMyShift, listBoardMembers } from '../lib/api/production'
import type { MyChange, MyPart, MyStep } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))

export function agoText(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return d === 1 ? 'ayer' : `hace ${d} días`
}

function dayText(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** One line in plain words, from the point of view of `me`. */
export function changeText(c: MyChange, me: string): { text: string; tone: 'new' | 'bad' | 'info' } {
  const who = c.actor.name
  const op = c.operation ?? 'el paso'
  const part = `${c.part} (${c.folio})`
  const pcs = (v: number | null) => `${n(Math.abs(v ?? 0))} ${Math.abs(v ?? 0) === 1 ? 'pieza' : 'piezas'}`
  switch (c.kind) {
    case 'assigned':
      if (c.subject?.id === me) return { text: `${who} te asignó ${op} de ${part}`, tone: 'new' }
      if (c.previous?.id === me) return { text: `${who} pasó ${op} de ${part} a ${c.subject?.name ?? 'otra persona'}`, tone: 'bad' }
      return { text: `${who} asignó ${op} de ${part} a ${c.subject?.name ?? '?'}`, tone: 'info' }
    case 'unassigned':
      if (c.previous?.id === me) return { text: `${who} te quitó ${op} de ${part}`, tone: 'bad' }
      return { text: `${who} dejó sin asignar ${op} de ${part}`, tone: 'info' }
    case 'taken':
      return { text: `${c.subject?.name ?? who} tomó ${op} de ${part}`, tone: 'info' }
    case 'released':
      return { text: `${who} soltó ${op} de ${part}`, tone: 'info' }
    case 'step_done':
      if (c.subject && c.subject.id !== c.actor.id) {
        const owner = c.subject.id === me ? 'tu' : `el de ${c.subject.name},`
        return { text: `${who} marcó terminado ${owner} ${op} de ${part}`, tone: 'info' }
      }
      return { text: `${who} terminó ${op} de ${part}`, tone: 'info' }
    case 'step_reopened':
      return { text: `${who} reabrió ${op} de ${part}`, tone: 'bad' }
    case 'pieces_recorded':
      return (c.pieces ?? 0) >= 0
        ? { text: `${who} registró ${pcs(c.pieces)} en ${part}`, tone: 'info' }
        : { text: `${who} corrigió ${part}: ${pcs(c.pieces)} menos`, tone: 'info' }
    case 'pieces_released':
      return { text: `Calidad (${who}) liberó ${pcs(c.pieces)} de ${part}`, tone: 'new' }
    case 'pieces_rejected':
      return { text: `Calidad (${who}) rechazó ${pcs(c.pieces)} de ${part}${c.reason ? `: ${c.reason}` : ''}. Hay que repetirlas`, tone: 'bad' }
    default:
      return { text: `${who} movió ${part}`, tone: 'info' }
  }
}

const TONE: Record<'new' | 'bad' | 'info', string> = {
  new: 'border-emerald-500/40 bg-emerald-500/10',
  bad: 'border-red-500/40 bg-red-500/10',
  info: 'border-border bg-muted/40',
}

const PRIORITY: Record<MyPart['priority'], string> = {
  urgent: 'bg-red-500/15 text-red-500',
  high: 'bg-amber-500/20 text-amber-500',
  medium: 'bg-muted text-muted-foreground',
  low: 'bg-muted text-muted-foreground',
}

export default function MyShift(): JSX.Element {
  const auth = useAuth()
  const [viewAs, setViewAs] = createSignal<string>('')
  const shift = createQuery(() => ({
    queryKey: ['production', 'my-shift', viewAs()],
    queryFn: () => getMyShift(viewAs() || null),
    refetchInterval: 60_000,
  }))
  const members = createQuery(() => ({
    queryKey: ['production', 'members'],
    queryFn: listBoardMembers,
    enabled: auth.isAdmin(),
  }))
  const drawings = createQuery(() => ({
    queryKey: ['production', 'part-drawings'],
    queryFn: listCompanyPartDrawings,
    staleTime: 60_000,
  }))
  const drawingOf = createMemo(() => new Map((drawings.data ?? []).map((d) => [d.concept_id, d.url])))
  const canOpenProject = () => auth.isAdmin() || auth.hasPermission('view_projects')
  const me = () => shift.data?.person.id ?? ''
  const own = () => !viewAs() || viewAs() === auth.userId()

  const subtitle = () => {
    const d = shift.data
    if (!d) return 'Lo tuyo y lo que cambió desde tu última vez'
    const name = own() ? `Hola, ${d.person.name}` : `Turno de ${d.person.name}`
    const since = d.first_visit ? 'cambios de las últimas 24 h' : `cambios desde ${own() ? 'tu' : 'su'} última vez (${agoText(d.since)})`
    return `${name} · ${since}`
  }

  return (
    <div class="space-y-4">
      <PageHeader
        title="Mi turno"
        subtitle={subtitle()}
        actions={
          <Show when={auth.isAdmin()}>
            <Select value={viewAs()} onChange={setViewAs} class="sm:w-56" aria-label="Ver el turno de">
              <option value="">Mi turno</option>
              <For each={(members.data ?? []).filter((m) => m.id !== auth.userId())}>
                {(m) => <option value={m.id}>{m.name}</option>}
              </For>
            </Select>
          </Show>
        }
      />

      <Show when={shift.data} fallback={<Show when={shift.isError} fallback={<Spinner />}><p class="text-sm text-red-500">No se pudo cargar tu turno.</p></Show>}>
        {(d) => (
          <>
            <section class="space-y-2">
              <h2 class="text-sm font-semibold text-foreground">Qué cambió</h2>
              <Show
                when={d().changes.length}
                fallback={<p class="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">Nadie movió nada tuyo desde {own() ? 'tu' : 'su'} última vez.</p>}
              >
                <ul class="space-y-1.5">
                  <For each={d().changes}>
                    {(c) => {
                      const t = changeText(c, me())
                      return (
                        <li class={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm text-foreground ${TONE[t.tone]}`}>
                          <span>
                            {t.text}
                            <span class="block text-xs text-muted-foreground">{c.project}</span>
                          </span>
                          <span class="shrink-0 text-xs text-muted-foreground" title={new Date(c.at).toLocaleString('es-MX')}>
                            {agoText(c.at)}
                          </span>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </Show>
            </section>

            <PartSection title="Te toca ahora" empty="No tienes ningún paso a tu nombre ahorita." parts={d().now} drawingOf={drawingOf()} canOpenProject={canOpenProject()} />
            <Show when={d().blocked.length}>
              <PartSection title="Detenidas" parts={d().blocked} drawingOf={drawingOf()} canOpenProject={canOpenProject()} />
            </Show>
            <Show when={d().elsewhere.length}>
              <PartSection title="Tuyas, en otro paso" hint="Ya hiciste tu parte o le toca a alguien más." parts={d().elsewhere} drawingOf={drawingOf()} canOpenProject={canOpenProject()} />
            </Show>

            <Show when={own()}>
              <WeeklyPiecesCard myId={auth.userId()} />
            </Show>
            <p class="text-xs text-muted-foreground">
              Para tomar o terminar trabajo usa el <A href="/produccion" class="underline">Tablero de Producción</A>.
            </p>
          </>
        )}
      </Show>
    </div>
  )
}

function PartSection(props: {
  title: string
  hint?: string
  empty?: string
  parts: MyPart[]
  drawingOf: Map<string, string>
  canOpenProject: boolean
}): JSX.Element {
  return (
    <section class="space-y-2">
      <div class="flex items-baseline gap-2">
        <h2 class="text-sm font-semibold text-foreground">{props.title}</h2>
        <span class="text-xs text-muted-foreground">{props.parts.length}</span>
      </div>
      <Show when={props.hint}>
        <p class="text-xs text-muted-foreground">{props.hint}</p>
      </Show>
      <Show when={props.parts.length} fallback={<p class="text-sm text-muted-foreground">{props.empty}</p>}>
        <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <For each={props.parts}>{(p) => <PartCard part={p} drawing={props.drawingOf.get(p.id)} canOpenProject={props.canOpenProject} />}</For>
        </div>
      </Show>
    </section>
  )
}

function StepChip(props: { step: MyStep; quantity: number }): JSX.Element {
  const s = () => props.step
  const cls = () =>
    s().state === 'done'
      ? 'bg-emerald-500/15 text-emerald-500'
      : s().state === 'blocked'
        ? 'bg-red-500/15 text-red-500'
        : s().current
          ? 'bg-sky-500/15 text-sky-500 ring-1 ring-sky-500/50'
          : 'bg-muted text-muted-foreground'
  const label = () => {
    let t = s().name
    if (s().state === 'done') t = `✓ ${t}`
    if (s().state !== 'done' && s().pieces != null) t += ` ${n(s().pieces!)}/${n(props.quantity)}`
    if (s().state !== 'done' && s().programmed) t += ' · programado'
    return t
  }
  return (
    <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls()}`} title={s().assignee ? `${s().name}: ${s().assignee!.name}` : `${s().name}: sin asignar`}>
      {label()}
      <Show when={s().mine}>
        <span class="ml-1 font-semibold">(tú)</span>
      </Show>
    </span>
  )
}

function PartCard(props: { part: MyPart; drawing?: string; canOpenProject: boolean }): JSX.Element {
  const p = () => props.part
  const late = () => p().scheduled_at != null && new Date(p().scheduled_at!).getTime() < Date.now()
  return (
    <div class={`min-w-0 space-y-2 rounded-lg border p-3 ${p().blocked_note ? 'border-red-500/40' : p().new ? 'border-emerald-500/50' : 'border-border'}`}>
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="truncate font-semibold text-foreground">
            {p().part} <span class="text-xs font-normal text-muted-foreground">{p().folio}</span>
          </p>
          <p class="truncate text-xs text-muted-foreground">
            <Show when={props.canOpenProject} fallback={p().project}>
              <A href={`/projects/${p().project_id}`} class="hover:underline">{p().project}</A>
            </Show>
            <Show when={p().client}>{(c) => <> · {c()}</>}</Show>
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap justify-end gap-1">
          <Show when={p().new}>
            <span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-500">NUEVO</span>
          </Show>
          <Show when={p().priority === 'urgent' || p().priority === 'high'}>
            <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium ${PRIORITY[p().priority]}`}>{p().priority_label}</span>
          </Show>
        </div>
      </div>

      <p class="text-sm text-foreground">
        Va en <span class="font-medium">{p().step}</span>
        <span class="text-muted-foreground"> · {p().step_assignee ? (p().step_assignee!.name) : 'sin asignar'}</span>
        <span class="ml-1.5 inline-block align-middle"><ReadyBadge ready={p().ready} /></span>
      </p>
      <Show when={p().blocked_note}>
        <p class="rounded bg-red-500/10 px-2 py-1 text-xs text-red-500">Detenida: {p().blocked_note}</p>
      </Show>

      <div class="flex flex-wrap gap-1">
        <For each={p().steps}>{(s) => <StepChip step={s} quantity={p().quantity} />}</For>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span class="tabular-nums">
          {n(p().released_quantity)} de {n(p().quantity)} {p().unit ?? 'pzs'} liberadas
          <Show when={p().completed_quantity > p().released_quantity}> · {n(p().completed_quantity - p().released_quantity)} en calidad</Show>
        </span>
        <Show when={p().scheduled_at}>
          {(at) => <span class={late() ? 'font-medium text-red-500' : ''}>Entrega {dayText(at())}</span>}
        </Show>
      </div>
      <Show when={props.drawing}>
        {(url) => (
          <a href={url()} target="_blank" rel="noopener" class="inline-block text-xs font-medium text-sky-500 hover:underline">
            Ver plano
          </a>
        )}
      </Show>
    </div>
  )
}
