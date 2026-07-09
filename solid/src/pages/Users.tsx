// Usuarios — user admin with per-company role/permission memberships: the
// most complex form in this batch. Faithful port of
// frontend/src/pages/users.rs; see docs/solid-migration/pages-part2.md
// "Users" for the behavior spec. One root user record plus N per-company
// membership sub-records (each with its own role and, for staff, a
// permission-checkbox array) are flattened into a single nested payload on
// save. While editing, a TOTP QR image (raw image/png, fetched as a Blob and
// shown via an object URL) plus the plaintext secret are shown for
// re-enrollment.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-solid'
import { type JSX, Show, createEffect, createSignal, onCleanup, For } from 'solid-js'
import { createStore } from 'solid-js/store'

import { Badge, roleBadgeTone } from '../components/ui/Badge'
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
import * as adminApi from '../lib/api/admin'
import { humanizeError } from '../lib/api/client'
import { getUserQrCode } from '../lib/api/misc'
import type { CompanyData, UserMembershipPayload, UserPayload, UserRowData } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

/** Staff permission grants: `(api_key, label)`. Order is the display order. */
const PERMISSIONS: { key: string; label: string }[] = [
  { key: 'view_projects', label: 'Ver proyectos' },
  { key: 'edit_resource_usage_today', label: 'Editar uso recursos hoy' },
  { key: 'view_resource_usage_history', label: 'Ver historial uso recursos' },
  { key: 'view_project_money', label: 'Ver montos de proyectos' },
  { key: 'view_timeline', label: 'Ver timeline financiero' },
]

/** One assignable company membership row in the edit form. */
interface MembershipState {
  companyId: string
  companyName: string
  included: boolean
  role: string
  /** One flag per entry in PERMISSIONS, same order. */
  perms: boolean[]
}

function freshRows(companies: CompanyData[]): MembershipState[] {
  return companies.map((c) => ({
    companyId: c.id,
    companyName: c.name,
    included: false,
    role: 'staff',
    perms: PERMISSIONS.map(() => false),
  }))
}

function opt(value: string): string | null {
  const v = value.trim()
  return v === '' ? null : v
}

