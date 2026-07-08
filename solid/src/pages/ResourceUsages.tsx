// Uso de recursos (grid) — day-view grid: rows = active project concepts
// (grouped by project), columns = 24 hours; each cell assigns one or more
// resources to that concept for that hour. Rebuilt natively in Solid (a
// `createStore` of `{ "<conceptId>::<hour>": resourceId[] }` is the single
// source of truth for the grid selection — NOT the DOM, unlike the Leptos/v1
// version which scraped checkboxes). See
// docs/solid-migration/pages-part2.md "Resource usages (hourly grid)".
//
// Preserved contracts:
// - `can_edit` from the GET response gates ALL interaction (no pointer
//   handlers wired at all when false, not just visual disabling).
// - Short press cycles a single-resource selection for a cell, falling back
//   to copying the previous hour's selection when the cell is empty and the
//   previous hour has resources that are also valid options here.
// - Long press opens a multi-select menu (implemented as a Modal here).
// - Save POSTs the ENTIRE current grid selection in one shot (bulk-save,
//   not per-cell PATCHes) — see GridSavePayload.
// - Filtering (Fecha/Estado + "Filtrar") re-fetches and replaces the grid;
//   unsaved local edits are discarded, matching current behavior.
import { A } from '@solidjs/router'
import { keepPreviousData, createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createEffect, createSignal } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'

import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import { cn } from '../lib/cn'
import * as operations from '../lib/api/operations'
import type { GridResource, GridRow, GridSelection, GridView } from '../lib/api/types'

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const LONG_PRESS_MS = 450

function isWorkHour(hour: number): boolean {
  return hour >= 7 && hour <= 22
}

/** Matches `js_sys::Date::new_0().to_iso_string()` (UTC-based ISO date). */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function cellKey(conceptId: string, hour: number): string {
  return `${conceptId}::${hour}`
}

function parseCellKey(key: string): { conceptId: string; hour: number } {
  const sep = key.lastIndexOf('::')
  return { conceptId: key.slice(0, sep), hour: Number(key.slice(sep + 2)) }
}

function buildCells(rows: GridRow[]): Record<string, string[]> {
  const cells: Record<string, string[]> = {}
  for (const row of rows) {
    for (const cell of row.cells) {
      cells[cellKey(row.concept_id, cell.hour)] = cell.resources.filter((r) => r.selected).map((r) => r.resource_id)
    }
  }
  return cells
}

interface OpenCellMenu {
  conceptId: string
  hour: number
  resources: GridResource[]
  title: string
}

