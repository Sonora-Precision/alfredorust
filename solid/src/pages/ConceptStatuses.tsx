// Estados de concepto — full CRUD reference: admin-gated create/edit/delete,
// read-only table visible to all. Faithful port of
// frontend/src/pages/concept_statuses.rs. See Accounts.tsx for the shared
// CRUD page shape this follows.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ListChecks, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, Show, createSignal } from 'solid-js'

import { Badge, boolBadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as operationsApi from '../lib/api/operations'
import type { ConceptStatusFull, ConceptStatusPayload } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const emptyForm = () => ({
  name: '',
  position: '0',
  color: '',
  isInitial: false,
  isTerminal: false,
  isCancelled: false,
  isActive: true,
})

export default function ConceptStatuses(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const statusesQuery = createQuery(() => ({
    queryKey: ['concept-statuses'],
    queryFn: operationsApi.listConceptStatuses,
  }))

  // --- create/edit modal state -------------------------------------------
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

  const openEdit = (status: ConceptStatusFull) => {
    setEditingId(status.id)
    setFormError(null)
    setForm({
      name: status.name,
      position: String(status.position),
      color: status.color ?? '',
      isInitial: status.is_initial,
      isTerminal: status.is_terminal,
      isCancelled: status.is_cancelled,
      isActive: status.is_active,
    })
    setModalOpen(true)
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ConceptStatusPayload) => {
      const id = editingId()
      return id ? operationsApi.updateConceptStatus(id, payload) : operationsApi.createConceptStatus(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
      toast.success(editingId() ? 'Estado actualizado' : 'Estado creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el estado'))
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
    const color = f.color.trim()
    saveMutation.mutate({
      name: f.name.trim(),
      position: parseInt(f.position, 10) || 0,
      color: color === '' ? null : color,
      is_initial: f.isInitial,
      is_terminal: f.isTerminal,
      is_cancelled: f.isCancelled,
      is_active: f.isActive,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<ConceptStatusFull | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => operationsApi.deleteConceptStatus(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
      toast.success('Estado eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el estado', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold text-foreground">Estados de concepto</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            <Show when={statusesQuery.data} fallback="Flujo de estados de los conceptos de proyecto.">
              {statusesQuery.data!.length} estado{statusesQuery.data!.length === 1 ? '' : 's'}
            </Show>
          </p>
        </div>
        <Show when={isAdmin()}>
          <Button onClick={openCreate}>
            <Plus class="mr-1.5 h-4 w-4" />
            Nuevo estado
          </Button>
        </Show>
      </div>

      <Card>
        <Show when={!statusesQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!statusesQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los estados.
              </CardContent>
            }
          >
            <Show
              when={statusesQuery.data && statusesQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <ListChecks class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin estados todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer estado
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Posición</TableHeadCell>
                    <TableHeadCell>Nombre</TableHeadCell>
                    <TableHeadCell>Inicial</TableHeadCell>
                    <TableHeadCell>Terminal</TableHeadCell>
                    <TableHeadCell>Activo</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(statusesQuery.data ?? []).map((s) => (
                    <TableRow>
                      <TableCell class="text-muted-foreground">{s.position}</TableCell>
                      <TableCell class="font-medium text-foreground">{s.name}</TableCell>
                      <TableCell>{s.is_initial ? 'Sí' : ''}</TableCell>
                      <TableCell>{s.is_terminal ? 'Sí' : ''}</TableCell>
                      <TableCell>
                        <Badge tone={boolBadgeTone(s.is_active)}>{s.is_active ? 'Sí' : 'No'}</Badge>
                      </TableCell>
                      <Show when={isAdmin()}>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button variant="ghost" onClick={() => openEdit(s)} aria-label="Editar">
                              <Pencil class="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(s)}
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
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar estado' : 'Nuevo estado'}>
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Cotizado"
              required
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Posición</label>
            <Input
              value={form().position}
              onInput={(v) => setForm((f) => ({ ...f, position: v }))}
              placeholder="0"
              inputmode="numeric"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Color</label>
            <Input
              value={form().color}
              onInput={(v) => setForm((f) => ({ ...f, color: v }))}
              placeholder="#22c55e"
            />
          </div>
          <div class="flex flex-wrap items-center gap-4 sm:col-span-2">
            <Checkbox
              checked={form().isInitial}
              onChange={(v) => setForm((f) => ({ ...f, isInitial: v }))}
              label="Inicial"
            />
            <Checkbox
              checked={form().isTerminal}
              onChange={(v) => setForm((f) => ({ ...f, isTerminal: v }))}
              label="Terminal"
            />
            <Checkbox
              checked={form().isCancelled}
              onChange={(v) => setForm((f) => ({ ...f, isCancelled: v }))}
              label="Cancelado"
            />
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
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear estado'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar estado">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el estado <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta acción
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
