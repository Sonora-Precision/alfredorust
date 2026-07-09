// Cuentas — full CRUD reference page (design-approval gate #2). Faithful port
// of frontend/src/pages/accounts.rs: admin-only create/edit form, table with
// type/status badges, delete with confirmation. See
// docs/solid-migration/pages-part1.md "AccountsPage" for the behavior spec.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Landmark, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, Show, createMemo, createSignal, For } from 'solid-js'

import { Badge, boolBadgeTone, typeBadgeTone } from '../components/ui/Badge'
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
import type { Account, AccountPayload, AccountType } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

/** Values match the backend (`bank|cash|credit_card|investment|other`). */
const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: 'bank', label: 'Banco' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'credit_card', label: 'Tarjeta de crédito' },
  { value: 'investment', label: 'Inversión' },
  { value: 'other', label: 'Otro' },
]

function accountTypeLabel(value: string): string {
  return ACCOUNT_TYPES.find((t) => t.value === value)?.label ?? value
}

const emptyForm = () => ({
  name: '',
  accountType: 'bank' as AccountType,
  currency: 'MXN',
  isActive: true,
  notes: '',
})

export default function Accounts(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const accountsQuery = createQuery(() => ({
    queryKey: ['accounts'],
    queryFn: financeApi.listAccounts,
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

  const openEdit = async (acc: Account) => {
    setEditingId(acc.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await financeApi.getAccount(acc.id)
      setForm({
        name: detail.name,
        accountType: detail.account_type,
        currency: detail.currency,
        isActive: detail.is_active,
        notes: detail.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar la cuenta'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: AccountPayload) => {
      const id = editingId()
      return id ? financeApi.updateAccount(id, payload) : financeApi.createAccount(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] })
      toast.success(editingId() ? 'Cuenta actualizada' : 'Cuenta creada')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar la cuenta'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.name.trim() === '') {
      setFormError('El nombre es obligatorio')
      return
    }
    setFormError(null)
    const notes = f.notes.trim()
    saveMutation.mutate({
      name: f.name.trim(),
      account_type: f.accountType,
      currency: f.currency,
      is_active: f.isActive,
      notes: notes === '' ? null : notes,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Account | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.deleteAccount(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] })
      toast.success('Cuenta eliminada')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar la cuenta', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  const activeCount = createMemo(() => (accountsQuery.data ?? []).filter((a) => a.is_active).length)

  return (
    <div class="space-y-6">
      <PageHeader
        title="Cuentas"
        breadcrumb={['Finanzas', 'Cuentas']}
        subtitle={
          accountsQuery.data
            ? `${accountsQuery.data.length} cuenta${accountsQuery.data.length === 1 ? '' : 's'} · ${activeCount()} activa${activeCount() === 1 ? '' : 's'}`
            : 'Bancos, efectivo, tarjetas e inversiones.'
        }
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>
              <Plus class="mr-1.5 h-4 w-4" />
              Nueva cuenta
            </Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!accountsQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!accountsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar las cuentas.
              </CardContent>
            }
          >
            <Show
              when={accountsQuery.data && accountsQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Landmark class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin cuentas todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear la primera cuenta
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Nombre</TableHeadCell>
                    <TableHeadCell>Tipo</TableHeadCell>
                    <TableHeadCell>Moneda</TableHeadCell>
                    <TableHeadCell>Estado</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={accountsQuery.data ?? []}>{(acc) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{acc.name}</TableCell>
                      <TableCell>
                        <Badge tone={typeBadgeTone}>{accountTypeLabel(acc.account_type)}</Badge>
                      </TableCell>
                      <TableCell class="text-muted-foreground">{acc.currency}</TableCell>
                      <TableCell>
                        <Badge tone={boolBadgeTone(acc.is_active)}>{acc.is_active ? 'Activa' : 'Inactiva'}</Badge>
                      </TableCell>
                      <Show when={isAdmin()}>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button variant="ghost" onClick={() => void openEdit(acc)} aria-label="Editar">
                              <Pencil class="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(acc)}
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
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar cuenta' : 'Nueva cuenta'}>
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Cuenta principal"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Tipo</label>
            <Select
              value={form().accountType}
              onChange={(v) => setForm((f) => ({ ...f, accountType: v as AccountType }))}
              disabled={loadingDetail()}
            >
              <For each={ACCOUNT_TYPES}>{(t) => (
                <option value={t.value}>{t.label}</option>
              )}</For>
            </Select>
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
              label="Activa"
            />
          </div>

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear cuenta'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar cuenta">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar la cuenta <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta acción
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
