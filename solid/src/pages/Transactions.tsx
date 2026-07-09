// Movimientos — CRUD for income/expense/transfer transactions, plus an
// inline analytics block (KPIs + monthly line/area + donut + top-category
// bars) computed client-side from the loaded list. Faithful port of
// frontend/src/pages/transactions.rs (`tx_charts` + the CRUD form), using
// the already-ported SVG chart components (LineArea/Donut) from
// frontend/src/pages/charts.rs. See docs/solid-migration/pages-part1.md
// "TransactionsPage".
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowLeftRight, Pencil, Trash2 } from 'lucide-solid'
import { type JSX, Show, createMemo, createSignal, For } from 'solid-js'

import { Donut } from '../components/charts/Donut'
import { LineArea } from '../components/charts/LineArea'
import { Badge, type BadgeTone, txTypeBadgeTone } from '../components/ui/Badge'
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
import { dateToRfc3339, money, rfc3339ToDate } from '../lib/format'
import type { Transaction, TransactionPayload, TransactionType } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const TX_TYPES: { value: TransactionType; label: string }[] = [
  { value: 'income', label: 'Ingreso' },
  { value: 'expense', label: 'Egreso' },
  { value: 'transfer', label: 'Transferencia' },
]

function txLabel(value: string): string {
  return TX_TYPES.find((t) => t.value === value)?.label ?? value
}

const emptyForm = () => ({
  date: '',
  description: '',
  txType: 'expense' as TransactionType,
  category: '',
  accountFrom: '',
  accountTo: '',
  amount: '',
  plannedEntry: '',
  isConfirmed: true,
  notes: '',
})

