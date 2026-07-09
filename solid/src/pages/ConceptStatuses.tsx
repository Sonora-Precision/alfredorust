// Estados de concepto — reorderable card list. Drag a card (grip handle) to
// change the flow order: a floating clone follows the pointer and a dashed gap
// marks where it will land. Position is implicit (list order); Inicial/Terminal
// are DERIVED from position (first/last) and persisted on drop. Activo and
// Cancelado are independent per-card toggles. Admin-gated; staff read-only.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { GripVertical, ListChecks, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, For, Show, createEffect, createSignal } from 'solid-js'
import { Portal } from 'solid-js/web'

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

interface DragState {
  id: string
  y: number // current pointer clientY
  offset: number // pointer offset inside the grabbed card
  height: number
  width: number
  left: number
}

export default function ConceptStatuses(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.isAdmin()
  const qc = useQueryClient()

  const statusesQuery = createQuery(() => ({
    queryKey: ['concept-statuses'],
    queryFn: operationsApi.listConceptStatuses,
  }))

  // Local ordered copy — source of truth for the list UI so drag feels instant.
  const [items, setItems] = createSignal<ConceptStatusFull[]>([])
  const [drag, setDrag] = createSignal<DragState | null>(null)
  const draggingId = () => drag()?.id ?? null
  let listRef: HTMLDivElement | undefined
  let normalizeAfterLoad = false // after create/delete: re-derive first/last

  createEffect(() => {
    const data = statusesQuery.data
    if (!data || draggingId() !== null) return
    const sorted = [...data].sort((a, b) => a.position - b.position)
    setItems(sorted)
    if (normalizeAfterLoad) {
      normalizeAfterLoad = false
      void commitOrder(sorted)
    }
  })

  /** Persist a new order: normalize position + first/last flags, update the
   * cache optimistically (so the list can't snap back), then write the changed
   * rows to the server (re-syncing from the server only on error). */
  async function commitOrder(order: ConceptStatusFull[]): Promise<void> {
    const prev = new Map((statusesQuery.data ?? []).map((s) => [s.id, s]))
    const n = order.length
    // Backend rule: a status is at most ONE of initial/terminal/cancelled.
    // Cancelled wins; otherwise first = initial, last = terminal (a lone status
    // is just initial, never also terminal).
    const normalized = order.map((s, i) => ({
      ...s,
      position: i,
      is_initial: !s.is_cancelled && i === 0,
      is_terminal: !s.is_cancelled && i === n - 1 && i !== 0,
    }))
    setItems(normalized)
    qc.setQueryData<ConceptStatusFull[]>(['concept-statuses'], normalized)
    const changed = normalized.filter((s) => {
      const o = prev.get(s.id)
      return (
        !o ||
        o.position !== s.position ||
        o.is_initial !== s.is_initial ||
        o.is_terminal !== s.is_terminal ||
        o.is_cancelled !== s.is_cancelled ||
        o.is_active !== s.is_active
      )
    })
    if (changed.length === 0) return
    try {
      for (const s of changed) {
        // Sequential (not parallel): the backend renumbers positions.
        await operationsApi.updateConceptStatus(s.id, {
          name: s.name,
          position: s.position,
          color: s.color ?? null,
          is_initial: s.is_initial,
          is_terminal: s.is_terminal,
          is_cancelled: s.is_cancelled,
          is_active: s.is_active,
        })
      }
      toast.success('Orden actualizado')
    } catch (e) {
      toast.error('No se pudo guardar el orden', humanizeError(e, ''))
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
    }
  }

  // "Activo" is an independent flag → direct update.
  const toggleActive = async (s: ConceptStatusFull, val: boolean): Promise<void> => {
    setItems((prev) => prev.map((x) => (x.id === s.id ? { ...x, is_active: val } : x)))
    try {
      await operationsApi.updateConceptStatus(s.id, {
        name: s.name,
        position: s.position,
        color: s.color ?? null,
        is_initial: s.is_initial,
        is_terminal: s.is_terminal,
        is_cancelled: s.is_cancelled,
        is_active: val,
      })
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
    } catch (e) {
      toast.error('No se pudo actualizar', humanizeError(e, ''))
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
    }
  }
  // "Cancelado" is one of the mutually-exclusive kinds, so flipping it re-derives
  // initial/terminal across the whole list (via commitOrder).
  const toggleCancelled = async (s: ConceptStatusFull, val: boolean): Promise<void> => {
    await commitOrder(items().map((x) => (x.id === s.id ? { ...x, is_cancelled: val } : x)))
  }

  // --- drag: floating clone + gap placeholder (pointer = mouse AND touch) ----
  const onDragStart = (e: PointerEvent, id: string): void => {
    if (!isAdmin()) return
    e.preventDefault()
    const card = (e.currentTarget as HTMLElement).closest('[data-cs]') as HTMLElement | null
    if (!card) return
    const r = card.getBoundingClientRect()
    setDrag({ id, y: e.clientY, offset: e.clientY - r.top, height: r.height, width: r.width, left: r.left })
    const move = (ev: PointerEvent) => onDragMove(ev)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const order = items()
      const had = drag() !== null
      setDrag(null)
      if (had) void commitOrder(order)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onDragMove = (e: PointerEvent): void => {
    const d = drag()
    if (!d || !listRef) return
    setDrag({ ...d, y: e.clientY })
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
    const from = cur.findIndex((s) => s.id === d.id)
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
      normalizeAfterLoad = true // re-derive first/last (+ un-cancel) after any save
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
    const cancelled = f.isCancelled
    saveMutation.mutate({
      name: f.name.trim(),
      color: color === '' ? null : color,
      is_cancelled: cancelled,
      is_active: f.isActive,
      position: existing ? existing.position : count,
      // Never initial+terminal together; cancelled clears both. A brand-new row
      // is appended last → terminal only when it isn't also the very first.
      is_initial: cancelled ? false : existing ? existing.is_initial : count === 0,
      is_terminal: cancelled ? false : existing ? existing.is_terminal : count > 0,
    })
  }

  // --- delete --------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<ConceptStatusFull | null>(null)
  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => operationsApi.deleteConceptStatus(id),
    onSuccess: () => {
      normalizeAfterLoad = true
      void qc.invalidateQueries({ queryKey: ['concept-statuses'] })
      toast.success('Estado eliminado')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error('No se pudo eliminar el estado', humanizeError(err, ''))
      setDeleteTarget(null)
    },
  }))

  const floatingItem = () => {
    const d = drag()
    return d ? items().find((s) => s.id === d.id) : undefined
  }

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
              <div ref={listRef} class="divide-y divide-border/60" classList={{ 'select-none': !!drag() }}>
                <For each={items()}>
                  {(s, i) => (
                    <div data-cs>
                      <Show
                        when={draggingId() === s.id}
                        fallback={
                          <div class="flex items-center gap-3 px-4 py-3">
                            <Show when={isAdmin()}>
                              <button
                                type="button"
                                class="shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                                style={{"touch-action":"none"}}
                                aria-label="Arrastrar para reordenar"
                                onPointerDown={(e) => onDragStart(e, s.id)}
                              >
                                <GripVertical class="h-5 w-5" />
                              </button>
                            </Show>
                            <Show when={s.color}>
                              <span class="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color ?? undefined }} />
                            </Show>
                            <div class="min-w-0 flex-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <span class="font-medium text-foreground">{s.name}</span>
                                <Show when={s.is_cancelled}>
                                  <Badge tone="danger">Cancelado</Badge>
                                </Show>
                                <Show when={!s.is_cancelled && i() === 0}>
                                  <Badge tone="info">Inicial</Badge>
                                </Show>
                                <Show when={!s.is_cancelled && i() === items().length - 1 && i() !== 0}>
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
                                <Checkbox
                                  checked={s.is_active}
                                  onChange={(v) => void toggleActive(s, v)}
                                  label="Activo"
                                />
                                <Checkbox
                                  checked={s.is_cancelled}
                                  onChange={(v) => void toggleCancelled(s, v)}
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
                        }
                      >
                        {/* Gap placeholder where the dragged card will land */}
                        <div class="p-2">
                          <div
                            class="rounded-lg border-2 border-dashed border-primary/40 bg-primary/5"
                            style={{ height: `${Math.max(0, (drag()?.height ?? 56) - 16)}px` }}
                          />
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

      {/* Floating clone that follows the pointer while dragging */}
      <Show when={drag() && floatingItem()}>
        <Portal>
          <div
            class="bg-glass pointer-events-none fixed z-[70] flex items-center gap-3 rounded-xl border border-border px-4 py-3 shadow-2xl"
            style={{ position: 'fixed', left: `${drag()!.left}px`, top: `${drag()!.y - drag()!.offset}px`, width: `${drag()!.width}px` }}
          >
            <GripVertical class="h-5 w-5 text-muted-foreground" />
            <Show when={floatingItem()!.color}>
              <span class="h-3 w-3 shrink-0 rounded-full" style={{ background: floatingItem()!.color ?? undefined }} />
            </Show>
            <span class="font-medium text-foreground">{floatingItem()!.name}</span>
          </div>
        </Portal>
      </Show>

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
          <p class="text-xs text-muted-foreground">La posición (inicial/terminal) se define arrastrando en la lista.</p>

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
      <Modal variant="center" open={deleteTarget() !== null} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Eliminar estado">
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
