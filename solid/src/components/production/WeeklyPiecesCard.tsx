// Finished pieces this week (Monday–Sunday, Hermosillo): the caller's per part, everyone's
// and the team total, against last week. Pieces only — money per person stays in the
// admin report (Daniel, 2026-11-02).
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, Show } from 'solid-js'

import { Card, CardContent } from '../ui/Card'
import * as productionApi from '../../lib/api/production'
import { PartName } from './PartName'

const n = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 0 })

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
                      <p class="truncate text-xs text-muted-foreground">{p.name}</p>
                      <p class="font-semibold tabular-nums text-foreground">{n(p.pieces)} pzas</p>
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
