// Registros de recursos — free-form start/end time-tracking entries for a
// resource against a project+phase (distinct from the structured hourly grid
// in ResourceUsages.tsx). Faithful port of frontend/src/pages/resource_logs.rs,
// using the Modal-based CRUD shell established in Accounts.tsx/Contacts.tsx.
// See docs/solid-migration/pages-part2.md "Resource logs".
//
// Datetime handling preserved 1:1 (PLAN §13): `datetime-local` inputs are
// converted via `localDtToRfc3339` (naive local value treated as UTC) — do
// NOT "fix" this.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Clock, Pencil, Trash2 } from 'lucide-solid'
import { type JSX, Show, createSignal, For } from 'solid-js'

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
import { localDtToRfc3339, rfc3339ToLocalDt } from '../lib/format'
import * as operations from '../lib/api/operations'
import type { ResourceLog, ResourceLogPayload } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

/** Trim, then turn an empty string into `null` — mirrors the Rust `opt()` helper. */
function opt(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const emptyForm = () => ({
  projectId: '',
  resourceId: '',
  phase: '',
  started: '',
  ended: '',
  operator: '',
  notes: '',
})

export default function ResourceLogs(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const logsQuery = createQuery(() => ({
    queryKey: ['resource-logs'],
    queryFn: operations.listResourceLogs,
  }))

  const projectsQuery = createQuery(() => ({
    queryKey: ['project-options'],
    queryFn: operations.listProjectOptions,
  }))

  const resourcesQuery = createQuery(() => ({
    queryKey: ['resources'],
    queryFn: operations.listResources,
  }))

  const projectName = (id: string | null | undefined): string => {
    if (!id) return ''
    return projectsQuery.data?.find((p) => p.id === id)?.title ?? ''
  }

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

  const openEdit = async (log: ResourceLog) => {
    setEditingId(log.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await operations.getResourceLog(log.id)
      setForm({
        projectId: detail.project_id ?? '',
        resourceId: detail.resource_id ?? '',
        phase: detail.phase ?? '',
        started: rfc3339ToLocalDt(detail.started_at),
        ended: detail.ended_at ? rfc3339ToLocalDt(detail.ended_at) : '',
        operator: detail.operator_name ?? '',
        notes: detail.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el registro'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ResourceLogPayload) => {
      const id = editingId()
      return id ? operations.updateResourceLog(id, payload) : operations.createResourceLog(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resource-logs'] })
      toast.success(editingId() ? 'Registro actualizado' : 'Registro creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el registro'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.started.trim() === '') {
      setFormError('El inicio es obligatorio')
      return
    }
    setFormError(null)
    saveMutation.mutate({
      project_id: opt(f.projectId),
      phase: opt(f.phase),
      resource_id: opt(f.resourceId),
      started_at: localDtToRfc3339(f.started),
      ended_at: f.ended.trim() === '' ? null : localDtToRfc3339(f.ended),
      operator_name: opt(f.operator),
      notes: opt(f.notes),
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<ResourceLog | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => operations.deleteResourceLog(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resource-logs'] })
      toast.success('Registro eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el registro', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  // --- "Terminar" (end now) row action -------------------------------------
  const endMutation = createMutation(() => ({
    mutationFn: (id: string) => operations.endResourceLog(id, { ended_at: null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resource-logs'] })
      toast.success('Registro finalizado')
    },
    onError: (err) => {
      toast.error('No se pudo finalizar el registro', humanizeError(err, ''))
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Registros de recursos"
        breadcrumb={['Operaciones', 'Registros de recursos']}
        subtitle={
          logsQuery.data
            ? `${logsQuery.data.length} registro${logsQuery.data.length === 1 ? '' : 's'}`
            : 'Entradas y salidas de uso de recursos por proyecto/fase.'
        }
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>Nuevo registro</Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!logsQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!logsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los registros.
              </CardContent>
            }
          >
            <Show
              when={logsQuery.data && logsQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Clock class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin registros todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer registro
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Proyecto</TableHeadCell>
                    <TableHeadCell>Fase</TableHeadCell>
                    <TableHeadCell>Recurso</TableHeadCell>
                    <TableHeadCell>Inicio</TableHeadCell>
                    <TableHeadCell>Fin</TableHeadCell>
                    <TableHeadCell>Horas</TableHeadCell>
                    <TableHeadCell>Operador</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={logsQuery.data ?? []}>{(log) => {
                    const open = log.ended_at == null
                    return (
                      <TableRow>
                        <TableCell class="text-muted-foreground">{projectName(log.project_id)}</TableCell>
                        <TableCell>{log.phase ?? ''}</TableCell>
                        <TableCell>{log.resource_name ?? ''}</TableCell>
                        <TableCell class="tnum text-muted-foreground">{rfc3339ToLocalDt(log.started_at)}</TableCell>
                        <TableCell class="tnum text-muted-foreground">
                          {log.ended_at ? rfc3339ToLocalDt(log.ended_at) : ''}
                        </TableCell>
                        <TableCell class="tnum">{log.duration_hours != null ? log.duration_hours.toFixed(2) : ''}</TableCell>
                        <TableCell>{log.operator_name ?? ''}</TableCell>
                        <Show when={isAdmin()}>
                          <TableCell class="text-right">
                            <div class="flex justify-end gap-1">
                              <Show when={open}>
                                <Button
                                  variant="ghost"
                                  class="text-emerald-700 hover:bg-emerald-50"
                                  disabled={endMutation.isPending}
                                  onClick={() => endMutation.mutate(log.id)}
                                >
                                  Terminar
                                </Button>
                              </Show>
                              <Button variant="ghost" onClick={() => void openEdit(log)} aria-label="Editar">
                                <Pencil class="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                class="text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget(log)}
                                aria-label="Eliminar"
                              >
                                <Trash2 class="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </Show>
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
      <Modal
        open={modalOpen()}
        onOpenChange={setModalOpen}
        title={editingId() ? 'Editar registro' : 'Nuevo registro'}
        class="max-w-2xl"
      >
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
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
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Recurso (opcional)</label>
            <Select
              value={form().resourceId}
              onChange={(v) => setForm((f) => ({ ...f, resourceId: v }))}
              disabled={loadingDetail()}
            >
              <option value="">— Ninguno —</option>
              <For each={resourcesQuery.data ?? []}>{(r) => (
                <option value={r.id}>{r.name}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fase</label>
            <Input value={form().phase} onInput={(v) => setForm((f) => ({ ...f, phase: v }))} disabled={loadingDetail()} />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Operador</label>
            <Input
              value={form().operator}
              onInput={(v) => setForm((f) => ({ ...f, operator: v }))}
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Inicio</label>
            <Input
              value={form().started}
              onInput={(v) => setForm((f) => ({ ...f, started: v }))}
              type="datetime-local"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Fin (opcional)</label>
            <Input
              value={form().ended}
              onInput={(v) => setForm((f) => ({ ...f, ended: v }))}
              type="datetime-local"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Notas</label>
            <Input value={form().notes} onInput={(v) => setForm((f) => ({ ...f, notes: v }))} disabled={loadingDetail()} />
          </div>

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear registro'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar registro">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar este registro de recurso? Esta acción no se puede deshacer.
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
