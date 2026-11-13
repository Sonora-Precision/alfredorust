// Maquila of a part in Seguimiento (Daniel, 2026-11-13): who has pieces of it, for which
// steps, how many, until when. The admin sends and edits; programmers only read
// "En maquila" (the supplier with its own permission, never prices).
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { listContacts } from '../../lib/api/finance'
import {
  type OutsourceJob,
  type OutsourceStatus,
  STATUS_LABEL,
  createOutsourcing,
  deleteOutsourcing,
  updateOutsourcing,
} from '../../lib/api/outsourcing'
import type { ProcessOperation, ProjectConcept } from '../../lib/api/types'
import { cn } from '../../lib/cn'

const money = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 })
/** Our margin on maquila: 30% of the sale, so at most 70% goes to the supplier. */
const SUPPLIER_SHARE = 0.7

const dayText = (iso: string) =>
  new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'America/Hermosillo' })
const dayValue = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Hermosillo' }) : ''

const STATUS_CLASS: Record<OutsourceStatus, string> = {
  planned: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  sent: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  received: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  cancelled: 'bg-muted text-muted-foreground line-through',
}

export function PartOutsourcing(props: {
  projectId: string
  concept: ProjectConcept
  jobs: OutsourceJob[]
  operations: ProcessOperation[]
  /** Send and edit (admin). */
  canEdit: boolean
  canSeeMoney: boolean
}): JSX.Element {
  const [editing, setEditing] = createSignal<OutsourceJob | 'new' | null>(null)
  const what = (j: OutsourceJob) =>
    j.operation_ids.length === 0
      ? 'pieza completa'
      : j.operation_ids.map((id) => props.operations.find((o) => o.id === id)?.name ?? 'paso').join(', ')

  return (
    <div class="mt-0.5 space-y-0.5 text-xs">
      <For each={props.jobs}>
        {(j) => (
          <button
            type="button"
            class={cn('flex max-w-[22rem] flex-wrap items-center gap-1 text-left', props.canEdit && 'hover:underline')}
            disabled={!props.canEdit}
            onClick={() => setEditing(j)}
            title={props.canEdit ? 'Editar el envío a maquila' : undefined}
          >
            <span class={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', STATUS_CLASS[j.status])}>
              {j.status === 'received' ? 'Maquila recibida' : j.status === 'cancelled' ? 'Maquila cancelada' : 'En maquila'}
            </span>
            <Show when={j.supplier_name}>
              <span class="font-medium text-foreground">{j.supplier_name}</span>
            </Show>
            <span class="text-muted-foreground">
              · {what(j)} · {j.status === 'received' ? `${j.received_quantity}/${j.quantity}` : j.quantity} pzs
            </span>
            <Show when={props.canSeeMoney && j.unit_cost != null}>
              <span class="tnum text-muted-foreground">· {money(j.unit_cost!)}/pz</span>
            </Show>
            <Show when={j.due_date && j.status !== 'cancelled'}>
              <span class={cn('text-muted-foreground', j.late && 'font-medium text-red-600 dark:text-red-400')}>
                · {j.status === 'received' ? 'era para' : 'entrega'} {dayText(j.due_date!)}
                {j.late ? (j.status === 'received' ? ' (llegó tarde)' : ' (atrasada)') : ''}
              </span>
            </Show>
          </button>
        )}
      </For>
      <Show when={props.canEdit}>
        <button type="button" class="text-sky-600 hover:underline dark:text-sky-400" onClick={() => setEditing('new')}>
          Mandar a maquila
        </button>
      </Show>
      <Show when={editing()}>
        {(e) => (
          <OutsourceModal
            projectId={props.projectId}
            concept={props.concept}
            job={e() === 'new' ? null : (e() as OutsourceJob)}
            others={props.jobs.filter((j) => j !== e())}
            operations={props.operations}
            onClose={() => setEditing(null)}
          />
        )}
      </Show>
    </div>
  )
}

function OutsourceModal(props: {
  projectId: string
  concept: ProjectConcept
  job: OutsourceJob | null
  others: OutsourceJob[]
  operations: ProcessOperation[]
  onClose: () => void
}): JSX.Element {
  const qc = useQueryClient()
  const contacts = createQuery(() => ({ queryKey: ['contacts'], queryFn: listContacts }))
  // Maquila suppliers first; any other supplier can still be picked.
  const suppliers = createMemo(() =>
    (contacts.data ?? [])
      .filter((c) => c.kind === 'supplier' || c.kind === 'service')
      .sort(
        (a, b) =>
          Number(!!b.outsourcing) - Number(!!a.outsourcing) || (a.alias ?? a.name).localeCompare(b.alias ?? b.name, 'es'),
      ),
  )
  const j = props.job
  // By default, the pieces nobody else has yet.
  const taken = props.others
    .filter((o) => o.status !== 'cancelled' && o.operation_ids.length === 0)
    .reduce((s, o) => s + o.quantity, 0)
  const [supplierId, setSupplierId] = createSignal(j?.supplier_id ?? '')
  const [whole, setWhole] = createSignal(j ? j.operation_ids.length === 0 : true)
  const [opIds, setOpIds] = createSignal<string[]>(j?.operation_ids ?? [])
  const [quantity, setQuantity] = createSignal(String(j?.quantity ?? Math.max(props.concept.quantity - taken, 1)))
  const [unitCost, setUnitCost] = createSignal(j?.unit_cost != null ? String(j.unit_cost) : '')
  const [materialByUs, setMaterialByUs] = createSignal(j?.material_by_us ?? false)
  const [due, setDue] = createSignal(dayValue(j?.due_date))
  const [status, setStatus] = createSignal<OutsourceStatus>(j?.status ?? 'planned')
  const [received, setReceived] = createSignal(String(j?.received_quantity || (j ? j.quantity : 0)))
  const [notes, setNotes] = createSignal(j?.notes ?? '')
  const [error, setError] = createSignal<string | null>(null)

  const maxCost = () => (props.concept.unit_price != null ? props.concept.unit_price * SUPPLIER_SHARE : null)
  const overMax = () => {
    const m = maxCost()
    const c = Number(unitCost())
    return m != null && unitCost().trim() !== '' && c > m
  }
  const chosen = () => suppliers().find((s) => s.id === supplierId())

  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ['outsourcing', props.projectId] })
    void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
    void qc.invalidateQueries({ queryKey: ['production'] })
    toast.success(msg)
    props.onClose()
  }
  const save = createMutation(() => ({
    mutationFn: () => {
      const payload = {
        concept_id: props.concept.id,
        supplier_id: supplierId(),
        operation_ids: whole() ? [] : opIds(),
        quantity: Number(quantity()),
        unit_cost: unitCost().trim() === '' ? null : Number(unitCost()),
        material_by_us: materialByUs(),
        due_date: due() || null,
        status: status(),
        received_quantity: status() === 'received' ? Number(received()) : 0,
        notes: notes().trim() || null,
      }
      return j ? updateOutsourcing(j.id, payload) : createOutsourcing(payload).then(() => undefined)
    },
    onSuccess: () => done(j ? 'Maquila actualizada' : 'Mandada a maquila'),
    onError: (err) => setError(humanizeError(err, 'No se pudo guardar')),
  }))
  const remove = createMutation(() => ({
    mutationFn: () => deleteOutsourcing(j!.id),
    onSuccess: () => done('Envío borrado'),
    onError: (err) => setError(humanizeError(err, 'No se pudo borrar')),
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    if (!supplierId()) return setError('Elige el proveedor')
    if (!whole() && opIds().length === 0) return setError('Marca qué pasos hace el proveedor')
    const q = Number(quantity())
    if (!(q > 0)) return setError('La cantidad debe ser mayor a 0')
    if (unitCost().trim() !== '' && !(Number(unitCost()) >= 0)) return setError('Precio no válido')
    if (status() === 'received') {
      const r = Number(received())
      if (!(r >= 0) || r > q) return setError('Las recibidas van de 0 a la cantidad enviada')
    }
    setError(null)
    save.mutate()
  }

  const label = 'block text-sm font-medium text-foreground'
  return (
    <Modal open onOpenChange={(o) => !o && props.onClose()} title={`Maquila · ${props.concept.name}`}>
      <form onSubmit={submit} class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5 sm:col-span-2">
          <label class={label} for="outsource-supplier">Proveedor</label>
          <select
            id="outsource-supplier"
            class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={supplierId()}
            onChange={(e) => setSupplierId(e.currentTarget.value)}
          >
            <option value="">Elige…</option>
            <For each={suppliers()}>
              {(s) => (
                <option value={s.id} selected={s.id === supplierId()}>
                  {s.alias ?? s.name}
                  {s.outsourcing ? ' · maquila' : ''}
                  {s.processes && s.processes.length > 0 ? ` (${s.processes.join(', ')})` : ''}
                </option>
              )}
            </For>
          </select>
          <Show when={chosen() && !chosen()!.outsourcing}>
            <p class="text-xs text-amber-700 dark:text-amber-300">
              No está marcado como "Hace maquila" en Contactos.
            </p>
          </Show>
        </div>

        <div class="space-y-2 sm:col-span-2">
          <span class={label}>Qué hace</span>
          <div class="flex flex-wrap gap-4 text-sm">
            <label class="inline-flex items-center gap-2">
              <input type="radio" name="outsource-what" checked={whole()} onChange={() => setWhole(true)} />
              Pieza completa
            </label>
            <label class="inline-flex items-center gap-2">
              <input type="radio" name="outsource-what" checked={!whole()} onChange={() => setWhole(false)} />
              Solo algunos pasos
            </label>
          </div>
          <Show when={!whole()}>
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              <For each={props.operations}>
                {(op) => (
                  <Checkbox
                    checked={opIds().includes(op.id)}
                    onChange={(v) => setOpIds((ids) => (v ? [...ids, op.id] : ids.filter((x) => x !== op.id)))}
                    label={op.name}
                  />
                )}
              </For>
            </div>
            <p class="text-xs text-muted-foreground">
              Si un proceso no está en la lista (por ejemplo "Tratamiento térmico"), agrégalo en "Pasos del proceso" sin
              cola, para que no le salga a nadie del taller.
            </p>
          </Show>
        </div>

        <div class="space-y-1.5">
          <label class={label} for="outsource-qty">Piezas</label>
          <Input id="outsource-qty" type="number" min="1" value={quantity()} onInput={setQuantity} />
          <p class="text-xs text-muted-foreground">La pieza lleva {props.concept.quantity}.</p>
        </div>
        <div class="space-y-1.5">
          <label class={label} for="outsource-cost">Precio por pieza al proveedor</label>
          <Input id="outsource-cost" type="number" min="0" step="0.01" value={unitCost()} onInput={setUnitCost} />
          <Show when={maxCost() != null}>
            <p class={cn('text-xs', overMax() ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
              Máximo a pagar: {money(maxCost()!)} (venta {money(props.concept.unit_price!)} × 70%)
              {overMax() ? ' — se pasa del máximo' : ''}
            </p>
          </Show>
        </div>
        <div class="space-y-1.5">
          <label class={label} for="outsource-due">Fecha compromiso</label>
          <Input id="outsource-due" type="date" value={due()} onInput={setDue} />
        </div>
        <div class="space-y-1.5">
          <label class={label} for="outsource-status">Estado</label>
          <select
            id="outsource-status"
            class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={status()}
            onChange={(e) => setStatus(e.currentTarget.value as OutsourceStatus)}
          >
            <For each={Object.entries(STATUS_LABEL)}>
              {([value, text]) => (
                <option value={value} selected={value === status()}>
                  {text}
                </option>
              )}
            </For>
          </select>
        </div>
        <Show when={status() === 'received'}>
          <div class="space-y-1.5">
            <label class={label} for="outsource-received">Piezas recibidas</label>
            <Input id="outsource-received" type="number" min="0" value={received()} onInput={setReceived} />
          </div>
        </Show>
        <div class="sm:col-span-2">
          <Checkbox checked={materialByUs()} onChange={setMaterialByUs} label="Nosotros le damos el material" />
        </div>
        <div class="space-y-1.5 sm:col-span-2">
          <label class={label} for="outsource-notes">Notas</label>
          <Input id="outsource-notes" value={notes()} onInput={setNotes} />
        </div>
        <p class="text-xs text-muted-foreground sm:col-span-2">
          Mientras el proveedor tenga todas las piezas de un paso, ese paso sale del tablero. Al recibirlas todas, el paso se
          marca hecho solo; si fue la pieza completa, las recibidas pasan a Calidad.
        </p>

        <Show when={error()}>
          <p class="text-sm text-destructive sm:col-span-2">{error()}</p>
        </Show>
        <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : j ? 'Guardar' : 'Mandar a maquila'}
          </Button>
          <Button type="button" variant="outline" onClick={() => props.onClose()}>
            Cancelar
          </Button>
          <Show when={j}>
            <Button
              type="button"
              variant="ghost"
              class="ml-auto text-destructive hover:bg-destructive/10"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm('¿Borrar este envío a maquila? Si ya se mandó, mejor márcalo como Cancelada.')) remove.mutate()
              }}
            >
              Borrar
            </Button>
          </Show>
        </div>
      </form>
    </Modal>
  )
}