export default function ResourceUsages(): JSX.Element {
  const qc = useQueryClient()

  // --- filter bar: input-bound values vs. applied (fetch-driving) values ---
  const [date, setDate] = createSignal(todayStr())
  const [statusFilter, setStatusFilter] = createSignal('all')
  const [appliedDate, setAppliedDate] = createSignal(date())
  const [appliedStatus, setAppliedStatus] = createSignal(statusFilter())

  const gridQuery = createQuery(() => ({
    queryKey: ['resource-usages', appliedDate(), appliedStatus()],
    queryFn: () => operations.getResourceUsageGrid(appliedDate(), appliedStatus()),
    // Keeps the previous view (statuses list, can_edit, rows) visible while a
    // new filter is in flight, mirroring the Leptos `meta` signal which only
    // ever updates on a successful response.
    placeholderData: keepPreviousData,
  }))

  const applyFilters = (ev: SubmitEvent) => {
    ev.preventDefault()
    setAppliedDate(date())
    setAppliedStatus(statusFilter())
  }

  // --- grid selection store: the single source of truth for checked cells --
  const [store, setStore] = createStore<{ cells: Record<string, string[]> }>({ cells: {} })

  createEffect(() => {
    const view = gridQuery.data
    if (view) setStore('cells', reconcile(buildCells(view.rows)))
  })

  const selectedIds = (conceptId: string, hour: number): string[] => store.cells[cellKey(conceptId, hour)] ?? []

  const cycleSingleResource = (conceptId: string, hour: number, resources: GridResource[]) => {
    const key = cellKey(conceptId, hour)
    const resourceIds = resources.map((r) => r.resource_id)
    const current = store.cells[key] ?? []
    const currentIndex = current.length > 0 ? resourceIds.indexOf(current[0]) : -1
    let next: string[]
    if (currentIndex === -1) {
      // Nothing selected: try copying the previous hour's selection first.
      const prevIds = store.cells[cellKey(conceptId, hour - 1)] ?? []
      const copied = prevIds.filter((id) => resourceIds.includes(id))
      next = copied.length > 0 ? copied : resourceIds.length > 0 ? [resourceIds[0]] : []
    } else {
      // Cycle to the next resource; cycling past the last one clears the cell.
      const nextIndex = currentIndex + 1
      next = nextIndex < resourceIds.length ? [resourceIds[nextIndex]] : []
    }
    setStore('cells', key, next)
  }

  const toggleResourceInCell = (conceptId: string, hour: number, resourceId: string, checked: boolean) => {
    const key = cellKey(conceptId, hour)
    setStore('cells', key, (prev: string[] | undefined) =>
      checked ? [...(prev ?? []), resourceId] : (prev ?? []).filter((id) => id !== resourceId),
    )
  }

  // --- long-press multi-select menu (Modal-based) ---------------------------
  const [openCell, setOpenCell] = createSignal<OpenCellMenu | null>(null)

  // --- save: POST the entire current grid selection in one shot -------------
  const saveMutation = createMutation(() => ({
    mutationFn: () => {
      const selections: GridSelection[] = []
      for (const [key, resourceIds] of Object.entries(store.cells)) {
        const { conceptId, hour } = parseCellKey(key)
        for (const resourceId of resourceIds) selections.push({ concept_id: conceptId, hour, resource_id: resourceId })
      }
      return operations.saveResourceUsageGrid({
        date: appliedDate(),
        status_id: appliedStatus() === 'all' ? null : appliedStatus(),
        selections,
      })
    },
    onSuccess: () => {
      toast.success('Guardado')
      void qc.invalidateQueries({ queryKey: ['resource-usages'] })
    },
    onError: (err) => {
      toast.error('No se pudo guardar', humanizeError(err, ''))
    },
  }))

  const showProjectDivider = (view: GridView, index: number): boolean =>
    index === 0 || view.rows[index - 1]?.project_id !== view.rows[index]?.project_id

  return (
    <div class="space-y-6">
      <PageHeader
        title="Uso de recursos"
        subtitle="Toca una celda para ciclar el recurso; mantén presionado para el menú múltiple. Horario normal 7–22; las demás horas también se capturan."
        breadcrumb={['Operaciones', 'Uso de recursos']}
        actions={
          <Show when={gridQuery.data?.can_edit} fallback={<Badge tone="neutral">Solo lectura</Badge>}>
            <Button type="button" class="magnetic" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              {saveMutation.isPending ? 'Guardando…' : 'Guardar captura'}
            </Button>
          </Show>
        }
      />

      <Card glass class="p-4">
        <form onSubmit={applyFilters} class="flex flex-wrap items-end gap-3">
          <div>
            <label class="block text-xs font-semibold text-muted-foreground">Fecha</label>
            <Input value={date()} onInput={setDate} type="date" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-muted-foreground">Estado</label>
            <Select value={statusFilter()} onChange={setStatusFilter}>
              <option value="all">Todos</option>
              <For each={gridQuery.data?.statuses ?? []}>{(s) => <option value={s.id}>{s.name}</option>}</For>
            </Select>
          </div>
          <Button type="submit">Filtrar</Button>
        </form>
      </Card>

      <Show
        when={!gridQuery.isFetching}
        fallback={
          <div class="card flex items-center justify-center gap-2 rounded-xl py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </div>
        }
      >
        <Show
          when={!gridQuery.isError}
          fallback={
            <p class="card rounded-xl py-16 text-center text-sm text-destructive">No se pudo cargar el grid.</p>
          }
        >
          <Show when={gridQuery.data}>
            <div class="card overflow-x-auto rounded-xl">
              <table class="min-w-[1200px] table-fixed border-collapse text-sm">
                <thead class="sticky top-0 z-20 bg-muted">
                  <tr>
                    <th class="sticky left-0 z-30 w-64 border-b border-r border-border bg-muted px-4 py-3 text-left align-bottom">
                      <div class="text-2xl font-black text-rose-600">{gridQuery.data!.date}</div>
                      <div class="mt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Concepto
                      </div>
                    </th>
                    <For each={HOURS}>
                      {(h) => (
                        <th
                          class={cn(
                            'w-24 border-b border-r border-border px-2 py-3 text-center text-2xl',
                            isWorkHour(h) ? 'font-black text-foreground' : 'font-semibold text-muted-foreground bg-muted',
                          )}
                        >
                          {h}
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <Show when={gridQuery.data!.rows.length === 0}>
                    <tr>
                      <td colspan={25} class="px-6 py-10 text-center text-muted-foreground">
                        No hay conceptos activos en este estado.
                      </td>
                    </tr>
                  </Show>
                  <For each={gridQuery.data!.rows}>
                    {(row, index) => (
                      <>
                        <Show when={showProjectDivider(gridQuery.data!, index())}>
                          <tr class="bg-muted/80">
                            <td
                              colspan={25}
                              class="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                            >
                              <A
                                href={`/projects/${row.project_id ?? ''}`}
                                class="text-sky-700 hover:text-sky-900 hover:underline"
                              >
                                {row.project_title ?? ''}
                              </A>
                            </td>
                          </tr>
                        </Show>
                        <tr class="hover:bg-muted/60">
                          <th class="sticky left-0 z-10 border-b border-r border-border bg-card px-4 py-4 text-left align-middle">
                            <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              <A href={`/projects/${row.project_id ?? ''}`} class="hover:text-sky-700 hover:underline">
                                {row.project_title ?? ''}
                              </A>
                            </div>
                            <div class="mt-1 flex flex-wrap items-center gap-2">
                              <span class="font-semibold text-sky-900">{row.concept_name}</span>
                              <span class="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {row.status_name ?? ''}
                              </span>
                            </div>
                            <div class="mt-1 text-xs text-muted-foreground">
                              {row.quantity.toFixed(2)} {row.unit ?? ''}
                            </div>
                          </th>
                          <For each={row.cells}>
                            {(cell) => {
                              let timer: number | undefined
                              let longPressed = false
                              const canEdit = () => gridQuery.data?.can_edit ?? false
                              const ids = () => selectedIds(row.concept_id, cell.hour)
                              const label = () => {
                                const sel = ids()
                                if (sel.length === 0) return '+'
                                return cell.resources
                                  .filter((r) => sel.includes(r.resource_id))
                                  .map((r) => r.label)
                                  .join(', ')
                              }
                              const clearTimer = () => {
                                if (timer !== undefined) {
                                  window.clearTimeout(timer)
                                  timer = undefined
                                }
                              }
                              const onPointerDown = (ev: PointerEvent) => {
                                if (!canEdit()) return
                                longPressed = false
                                timer = window.setTimeout(() => {
                                  longPressed = true
                                  setOpenCell({
                                    conceptId: row.concept_id,
                                    hour: cell.hour,
                                    resources: cell.resources,
                                    title: `${row.concept_name} · ${cell.hour}:00`,
                                  })
                                }, LONG_PRESS_MS)
                                ev.preventDefault()
                              }
                              const onPointerUp = (ev: PointerEvent) => {
                                if (!canEdit()) return
                                clearTimer()
                                if (!longPressed) cycleSingleResource(row.concept_id, cell.hour, cell.resources)
                                ev.preventDefault()
                              }
                              const onPointerLeave = () => clearTimer()
                              return (
                                <td class={cn('h-20 border-b border-r border-border p-1 align-top', !cell.is_work_hour && 'bg-muted/70')}>
                                  <div class={cn('group relative h-full rounded-xl transition', ids().length > 0 && 'bg-sky-50')}>
                                    <button
                                      type="button"
                                      disabled={!canEdit()}
                                      onPointerDown={onPointerDown}
                                      onPointerUp={onPointerUp}
                                      onPointerLeave={onPointerLeave}
                                      class={cn(
                                        'flex h-full w-full items-center justify-center rounded-xl px-1 text-center text-xs hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent',
                                        cell.is_work_hour ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
                                        ids().length === 0 && 'text-muted-foreground',
                                      )}
                                    >
                                      {label()}
                                    </button>
                                  </div>
                                </td>
                              )
                            }}
                          </For>
                        </tr>
                      </>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Show>

      {/* Long-press multi-select menu */}
      <Modal open={openCell() !== null} onOpenChange={(open) => !open && setOpenCell(null)} title={openCell()?.title ?? ''}>
        <Show when={openCell()}>
          {(oc) => (
            <div class="space-y-3">
              <Show
                when={oc().resources.length > 0}
                fallback={<p class="text-sm text-muted-foreground">Sin recursos disponibles para este concepto.</p>}
              >
                <div class="space-y-2">
                  <For each={oc().resources}>
                    {(r) => (
                      <Checkbox
                        checked={selectedIds(oc().conceptId, oc().hour).includes(r.resource_id)}
                        onChange={(checked) => toggleResourceInCell(oc().conceptId, oc().hour, r.resource_id, checked)}
                        label={r.label}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <div class="pt-1">
                <Button type="button" variant="outline" onClick={() => setOpenCell(null)}>
                  Cerrar
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Modal>
    </div>
  )
}
