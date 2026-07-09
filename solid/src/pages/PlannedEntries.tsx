// Entradas planificadas — the most stateful page in this batch: three
// overlapping, independently-loading flows on top of one list —
//   1) main CRUD (create/edit/delete a planned entry)
//   2) single-row "Pagar" (registers a payment against one entry)
//   3) multi-row bulk-pay (checkbox selection -> pay several at once)
// Faithful port of frontend/src/pages/planned_entries.rs; follows the
// Accounts.tsx pattern (solid-query + Modal + Table + toast + Badge). See
// docs/solid-migration/pages-part1.md "PlannedEntriesPage" for the spec.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Banknote, ListChecks, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, Show, createSignal, For } from 'solid-js'

import { Badge, flowBadgeProps, statusBadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as financeApi from '../lib/api/finance'
import { listProjectOptions } from '../lib/api/operations'
import type {
  FlowType,
  PlannedEntry,
  PlannedEntryBulkPayPayload,
  PlannedEntryPayload,
  PlannedEntryPayPayload,
  PlannedStatus,
} from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { dateToRfc3339, money, rfc3339ToDate } from '../lib/format'

const STATUSES: { value: PlannedStatus; label: string }[] = [
  { value: 'planned', label: 'Planificado' },
  { value: 'partially_covered', label: 'Parcial' },
  { value: 'covered', label: 'Cubierto' },
  { value: 'overdue', label: 'Vencido' },
  { value: 'cancelled', label: 'Cancelado' },
]

/** `status_label` from the API when present, else the raw `status` value. */
function statusLabel(e: PlannedEntry): string {
  return e.status_label && e.status_label !== '' ? e.status_label : e.status
}

const emptyForm = () => ({
  name: '',
  flowType: 'expense' as FlowType,
  categoryId: '',
  accountExpectedId: '',
  contactId: '',
  projectId: '',
  amountEstimated: '',
  dueDate: '',
  status: 'planned' as PlannedStatus,
  notes: '',
})

export default function PlannedEntries(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const entriesQuery = createQuery(() => ({
    queryKey: ['planned-entries'],
    queryFn: financeApi.listPlannedEntries,
  }))
  const categoriesQuery = createQuery(() => ({ queryKey: ['categories'], queryFn: financeApi.listCategories }))
  const accountsQuery = createQuery(() => ({ queryKey: ['accounts'], queryFn: financeApi.listAccounts }))
  const contactsQuery = createQuery(() => ({ queryKey: ['contacts'], queryFn: financeApi.listContacts }))
  const projectsQuery = createQuery(() => ({ queryKey: ['project-options'], queryFn: listProjectOptions }))

  const invalidateEntries = () => qc.invalidateQueries({ queryKey: ['planned-entries'] })

  // === 1) main CRUD ========================================================
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

  const openEdit = async (entry: PlannedEntry) => {
    setEditingId(entry.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const d = await financeApi.getPlannedEntry(entry.id)
      setForm({
        name: d.name,
        flowType: d.flow_type,
        categoryId: d.category_id,
        accountExpectedId: d.account_expected_id,
        contactId: d.contact_id ?? '',
        projectId: d.project_id ?? '',
        amountEstimated: String(d.amount_estimated),
        dueDate: rfc3339ToDate(d.due_date),
        status: d.status,
        notes: d.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar la entrada'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: PlannedEntryPayload) => {
      const id = editingId()
      return id ? financeApi.updatePlannedEntry(id, payload) : financeApi.createPlannedEntry(payload)
    },
    onSuccess: () => {
      void invalidateEntries()
      toast.success(editingId() ? 'Entrada actualizada' : 'Entrada creada')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar la entrada'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.name.trim() === '' || f.categoryId === '' || f.accountExpectedId === '' || f.dueDate.trim() === '') {
      setFormError('Completa nombre, categoría, cuenta y vencimiento')
      return
    }
    setFormError(null)
    const notes = f.notes.trim()
    saveMutation.mutate({
      name: f.name.trim(),
      flow_type: f.flowType,
      category_id: f.categoryId,
      account_expected_id: f.accountExpectedId,
      contact_id: f.contactId === '' ? null : f.contactId,
      amount_estimated: Number.parseFloat(f.amountEstimated.trim()) || 0,
      due_date: dateToRfc3339(f.dueDate),
      status: f.status,
      project_id: f.projectId === '' ? null : f.projectId,
      notes: notes === '' ? null : notes,
    })
  }

  const [deleteTarget, setDeleteTarget] = createSignal<PlannedEntry | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.deletePlannedEntry(id),
    onSuccess: () => {
      void invalidateEntries()
      toast.success('Entrada eliminada')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar la entrada', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  // === 2) single "Pagar" flow ==============================================
  const [payTarget, setPayTarget] = createSignal<PlannedEntry | null>(null)
  const [payDate, setPayDate] = createSignal('')
  const [payAmount, setPayAmount] = createSignal('')
  const [payAccountId, setPayAccountId] = createSignal('')
  const [payNotes, setPayNotes] = createSignal('')
  const [payError, setPayError] = createSignal<string | null>(null)

  const beginPay = (entry: PlannedEntry) => {
    setPayTarget(entry)
    setPayDate('')
    setPayAmount('')
    setPayAccountId('')
    setPayNotes('')
    setPayError(null)
  }
  const cancelPay = () => setPayTarget(null)

  const payMutation = createMutation(() => ({
    mutationFn: (vars: { id: string; payload: PlannedEntryPayPayload }) =>
      financeApi.payPlannedEntry(vars.id, vars.payload),
    onSuccess: () => {
      void invalidateEntries()
      toast.success('Pago registrado')
      setPayTarget(null)
    },
    onError: (err) => {
      setPayError(humanizeError(err, 'No se pudo registrar el pago'))
    },
  }))

  const paySubmit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const target = payTarget()
    if (!target) return
    if (payDate().trim() === '' || payAccountId() === '') {
      setPayError('Completa fecha y cuenta')
      return
    }
    setPayError(null)
    const notes = payNotes().trim()
    payMutation.mutate({
      id: target.id,
      payload: {
        paid_at: dateToRfc3339(payDate()),
        amount: Number.parseFloat(payAmount().trim()) || 0,
        account_id: payAccountId(),
        // Not wired to a project picker in v1 (matches the original Leptos
        // pay/bulk-pay forms) even though PlannedEntry itself has one.
        project_id: null,
        notes: notes === '' ? null : notes,
      },
    })
  }

  // === 3) bulk-pay flow =====================================================
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const [bulkOpen, setBulkOpen] = createSignal(false)
  const [bulkDate, setBulkDate] = createSignal('')
  const [bulkAccountId, setBulkAccountId] = createSignal('')
  const [bulkNotes, setBulkNotes] = createSignal('')
  const [bulkError, setBulkError] = createSignal<string | null>(null)

  const openBulk = () => {
    setBulkDate('')
    setBulkAccountId('')
    setBulkNotes('')
    setBulkError(null)
    setBulkOpen(true)
  }

  const bulkMutation = createMutation(() => ({
    mutationFn: (payload: PlannedEntryBulkPayPayload) => financeApi.bulkPayPlannedEntries(payload),
    onSuccess: () => {
      void invalidateEntries()
      toast.success('Pagos registrados')
      setBulkOpen(false)
      setSelected(new Set<string>())
    },
    onError: (err) => {
      setBulkError(humanizeError(err, 'No se pudo registrar el pago'))
    },
  }))

  const bulkSubmit = (ev: SubmitEvent) => {
    ev.preventDefault()
    if (bulkDate().trim() === '' || bulkAccountId() === '') {
      setBulkError('Completa fecha y cuenta')
      return
    }
    setBulkError(null)
    const notes = bulkNotes().trim()
    bulkMutation.mutate({
      entry_ids: Array.from(selected()),
      paid_at: dateToRfc3339(bulkDate()),
      account_id: bulkAccountId(),
      project_id: null,
      notes: notes === '' ? null : notes,
    })
  }

  return (
    <div class="space-y-6">
      <PageHeader
        title="Entradas planificadas"
        breadcrumb={['Finanzas', 'Entradas planificadas']}
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>
              <Plus class="mr-1.5 h-4 w-4" />
              Nueva entrada
            </Button>
          </Show>
        }
      />
      <p class="-mt-4 text-sm text-muted-foreground">
        <Show when={entriesQuery.data} fallback="Compromisos de ingreso/egreso esperados.">
          {entriesQuery.data!.length} entrada{entriesQuery.data!.length === 1 ? '' : 's'}
        </Show>
      </p>

      {/* Bulk-pay bar: appears while rows are selected. */}
      <Show when={isAdmin() && selected().size > 0}>
        <div class="flex items-center gap-3 rounded-md bg-muted px-4 py-2 text-sm">
          <span>{selected().size} seleccionadas</span>
          <Button onClick={openBulk}>Pagar seleccionadas</Button>
          <Button variant="ghost" onClick={() => setSelected(new Set<string>())}>
            Limpiar selección
          </Button>
        </div>
      </Show>

      <Card glass>
        <Show when={!entriesQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!entriesQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar las entradas.
              </CardContent>
            }
          >
            <Show
              when={entriesQuery.data && entriesQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <ListChecks class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin entradas todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear la primera entrada
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <div class="hidden md:block">
                <Table>
                  <TableHead>
                    <TableRow>
                      <Show when={isAdmin()}>
                        <TableHeadCell class="w-8" />
                      </Show>
                      <TableHeadCell>Nombre</TableHeadCell>
                      <TableHeadCell>Flujo</TableHeadCell>
                      <TableHeadCell>Monto</TableHeadCell>
                      <TableHeadCell>Vence</TableHeadCell>
                      <TableHeadCell>Estado</TableHeadCell>
                      <Show when={isAdmin()}>
                        <TableHeadCell class="text-right">Acciones</TableHeadCell>
                      </Show>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <For each={entriesQuery.data ?? []}>{(e) => (
                      <TableRow>
                        <Show when={isAdmin()}>
                          <TableCell>
                            <input
                              type="checkbox"
                              class="h-4 w-4 rounded border-input"
                              checked={selected().has(e.id)}
                              onChange={() => toggleSelected(e.id)}
                            />
                          </TableCell>
                        </Show>
                        <TableCell class="font-medium text-foreground">{e.name}</TableCell>
                        <TableCell>
                          <Badge tone={flowBadgeProps(e.flow_type).tone}>{flowBadgeProps(e.flow_type).label}</Badge>
                        </TableCell>
                        <TableCell class="tnum">{money(e.amount_estimated)}</TableCell>
                        <TableCell class="tnum text-muted-foreground">{e.due_date}</TableCell>
                        <TableCell>
                          <Badge tone={statusBadgeTone(statusLabel(e))}>{statusLabel(e)}</Badge>
                        </TableCell>
                        <Show when={isAdmin()}>
                          <TableCell class="text-right">
                            <div class="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                class="text-emerald-600 hover:bg-emerald-500/10"
                                onClick={() => beginPay(e)}
                                aria-label="Pagar"
                              >
                                <Banknote class="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" onClick={() => void openEdit(e)} aria-label="Editar">
                                <Pencil class="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                class="text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget(e)}
                                aria-label="Eliminar"
                              >
                                <Trash2 class="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </Show>
                      </TableRow>
                    )}</For>
                  </TableBody>
                </Table>
              </div>
              <div class="space-y-2 md:hidden">
                <For each={entriesQuery.data ?? []}>{(e) => (
                  <div class="rounded-lg border border-border p-3">
                    <div class="flex items-start justify-between gap-2">
                      <div class="flex min-w-0 flex-1 items-start gap-2">
                        <Show when={isAdmin()}>
                          <input
                            type="checkbox"
                            class="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
                            checked={selected().has(e.id)}
                            onChange={() => toggleSelected(e.id)}
                          />
                        </Show>
                        <p class="min-w-0 flex-1 font-medium text-foreground">{e.name}</p>
                      </div>
                      <Show when={isAdmin()}>
                        <div class="flex shrink-0 gap-1">
                          <Button
                            variant="ghost"
                            class="text-emerald-600 hover:bg-emerald-500/10"
                            onClick={() => beginPay(e)}
                            aria-label="Pagar"
                          >
                            <Banknote class="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" onClick={() => void openEdit(e)} aria-label="Editar">
                            <Pencil class="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            class="text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteTarget(e)}
                            aria-label="Eliminar"
                          >
                            <Trash2 class="h-4 w-4" />
                          </Button>
                        </div>
                      </Show>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Badge tone={flowBadgeProps(e.flow_type).tone}>{flowBadgeProps(e.flow_type).label}</Badge>
                      <Badge tone={statusBadgeTone(statusLabel(e))}>{statusLabel(e)}</Badge>
                      <span class="tnum font-medium text-foreground">{money(e.amount_estimated)}</span>
                      <span class="tnum text-muted-foreground">Vence {e.due_date}</span>
                    </div>
                  </div>
                )}</For>
              </div>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* 1) Create / edit modal */}
      <Modal
        open={modalOpen()}
        onOpenChange={setModalOpen}
        title={editingId() ? 'Editar entrada' : 'Nueva entrada'}
        class="max-w-2xl"
      >
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
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
            <label class="block text-sm font-medium text-foreground">Estado</label>
            <Select
              value={form().status}
              onChange={(v) => setForm((f) => ({ ...f, status: v as PlannedStatus }))}
              disabled={loadingDetail()}
            >
              <For each={STATUSES}>{(s) => (
                <option value={s.value}>{s.label}</option>
              )}</For>
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
              <For each={categoriesQuery.data ?? []}>{(c) => (
                <option value={c.id}>{c.name}</option>
              )}</For>
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
              <For each={accountsQuery.data ?? []}>{(a) => (
                <option value={a.id}>{a.name}</option>
              )}</For>
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
            <label class="block text-sm font-medium text-foreground">Vencimiento</label>
            <Input
              value={form().dueDate}
              onInput={(v) => setForm((f) => ({ ...f, dueDate: v }))}
              type="date"
              required
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
              <For each={contactsQuery.data ?? []}>{(c) => (
                <option value={c.id}>{c.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Proyecto (opcional)</label>
            <Select
              value={form().projectId}
              onChange={(v) => setForm((f) => ({ ...f, projectId: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguno —</option>
              <For each={projectsQuery.data ?? []}>{(p) => (
                <option value={p.id}>{p.title}</option>
              )}</For>
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

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear entrada'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* 2) Single "Pagar" modal — independent pending/error state from the main form. */}
      <Modal
        open={payTarget() !== null}
        onOpenChange={(open) => !open && cancelPay()}
        title={`Registrar pago${payTarget() ? `: ${payTarget()!.name}` : ''}`}
      >
        <form onSubmit={paySubmit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fecha de pago</label>
            <Input value={payDate()} onInput={setPayDate} type="date" required />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Monto real pagado</label>
            <Input value={payAmount()} onInput={setPayAmount} inputmode="decimal" placeholder="0.00" />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Cuenta</label>
            <Select value={payAccountId()} onChange={setPayAccountId} required>
              <option value="">— Selecciona —</option>
              <For each={accountsQuery.data ?? []}>{(a) => (
                <option value={a.id}>{a.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Notas</label>
            <Input value={payNotes()} onInput={setPayNotes} />
          </div>

          <Show when={payError()}>
            <p class="text-sm text-destructive sm:col-span-2">{payError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={payMutation.isPending}>
              {payMutation.isPending ? 'Pagando…' : 'Confirmar pago'}
            </Button>
            <Button type="button" variant="outline" onClick={cancelPay}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* 3) Bulk-pay modal — independent pending/error state, shared date+account across `selected`. */}
      <Modal
        open={bulkOpen()}
        onOpenChange={(open) => !open && setBulkOpen(false)}
        title={`Pagar ${selected().size} entradas`}
      >
        <form onSubmit={bulkSubmit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fecha de pago</label>
            <Input value={bulkDate()} onInput={setBulkDate} type="date" required />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cuenta</label>
            <Select value={bulkAccountId()} onChange={setBulkAccountId} required>
              <option value="">— Selecciona —</option>
              <For each={accountsQuery.data ?? []}>{(a) => (
                <option value={a.id}>{a.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Notas</label>
            <Input value={bulkNotes()} onInput={setBulkNotes} />
          </div>

          <Show when={bulkError()}>
            <p class="text-sm text-destructive sm:col-span-2">{bulkError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={bulkMutation.isPending}>
              {bulkMutation.isPending ? 'Pagando…' : 'Confirmar pago'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setBulkOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        open={deleteTarget() !== null} variant="center"
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Eliminar entrada"
      >
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar la entrada <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta
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