export default function Users(): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()

  const usersQuery = createQuery(() => ({
    queryKey: ['users'],
    queryFn: adminApi.listUsers,
  }))

  // Universe of assignable companies — loaded once to seed membership rows.
  const companiesQuery = createQuery(() => ({
    queryKey: ['companies'],
    queryFn: adminApi.listCompanies,
  }))
  const [rowsSeeded, setRowsSeeded] = createSignal(false)
  const [membershipRows, setMembershipRows] = createStore<MembershipState[]>([])
  createEffect(() => {
    const companies = companiesQuery.data
    if (companies && !rowsSeeded()) {
      setMembershipRows(freshRows(companies))
      setRowsSeeded(true)
    }
  })

  // --- create/edit modal state -------------------------------------------
  const [modalOpen, setModalOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [username, setUsername] = createSignal('')
  const [secret, setSecret] = createSignal('')
  // The existing secret of the user being edited, shown read-only under the
  // QR so it can be copied. Empty when creating.
  const [secretView, setSecretView] = createSignal('')
  const [formError, setFormError] = createSignal<string | null>(null)
  const [loadingDetail, setLoadingDetail] = createSignal(false)

  const resetMembershipRows = () => {
    if (membershipRows.length === 0) return
    setMembershipRows(
      { from: 0, to: membershipRows.length - 1 },
      { included: false, role: 'staff', perms: PERMISSIONS.map(() => false) },
    )
  }

  const openCreate = () => {
    setEditingId(null)
    setUsername('')
    setSecret('')
    setSecretView('')
    setFormError(null)
    if (membershipRows.length > 0) resetMembershipRows()
    setModalOpen(true)
  }

  const openEdit = async (row: UserRowData) => {
    setEditingId(row.id)
    setUsername(row.username)
    setSecret('')
    setSecretView('')
    setFormError(null)
    setModalOpen(true)
    setLoadingDetail(true)
    try {
      const detail = await adminApi.getUser(row.id)
      setUsername(detail.username)
      setSecretView(detail.secret)
      if (membershipRows.length > 0) {
        setMembershipRows(
          { from: 0, to: membershipRows.length - 1 },
          (r) => {
            const m = detail.memberships.find((mm) => mm.company_id === r.companyId)
            if (m) {
              return {
                ...r,
                included: true,
                role: m.role,
                perms: PERMISSIONS.map((p) => m.permissions.includes(p.key)),
              }
            }
            return { ...r, included: false, role: 'staff', perms: PERMISSIONS.map(() => false) }
          },
        )
      }
    } catch (err) {
      setFormError(humanizeError(err, 'No se pudo cargar el usuario'))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeModal = () => setModalOpen(false)

  // --- QR code (TOTP re-enrollment), only while editing --------------------
  const [qrUrl, setQrUrl] = createSignal<string | null>(null)
  createEffect(() => {
    const id = editingId()
    if (!id) {
      setQrUrl(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    void getUserQrCode(id)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setQrUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setQrUrl(null)
      })
    onCleanup(() => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    })
  })

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: UserPayload) => {
      const id = editingId()
      return id ? adminApi.updateUser(id, payload) : adminApi.createUser(payload)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      toast.success(editingId() ? 'Usuario actualizado' : 'Usuario creado')
      closeModal()
    },
    onError: (err) => {
      // Backend sends "El nombre de usuario ya existe" on 409; humanizeError
      // surfaces it, other errors fall back.
      setFormError(humanizeError(err, 'No se pudo guardar el usuario'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    if (username().trim() === '') {
      setFormError('El nombre de usuario es obligatorio')
      return
    }
    if (!membershipRows.some((r) => r.included)) {
      setFormError('Selecciona al menos una compañía')
      return
    }
    setFormError(null)
    const memberships: UserMembershipPayload[] = membershipRows
      .filter((r) => r.included)
      .map((r) => ({
        company_id: r.companyId,
        role: r.role,
        permissions: PERMISSIONS.filter((_, i) => r.perms[i]).map((p) => p.key),
      }))
    saveMutation.mutate({
      username: username().trim(),
      secret: opt(secret()),
      memberships,
    })
  }

  // --- delete confirmation -------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<UserRowData | null>(null)

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => adminApi.deleteUser(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      toast.success('Usuario eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el usuario', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Usuarios"
        breadcrumb={['Administración', 'Usuarios']}
        subtitle={
          usersQuery.data
            ? `${usersQuery.data.length} usuario${usersQuery.data.length === 1 ? '' : 's'}`
            : 'Usuarios y sus membresías por compañía.'
        }
        actions={
          <Button onClick={openCreate}>
            <Plus class="mr-1.5 h-4 w-4" />
            Nuevo usuario
          </Button>
        }
      />

      <Card glass>
        <Show when={!usersQuery.isLoading} fallback={
          <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </CardContent>
        }>
          <Show
            when={!usersQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los usuarios.
              </CardContent>
            }
          >
            <Show
              when={usersQuery.data && usersQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <UsersIcon class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin usuarios todavía.</p>
                  <Button variant="outline" onClick={openCreate}>
                    Crear el primer usuario
                  </Button>
                </CardContent>
              }
            >
              {/* Desktop: table. Mobile (<md): stacked cards. */}
              <div class="hidden md:block">
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeadCell>Usuario</TableHeadCell>
                      <TableHeadCell>Compañías</TableHeadCell>
                      <TableHeadCell>Rol</TableHeadCell>
                      <TableHeadCell class="text-right">Acciones</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <For each={usersQuery.data ?? []}>{(u) => (
                      <TableRow>
                        <TableCell class="font-medium text-foreground">{u.username}</TableCell>
                        <TableCell class="text-muted-foreground">{u.companies.join(', ')}</TableCell>
                        <TableCell>
                          <Badge tone={roleBadgeTone(u.role)} class="uppercase">
                            {u.role}
                          </Badge>
                        </TableCell>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-1">
                            <Button variant="ghost" onClick={() => void openEdit(u)} aria-label="Editar">
                              <Pencil class="h-4 w-4" />
                            </Button>
                            <Show when={u.username !== auth.user()}>
                              <Button
                                variant="ghost"
                                class="text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget(u)}
                                aria-label="Eliminar"
                              >
                                <Trash2 class="h-4 w-4" />
                              </Button>
                            </Show>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}</For>
                  </TableBody>
                </Table>
              </div>
              <div class="space-y-2 md:hidden">
                <For each={usersQuery.data ?? []}>{(u) => (
                  <div class="rounded-lg border border-border p-3">
                    <div class="flex items-start justify-between gap-2">
                      <p class="min-w-0 flex-1 font-medium text-foreground">{u.username}</p>
                      <div class="flex shrink-0 gap-1">
                        <Button variant="ghost" onClick={() => void openEdit(u)} aria-label="Editar">
                          <Pencil class="h-4 w-4" />
                        </Button>
                        <Show when={u.username !== auth.user()}>
                          <Button
                            variant="ghost"
                            class="text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteTarget(u)}
                            aria-label="Eliminar"
                          >
                            <Trash2 class="h-4 w-4" />
                          </Button>
                        </Show>
                      </div>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Badge tone={roleBadgeTone(u.role)} class="uppercase">{u.role}</Badge>
                      <Show when={u.companies.length > 0}>
                        <span class="text-muted-foreground">{u.companies.join(', ')}</span>
                      </Show>
                    </div>
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
        title={editingId() ? 'Editar usuario' : 'Nuevo usuario'}
        class="max-w-2xl"
      >
        <form onSubmit={submit} class="space-y-4">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Nombre de usuario</label>
            <Input
              value={username()}
              onInput={setUsername}
              autocomplete="username"
              placeholder="ej. alfredo@example.com"
              required
              disabled={loadingDetail()}
            />
            <p class="text-xs text-muted-foreground">Identificador de acceso. Debe ser único.</p>
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Secreto TOTP</label>
            <Input
              value={secret()}
              onInput={setSecret}
              class="font-mono"
              placeholder="Se genera automáticamente si lo dejas vacío"
              disabled={loadingDetail()}
            />
            <p class="text-xs text-muted-foreground">
              Comparte este valor con el usuario para configurar su autenticador.
            </p>
          </div>

          <div class="space-y-2">
            <p class="text-sm font-medium text-foreground">Compañías y rol</p>
            <Show
              when={membershipRows.length > 0}
              fallback={<p class="text-sm text-muted-foreground">Sin compañías disponibles.</p>}
            >
              <div class="space-y-2">
                {/* eslint-disable-next-line solid/prefer-for -- index-keyed store form: array is stable, only nested fields mutate via setMembershipRows(i, ...) */}
                {membershipRows.map((m, i) => (
                  <div class="rounded-md border border-border p-3">
                    <div class="flex items-center justify-between gap-3">
                      <Checkbox
                        checked={m.included}
                        onChange={(v) => setMembershipRows(i, 'included', v)}
                        label={m.companyName}
                      />
                      <Show when={m.included}>
                        <Select
                          value={m.role}
                          onChange={(v) => setMembershipRows(i, 'role', v)}
                          class="w-32"
                        >
                          <option value="staff">Staff</option>
                          <option value="admin">Admin</option>
                        </Select>
                      </Show>
                    </div>
                    <Show when={m.included && m.role === 'staff'}>
                      <div class="mt-2 grid gap-1 pl-6 sm:grid-cols-2">
                        <p class="text-xs font-semibold uppercase text-muted-foreground sm:col-span-2">
                          Permisos staff
                        </p>
                        {/* eslint-disable-next-line solid/prefer-for -- static PERMISSIONS list, pi indexes the store's perms array */}
                        {PERMISSIONS.map((p, pi) => (
                          <Checkbox
                            checked={m.perms[pi] ?? false}
                            onChange={(v) => setMembershipRows(i, 'perms', pi, v)}
                            label={p.label}
                          />
                        ))}
                      </div>
                    </Show>
                  </div>
                ))}
              </div>
            </Show>
          </div>

          {/* TOTP QR + plaintext secret — only while editing an existing user. */}
          <Show when={editingId()}>
            <div class="space-y-1.5">
              <p class="text-sm font-medium text-foreground">Código QR (autenticador)</p>
              <Show
                when={qrUrl()}
                fallback={
                  <div class="flex h-40 w-40 items-center justify-center rounded border border-border bg-card">
                    <Spinner />
                  </div>
                }
              >
                <img
                  src={qrUrl()!}
                  alt="Código QR TOTP"
                  class="h-40 w-40 rounded border border-border bg-card p-1"
                />
              </Show>
              <p class="text-xs text-muted-foreground">
                El usuario escanea este código para configurar su autenticador.
              </p>
              <Show when={secretView() !== ''}>
                <div class="space-y-1">
                  <label class="block text-xs font-medium text-muted-foreground">Secreto TOTP (texto)</label>
                  <code class="block select-all break-all rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
                    {secretView()}
                  </code>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={formError()}>
            <p class="text-sm text-destructive">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2">
            <Button type="submit" disabled={saveMutation.isPending || loadingDetail()}>
              {saveMutation.isPending ? 'Guardando…' : editingId() ? 'Guardar cambios' : 'Crear usuario'}
            </Button>
            <Button type="button" variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal variant="center" open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar usuario">
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            ¿Eliminar al usuario{' '}
            <span class="font-semibold text-foreground">{deleteTarget()?.username}</span>? Esta acción no se
            puede deshacer.
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
