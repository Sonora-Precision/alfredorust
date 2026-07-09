// Contactos — CRUD for customers/suppliers/service/other contacts. Faithful
// port of frontend/src/pages/contacts.rs. See
// docs/solid-migration/pages-part1.md "ContactsPage" for the behavior spec.
//
// Quirk preserved 1:1: the Tipo column renders the raw `kind` enum value
// (e.g. "customer") as plain text — the API doesn't return a localized label
// for the list row (unlike PlannedEntry.status_label), and the Leptos source
// does the same (`<td>{c.kind}</td>`, no badge, no label lookup). The
// migration doc flags this as "worth normalizing" but it isn't in PLAN §13,
// so it's kept as-is here rather than silently upgraded.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Pencil, Trash2, Users } from 'lucide-solid'
import { type JSX, Show, createSignal, For } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as financeApi from '../lib/api/finance'
import type { Contact, ContactPayload, ContactType } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const CONTACT_TYPES: { value: ContactType; label: string }[] = [
  { value: 'customer', label: 'Cliente' },
  { value: 'supplier', label: 'Proveedor' },
  { value: 'service', label: 'Servicio' },
  { value: 'other', label: 'Otro' },
]

/** Trim, then turn an empty string into `null` — mirrors the Rust `opt()` helper. */
function opt(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const emptyForm = () => ({
  name: '',
  contactType: 'customer' as ContactType,
  email: '',
  rfc: '',
  phone: '',
  notes: '',
})

export default function Contacts(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

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

  const openEdit = async (contact: Contact) => {
    setEditingId(contact.id)
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await financeApi.getContact(contact.id)
      setForm({
        name: detail.name,
        contactType: detail.contact_type,
        email: detail.email ?? '',
        rfc: detail.rfc ?? '',
        phone: detail.phone ?? '',
        notes: detail.notes ?? '',
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el contacto'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ContactPayload) => {
      const id = editingId()
      return id ? financeApi.updateContact(id, payload) : financeApi.createContact(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] })
      toast.success(editingId() ? 'Contacto actualizado' : 'Contacto creado')
      closeModal()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar el contacto'))
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
    saveMutation.mutate({
      name: f.name.trim(),
      contact_type: f.contactType,
      rfc: opt(f.rfc),
      email: opt(f.email),
      phone: opt(f.phone),
      notes: opt(f.notes),
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Contact | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => financeApi.deleteContact(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] })
      toast.success('Contacto eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el contacto', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Contactos"
        breadcrumb={['Finanzas', 'Contactos']}
        subtitle={
          contactsQuery.data
            ? `${contactsQuery.data.length} contacto${contactsQuery.data.length === 1 ? '' : 's'}`
            : 'Clientes, proveedores y contactos de servicio.'
        }
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>Nuevo contacto</Button>
          </Show>
        }
      />

      <Card glass>
        <Show when={!contactsQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!contactsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los contactos.
              </CardContent>
            }
          >
            <Show
              when={contactsQuery.data && contactsQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Users class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin contactos todavía.</p>
                  <Show when={isAdmin()}>
                    <Button variant="outline" onClick={openCreate}>
                      Crear el primer contacto
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
                    <TableHeadCell>Correo</TableHeadCell>
                    <Show when={isAdmin()}>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={contactsQuery.data ?? []}>{(c) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{c.name}</TableCell>
                      <TableCell>{c.kind}</TableCell>
                      <TableCell class="text-muted-foreground">{c.email ?? ''}</TableCell>
                      <Show when={isAdmin()}>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button variant="ghost" onClick={() => void openEdit(c)} aria-label="Editar">
                              <Pencil class="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              class="text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTarget(c)}
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
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar contacto' : 'Nuevo contacto'}>
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input
              value={form().name}
              onInput={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="ACME S.A."
              required
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Tipo</label>
            <Select
              value={form().contactType}
              onChange={(v) => setForm((f) => ({ ...f, contactType: v as ContactType }))}
              disabled={loadingDetail()}
            >
              <For each={CONTACT_TYPES}>{(t) => (
                <option value={t.value}>{t.label}</option>
              )}</For>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Correo</label>
            <Input
              value={form().email}
              onInput={(v) => setForm((f) => ({ ...f, email: v }))}
              type="email"
              placeholder="contacto@acme.com"
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">RFC</label>
            <Input
              value={form().rfc}
              onInput={(v) => setForm((f) => ({ ...f, rfc: v }))}
              disabled={loadingDetail()}
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Teléfono</label>
            <Input
              value={form().phone}
              onInput={(v) => setForm((f) => ({ ...f, phone: v }))}
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

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear contacto'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal variant="center" open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar contacto">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar el contacto <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta
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
