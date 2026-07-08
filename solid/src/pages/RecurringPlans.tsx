// Planes recurrentes — CRUD for recurring income/expense templates, plus a
// "Generar" action that materializes PlannedEntry rows from a plan
// (idempotent per its hidden `version` field). Faithful port of
// frontend/src/pages/recurring_plans.rs; follows the Accounts.tsx pattern
// (solid-query + Modal + Table + toast + Badge). See
// docs/solid-migration/pages-part1.md "RecurringPlansPage" for the spec.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Pencil, Play, Plus, Repeat, Trash2 } from 'lucide-solid'
import { type JSX, Show, createSignal } from 'solid-js'

import { Badge, boolBadgeTone, flowBadgeProps } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as financeApi from '../lib/api/finance'
import type { FlowType, RecurringPlan, RecurringPlanPayload } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { dateToRfc3339, money, rfc3339ToDate } from '../lib/format'

const FREQUENCIES: { value: string; label: string }[] = [
  { value: 'monthly', label: 'Mensual' },
  { value: 'weekly', label: 'Semanal' },
]

const emptyForm = () => ({
  name: '',
  flowType: 'expense' as FlowType,
  categoryId: '',
  accountExpectedId: '',
  contactId: '',
  amountEstimated: '',
  frequency: 'monthly',
  startDate: '',
  endDate: '',
  dayOfMonth: '',
  isActive: true,
  notes: '',
  // Hidden across the form UI, but load-bearing: the backend uses it to mark
  // previously generated PlannedEntry rows as outdated when it changes.
  // Round-tripped unchanged through edit; defaults to 1 for new plans.
  version: 1,
})

