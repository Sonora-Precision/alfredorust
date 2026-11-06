// Finished pieces this week (Monday–Sunday, Hermosillo): the caller's per part, everyone's
// and the team total, against last week. The admin also sees what those pieces are worth
// at the quoted unit price (Daniel, 2026-11-05); the API sends money to nobody else.
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, Show } from 'solid-js'

import { Card, CardContent } from '../ui/Card'
import * as productionApi from '../../lib/api/production'
import { PartName } from './PartName'
import { ProgrammerName } from './ProgrammerPanel'

const n = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 0 })
const money = (v: number) =>
  v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })

function MoneyTrend(props: { now: number; before: number }): JSX.Element {
  const diff = () => props.now - props.before
  return (
    <span class={`text-xs ${diff() >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
      {diff() >= 0 ? '+' : '−'}
      {money(Math.abs(diff()))}
    </span>
  )
}

function Trend(props: { now: number; before: number }): JSX.Element {
  const diff = () => props.now - props.before
  return (
    <span class={`text-xs ${diff() >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
      {diff() >= 0 ? '+' : ''}
      {n(diff())} vs semana pasada
    </span>
  )
}

export function WeeklyPiecesCard(props: {
  /** Team total only (plant view); otherwise everyone plus the caller's parts. */
  compact?: boolean
  myId?: string | null
}): JSX.Element {
  const q = createQuery(() => ({
    queryKey: ['production', 'weekly-pieces'],
    queryFn: productionApi.getWeeklyPieces,
    refetchInterval: 60_000,
  }))
  const mine = () => q.data?.people.find((p) => p.id === props.myId)

  return (
    <Show when={q.data}>
      {(w) => (
        <Card glass glow={false}>
          <CardContent class="space-y-3 p-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-sm font-semibold text-foreground">Piezas liberadas esta semana</p>
              <p class="text-sm">
                <span class="text-lg font-semibold tabular-nums text-foreground">{n(w().team)}</span>{' '}
                <span class="text-muted-foreground">equipo</span>{' '}
                <Trend now={w().team} before={w().team_previous_week} />
                <Show when={w().team_amount != null}>
                  <span class="ml-2 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {money(w().team_amount!)}
                  </span>{' '}
                  <MoneyTrend now={w().team_amount!} before={w().team_previous_amount ?? 0} />
                </Show>
              </p>
            </div>
            <Show when={!props.compact}>
              <Show when={mine()}>
                {(m) => (
                  <div class="rounded-lg border border-border p-3">
                    <p class="text-sm">
                      <span class="font-medium text-foreground">Tus piezas:</span>{' '}
                      <span class="text-lg font-semibold tabular-nums text-foreground">{n(m().pieces)}</span>{' '}
                      <Trend now={m().pieces} before={m().previous_week} />
                    </p>
                    <Show when={w().mine_by_part.length > 0}>
                      <ul class="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        <For each={w().mine_by_part}>
                          {(p) => (
                            <li>
                              {p.folio} <PartName conceptId={p.id} part={p.part} />: <span class="tabular-nums text-foreground">{n(p.pieces)}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                )}
              </Show>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <For each={w().people}>
                  {(p) => (
                    <div class="rounded-lg bg-muted/40 px-3 py-2">
                      <ProgrammerName id={p.id} name={p.name} class="block max-w-full truncate text-left text-xs text-muted-foreground" />
                      <p class="font-semibold tabular-nums text-foreground">{n(p.pieces)} pzas</p>
                      <Show when={p.amount != null}>
                        <p class="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {money(p.amount!)}{' '}
                          <span class="text-xs font-normal text-muted-foreground">
                            vs {money(p.previous_amount ?? 0)} sem. pasada
                          </span>
                        </p>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </CardContent>
        </Card>
      )}
    </Show>
  )
}
