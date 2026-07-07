// Categorías — CRUD for income/expense categories with an optional parent
// (hierarchical). Faithful port of frontend/src/pages/categories.rs. See
// docs/solid-migration/pages-part1.md "CategoriesPage" for the behavior spec.
//
// Quirk preserved 1:1: the Leptos form declares a `notes` signal that is
// round-tripped through create/edit (sent in the payload, populated from
// CategoryDetail on edit) but never rendered as a visible input — same
// "hidden preserved field" pattern as RecurringPlan.version. We keep that
// exact behavior here rather than "fixing" it (not in PLAN §13).
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { FolderTree, Pencil, Trash2 } from 'lucide-solid'
import { type JSX, Show, createMemo, createSignal } from 'solid-js'

import { Badge, flowBadgeProps } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as financeApi from '../lib/api/finance'
import type { Category, CategoryPayload, FlowType } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const FLOW_TYPES: { value: FlowType; label: string }[] = [
  { value: 'income', label: 'Ingreso' },
  { value: 'expense', label: 'Egreso' },
]

const emptyForm = () => ({
  name: '',
  flowType: 'expense' as FlowType,
  parentId: '',
  notes: '', // hidden, preserved-across-edit field — no input renders it
})

export default function Categories(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const categoriesQuery = createQuery(() => ({
    queryKey: ['categories'],
    queryFn: financeApi.listCategories,
  }))

  // Parent-category options derived from the same list (mirrors the Leptos
  // separate `cat_opts` signal without a second request — same data source).
  const parentOptions = createMemo(() => categoriesQuery.data ?? [])

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

  const openEdit = async (cat: Category) => {
    setEditingId(cat.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await financeApi.getCategory(cat.id)
      setForm({
        name: detail.name,
        flowType: detail.flow_type,
        parentId: detail.parent_id ?? '',
        notes: detail.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar la categoría'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: CategoryPayload) => {
      const id = editingId()
      return id ? financeApi.updateCategory(id, payload) : financeApi.createCategory(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] })
      toast.success(editingId() ? 'Categoría actualizada' : 'Categoría creada')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar la categoría'))
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
      flow_type: f.flowType,
      parent_id: f.parentId === '' ? null : f.parentId,
      notes: notes === '' ? null : notes,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Category | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.deleteCategory(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] })
      toast.success('Categoría eliminada')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar la categoría', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold text-foreground">Categorías</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            <Show when={categoriesQuery.data} fallback="Categorías de ingreso y egreso.">
              {categoriesQuery.data!.length} categoría{categoriesQuery.data!.length === 1 ? '' : 's'}
            </Show>
          </p>
        </div>
        <Show when={isAdmin()}>
          <Button onClick={openCreate}>Nueva categoría</Button>
        </Show>
      </div>

      <Card>
        <Show when={!categoriesQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!categoriesQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar las categorías.
              </CardContent>
            }
          >
            <Show
              when={categoriesQuery.data && categoriesQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <FolderTree class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin categorías todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear la primera categoría
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
                    <TableHeadCell>Padre</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(categoriesQuery.data ?? []).map((cat) => {
                    const flow = flowBadgeProps(cat.flow_type)
                    return (
                      <TableRow>
                        <TableCell class="font-medium text-foreground">{cat.name}</TableCell>
                        <TableCell>
                          <Badge tone={flow.tone}>{flow.label}</Badge>
                        </TableCell>
                        <TableCell class="text-muted-foreground">{cat.parent ?? ''}</TableCell>
                        <Show when={isAdmin()}>
                          <TableCell class="text-right">
                            <div class="flex justify-end gap-1">
                              <Button variant="ghost" onClick={() => void openEdit(cat)} aria-label="Editar">
                                <Pencil class="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                class="text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget(cat)}
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
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar categoría' : 'Nueva categoría'}>
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Servicios"
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
              {FLOW_TYPES.map((t) => (
                <option value={t.value}>{t.label}</option>
              ))}
            </Select>
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Categoría padre (opcional)</label>
            <Select
              value={form().parentId}
              onChange={(v) => setForm((f) => ({ ...f, parentId: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguna —</option>
              {parentOptions().map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear categoría'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar categoría">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar la categoría <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta
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
