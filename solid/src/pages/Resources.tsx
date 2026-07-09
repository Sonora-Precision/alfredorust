// Recursos — catalog of billable resources (machinery/vehicle/equipment/other)
// with an hourly cost and a per-resource "which concept statuses show this
// resource in the usage grid" allow-list (feeds ResourceUsages.tsx's cell
// menus). Faithful port of frontend/src/pages/resources.rs, using the
// Modal-based CRUD shell established in Accounts.tsx/Contacts.tsx. See
// docs/solid-migration/pages-part2.md "Resources".
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Pencil, Trash2, Wrench } from 'lucide-solid'
import { type JSX, For, Show, createSignal } from 'solid-js'

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
import { money } from '../lib/format'
import * as operations from '../lib/api/operations'
import type { Resource, ResourcePayload, ResourceType } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

/** Values match the backend (`machinery|vehicle|equipment|other`). */
const RESOURCE_TYPES: { value: ResourceType; label: string }[] = [
  { value: 'machinery', label: 'Maquinaria' },
  { value: 'vehicle', label: 'Vehículo' },
  { value: 'equipment', label: 'Equipo' },
  { value: 'other', label: 'Otro' },
]

function resourceTypeLabel(r: Resource): string {
  if (r.resource_type_label && r.resource_type_label !== '') return r.resource_type_label
  return RESOURCE_TYPES.find((t) => t.value === r.resource_type)?.label ?? r.resource_type
}

