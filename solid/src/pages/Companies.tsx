// Compañías — tenant admin: list, create/edit, delete, plus a "danger zone"
// for wiping a company's test data. Faithful port of
// frontend/src/pages/companies.rs. See docs/solid-migration/pages-part2.md
// "Companies" for the behavior spec. Slug validity (incl. reserved names) is
// authoritative on the server — we only do light client-side format
// checking and surface server errors (e.g. reserved slug) through the form
// error, without hardcoding the reserved-slug list.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Building2, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, Show, createSignal } from 'solid-js'

import { Badge, boolBadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import * as adminApi from '../lib/api/admin'
import { humanizeError } from '../lib/api/client'
import type { CompanyData, CompanyPayload } from '../lib/api/types'

/**
 * Light client-side mirror of the backend's well-formedness rule (NOT the
 * reserved-word list, which lives only on the server and can change there
 * without this file going stale): empty (auto-derived from name) is fine;
 * otherwise lowercase ascii letters, digits and hyphens, no leading/trailing
 * hyphen, <=64 chars. Reserved-slug rejection surfaces via the server error.
 */
function slugFormatProblem(slug: string): string | null {
  const s = slug.trim()
  if (s === '') return null
  const wellFormed =
    s.length <= 64 && !s.startsWith('-') && !s.endsWith('-') && /^[a-z0-9-]+$/.test(s)
  if (!wellFormed) {
    return 'Slug inválido. Usa solo minúsculas, números y guiones, sin iniciar ni terminar con guion (máx 64).'
  }
  return null
}

function opt(value: string): string | null {
  const v = value.trim()
  return v === '' ? null : v
}

const emptyForm = () => ({
  name: '',
  slug: '',
  currency: 'MXN',
  notes: '',
  isActive: true,
})

export default function Companies(): JSX.Element {
  const qc = useQueryClient()

  const companiesQuery = createQuery(() => ({
    queryKey: ['companies'],
    queryFn: adminApi.listCompanies,
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

  const openEdit = async (company: CompanyData) => {
    setEditingId(company.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await adminApi.getCompany(company.id)
      setForm({
        name: detail.name,
        slug: detail.slug,
        currency: detail.default_currency,
        notes: detail.notes ?? '',
        isActive: detail.is_active,
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar la compañía'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: CompanyPayload) => {
      const id = editingId()
      return id ? adminApi.updateCompany(id, payload) : adminApi.createCompany(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success(editingId() ? 'Compañía actualizada' : 'Compañía creada')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar la compañía'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const f = form()
    if (f.name.trim() === '') {
      setFormError('El nombre es obligatorio')
      return
    }
    const slugProblem = slugFormatProblem(f.slug)
    if (slugProblem) {
      setFormError(slugProblem)
      return
    }
    setFormError(null)
    saveMutation.mutate({
      name: f.name.trim(),
      slug: opt(f.slug),
      default_currency: opt(f.currency),
      is_active: f.isActive,
      notes: opt(f.notes),
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<CompanyData | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => adminApi.deleteCompany(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success('Compañía eliminada')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar la compañía', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  // --- danger zone: wipe a company's CFDIs / transactions ------------------
  const dangerCfdisMutation = createMutation(() => ({
    mutationFn: (id: string) => adminApi.deleteAllCompanyCfdis(id),
    onSuccess: () => toast.success('CFDIs borrados'),
    onError: (err) => toast.error('No se pudo completar', humanizeError(err, '')),
  }))
  const dangerTransactionsMutation = createMutation(() => ({
    mutationFn: (id: string) => adminApi.deleteAllCompanyTransactions(id),
    onSuccess: () => toast.success('Transacciones borradas'),
    onError: (err) => toast.error('No se pudo completar', humanizeError(err, '')),
  }))

  const confirmAndRunDanger = (
    mutation: { mutate: (id: string) => void },
    confirmMsg: string,
  ) => {
    const id = editingId()
    if (!id) return
    if (!window.confirm(confirmMsg)) return
    mutation.mutate(id)
  }

  return (
    <div class="space-y-6">
      <PageHeader
        title="Compañías"
        breadcrumb={['Administración', 'Compañías']}
        subtitle={
          companiesQuery.data
            ? `${companiesQuery.data.length} compañía${companiesQuery.data.length === 1 ? '' : 's'}`
            : 'Los tenants (subdominios) de la plataforma.'
        }
        actions={
          <Button onClick={openCreate}>
            <Plus class="mr-1.5 h-4 w-4" />
            Nueva compañía
          </Button>
        }
      />

      <Card glass>
        <Show when={!companiesQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!companiesQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar las compañías.
              </CardContent>
            }
          >
            <Show
              when={companiesQuery.data && companiesQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Building2 class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin compañías todavía.</p>
                  <Button variant="outline" onClick={openCreate}>
                    Crear la primera compañía
                  </Button>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Nombre</TableHeadCell>
                    <TableHeadCell>Moneda</TableHeadCell>
                    <TableHeadCell>Estado</TableHeadCell>
                    <TableHeadCell class="text-right">Acciones</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(companiesQuery.data ?? []).map((c) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{c.name}</TableCell>
                      <TableCell class="text-muted-foreground">{c.default_currency}</TableCell>
                      <TableCell>
                        <Badge tone={boolBadgeTone(c.is_active)}>{c.is_active ? 'Activa' : 'Inactiva'}</Badge>
                      </TableCell>
                      <TableCell class="text-right">
                        <div class="flex justify-end gap-1">
                          <Button variant="ghost" onClick={() => void openEdit(c)} aria-label="Editar">
                            <Pencil class="h-4 w-4" />
                          </Button>
                          <Show
                            when={!c.is_current}
                            fallback={
                              <span class="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                                Actual
                              </span>
                            }
                          >
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(c)}
                              aria-label="Eliminar"
                            >
                              <Trash2 class="h-4 w-4" />
                            </Button>
                          </Show>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar compañía' : 'Nueva compañía'}>
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5 sm:col-span-2">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Mi Empresa S.A."
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Slug (subdominio)</label>
            <Input
              value={form().slug}
              onInput={(v) => setForm((f) => ({ ...f, slug: v }))}
              placeholder="ej. research"
              disabled={loadingDetail()}
            />
            <p class="text-xs text-muted-foreground">Se genera del nombre si lo dejas vacío.</p>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Moneda por defecto</label>
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
              placeholder="Opcional"
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
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear compañía'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>

        {/* Danger zone: only while editing an existing company. */}
        <Show when={editingId()}>
          <div class="mt-6 rounded-md border border-destructive/30 bg-destructive/5 p-4">
            <p class="text-sm font-semibold text-destructive">Zona de pruebas</p>
            <p class="mt-1 text-xs text-muted-foreground">
              Acciones irreversibles para limpiar datos de prueba de esta compañía.
            </p>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                class="border-destructive/30 text-destructive hover:bg-destructive/10"
                disabled={dangerCfdisMutation.isPending}
                onClick={() =>
                  confirmAndRunDanger(
                    dangerCfdisMutation,
                    '¿Borrar TODOS los CFDIs de esta compañía? Esta acción no se puede deshacer.',
                  )
                }
              >
                Borrar todos los CFDIs
              </Button>
              <Button
                variant="outline"
                class="border-destructive/30 text-destructive hover:bg-destructive/10"
                disabled={dangerTransactionsMutation.isPending}
                onClick={() =>
                  confirmAndRunDanger(
                    dangerTransactionsMutation,
                    '¿Borrar TODAS las transacciones de esta compañía? Esta acción no se puede deshacer.',
                  )
                }
              >
                Borrar todas las transacciones
              </Button>
            </div>
          </div>
        </Show>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar compañía">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar la compañía <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta
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
