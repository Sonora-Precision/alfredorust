// Estados de concepto — reorderable card list (drag to change order). Position
// is implicit (list order); "Inicial"/"Terminal" are DERIVED from position
// (first = inicial, last = terminal) and persisted automatically on reorder.
// "Activo" and "Cancelado" are independent per-status toggles. Admin-gated
// create/edit/delete; staff see a read-only list.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { GripVertical, ListChecks, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createSignal } from 'solid-js'

import { Badge, boolBadgeTone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as operationsApi from '../lib/api/operations'
import type { ConceptStatusFull, ConceptStatusPayload } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const emptyForm = () => ({ name: '', color: '', isActive: true, isCancelled: false })

export default function ConceptStatuses(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const statusesQuery = createQuery(() => ({
    queryKey: ['concept-statuses'],
    queryFn: operationsApi.listConceptStatuses,
  }))

  // Local ordered copy — the source of truth for the list UI (so drag reorders
  // feel instant). Synced from the server whenever we're not mid-drag.
  const [items, setItems] = createSignal<ConceptStatusFull[]>([])
  const [dragId, setDragId] = createSignal<string | null>(null)
  let listRef: HTMLDivElement | undefined
  // Set after create/delete so the next load re-derives positions + first/last
  // flags (e.g. the old last item stops being "terminal" once a new one is added).
  let normalizeAfterLoad = false

  createEffect(() => {
    const data = statusesQuery.data
    if (!data || dragId() !== null) return
    const sorted = [...data].sort((a, b) => a.position - b.position)
    setItems(sorted)
    if (normalizeAfterLoad) {
      normalizeAfterLoad = false
      void persist(sorted)
    }
  })

  /** Write position + derived is_initial/is_terminal for any row that drifted. */
  async function persist(list: ConceptStatusFull[]): Promise<void> {
    let wrote = false
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      const isInitial = i === 0
      const isTerminal = i === list.length - 1
      if (s.position !== i || s.is_initial !== isInitial || s.is_terminal !== isTerminal) {
        wrote = true
        // Sequential (not parallel): the backend renumbers positions, so
        // concurrent writes could race.
        await operationsApi.updateConceptStatus(s.id, {
          name: s.name,
          position: i,
          color: s.color ?? null,
          is_initial: isInitial,
          is_terminal: isTerminal,
          is_cancelled: s.is_cancelled,
          is_active: s.is_active,
        })
      }
    }
    if (wrote) void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
  }

  const toggleFlag = async (s: ConceptStatusFull, key: 'is_active' | 'is_cancelled', val: boolean): Promise<void> => {
    setItems((prev) => prev.map((x) => (x.id === s.id ? { ...x, [key]: val } : x)))
    try {
      await operationsApi.updateConceptStatus(s.id, {
        name: s.name,
        position: s.position,
        color: s.color ?? null,
        is_initial: s.is_initial,
        is_terminal: s.is_terminal,
        is_cancelled: key === 'is_cancelled' ? val : s.is_cancelled,
        is_active: key === 'is_active' ? val : s.is_active,
      })
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
    } catch (e) {
      toast.error('No se pudo actualizar', humanizeError(e, ''))
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
    }
  }

  // --- drag to reorder (pointer-based → works with mouse AND touch) ---------
  const onDragStart = (e: PointerEvent, id: string): void => {
    if (!isAdmin()) return
    e.preventDefault()
    setDragId(id)
    const move = (ev: PointerEvent) => onDragMove(ev)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const dropped = dragId() !== null
      setDragId(null)
      if (dropped) void persist(items())
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onDragMove = (e: PointerEvent): void => {
    const id = dragId()
    if (!id || !listRef) return
    const cards = Array.from(listRef.querySelectorAll<HTMLElement>('[data-cs]'))
    const y = e.clientY
    let target = cards.length - 1
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) {
        target = i
        break
      }
    }
    const cur = items()
    const from = cur.findIndex((s) => s.id === id)
    if (from === -1 || from === target) return
    const next = cur.slice()
    const [moved] = next.splice(from, 1)
    next.splice(target, 0, moved)
    setItems(next)
  }

  // --- create / edit modal -------------------------------------------------
  const [modalOpen, setModalOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [form, setForm] = createSignal(emptyForm())
  const [formError, setFormError] = createSignal<string | null>(null)

  const openCreate = (): void => {
    setEditingId(null)
    setForm(emptyForm())
    setFormError(null)
    setModalOpen(true)
  }
  const openEdit = (status: ConceptStatusFull): void => {
    setEditingId(status.id)
    setFormError(null)
    setForm({ name: status.name, color: status.color ?? '', isActive: status.is_active, isCancelled: status.is_cancelled })
    setModalOpen(true)
  }
  const closeModal = (): void => {
    setModalOpen(false)
  }

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ConceptStatusPayload) => {
      const id = editingId()
      return id ? operationsApi.updateConceptStatus(id, payload) : operationsApi.createConceptStatus(payload)
    },
    onSuccess: () => {
      if (!editingId()) normalizeAfterLoad = true // new item appended → re-derive first/last
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
      toast.success(editingId() ? 'Estado actualizado' : 'Estado creado')
      closeModal()
    },
    onError: (err) => setFormError(humanizeError(err, 'No se pudo guardar el estado')),
  }))

  const submit = (ev: SubmitEvent): void => {
    ev.preventDefault()
    const f = form()
    if (f.name.trim() === '') {
      setFormError('El nombre es obligatorio')
      return
    }
    setFormError(null)
    const color = f.color.trim()
    const id = editingId()
    const existing = id ? items().find((s) => s.id === id) : undefined
    const count = items().length
    // Position + Inicial/Terminal come from list order, not the form: keep the
    // edited row's values; a new row goes to the end (and becomes terminal).
    saveMutation.mutate({
      name: f.name.trim(),
      color: color === '' ? null : color,
      is_cancelled: f.isCancelled,
      is_active: f.isActive,
      position: existing ? existing.position : count,
      is_initial: existing ? existing.is_initial : count === 0,
      is_terminal: existing ? existing.is_terminal : true,
    })
  }

  // --- delete --------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<ConceptStatusFull | null>(null)
  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => operationsApi.deleteConceptStatus(id),
    onSuccess: () => {
      normalizeAfterLoad = true // removing a row can shift first/last
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
      <PageHeader
        title="Estados de concepto"
        subtitle="Arrastra para ordenar el flujo. El primero es el inicial y el último el terminal."
        breadcrumb={['Operaciones', 'Estados de concepto']}
        actions={
          <Show when={isAdmin()}>
            <Button onClick={openCreate}>
              <Plus class="mr-1.5 h-4 w-4" />
              Nuevo estado
            </Button>
          </Show>
        }
      />

      <Card glass>
        <Show
          when={!statusesQuery.isLoading}
          fallback={
            <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Spinner />
              <span>Cargando…</span>
            </CardContent>
          }
        >
          <Show
            when={!statusesQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar los estados.
              </CardContent>
            }
          >
            <Show
              when={items().length > 0}
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
              <div ref={listRef} class="divide-y divide-border/60">
                <For each={items()}>
                  {(s, i) => (
                    <div
                      data-cs
                      class="flex items-center gap-3 px-4 py-3 transition"
                      classList={{ 'bg-muted/40': dragId() === s.id }}
                    >
                      <Show when={isAdmin()}>
                        <button
                          type="button"
                          class="shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                          style="touch-action:none"
                          aria-label="Arrastrar para reordenar"
                          onPointerDown={(e) => onDragStart(e, s.id)}
                        >
                          <GripVertical class="h-5 w-5" />
                        </button>
                      </Show>
                      <Show when={s.color}>
                        <span class="h-3 w-3 shrink-0 rounded-full" style={`background:${s.color}`} />
                      </Show>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="font-medium text-foreground">{s.name}</span>
                          <Show when={i() === 0}>
                            <Badge tone="info">Inicial</Badge>
                          </Show>
                          <Show when={i() === items().length - 1}>
                            <Badge tone="neutral">Terminal</Badge>
                          </Show>
                        </div>
                      </div>
                      <Show
                        when={isAdmin()}
                        fallback={
                          <div class="flex items-center gap-1.5">
                            <Badge tone={boolBadgeTone(s.is_active)}>{s.is_active ? 'Activo' : 'Inactivo'}</Badge>
                            <Show when={s.is_cancelled}>
                              <Badge tone="danger">Cancelado</Badge>
                            </Show>
                          </div>
                        }
                      >
                        <div class="flex items-center gap-4">
                          <Checkbox checked={s.is_active} onChange={(v) => void toggleFlag(s, 'is_active', v)} label="Activo" />
                          <Checkbox
                            checked={s.is_cancelled}
                            onChange={(v) => void toggleFlag(s, 'is_cancelled', v)}
                            label="Cancelado"
                          />
                          <div class="flex gap-1">
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
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Card>

      {/* Create / edit modal */}
      <Modal open={modalOpen()} onOpenChange={setModalOpen} title={editingId() ? 'Editar estado' : 'Nuevo estado'}>
        <form onSubmit={submit} class="space-y-4">
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Nombre</label>
            <Input value={form().name} onInput={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="Cotizado" required />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-foreground">Color</label>
            <Input value={form().color} onInput={(v) => setForm((f) => ({ ...f, color: v }))} placeholder="#22c55e" />
          </div>
          <div class="flex flex-wrap items-center gap-4">
            <Checkbox checked={form().isActive} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} label="Activo" />
            <Checkbox
              checked={form().isCancelled}
              onChange={(v) => setForm((f) => ({ ...f, isCancelled: v }))}
              label="Cancelado"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            La posición (inicial/terminal) se define arrastrando en la lista.
          </p>

          <Show when={formError()}>
            <p class="text-sm text-destructive">{formError()}</p>
          </Show>

          <div class="flex items-center gap-2">
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
            ¿Eliminar el estado <span class="font-semibold text-foreground">{deleteTarget()?.name}</span>? Esta acción no
            se puede deshacer.
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