export default function RecurringPlans(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const plansQuery = createQuery(() => ({
    queryKey: ['recurring-plans'],
    queryFn: financeApi.listRecurringPlans,
  }))
  const categoriesQuery = createQuery(() => ({ queryKey: ['categories'], queryFn: financeApi.listCategories }))
  const accountsQuery = createQuery(() => ({ queryKey: ['accounts'], queryFn: financeApi.listAccounts }))
  const contactsQuery = createQuery(() => ({ queryKey: ['contacts'], queryFn: financeApi.listContacts }))

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

  const openEdit = async (plan: RecurringPlan) => {
    setEditingId(plan.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const d = await financeApi.getRecurringPlan(plan.id)
      setForm({
        name: d.name,
        flowType: d.flow_type,
        categoryId: d.category_id,
        accountExpectedId: d.account_expected_id,
        contactId: d.contact_id ?? '',
        amountEstimated: String(d.amount_estimated),
        frequency: d.frequency,
        startDate: rfc3339ToDate(d.start_date),
        endDate: d.end_date ? rfc3339ToDate(d.end_date) : '',
        dayOfMonth: d.day_of_month != null ? String(d.day_of_month) : '',
        isActive: d.is_active,
        notes: d.notes ?? '',
        version: d.version,
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el plan'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: RecurringPlanPayload) => {
      const id = editingId()
      return id ? financeApi.updateRecurringPlan(id, payload) : financeApi.createRecurringPlan(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring-plans'] })
      toast.success(editingId() ? 'Plan actualizado' : 'Plan creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el plan'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.name.trim() === '' || f.categoryId === '' || f.accountExpectedId === '' || f.startDate.trim() === '') {
      setFormError('Completa nombre, categoría, cuenta y fecha')
      return
    }
    setFormError(null)
    const notes = f.notes.trim()
    const end = f.endDate.trim()
    const dom = f.dayOfMonth.trim()
    const domNum = dom === '' ? null : Number.parseInt(dom, 10)
    saveMutation.mutate({
      name: f.name.trim(),
      flow_type: f.flowType,
      category_id: f.categoryId,
      account_expected_id: f.accountExpectedId,
      contact_id: f.contactId === '' ? null : f.contactId,
      amount_estimated: Number.parseFloat(f.amountEstimated.trim()) || 0,
      frequency: f.frequency,
      day_of_month: domNum !== null && Number.isNaN(domNum) ? null : domNum,
      start_date: dateToRfc3339(f.startDate),
      end_date: end === '' ? null : dateToRfc3339(end),
      is_active: f.isActive,
      version: f.version,
      notes: notes === '' ? null : notes,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<RecurringPlan | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.deleteRecurringPlan(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring-plans'] })
      toast.success('Plan eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el plan', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  // --- "Generar" action: materialize planned entries from a plan ----------
  const generateMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.generateRecurringPlan(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['planned-entries'] })
      toast.success('Entradas generadas')
    },
    onError: (err) => {
      // Surface the server's reason (e.g. "recurring plan is inactive").
      toast.error('No se pudo generar', humanizeError(err, 'intenta de nuevo'))
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Planes recurrentes"
        breadcrumb={['Finanzas', 'Planes recurrentes']}
        subtitle={
          plansQuery.data
            ? `${plansQuery.data.length} plan${plansQuery.data.length === 1 ? '' : 'es'}`
            : 'Plantillas que generan entradas planificadas.'
        }
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>
              <Plus class="mr-1.5 h-4 w-4" />
              Nuevo plan
            </Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!plansQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!plansQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los planes.
              </CardContent>
            }
          >
            <Show
              when={plansQuery.data && plansQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Repeat class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin planes todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer plan
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Nombre</TableHeadCell>
                    <TableHeadCell>Flujo</TableHeadCell>
                    <TableHeadCell>Monto</TableHeadCell>
                    <TableHeadCell>Frecuencia</TableHeadCell>
                    <TableHeadCell>Activo</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(plansQuery.data ?? []).map((p) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{p.name}</TableCell>
                      <TableCell>
                        <Badge tone={flowBadgeProps(p.flow_type).tone}>{flowBadgeProps(p.flow_type).label}</Badge>
                      </TableCell>
                      <TableCell class="tnum">{money(p.amount_estimated)}</TableCell>
                      <TableCell class="text-muted-foreground">{p.frequency}</TableCell>
                      <TableCell>
                        <Badge tone={boolBadgeTone(p.is_active)}>{p.is_active ? 'Sí' : 'No'}</Badge>
                      </TableCell>
                      <Show when={isAdmin()}>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              onClick={() => generateMutation.mutate(p.id)}
                              disabled={generateMutation.isPending}
                              aria-label="Generar entradas"
                            >
                              <Play class="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" onClick={() => void openEdit(p)} aria-label="Editar">
                              <Pencil class="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(p)}
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
        title={editingId() ? 'Editar plan' : 'Nuevo plan'}
        class="max-w-2xl"
      >
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Renta de oficina"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Flujo</label>
            <Select
              value={form().flowType}
              onChange={(v) => setForm((f) => ({ ...f, flowType: v as FlowType }))}
              disabled={loadingDetail()}
            >
              <option value="income">Ingreso</option>
              <option value="expense">Egreso</option>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Frecuencia</label>
            <Select
              value={form().frequency}
              onChange={(v) => setForm((f) => ({ ...f, frequency: v }))}
              disabled={loadingDetail()}
            >
              {FREQUENCIES.map((fr) => (
                <option value={fr.value}>{fr.label}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Categoría</label>
            <Select
              value={form().categoryId}
              onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}
              disabled={loadingDetail()}
              required
            >
              <option value="">— Selecciona —</option>
              {(categoriesQuery.data ?? []).map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cuenta esperada</label>
            <Select
              value={form().accountExpectedId}
              onChange={(v) => setForm((f) => ({ ...f, accountExpectedId: v }))}
              disabled={loadingDetail()}
              required
            >
              <option value="">— Selecciona —</option>
              {(accountsQuery.data ?? []).map((a) => (
                <option value={a.id}>{a.name}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Monto estimado</label>
            <Input
              value={form().amountEstimated}
              onInput={(v) => setForm((f) => ({ ...f, amountEstimated: v }))}
              inputmode="decimal"
              placeholder="0.00"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Inicio</label>
            <Input
              value={form().startDate}
              onInput={(v) => setForm((f) => ({ ...f, startDate: v }))}
              type="date"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Término (opcional)</label>
            <Input
              value={form().endDate}
              onInput={(v) => setForm((f) => ({ ...f, endDate: v }))}
              type="date"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Día del mes (opcional)</label>
            <Input
              value={form().dayOfMonth}
              onInput={(v) => setForm((f) => ({ ...f, dayOfMonth: v }))}
              inputmode="numeric"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Contacto (opcional)</label>
            <Select
              value={form().contactId}
              onChange={(v) => setForm((f) => ({ ...f, contactId: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguno —</option>
              {(contactsQuery.data ?? []).map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Notas</label>
            <Input
              value={form().notes}
              onInput={(v) => setForm((f) => ({ ...f, notes: v }))}
              disabled={loadingDetail()}
            />
          </div>
          <div class="sm:col-span-2">
            <Checkbox
              checked={form().isActive}
              onChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
              label="Activo"
            />
          </div>

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear plan'}
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
        title="Eliminar plan"
      >
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el plan <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta acción
            no se puede deshacer.
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