export default function Transactions(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const transactionsQuery = createQuery(() => ({
    queryKey: ['transactions'],
    queryFn: financeApi.listTransactions,
  }))
  const categoriesQuery = createQuery(() => ({
    queryKey: ['categories'],
    queryFn: financeApi.listCategories,
  }))
  const accountsQuery = createQuery(() => ({
    queryKey: ['accounts'],
    queryFn: financeApi.listAccounts,
  }))
  const plannedEntriesQuery = createQuery(() => ({
    queryKey: ['plannedEntries'],
    queryFn: financeApi.listPlannedEntries,
  }))

  // --- client-side analytics, mirrors `tx_charts` in transactions.rs ------
  const charts = createMemo(() => {
    const list = transactionsQuery.data ?? []
    const monthly = new Map<string, { income: number; expense: number }>()
    const cats = new Map<string, { income: number; expense: number; transfer: number; count: number }>()
    let totalIncome = 0
    let totalExpense = 0

    for (const t of list) {
      const month = t.date.slice(0, 7) || ''
      const m = monthly.get(month) ?? { income: 0, expense: 0 }
      if (t.tx_type === 'income') {
        m.income += t.amount
        totalIncome += t.amount
      } else if (t.tx_type === 'expense') {
        m.expense += t.amount
        totalExpense += t.amount
      }
      monthly.set(month, m)

      const key = t.category && t.category !== '' ? t.category : 'Sin categoría'
      const c = cats.get(key) ?? { income: 0, expense: 0, transfer: 0, count: 0 }
      if (t.tx_type === 'income') c.income += t.amount
      else if (t.tx_type === 'expense') c.expense += t.amount
      else c.transfer += t.amount
      c.count += 1
      cats.set(key, c)
    }

    const monthlySeries = [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, v]) => ({ label, income: v.income, expense: v.expense }))

    const net = totalIncome - totalExpense

    const catBars = [...cats.entries()]
      .map(([name, v]) => ({ name, ...v, total: v.income + v.expense + v.transfer }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
    const maxAmt = Math.max(1, ...catBars.map((c) => c.total))

    return { monthlySeries, totalIncome, totalExpense, net, catBars, maxAmt }
  })

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

  const openEdit = async (tx: Transaction) => {
    setEditingId(tx.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await financeApi.getTransaction(tx.id)
      setForm({
        date: rfc3339ToDate(detail.date),
        description: detail.description,
        txType: detail.transaction_type,
        category: detail.category_id,
        accountFrom: detail.account_from_id ?? '',
        accountTo: detail.account_to_id ?? '',
        amount: String(detail.amount),
        plannedEntry: detail.planned_entry_id ?? '',
        isConfirmed: detail.is_confirmed,
        notes: detail.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el movimiento'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: TransactionPayload) => {
      const id = editingId()
      return id ? financeApi.updateTransaction(id, payload) : financeApi.createTransaction(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      toast.success(editingId() ? 'Movimiento actualizado' : 'Movimiento creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el movimiento'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.date.trim() === '' || f.description.trim() === '' || f.category === '') {
      setFormError('Completa fecha, descripción y categoría')
      return
    }
    setFormError(null)
    const notes = f.notes.trim()
    saveMutation.mutate({
      date: dateToRfc3339(f.date),
      description: f.description.trim(),
      transaction_type: f.txType,
      category_id: f.category,
      account_from_id: f.accountFrom === '' ? null : f.accountFrom,
      account_to_id: f.accountTo === '' ? null : f.accountTo,
      amount: Number.parseFloat(f.amount.trim()) || 0,
      planned_entry_id: f.plannedEntry === '' ? null : f.plannedEntry,
      is_confirmed: f.isConfirmed,
      notes: notes === '' ? null : notes,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Transaction | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.deleteTransaction(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      toast.success('Movimiento eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el movimiento', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Movimientos"
        breadcrumb={['Finanzas', 'Movimientos']}
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>Nuevo movimiento</Button>
          </Show>
        }
      />
      <p class="-mt-4 text-sm text-muted-foreground">
        <Show when={transactionsQuery.data} fallback="Ingresos, egresos y transferencias.">
          {transactionsQuery.data!.length} movimiento{transactionsQuery.data!.length === 1 ? '' : 's'}
        </Show>
      </p>

      {/* Analytics block — only when the list is non-empty, mirrors tx_charts gating */}
      <Show when={(transactionsQuery.data?.length ?? 0) > 0}>
        <div class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-3">
            <Card glass glow>
              <CardContent class="p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Ingresos</p>
                <p class="mt-1 text-2xl font-bold text-emerald-600 tnum">{money(charts().totalIncome)}</p>
              </CardContent>
            </Card>
            <Card glass glow>
              <CardContent class="p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Egresos</p>
                <p class="mt-1 text-2xl font-bold text-rose-600 tnum">{money(charts().totalExpense)}</p>
              </CardContent>
            </Card>
            <Card glass glow>
              <CardContent class="p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Neto</p>
                <p
                  class={`mt-1 text-2xl font-bold tnum ${charts().net >= 0 ? 'text-sky-600' : 'text-rose-600'}`}
                >
                  {money(charts().net)}
                </p>
              </CardContent>
            </Card>
          </div>

          <div class="grid gap-3 lg:grid-cols-3">
            <Card glass class="lg:col-span-2">
              <CardContent class="p-4">
                <p class="mb-2 text-xs font-semibold text-muted-foreground">Mensual (ingresos vs egresos)</p>
                <div class="h-40">
                  <LineArea data={charts().monthlySeries} class="h-full w-full text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
            <Card glass>
              <CardContent class="p-4">
                <p class="mb-2 text-xs font-semibold text-muted-foreground">Distribución</p>
                <div class="mx-auto h-40 w-40">
                  <Donut
                    segments={[
                      { label: 'Ingresos', value: charts().totalIncome, color: '#10b981' },
                      { label: 'Egresos', value: charts().totalExpense, color: '#f43f5e' },
                    ]}
                    centerValue={money(charts().net)}
                    centerLabel="neto"
                    class="text-foreground"
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          <Card glass>
            <CardContent class="p-4">
              <p class="mb-2 text-xs font-semibold text-muted-foreground">Por categoría</p>
              <For each={charts().catBars}>{(c) => (
                <div class="mb-2">
                  <div class="flex justify-between text-xs">
                    <span class="truncate text-muted-foreground">{c.name}</span>
                    <span class="font-medium text-foreground tnum">{money(c.total)}</span>
                  </div>
                  <div class="mt-1 flex h-1.5 overflow-hidden rounded bg-muted">
                    <div
                      style={{ width: `${(c.income / charts().maxAmt) * 100}%`, background: '#10b981' }}
                    />
                    <div
                      style={{ width: `${(c.expense / charts().maxAmt) * 100}%`, background: '#f43f5e' }}
                    />
                    <div
                      style={{ width: `${(c.transfer / charts().maxAmt) * 100}%`, background: '#2563eb' }}
                    />
                  </div>
                  <span class="text-[10px] text-muted-foreground">{c.count} mov.</span>
                </div>
              )}</For>
            </CardContent>
          </Card>
        </div>
      </Show>

      <Card glass>
        <Show when={!transactionsQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!transactionsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los movimientos.
              </CardContent>
            }
          >
            <Show
              when={transactionsQuery.data && transactionsQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <ArrowLeftRight class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin movimientos todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer movimiento
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Fecha</TableHeadCell>
                    <TableHeadCell>Descripción</TableHeadCell>
                    <TableHeadCell>Tipo</TableHeadCell>
                    <TableHeadCell>Monto</TableHeadCell>
                    <TableHeadCell>Categoría</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={transactionsQuery.data ?? []}>{(t) => (
                    <TableRow>
                      <TableCell class="tnum text-muted-foreground">{t.date}</TableCell>
                      <TableCell class="font-medium text-foreground">{t.description}</TableCell>
                      <TableCell>
                        <Badge tone={txTypeBadgeTone(t.tx_type) as BadgeTone}>{txLabel(t.tx_type)}</Badge>
                      </TableCell>
                      <TableCell class="tnum">{money(t.amount)}</TableCell>
                      <TableCell class="text-muted-foreground">{t.category ?? ''}</TableCell>
                      <Show when={isAdmin()}>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button variant="ghost" onClick={() => void openEdit(t)} aria-label="Editar">
                              <Pencil class="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(t)}
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
      <Modal
        open={modalOpen()}
        onOpenChange={setModalOpen}
        title={editingId() ? 'Editar movimiento' : 'Nuevo movimiento'}
        class="max-w-2xl"
      >
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fecha</label>
            <Input
              value={form().date}
              onInput={(v) => setForm((f) => ({ ...f, date: v }))}
              type="date"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Descripción</label>
            <Input
              value={form().description}
              onInput={(v) => setForm((f) => ({ ...f, description: v }))}
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Tipo</label>
            <Select
              value={form().txType}
              onChange={(v) => setForm((f) => ({ ...f, txType: v as TransactionType }))}
              disabled={loadingDetail()}
            >
              <For each={TX_TYPES}>{(t) => (
                <option value={t.value}>{t.label}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Categoría</label>
            <Select
              value={form().category}
              onChange={(v) => setForm((f) => ({ ...f, category: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Selecciona —</option>
              <For each={categoriesQuery.data ?? []}>{(c) => (
                <option value={c.id}>{c.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Monto</label>
            <Input
              value={form().amount}
              onInput={(v) => setForm((f) => ({ ...f, amount: v }))}
              inputmode="decimal"
              placeholder="0.00"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cuenta origen</label>
            <Select
              value={form().accountFrom}
              onChange={(v) => setForm((f) => ({ ...f, accountFrom: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguna —</option>
              <For each={accountsQuery.data ?? []}>{(a) => (
                <option value={a.id}>{a.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cuenta destino</label>
            <Select
              value={form().accountTo}
              onChange={(v) => setForm((f) => ({ ...f, accountTo: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguna —</option>
              <For each={accountsQuery.data ?? []}>{(a) => (
                <option value={a.id}>{a.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Compromiso ligado (opcional)</label>
            <Select
              value={form().plannedEntry}
              onChange={(v) => setForm((f) => ({ ...f, plannedEntry: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguno —</option>
              <For each={plannedEntriesQuery.data ?? []}>{(p) => (
                <option value={p.id}>{p.name}</option>
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
          <div class="flex items-end">
            <Checkbox
              checked={form().isConfirmed}
              onChange={(v) => setForm((f) => ({ ...f, isConfirmed: v }))}
              label="Confirmado"
            />
          </div>

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-3">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-3">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear movimiento'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar movimiento">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el movimiento <span class="font-semibold text-foreground">{deleteTarget()?.description}</span>?
            Esta acción no se puede deshacer.
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
