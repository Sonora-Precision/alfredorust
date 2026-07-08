// Órdenes de servicio — full CRUD page with dynamic line-items via
// createStore. Faithful port of frontend/src/pages/orders.rs, following the
// Modal-based CRUD shape established in Accounts.tsx (the frozen reference
// page) rather than the old Leptos inline-Card form.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Check, ClipboardList, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, Show, createMemo, createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'

import { Badge, statusBadgeTone } from '../components/ui/Badge'
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
import * as operationsApi from '../lib/api/operations'
import type { Order, OrderPayload, OrderStatus } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'
import { dateToRfc3339, money, rfc3339ToDate } from '../lib/format'

/** Values match the backend (`pending|confirmed|in_progress|completed|cancelled`). */
const STATUSES: { value: OrderStatus; label: string }[] = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'in_progress', label: 'En proceso' },
  { value: 'completed', label: 'Completada' },
  { value: 'cancelled', label: 'Cancelada' },
]

interface ItemRow {
  id: number
  description: string
  quantity: string
  unitPrice: string
}

let itemSeq = 0

const emptyForm = () => ({
  title: '',
  status: 'pending' as OrderStatus,
  contactId: '',
  categoryId: '',
  accountId: '',
  amount: '',
  scheduledAt: '',
  notes: '',
})

