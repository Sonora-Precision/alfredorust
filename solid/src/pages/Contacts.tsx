// Contactos — customers, suppliers, service and other contacts.
//
// Suppliers carry a card (Daniel, 2026-11-13): they can start as just an alias ("Ripasa")
// and be filled in later with legal name, RFC, address, contact and bank data. The ones
// that machine parts for us are marked "Hace maquila" with the processes they do.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Pencil, Trash2, Users, X } from 'lucide-solid'
import { type JSX, Show, createMemo, createSignal, For } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
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
import { cn } from '../lib/cn'

const CONTACT_TYPES: { value: ContactType; label: string }[] = [
  { value: 'customer', label: 'Cliente' },
  { value: 'supplier', label: 'Proveedor' },
  { value: 'service', label: 'Servicio' },
  { value: 'other', label: 'Otro' },
]
const typeLabel = (t: ContactType) => CONTACT_TYPES.find((c) => c.value === t)?.label ?? t

/** Common maquila processes; others can be typed. */
const PROCESSES = [
  'Torno CNC',
  'Fresa CNC',
  'Torno convencional',
  'Fresa convencional',
  'Tratamiento térmico',
  'Rectificado',
  'Electroerosión',
  'Soldadura',
  'Corte láser',
  'Pintura',
  'Anodizado',
  'Pavonado',
]

const MISSING_LABEL = { rfc: 'RFC', address: 'dirección', contact: 'teléfono o correo' } as const

type Filter = 'all' | 'customer' | 'supplier' | 'outsourcing'

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
  alias: '',
  taxRegime: '',
  address: '',
  city: '',
  state: '',
  postalCode: '',
  contactPerson: '',
  whatsapp: '',
  website: '',
  bank: '',
  clabe: '',
  creditDays: '',
  outsourcing: false,
  processes: [] as string[],
})
type Form = ReturnType<typeof emptyForm>
type TextKey = { [K in keyof Form]: Form[K] extends string ? K : never }[keyof Form]

