// A part's machines from the project's part list (Daniel, 2026-11-04: "asignar piezas a las
// máquinas desde la vista de proyecto"): where it runs or waits, and "+ Máquina" to put it in
// a machine's queue or in production there, with its setup. Same endpoints as the plant's
// machine panel; the plant view is the source of truth.
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createSignal } from 'solid-js'
import { Cpu } from 'lucide-solid'

import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import * as productionApi from '../../lib/api/production'
import type { PlantMachine } from '../../lib/api/types'

export interface PartPlace {
  machine: string
  running: boolean
  position: number
  label: string | null
}

/** Where each part runs or waits, from the plant view. */
export function placesByPart(machines: PlantMachine[]): Map<string, PartPlace[]> {
  const map = new Map<string, PartPlace[]>()
  const push = (id: string, p: PartPlace) => map.set(id, [...(map.get(id) ?? []), p])
  for (const m of machines) {
    if (m.order && m.status === 'working') push(m.order.id, { machine: m.name, running: true, position: 0, label: m.label })
    m.queue.forEach((e, i) => push(e.order.id, { machine: m.name, running: false, position: i + 1, label: e.label }))
  }
  return map
}

export function PartMachines(props: {
  conceptId: string
  partName: string
  places: PartPlace[]
  machines: PlantMachine[]
  canEdit: boolean
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="mt-0.5 space-y-0.5 text-xs">
      <For each={props.places}>
        {(p) => (
          <p class={p.running ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-sky-700 dark:text-sky-300'}>
            {p.running ? '▶ Corriendo en ' : `#${p.position} en fila de `}
            {p.machine}
            <Show when={p.label}> · {p.label}</Show>
          </p>
        )}
      </For>
      <Show when={props.canEdit && props.machines.length > 0}>
        <button
          type="button"
          class="inline-flex items-center gap-1 font-medium text-sky-600 hover:underline"
          onClick={() => setOpen(true)}
        >
          <Cpu class="h-3.5 w-3.5" />
          Asignar a máquina
        </button>
        <Show when={open()}>
          <AssignMachine
            conceptId={props.conceptId}
            partName={props.partName}
            machines={props.machines}
            onClose={() => setOpen(false)}
          />
        </Show>
      </Show>
    </div>
  )
}

function AssignMachine(props: {
  conceptId: string
  partName: string
  machines: PlantMachine[]
  onClose: () => void
}): JSX.Element {
  const qc = useQueryClient()
  const [machineId, setMachineId] = createSignal('')
  const [label, setLabel] = createSignal('')
  const machine = () => props.machines.find((m) => m.resource_id === machineId())
  const cleanLabel = () => label().trim() || null

  const run = createMutation(() => ({
    mutationFn: (v: { fn: () => Promise<void>; done: string }) => v.fn(),
    onSuccess: (_d, v) => {
      toast.success(v.done, props.partName)
      void qc.invalidateQueries({ queryKey: ['production'] })
      props.onClose()
    },
    onError: (err) => toast.error('No se pudo asignar', humanizeError(err, 'Intenta de nuevo')),
  }))

  const toQueue = () => {
    const m = machine()
    if (!m) return
    run.mutate({ fn: () => productionApi.queueOnMachine(m.resource_id, props.conceptId, cleanLabel()), done: `En la fila de ${m.name}` })
  }
  const toRun = () => {
    const m = machine()
    if (!m) return
    if (m.order && m.status === 'working' && m.order.id !== props.conceptId) {
      if (!window.confirm(`${m.name} tiene ${m.order.folio} en producción. ¿Cambiar a ${props.partName}?`)) return
    }
    run.mutate({
      fn: () => productionApi.setMachineState(m.resource_id, { status: 'working', concept_id: props.conceptId, label: cleanLabel() }),
      done: `En producción en ${m.name}`,
    })
  }

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  return (
    <Modal open onOpenChange={(o) => !o && props.onClose()} title={`Asignar a máquina · ${props.partName}`}>
      <div class="space-y-3 p-1 text-sm">
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">Máquina</span>
          <select class={field} value={machineId()} onChange={(e) => setMachineId(e.currentTarget.value)}>
            <option value="">Elige una máquina…</option>
            <For each={props.machines}>
              {(m) => (
                <option value={m.resource_id}>
                  {m.name}
                  {m.order && m.status === 'working' ? ` — corriendo ${m.order.folio}` : ''}
                  {m.queue.length ? ` · ${m.queue.length} en fila` : ''}
                </option>
              )}
            </For>
          </select>
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">Setup u operación (opcional)</span>
          <input class={field} list="setup-labels" placeholder="Setup 1" maxlength={40} value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />
          <datalist id="setup-labels">
            {['Setup 1', 'Setup 2', 'Setup 3', 'Setup 4'].map((s) => (
              <option value={s} />
            ))}
          </datalist>
        </label>
        <Show when={machine()}>
          {(m) => (
            <p class="text-xs text-muted-foreground">
              {m().order && m().status === 'working' ? `Corriendo: ${m().order!.folio} ${m().order!.part}. ` : 'Sin trabajo en producción. '}
              {m().queue.length ? `En fila: ${m().queue.map((e) => e.order.folio).join(', ')}.` : 'Fila vacía.'}
            </p>
          )}
        </Show>
        <div class="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="outline" disabled={!machine() || run.isPending} onClick={toQueue}>
            A la fila
          </Button>
          <Button variant="primary" disabled={!machine() || run.isPending} onClick={toRun}>
            Poner en producción
          </Button>
        </div>
      </div>
    </Modal>
  )
}