export default function Orders(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const ordersQuery = createQuery(() => ({
    queryKey: ['orders'],
    queryFn: operationsApi.listOrders,
  }))
  const categoriesQuery = createQuery(() => ({
    queryKey: ['categories'],
    queryFn: financeApi.listCategories,
    enabled: isAdmin(),
  }))
  const contactsQuery = createQuery(() => ({
    queryKey: ['contacts'],
    queryFn: financeApi.listContacts,
  }))
  const accountsQuery = createQuery(() => ({
    queryKey: ['accounts'],
    queryFn: financeApi.listAccounts,
    enabled: isAdmin(),
  }))

  const contactName = (contactId: string | null | undefined): string => {
    if (!contactId) return ''
    return contactsQuery.data?.find((c) => c.id === contactId)?.name ?? ''
  }

  // --- create/edit modal state -------------------------------------------
  const [modalOpen, setModalOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [form, setForm] = createSignal(emptyForm())
  const [formError, setFormError] = createSignal<string | null>(null)
  const [loadingDetail, setLoadingDetail] = createSignal(false)
  const [items, setItems] = createStore<ItemRow[]>([])

  const addLine = () => {
    itemSeq += 1
    setItems(items.length, { id: itemSeq, description: '', quantity: '1', unitPrice: '' })
  }
  const removeLine = (id: number) => setItems((rows) => rows.filter((r) => r.id !== id))

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm())
    setFormError(null)
    setItems([])
    setModalOpen(true)
  }

  const openEdit = async (order: Order) => {
    setEditingId(order.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const d = await operationsApi.getOrder(order.id)
      setForm({
        title: d.title,
        status: d.status,
        contactId: d.contact_id ?? '',
        categoryId: d.category_id ?? '',
        accountId: d.account_id ?? '',
        amount: String(d.amount),
        scheduledAt: d.scheduled_at ? rfc3339ToDate(d.scheduled_at) : '',
        notes: d.notes ?? '',
      })
      setItems(
        d.items.map((it) => {
          itemSeq += 1
          return { id: itemSeq, description: it.description, quantity: String(it.quantity), unitPrice: String(it.unit_price) }
        }),
      )
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar la orden'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: OrderPayload) => {
      const id = editingId()
      return id ? operationsApi.updateOrder(id, payload) : operationsApi.createOrder(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] })
      toast.success(editingId() ? 'Orden actualizada' : 'Orden creada')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar la orden'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.title.trim() === '') {
      setFormError('El título es obligatorio')
      return
    }
    setFormError(null)
    saveMutation.mutate({
      title: f.title.trim(),
      contact_id: f.contactId.trim() === '' ? null : f.contactId,
      category_id: f.categoryId.trim() === '' ? null : f.categoryId,
      account_id: f.accountId.trim() === '' ? null : f.accountId,
      status: f.status,
      amount: parseFloat(f.amount) || 0,
      scheduled_at: f.scheduledAt.trim() === '' ? null : dateToRfc3339(f.scheduledAt),
      items: items
        .filter((r) => r.description.trim() !== '')
        .map((r) => ({
          description: r.description.trim(),
          quantity: parseFloat(r.quantity) || 0,
          unit_price: parseFloat(r.unitPrice) || 0,
        })),
      notes: f.notes.trim() === '' ? null : f.notes,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Order | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => operationsApi.deleteOrder(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] })
      toast.success('Orden eliminada')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar la orden', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  const completeMutation = createMutation(() => ({
    mutationFn: (id: string) => operationsApi.completeOrder(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] })
      toast.success('Orden completada')
    },
    onError: (err) => {
      toast.error('No se pudo completar la orden', humanizeError(err, ''))
    },
  }))

  const orderCount = createMemo(() => (ordersQuery.data ?? []).length)

  return (
    <div class="space-y-6">
      <PageHeader
        title="Órdenes"
        breadcrumb={['Operaciones', 'Órdenes']}
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>
              <Plus class="mr-1.5 h-4 w-4" />
              Nueva orden
            </Button>
          </Show>
        }
      />
      <p class="-mt-4 text-sm text-muted-foreground">
        <Show when={ordersQuery.data} fallback="Órdenes de trabajo y su estado.">
          {orderCount()} orden{orderCount() === 1 ? '' : 'es'}
        </Show>
      </p>

      <Card glass>
        <Show when={!ordersQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!ordersQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar las órdenes.
              </CardContent>
            }
          >
            <Show
              when={ordersQuery.data && ordersQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <ClipboardList class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin órdenes todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear la primera orden
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Título</TableHeadCell>
                    <TableHeadCell>Cliente</TableHeadCell>
                    <TableHeadCell>Estado</TableHeadCell>
                    <TableHeadCell>Monto</TableHeadCell>
                    <TableHeadCell>Fecha</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(ordersQuery.data ?? []).map((o) => {
                    const label = o.status_label || o.status
                    return (
                      <TableRow>
                        <TableCell class="font-medium text-foreground">{o.title}</TableCell>
                        <TableCell class="text-muted-foreground">{contactName(o.contact_id)}</TableCell>
                        <TableCell>
                          <Badge tone={statusBadgeTone(label)}>{label}</Badge>
                        </TableCell>
                        <TableCell class="tnum">{money(o.amount)}</TableCell>
                        <TableCell class="tnum text-muted-foreground">
                          {o.scheduled_at ? rfc3339ToDate(o.scheduled_at) : ''}
                        </TableCell>
                        <Show when={isAdmin()}>
                          <TableCell class="text-right">
                            <div class="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                class="text-emerald-700 hover:bg-emerald-50"
                                onClick={() => completeMutation.mutate(o.id)}
                                aria-label="Completar"
                              >
                                <Check class="mr-1 h-4 w-4" />
                                Completar
                              </Button>
                              <Button variant="ghost" onClick={() => void openEdit(o)} aria-label="Editar">
                                <Pencil class="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                class="text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget(o)}
                                aria-label="Eliminar"
                              >
                                <Trash2 class="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </Show>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar orden' : 'Nueva orden'} class="max-w-2xl">
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Título</label>
            <Input
              value={form().title}
              onInput={(v) => setForm((f) => ({ ...f, title: v }))}
              placeholder="Título de la orden"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Estado</label>
            <Select
              value={form().status}
              onChange={(v) => setForm((f) => ({ ...f, status: v as OrderStatus }))}
              disabled={loadingDetail()}
            >
              {STATUSES.map((s) => (
                <option value={s.value}>{s.label}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cliente (opcional)</label>
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
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Categoría (opcional)</label>
            <Select
              value={form().categoryId}
              onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguna —</option>
              {(categoriesQuery.data ?? []).map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cuenta destino (opcional)</label>
            <Select
              value={form().accountId}
              onChange={(v) => setForm((f) => ({ ...f, accountId: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguna —</option>
              {(accountsQuery.data ?? []).map((a) => (
                <option value={a.id}>{a.name}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Monto total</label>
            <Input
              value={form().amount}
              onInput={(v) => setForm((f) => ({ ...f, amount: v }))}
              inputmode="decimal"
              placeholder="0.00"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fecha (cita/entrega)</label>
            <Input
              type="date"
              value={form().scheduledAt}
              onInput={(v) => setForm((f) => ({ ...f, scheduledAt: v }))}
              disabled={loadingDetail()}
            />
          </div>

          {/* Line items */}
          <div class="space-y-2 sm:col-span-2">
            <div class="flex items-center justify-between">
              <label class="text-sm font-medium text-foreground">Conceptos</label>
              <Button type="button" variant="outline" onClick={addLine} disabled={loadingDetail()}>
                + Agregar línea
              </Button>
            </div>
            <div class="space-y-2">
              {items.map((row) => (
                <div class="grid grid-cols-12 gap-2">
                  <div class="col-span-6">
                    <Input
                      value={row.description}
                      onInput={(v) => setItems((r) => r.id === row.id, 'description', v)}
                      placeholder="Descripción"
                      disabled={loadingDetail()}
                    />
                  </div>
                  <div class="col-span-2">
                    <Input
                      value={row.quantity}
                      onInput={(v) => setItems((r) => r.id === row.id, 'quantity', v)}
                      inputmode="decimal"
                      placeholder="Cant."
                      disabled={loadingDetail()}
                    />
                  </div>
                  <div class="col-span-3">
                    <Input
                      value={row.unitPrice}
                      onInput={(v) => setItems((r) => r.id === row.id, 'unitPrice', v)}
                      inputmode="decimal"
                      placeholder="P. unit."
                      disabled={loadingDetail()}
                    />
                  </div>
                  <div class="col-span-1 flex items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      class="text-destructive hover:bg-destructive/10"
                      onClick={() => removeLine(row.id)}
                      disabled={loadingDetail()}
                      aria-label="Quitar línea"
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              ))}
            </div>
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
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear orden'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar orden">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar la orden <span class="font-semibold text-foreground">{deleteTarget()?.title}</span>? Esta acción
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