export default function Contacts(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const contactsQuery = createQuery(() => ({
    queryKey: ['contacts'],
    queryFn: financeApi.listContacts,
  }))

  const [filter, setFilter] = createSignal<Filter>('all')
  const [search, setSearch] = createSignal('')
  const counts = createMemo(() => {
    const all = contactsQuery.data ?? []
    return {
      all: all.length,
      customer: all.filter((c) => c.kind === 'customer').length,
      supplier: all.filter((c) => c.kind === 'supplier').length,
      outsourcing: all.filter((c) => c.outsourcing).length,
    }
  })
  const visible = createMemo(() => {
    const q = search().trim().toLowerCase()
    return (contactsQuery.data ?? [])
      .filter((c) => {
        const f = filter()
        if (f === 'outsourcing') return !!c.outsourcing
        if (f !== 'all') return c.kind === f
        return true
      })
      .filter(
        (c) =>
          !q ||
          [c.name, c.alias, c.rfc, c.email, ...(c.processes ?? [])].some((v) => v && v.toLowerCase().includes(q)),
      )
      .sort((a, b) => (a.alias ?? a.name).localeCompare(b.alias ?? b.name, 'es'))
  })

  // --- create/edit modal state -------------------------------------------
  const [modalOpen, setModalOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [form, setForm] = createSignal(emptyForm())
  const [formError, setFormError] = createSignal<string | null>(null)
  const [loadingDetail, setLoadingDetail] = createSignal(false)
  const [otherProcess, setOtherProcess] = createSignal('')
  const set = (key: TextKey) => (v: string) => setForm((f) => ({ ...f, [key]: v }))
  const isSupplier = () => form().contactType === 'supplier' || form().contactType === 'service'

  const openCreate = (supplier = false) => {
    setEditingId(null)
    setForm({ ...emptyForm(), contactType: supplier ? 'supplier' : 'customer' })
    setFormError(null)
    setOtherProcess('')
    setModalOpen(true)
  }

  const openEdit = async (contact: Contact) => {
    setEditingId(contact.id)
    setFormError(null)
    setOtherProcess('')
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const d = await financeApi.getContact(contact.id)
      const p = d.profile
      setForm({
        name: d.name,
        contactType: d.contact_type,
        email: d.email ?? '',
        rfc: d.rfc ?? '',
        phone: d.phone ?? '',
        notes: d.notes ?? '',
        alias: p?.alias ?? '',
        taxRegime: p?.tax_regime ?? '',
        address: p?.address ?? '',
        city: p?.city ?? '',
        state: p?.state ?? '',
        postalCode: p?.postal_code ?? '',
        contactPerson: p?.contact_person ?? '',
        whatsapp: p?.whatsapp ?? '',
        website: p?.website ?? '',
        bank: p?.bank ?? '',
        clabe: p?.clabe ?? '',
        creditDays: p?.credit_days != null ? String(p.credit_days) : '',
        outsourcing: p?.outsourcing ?? false,
        processes: p?.processes ?? [],
      })
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el contacto'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  const toggleProcess = (p: string) =>
    setForm((f) => ({
      ...f,
      processes: f.processes.includes(p) ? f.processes.filter((x) => x !== p) : [...f.processes, p],
    }))
  const addOtherProcess = () => {
    const p = otherProcess().trim()
    if (!p) return
    if (!form().processes.some((x) => x.toLowerCase() === p.toLowerCase())) toggleProcess(p)
    setOtherProcess('')
  }

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
    // A supplier can be given with just its alias.
    const name = f.name.trim() || f.alias.trim()
    if (name === '') {
      setFormError(isSupplier() ? 'Escribe el alias o la razón social' : 'El nombre es obligatorio')
      return
    }
    const days = f.creditDays.trim() === '' ? null : Number(f.creditDays)
    if (days != null && (!Number.isInteger(days) || days < 0)) {
      setFormError('Los días de crédito deben ser un número entero')
      return
    }
    setFormError(null)
    saveMutation.mutate({
      name,
      contact_type: f.contactType,
      rfc: opt(f.rfc),
      email: opt(f.email),
      phone: opt(f.phone),
      notes: opt(f.notes),
      profile: {
        alias: opt(f.alias),
        tax_regime: opt(f.taxRegime),
        address: opt(f.address),
        city: opt(f.city),
        state: opt(f.state),
        postal_code: opt(f.postalCode),
        contact_person: opt(f.contactPerson),
        whatsapp: opt(f.whatsapp),
        website: opt(f.website),
        bank: opt(f.bank),
        clabe: opt(f.clabe),
        credit_days: days,
        outsourcing: isSupplier() && f.outsourcing,
        processes: isSupplier() && f.outsourcing ? f.processes : [],
      },
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

  const field = (label: string, key: TextKey, extra?: { placeholder?: string; type?: string; wide?: boolean }) => (
    <div class={cn('space-y-1.5', extra?.wide && 'sm:col-span-2')}>
      <label class="block text-sm font-medium text-foreground">{label}</label>
      <Input
        value={form()[key]}
        onInput={set(key)}
        type={extra?.type}
        placeholder={extra?.placeholder}
        disabled={loadingDetail()}
      />
    </div>
  )

  const NameCell = (c: Contact) => (
    <div class="min-w-0">
      <p class="font-medium text-foreground">{c.alias ?? c.name}</p>
      <Show when={c.alias && c.alias !== c.name}>
        <p class="truncate text-xs text-muted-foreground">{c.name}</p>
      </Show>
      <Show when={c.missing && c.missing.length > 0}>
        <p class="text-xs font-medium text-amber-700 dark:text-amber-300">
          Falta: {c.missing!.map((m) => MISSING_LABEL[m]).join(' · ')}
        </p>
      </Show>
    </div>
  )
  const MaquilaCell = (c: Contact) => (
    <Show when={c.outsourcing}>
      <div class="flex flex-wrap items-center gap-1">
        <span class="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
          Maquila
        </span>
        <For each={c.processes ?? []}>
          {(p) => <span class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{p}</span>}
        </For>
      </div>
    </Show>
  )
  const Actions = (c: Contact) => (
    <div class="flex shrink-0 justify-end gap-1">
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
  )

  const FILTERS: { value: Filter; label: string }[] = [
    { value: 'all', label: 'Todos' },
    { value: 'customer', label: 'Clientes' },
    { value: 'supplier', label: 'Proveedores' },
    { value: 'outsourcing', label: 'Maquila' },
  ]

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
            <div class="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => openCreate(true)}>
                Nuevo proveedor
              </Button>
              <Button onClick={() => openCreate(false)}>Nuevo contacto</Button>
            </div>
          </Show>
        }
      />

      <div class="flex flex-wrap items-center gap-2">
        <div class="flex flex-wrap gap-1 rounded-lg border border-border p-1">
          <For each={FILTERS}>
            {(f) => (
              <button
                type="button"
                class={cn(
                  'rounded-md px-3 py-1 text-sm transition',
                  filter() === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setFilter(f.value)}
              >
                {f.label} <span class="tnum text-xs opacity-70">{counts()[f.value]}</span>
              </button>
            )}
          </For>
        </div>
        <Input
          value={search()}
          onInput={setSearch}
          placeholder="Buscar por nombre, alias, RFC o proceso"
          class="max-w-xs"
          aria-label="Buscar contactos"
        />
      </div>

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
              when={visible().length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <Users class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">
                    {(contactsQuery.data ?? []).length > 0 ? 'Ningún contacto coincide.' : 'Sin contactos todavía.'}
                  </p>
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
                      <TableHeadCell>RFC</TableHeadCell>
                      <TableHeadCell>Contacto</TableHeadCell>
                      <TableHeadCell>Maquila</TableHeadCell>
                      <Show when={isAdmin()}>
                        <TableHeadCell class="text-right">Acciones</TableHeadCell>
                      </Show>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <For each={visible()}>{(c) => (
                      <TableRow>
                        <TableCell class="max-w-[22rem]">{NameCell(c)}</TableCell>
                        <TableCell class="text-sm">{typeLabel(c.kind)}</TableCell>
                        <TableCell class="tnum text-sm text-muted-foreground">{c.rfc ?? ''}</TableCell>
                        <TableCell class="text-sm text-muted-foreground">
                          <Show when={c.phone}><p>{c.phone}</p></Show>
                          <Show when={c.email && c.email !== '-'}><p class="truncate">{c.email}</p></Show>
                        </TableCell>
                        <TableCell>{MaquilaCell(c)}</TableCell>
                        <Show when={isAdmin()}>
                          <TableCell class="text-right">{Actions(c)}</TableCell>
                        </Show>
                      </TableRow>
                    )}</For>
                  </TableBody>
                </Table>
              </div>
              <div class="space-y-2 p-2 md:hidden">
                <For each={visible()}>{(c) => (
                  <div class="rounded-lg border border-border p-3">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">{NameCell(c)}</div>
                      <Show when={isAdmin()}>{Actions(c)}</Show>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{typeLabel(c.kind)}</span>
                      <Show when={c.rfc}><span>{c.rfc}</span></Show>
                      <Show when={c.phone}><span>{c.phone}</span></Show>
                      <Show when={c.email && c.email !== '-'}><span>{c.email}</span></Show>
                    </div>
                    <div class="mt-2">{MaquilaCell(c)}</div>
                  </div>
                )}</For>
              </div>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal
        open={modalOpen()}
        onOpenChange={setModalOpen}
        title={editingId() ? 'Editar contacto' : isSupplier() ? 'Nuevo proveedor' : 'Nuevo contacto'}
        class="max-w-[640px]"
      >
        <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
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
          <Show when={isSupplier()}>
            {field('Alias (nombre corto)', 'alias', { placeholder: 'Ripasa' })}
          </Show>
          {field(isSupplier() ? 'Razón social' : 'Nombre', 'name', {
            placeholder: isSupplier() ? 'Opcional si ya pusiste el alias' : 'ACME S.A.',
            wide: true,
          })}
          {field('RFC', 'rfc')}
          <Show when={isSupplier()}>{field('Régimen fiscal', 'taxRegime', { placeholder: '601 General de Ley' })}</Show>
          {field('Teléfono', 'phone')}
          {field('Correo', 'email', { type: 'email', placeholder: 'contacto@acme.com' })}

          <Show when={isSupplier()}>
            {field('Persona de contacto', 'contactPerson')}
            {field('WhatsApp', 'whatsapp')}
            <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:col-span-2">Dirección</p>
            {field('Calle y número', 'address', { wide: true })}
            {field('Ciudad', 'city')}
            {field('Estado', 'state')}
            {field('Código postal', 'postalCode')}
            {field('Sitio web', 'website')}
            <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:col-span-2">Pago</p>
            {field('Banco', 'bank')}
            {field('CLABE', 'clabe')}
            {field('Días de crédito', 'creditDays', { type: 'number', placeholder: '0' })}

            <div class="space-y-2 rounded-lg border border-border p-3 sm:col-span-2">
              <Checkbox
                checked={form().outsourcing}
                onChange={(v) => setForm((f) => ({ ...f, outsourcing: v }))}
                label="Hace maquila (le mandamos números de parte o procesos)"
              />
              <Show when={form().outsourcing}>
                <div class="flex flex-wrap gap-1.5">
                  <For each={[...PROCESSES, ...form().processes.filter((p) => !PROCESSES.includes(p))]}>
                    {(p) => (
                      <button
                        type="button"
                        class={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition',
                          form().processes.includes(p)
                            ? 'border-sky-500 bg-sky-500/15 text-sky-700 dark:text-sky-300'
                            : 'border-border text-muted-foreground hover:bg-muted',
                        )}
                        aria-pressed={form().processes.includes(p)}
                        onClick={() => toggleProcess(p)}
                      >
                        {p}
                        <Show when={!PROCESSES.includes(p)}>
                          <X class="h-3 w-3" />
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
                <div class="flex gap-2">
                  <Input
                    value={otherProcess()}
                    onInput={setOtherProcess}
                    placeholder="Otro proceso"
                    aria-label="Otro proceso"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addOtherProcess()
                      }
                    }}
                  />
                  <Button type="button" variant="outline" onClick={addOtherProcess}>
                    Agregar
                  </Button>
                </div>
              </Show>
            </div>
          </Show>

          {field('Notas', 'notes', { wide: true })}

          <Show when={formError()}>
            <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear'}
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
            ¿Eliminar el contacto <span class="font-semibold text-foreground">{deleteTarget()?.alias ?? deleteTarget()?.name}</span>? Esta
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