/** Trim, then turn an empty string into `null` — mirrors the Rust `opt()` helper. */
function opt(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const emptyForm = () => ({
  name: '',
  resourceType: 'machinery' as ResourceType,
  hourlyCost: '',
  currency: 'MXN',
  isActive: true,
  allowedStatusIds: [] as string[],
  notes: '',
})

export default function Resources(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const resourcesQuery = createQuery(() => ({
    queryKey: ['resources'],
    queryFn: operations.listResources,
  }))

  const statusesQuery = createQuery(() => ({
    queryKey: ['concept-statuses'],
    queryFn: operations.listConceptStatuses,
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

  const openEdit = async (r: Resource) => {
    setEditingId(r.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await operations.getResource(r.id)
      setForm({
        name: detail.name,
        resourceType: detail.resource_type,
        hourlyCost: String(detail.hourly_cost),
        currency: detail.currency,
        isActive: detail.is_active,
        allowedStatusIds: detail.allowed_status_ids,
        notes: detail.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el recurso'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const toggleStatus = (id: string) => {
    setForm((f) => ({
      ...f,
      allowedStatusIds: f.allowedStatusIds.includes(id)
        ? f.allowedStatusIds.filter((x) => x !== id)
        : [...f.allowedStatusIds, id],
    }))
  }

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ResourcePayload) => {
      const id = editingId()
      return id ? operations.updateResource(id, payload) : operations.createResource(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resources'] })
      toast.success(editingId() ? 'Recurso actualizado' : 'Recurso creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el recurso'))
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
    const parsedCost = Number.parseFloat(f.hourlyCost.trim())
    saveMutation.mutate({
      name: f.name.trim(),
      resource_type: f.resourceType,
      is_active: f.isActive,
      hourly_cost: Number.isFinite(parsedCost) ? parsedCost : 0,
      currency: f.currency.trim(),
      allowed_status_ids: f.allowedStatusIds,
      notes: opt(f.notes),
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Resource | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => operations.deleteResource(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resources'] })
      toast.success('Recurso eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el recurso', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Recursos"
        breadcrumb={['Operaciones', 'Recursos']}
        subtitle={
          resourcesQuery.data
            ? `${resourcesQuery.data.length} recurso${resourcesQuery.data.length === 1 ? '' : 's'}`
            : 'Maquinaria, vehículos, equipo y otros recursos facturables.'
        }
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>Nuevo recurso</Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!resourcesQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!resourcesQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los recursos.
              </CardContent>
            }
          >
            <Show
              when={resourcesQuery.data && resourcesQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Wrench class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin recursos todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer recurso
                    </Button>
                  </Show>
                </CardContent>
              }
            >
              {/* Desktop: table. Mobile (<md): stacked cards. */}
              <div class="hidden md:block">
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeadCell>Nombre</TableHeadCell>
                      <TableHeadCell>Tipo</TableHeadCell>
                      <TableHeadCell>Costo/hora</TableHeadCell>
                      <TableHeadCell>Moneda</TableHeadCell>
                      <TableHeadCell>Estados</TableHeadCell>
                      <TableHeadCell>Activo</TableHeadCell>
                      <Show when={isAdmin()}>
                        <TableHeadCell class="text-right">Acciones</TableHeadCell>
                      </Show>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <For each={resourcesQuery.data ?? []}>{(r) => (
                      <TableRow>
                        <TableCell class="font-medium text-foreground">{r.name}</TableCell>
                        <TableCell>
                          <Badge tone={typeBadgeTone}>{resourceTypeLabel(r)}</Badge>
                        </TableCell>
                        <TableCell class="tnum text-muted-foreground">{money(r.hourly_cost)}</TableCell>
                        <TableCell class="text-muted-foreground">{r.currency}</TableCell>
                        <TableCell class="tnum text-muted-foreground">{r.allowed_status_ids.length}</TableCell>
                        <TableCell>
                          <Badge tone={boolBadgeTone(r.is_active)}>{r.is_active ? 'Sí' : 'No'}</Badge>
                        </TableCell>
                        <Show when={isAdmin()}>
                          <TableCell class="text-right">
                            <div class="flex justify-end gap-1">
                              <Button variant="ghost" onClick={() => void openEdit(r)} aria-label="Editar">
                                <Pencil class="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                class="text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget(r)}
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
                <For each={resourcesQuery.data ?? []}>{(r) => (
                  <div class="rounded-lg border border-border p-3">
                    <div class="flex items-start justify-between gap-2">
                      <p class="min-w-0 flex-1 font-medium text-foreground">{r.name}</p>
                      <Show when={isAdmin()}>
                        <div class="flex shrink-0 gap-1">
                          <Button variant="ghost" onClick={() => void openEdit(r)} aria-label="Editar">
                            <Pencil class="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            class="text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteTarget(r)}
                            aria-label="Eliminar"
                          >
                            <Trash2 class="h-4 w-4" />
                          </Button>
                        </div>
                      </Show>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Badge tone={typeBadgeTone}>{resourceTypeLabel(r)}</Badge>
                      <Badge tone={boolBadgeTone(r.is_active)}>{r.is_active ? 'Sí' : 'No'}</Badge>
                      <span class="tnum text-muted-foreground">{money(r.hourly_cost)} {r.currency}</span>
                      <span class="text-muted-foreground">{r.allowed_status_ids.length} estados</span>
                    </div>
                  </div>
                )}</For>
              </div>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar recurso' : 'Nuevo recurso'}>
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Camión de carga"
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Tipo</label>
            <Select
              value={form().resourceType}
              onChange={(v) => setForm((f) => ({ ...f, resourceType: v as ResourceType }))}
              disabled={loadingDetail()}
            >
              <For each={RESOURCE_TYPES}>{(t) => (
                <option value={t.value}>{t.label}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Costo por hora</label>
            <Input
              value={form().hourlyCost}
              onInput={(v) => setForm((f) => ({ ...f, hourlyCost: v }))}
              inputmode="decimal"
              placeholder="0.00"
              disabled={loadingDetail()}
            />
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
          <div class="sm:col-span-2">
            <Checkbox
              checked={form().isActive}
              onChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
              label="Activo"
            />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Mostrar en estados</label>
            <div class="flex flex-wrap gap-3 rounded-md border border-input p-3">
              <Show
                when={!statusesQuery.isLoading}
                fallback={<span class="text-sm text-muted-foreground">Cargando estados…</span>}
              >
                <Show
                  when={statusesQuery.data && statusesQuery.data.length > 0}
                  fallback={<span class="text-sm text-muted-foreground">Sin estados definidos.</span>}
                >
                  <For each={statusesQuery.data}>
                    {(s) => (
                      <Checkbox
                        checked={form().allowedStatusIds.includes(s.id)}
                        onChange={() => toggleStatus(s.id)}
                        label={s.name}
                      />
                    )}
                  </For>
                </Show>
              </Show>
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
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear recurso'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal variant="center" open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar recurso">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el recurso <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta
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
