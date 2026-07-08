// Pronósticos — CRUD for named financial-scenario forecasts (projected
// income/expense/net over a date range). Faithful port of
// frontend/src/pages/forecasts.rs; follows the Accounts.tsx pattern
// (solid-query + Modal + Table + toast + Badge). See
// docs/solid-migration/pages-part1.md "ForecastsPage" for the spec.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { LineChart, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, Show, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as financeApi from '../lib/api/finance'
import type { Forecast, ForecastPayload } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { dateToRfc3339, money, rfc3339ToDate } from '../lib/format'

/** Required decimal field: empty/invalid -> 0. */
function num(s: string): number {
  const n = Number.parseFloat(s.trim())
  return Number.isNaN(n) ? 0 : n
}

/** Optional decimal field: empty -> null (vs. 0 for required fields). */
function optNum(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number.parseFloat(t)
  return Number.isNaN(n) ? null : n
}

const emptyForm = () => ({
  scenarioName: '',
  startDate: '',
  endDate: '',
  currency: 'MXN',
  income: '',
  expense: '',
  initialBalance: '',
  finalBalance: '',
  details: '',
  // Hidden across the form UI, but load-bearing: on create it defaults to
  // start_date's ISO value at submit time; on edit it's preserved from the
  // fetched detail and resent unchanged.
  generatedAt: null as string | null,
  notes: null as string | null,
})

