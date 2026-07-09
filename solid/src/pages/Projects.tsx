// Proyectos — full CRUD page. Faithful port of
// frontend/src/pages/projects.rs: admin-only create/edit modal, table with
// status/priority badges, an optional budget column gated by the
// `view_project_money` permission (mirrors the backend nulling the amount for
// staff without it), and a "Ver" link to the (sibling-owned) detail page.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { A } from '@solidjs/router'
import { Briefcase, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, Show, createMemo, createSignal, For } from 'solid-js'

import { Badge, priorityBadgeTone, statusBadgeTone } from '../components/ui/Badge'
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
import type { ProjectPayload, ProjectPriority, ProjectRow } from '../lib/api/types'
import { dateToRfc3339, money, rfc3339ToDate } from '../lib/format'
import { useAuth } from '../lib/auth/AuthContext'

/** Values match the backend (`low|medium|high|urgent`). */
const PRIORITIES: { value: ProjectPriority; label: string }[] = [
  { value: 'low', label: 'Baja' },
  { value: 'medium', label: 'Media' },
  { value: 'high', label: 'Alta' },
  { value: 'urgent', label: 'Urgente' },
]

const emptyForm = () => ({
  title: '',
  priority: 'medium' as ProjectPriority,
  contactId: '',
  categoryId: '',
  budget: '',
  scheduled: '',
  description: '',
  notes: '',
})

export default function Projects(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const canMoney = () => auth.isAdmin() || auth.hasPermission('view_project_money')
  const qc = useQueryClient()

  const projectsQuery = createQuery(() => ({
    queryKey: ['projects'],
    queryFn: operationsApi.listProjects,
  }))
  const categoriesQuery = createQuery(() => ({
    queryKey: ['categories'],
    queryFn: financeApi.listCategories,
  }))
  const contactsQuery = createQuery(() => ({
    queryKey: ['contacts'],
    queryFn: financeApi.listContacts,
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

  const openEdit = async (row: ProjectRow) => {
    setEditingId(row.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await operationsApi.getProject(row.id)
      setForm({
        title: detail.title,
        priority: detail.priority,
        contactId: detail.contact_id ?? '',
        categoryId: detail.category_id ?? '',
        budget: detail.total_budget != null ? String(detail.total_budget) : '',
        scheduled: detail.scheduled_at ? rfc3339ToDate(detail.scheduled_at) : '',
        description: detail.description ?? '',
        notes: detail.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el proyecto'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ProjectPayload) => {
      const id = editingId()
      return id ? operationsApi.updateProject(id, payload) : operationsApi.createProject(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success(editingId() ? 'Proyecto actualizado' : 'Proyecto creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el proyecto'))
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
    const budget = f.budget.trim()
    const parsedBudget = budget === '' ? null : Number.parseFloat(budget)
    const description = f.description.trim()
    const notes = f.notes.trim()
    const scheduled = f.scheduled.trim()
    saveMutation.mutate({
      title: f.title.trim(),
      contact_id: f.contactId === '' ? null : f.contactId,
      category_id: f.categoryId === '' ? null : f.categoryId,
      description: description === '' ? null : description,
      priority: f.priority,
      total_budget: parsedBudget != null && Number.isNaN(parsedBudget) ? null : parsedBudget,
      scheduled_at: scheduled === '' ? null : dateToRfc3339(scheduled),
      notes: notes === '' ? null : notes,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<ProjectRow | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => operationsApi.deleteProject(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Proyecto eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el proyecto', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  // --- advance ---------------------------------------------------------------
  const advanceMutation = createMutation(() => ({
    mutationFn: (id: string) => operationsApi.advanceProject(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Proyecto avanzado')
    },
    onError: (err) => {
      toast.error('No se pudo avanzar el proyecto', humanizeError(err, ''))
    },
  }))

  const totalCount = createMemo(() => (projectsQuery.data ?? []).length)

  return (
    <div class="space-y-6">
      <PageHeader
        title="Proyectos"
        breadcrumb={['Operaciones', 'Proyectos']}
        subtitle={
          projectsQuery.data ? `${totalCount()} proyecto${totalCount() === 1 ? '' : 's'}` : 'Seguimiento de proyectos y presupuestos.'
        }
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>
              <Plus class="mr-1.5 h-4 w-4" />
              Nuevo proyecto
            </Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!projectsQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!projectsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los proyectos.
              </CardContent>
            }
          >
            <Show
              when={projectsQuery.data && projectsQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Briefcase class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin proyectos todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer proyecto
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Título</TableHeadCell>
                    <TableHeadCell>Estado</TableHeadCell>
                    <TableHeadCell>Prioridad</TableHeadCell>
                    <Show when={canMoney()}>
                      <TableHeadCell>Presupuesto</TableHeadCell>
                    </Show>
                    <TableHeadCell>Fecha límite</TableHeadCell>
                    <TableHeadCell class="text-right">Acciones</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={projectsQuery.data ?? []}>{(p) => {
                    const statusLabel = p.status_label || p.status
                    const priorityLabel = p.priority_label || p.priority
                    return (
                      <TableRow>
                        <TableCell class="font-medium text-foreground">{p.title}</TableCell>
                        <TableCell>
                          <Badge tone={statusBadgeTone(statusLabel)}>{statusLabel}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge tone={priorityBadgeTone(p.priority)}>{priorityLabel}</Badge>
                        </TableCell>
                        <Show when={canMoney()}>
                          <TableCell class="tnum text-muted-foreground">
                            {p.total_budget != null ? money(p.total_budget) : ''}
                          </TableCell>
                        </Show>
                        <TableCell class="tnum text-muted-foreground">
                          {p.scheduled_at ? rfc3339ToDate(p.scheduled_at) : ''}
                        </TableCell>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <A
                              href={`/projects/${p.id}`}
                              class="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                            >
                              Ver
                            </A>
                            <Show when={isAdmin()}>
                              <Button
                                variant="ghost"
                                class="text-emerald-700 hover:bg-emerald-50"
                                disabled={advanceMutation.isPending}
                                onClick={() => advanceMutation.mutate(p.id)}
                              >
                                Avanzar
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
                            </Show>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  }}</For>
                </TableBody>
              </Table>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar proyecto' : 'Nuevo proyecto'}>
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Título</label>
            <Input
              value={form().title}
              onInput={(v) => setForm((f) => ({ ...f, title: v }))}
              placeholder="Nombre del proyecto"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Prioridad</label>
            <Select
              value={form().priority}
              onChange={(v) => setForm((f) => ({ ...f, priority: v as ProjectPriority }))}
              disabled={loadingDetail()}
            >
              <For each={PRIORITIES}>{(p) => (
                <option value={p.value}>{p.label}</option>
              )}</For>
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
              <For each={contactsQuery.data ?? []}>{(c) => (
                <option value={c.id}>{c.name}</option>
              )}</For>
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
              <For each={categoriesQuery.data ?? []}>{(c) => (
                <option value={c.id}>{c.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Presupuesto (opcional)</label>
            <Input
              value={form().budget}
              onInput={(v) => setForm((f) => ({ ...f, budget: v }))}
              inputmode="decimal"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fecha límite (opcional)</label>
            <Input
              type="date"
              value={form().scheduled}
              onInput={(v) => setForm((f) => ({ ...f, scheduled: v }))}
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Descripción (opcional)</label>
            <Input
              value={form().description}
              onInput={(v) => setForm((f) => ({ ...f, description: v }))}
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Notas (opcional)</label>
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
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear proyecto'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar proyecto">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el proyecto <span class="font-semibold text-foreground">{deleteTarget()?.title}</span>? Esta
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
