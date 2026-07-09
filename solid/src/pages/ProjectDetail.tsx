// Proyecto detalle — nested concepts, distinct API roots per operation. Port
// of frontend/src/pages/project_detail.rs. Deviates from the Leptos original
// by using a Modal for create/edit (matching the Solid CRUD convention set by
// Accounts.tsx) and by actually exposing the `notes` field, which the Leptos
// page hardcoded to `None` despite the backend supporting it — see
// docs/solid-migration/pages-part2.md "Project detail" and PLAN.md §13.
import { A, useParams } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, Show, createSignal, For } from 'solid-js'

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
import { advanceProjectConcept, createProjectConcept, deleteProjectConcept, getProject, listConceptStatuses, listProjectConcepts, updateProjectConcept } from '../lib/api/operations'
import type { ProjectConcept, ProjectConceptPayload } from '../lib/api/types'
import { money } from '../lib/format'
import { useAuth } from '../lib/auth/AuthContext'

const opt = (s: string): string | null => {
  const t = s.trim()
  return t === '' ? null : t
}

const emptyForm = () => ({
  statusId: '',
  name: '',
  quantity: '1',
  unit: '',
  description: '',
  estimatedHours: '',
  estimatedCost: '',
  notes: '',
  position: '0',
})

export default function ProjectDetail(): JSX.Element {
  const params = useParams<{ id: string }>()
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const projectQuery = createQuery(() => ({
    queryKey: ['project', params.id],
    queryFn: () => getProject(params.id),
  }))

  const conceptsQuery = createQuery(() => ({
    queryKey: ['project-concepts', params.id],
    queryFn: () => listProjectConcepts(params.id),
  }))

  const statusesQuery = createQuery(() => ({
    queryKey: ['concept-statuses'],
    queryFn: listConceptStatuses,
  }))

  const statusName = (sid: string): string => (statusesQuery.data ?? []).find((s) => s.id === sid)?.name ?? ''

  // --- create/edit modal state ---------------------------------------------
  const [modalOpen, setModalOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [form, setForm] = createSignal(emptyForm())
  const [formError, setFormError] = createSignal<string | null>(null)

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm())
    setFormError(null)
    setModalOpen(true)
  }

  const openEdit = (concept: ProjectConcept) => {
    setEditingId(concept.id)
    setForm({
      statusId: concept.status_id ?? '',
      name: concept.name,
      quantity: String(concept.quantity),
      unit: concept.unit ?? '',
      description: concept.description ?? '',
      estimatedHours: concept.estimated_hours != null ? String(concept.estimated_hours) : '',
      estimatedCost: concept.estimated_cost != null ? String(concept.estimated_cost) : '',
      notes: '',
      position: String(concept.position),
    })
    setFormError(null)
    setModalOpen(true)
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ProjectConceptPayload) => {
      const id = editingId()
      return id ? updateProjectConcept(id, payload) : createProjectConcept(params.id, payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project-concepts', params.id] })
      toast.success(editingId() ? 'Concepto actualizado' : 'Concepto agregado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el concepto'))
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
    const hours = f.estimatedHours.trim() === '' ? null : Number.parseFloat(f.estimatedHours)
    const cost = f.estimatedCost.trim() === '' ? null : Number.parseFloat(f.estimatedCost)
    saveMutation.mutate({
      status_id: f.statusId.trim() === '' ? null : f.statusId,
      name: f.name.trim(),
      quantity: Number.parseFloat(f.quantity) || 0,
      unit: opt(f.unit),
      description: opt(f.description),
      estimated_hours: hours != null && Number.isNaN(hours) ? null : hours,
      estimated_cost: cost != null && Number.isNaN(cost) ? null : cost,
      notes: opt(f.notes),
      position: Number.parseInt(f.position, 10) || 0,
    })
  }

  // --- advance ---------------------------------------------------------------
  const advanceMutation = createMutation(() => ({
    mutationFn: (id: string) => advanceProjectConcept(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project-concepts', params.id] })
      toast.success('Concepto avanzado')
    },
    onError: (err) => {
      toast.error('No se pudo avanzar el concepto', humanizeError(err, ''))
    },
  }))

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<ProjectConcept | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => deleteProjectConcept(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project-concepts', params.id] })
      toast.success('Concepto eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el concepto', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <A href="/projects" class="text-sm text-muted-foreground hover:underline">
        ← Proyectos
      </A>
      <PageHeader
        title={projectQuery.data?.title || 'Proyecto'}
        breadcrumb={['Operaciones', 'Proyectos']}
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>Agregar concepto</Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!conceptsQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!conceptsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los conceptos.
              </CardContent>
            }
          >
            <Show
              when={conceptsQuery.data && conceptsQuery.data.length > 0}
              fallback={
                <CardContent class="py-16 text-center text-sm text-muted-foreground">
                  Sin conceptos todavía.
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Orden</TableHeadCell>
                    <TableHeadCell>Concepto</TableHeadCell>
                    <TableHeadCell>Cantidad</TableHeadCell>
                    <TableHeadCell>Estado</TableHeadCell>
                    <TableHeadCell>Estimado (h)</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={conceptsQuery.data ?? []}>{(c) => (
                    <TableRow>
                      <TableCell class="tnum text-muted-foreground">{c.position}</TableCell>
                      <TableCell class="font-medium text-foreground">{c.name}</TableCell>
                      <TableCell class="tnum">
                        {money(c.quantity)} {c.unit ?? ''}
                      </TableCell>
                      <TableCell>
                        <Show when={statusName(c.status_id)} fallback={<span class="text-muted-foreground">—</span>}>
                          <Badge tone={statusBadgeTone(statusName(c.status_id))}>{statusName(c.status_id)}</Badge>
                        </Show>
                      </TableCell>
                      <TableCell class="tnum">{c.estimated_hours != null ? c.estimated_hours.toFixed(1) : ''}</TableCell>
                      <Show when={isAdmin()}>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              class="text-emerald-700 hover:bg-emerald-50"
                              disabled={advanceMutation.isPending}
                              onClick={() => advanceMutation.mutate(c.id)}
                            >
                              Avanzar
                            </Button>
                            <Button variant="ghost" onClick={() => openEdit(c)}>
                              Editar
                            </Button>
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(c)}
                            >
                              Eliminar
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
        title={editingId() ? 'Editar concepto' : 'Agregar concepto'}
      >
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Concepto</label>
            <Input value={form().name} onInput={(v) => setForm((f) => ({ ...f, name: v }))} required />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Estado</label>
            <Select value={form().statusId} onChange={(v) => setForm((f) => ({ ...f, statusId: v }))}>
              <option value="">— Inicial —</option>
              <For each={statusesQuery.data ?? []}>{(s) => (
                <option value={s.id}>{s.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Cantidad</label>
            <Input
              value={form().quantity}
              onInput={(v) => setForm((f) => ({ ...f, quantity: v }))}
              inputmode="decimal"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Unidad</label>
            <Input value={form().unit} onInput={(v) => setForm((f) => ({ ...f, unit: v }))} />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Orden</label>
            <Input
              value={form().position}
              onInput={(v) => setForm((f) => ({ ...f, position: v }))}
              inputmode="numeric"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Horas estimadas</label>
            <Input
              value={form().estimatedHours}
              onInput={(v) => setForm((f) => ({ ...f, estimatedHours: v }))}
              inputmode="decimal"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Costo estimado</label>
            <Input
              value={form().estimatedCost}
              onInput={(v) => setForm((f) => ({ ...f, estimatedCost: v }))}
              inputmode="decimal"
            />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Descripción</label>
            <Input value={form().description} onInput={(v) => setForm((f) => ({ ...f, description: v }))} />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Notas</label>
            <Input value={form().notes} onInput={(v) => setForm((f) => ({ ...f, notes: v }))} />
          </div>

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Agregar concepto'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar concepto">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el concepto <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta
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