export default function Forecasts(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const forecastsQuery = createQuery(() => ({
    queryKey: ['forecasts'],
    queryFn: financeApi.listForecasts,
  }))

  // --- create/edit modal state -------------------------------------------
  const [modalOpen, setModalOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [form, setForm] = createSignal(emptyForm())
  const [formError, setFormError] = createSignal<string | null>(null)
  const [loadingDetail, setLoadingDetail] = createSignal(false)

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm())
    setFormError(null)
    setModalOpen(true)
  }

  const openEdit = async (forecast: Forecast) => {
    setEditingId(forecast.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const d = await financeApi.getForecast(forecast.id)
      setForm({
        scenarioName: d.scenario_name ?? '',
        startDate: rfc3339ToDate(d.start_date),
        endDate: rfc3339ToDate(d.end_date),
        currency: d.currency,
        income: String(d.projected_income_total),
        expense: String(d.projected_expense_total),
        initialBalance: d.initial_balance != null ? String(d.initial_balance) : '',
        finalBalance: d.final_balance != null ? String(d.final_balance) : '',
        details: d.details ?? '',
        generatedAt: d.generated_at,
        notes: d.notes ?? null,
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el pronóstico'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ForecastPayload) => {
      const id = editingId()
      return id ? financeApi.updateForecast(id, payload) : financeApi.createForecast(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['forecasts'] })
      toast.success(editingId() ? 'Pronóstico actualizado' : 'Pronóstico creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el pronóstico'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.startDate.trim() === '' || f.endDate.trim() === '') {
      setFormError('Las fechas son obligatorias')
      return
    }
    setFormError(null)
    const income = num(f.income)
    const expense = num(f.expense)
    const startIso = dateToRfc3339(f.startDate)
    const scenario = f.scenarioName.trim()
    const details = f.details.trim()
    saveMutation.mutate({
      generated_at: f.generatedAt ?? startIso,
      start_date: startIso,
      end_date: dateToRfc3339(f.endDate),
      currency: f.currency,
      projected_income_total: income,
      projected_expense_total: expense,
      projected_net: income - expense,
      initial_balance: optNum(f.initialBalance),
      final_balance: optNum(f.finalBalance),
      details: details === '' ? null : details,
      scenario_name: scenario === '' ? null : scenario,
      notes: f.notes,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Forecast | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.deleteForecast(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['forecasts'] })
      toast.success('Pronóstico eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el pronóstico', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Pronósticos"
        breadcrumb={['Finanzas', 'Pronósticos']}
        subtitle={
          forecastsQuery.data
            ? `${forecastsQuery.data.length} pronóstico${forecastsQuery.data.length === 1 ? '' : 's'}`
            : 'Escenarios de ingreso/egreso proyectados.'
        }
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>
              <Plus class="mr-1.5 h-4 w-4" />
              Nuevo pronóstico
            </Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!forecastsQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!forecastsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los pronósticos.
              </CardContent>
            }
          >
            <Show
              when={forecastsQuery.data && forecastsQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <LineChart class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin pronósticos todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer pronóstico
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Escenario</TableHeadCell>
                    <TableHeadCell>Periodo</TableHeadCell>
                    <TableHeadCell>Neto</TableHeadCell>
                    <TableHeadCell>Moneda</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(forecastsQuery.data ?? []).map((f) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{f.scenario_name ?? ''}</TableCell>
                      <TableCell class="tnum text-muted-foreground">
                        {f.start_date} → {f.end_date}
                      </TableCell>
                      <TableCell class="tnum">{money(f.projected_net)}</TableCell>
                      <TableCell class="text-muted-foreground">{f.currency}</TableCell>
                      <Show when={isAdmin()}>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button variant="ghost" onClick={() => void openEdit(f)} aria-label="Editar">
                              <Pencil class="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(f)}
                              aria-label="Eliminar"
                            >
                              <Trash2 class="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </Show>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal
        open={modalOpen()}
        onOpenChange={setModalOpen}
        title={editingId() ? 'Editar pronóstico' : 'Nuevo pronóstico'}
        class="max-w-2xl"
      >
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-1.5 sm:col-span-3">
            <label class="block text-sm font-medium text-foreground">Escenario</label>
            <Input
              value={form().scenarioName}
              onInput={(v) => setForm((f) => ({ ...f, scenarioName: v }))}
              placeholder="Base 2026"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Desde</label>
            <Input
              value={form().startDate}
              onInput={(v) => setForm((f) => ({ ...f, startDate: v }))}
              type="date"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Hasta</label>
            <Input
              value={form().endDate}
              onInput={(v) => setForm((f) => ({ ...f, endDate: v }))}
              type="date"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Moneda</label>
            <Input
              value={form().currency}
              onInput={(v) => setForm((f) => ({ ...f, currency: v }))}
              placeholder="MXN"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Ingreso proyectado</label>
            <Input
              value={form().income}
              onInput={(v) => setForm((f) => ({ ...f, income: v }))}
              inputmode="decimal"
              placeholder="0.00"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Egreso proyectado</label>
            <Input
              value={form().expense}
              onInput={(v) => setForm((f) => ({ ...f, expense: v }))}
              inputmode="decimal"
              placeholder="0.00"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Saldo inicial (opcional)</label>
            <Input
              value={form().initialBalance}
              onInput={(v) => setForm((f) => ({ ...f, initialBalance: v }))}
              inputmode="decimal"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Saldo final (opcional)</label>
            <Input
              value={form().finalBalance}
              onInput={(v) => setForm((f) => ({ ...f, finalBalance: v }))}
              inputmode="decimal"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5 sm:col-span-3">
            <label class="block text-sm font-medium text-foreground">Detalles (opcional)</label>
            <Input
              value={form().details}
              onInput={(v) => setForm((f) => ({ ...f, details: v }))}
              disabled={loadingDetail()}
            />
          </div>

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-3">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-3">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear pronóstico'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        open={deleteTarget() !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Eliminar pronóstico"
      >
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el pronóstico{' '}
            <span class="font-semibold text-foreground">{deleteTarget()?.scenario_name || 'sin nombre'}</span>? Esta
            acción no se puede deshacer.
          </p>
          <div class="flex items-center gap-2">
            <Button
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => {
                const target = deleteTarget()
                if (target) deleteMutation.mutate(target.id)
              }}
            >
              {deleteMutation.isPending ? 'Eliminando…' : 'Eliminar'}
            </Button>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
