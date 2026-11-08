// Avance por setup (Daniel, 2026-11-08): the part's programmer owns it end to end. He counts
// the pieces cut and the pieces through each setup, and marks each setup programmed; a setup
// goes to a machine queue only once programmed (the server enforces it).
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { type JSX, For, Show, createSignal } from 'solid-js'

import { Drawer } from '../ui/Drawer'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { updatePartProgress } from '../../lib/api/operations'
import type { PartProgressPayload, PartStep, ProcessOperation, ProjectConcept } from '../../lib/api/types'

const norm = (s: string) => s.trim().toLowerCase()
/** "Material habilitado" is the saw cut. */
export const isCutOp = (name: string) => norm(name) === 'material habilitado'
export const isSetupOp = (name: string) => norm(name).startsWith('setup')
/** Steps that count pieces: the cut and every setup. */
export const isCountOp = (name: string) => isCutOp(name) || isSetupOp(name)

/** Pieces through a step; a done step without a count is all of them. */
export function stepPieces(concept: ProjectConcept, step: PartStep | undefined): number {
  if (step?.state === 'done') return concept.quantity
  return step?.pieces ?? 0
}

/** The old "Programa" step done means every setup is programmed. */
export const programaDone = (concept: ProjectConcept) =>
  concept.process_steps.some((s) => norm(s.name) === 'programa' && s.state === 'done')

/** "Corte 12/30 · Setup 1 6/30": the active stages of a part, for its cell. */
export function activeCounts(concept: ProjectConcept, ops: ProcessOperation[]): { label: string; pieces: number; programmed: boolean | null }[] {
  return ops
    .filter((op) => isCountOp(op.name))
    .map((op) => ({ op, step: concept.process_steps.find((s) => s.operation_id === op.id) }))
    .filter(({ step }) => step?.state !== 'not_applicable')
    .map(({ op, step }) => ({
      label: isCutOp(op.name) ? 'Corte' : op.name,
      pieces: stepPieces(concept, step),
      programmed: isSetupOp(op.name) ? !!step?.programmed || programaDone(concept) : null,
    }))
}

export function SetupProgress(props: {
  projectId: string
  concept: ProjectConcept
  ops: ProcessOperation[]
  canEdit: boolean
  onClose: () => void
}): JSX.Element {
  const qc = useQueryClient()
  const c = () => props.concept
  const total = () => c().quantity
  const stepOf = (op: ProcessOperation) => c().process_steps.find((s) => s.operation_id === op.id)
  const isProgrammed = (op: ProcessOperation) => !!stepOf(op)?.programmed || programaDone(c())
  const rows = () => props.ops.filter((op) => isCountOp(op.name))

  const save = createMutation(() => ({
    mutationFn: (payload: PartProgressPayload) => updatePartProgress(c().id, payload),
    onSuccess: (updated) => {
      qc.setQueryData<ProjectConcept[]>(['project-concepts', props.projectId], (list) => list?.map((x) => (x.id === updated.id ? updated : x)))
      void qc.invalidateQueries({ queryKey: ['project-concepts', props.projectId] })
      void qc.invalidateQueries({ queryKey: ['traveler'] })
    },
    onError: (err) => toast.error('No se guardó', humanizeError(err, 'Intenta de nuevo')),
  }))

  return (
    <Drawer open onOpenChange={(o) => !o && props.onClose()} title={`Avance · ${c().name}`} subtitle={`${total()} piezas · lo cuenta el programador`}>
      <div class="space-y-3 p-4 text-sm">
        <For each={rows()}>
          {(op) => {
            const step = () => stepOf(op)
            const na = () => step()?.state === 'not_applicable'
            const pieces = () => stepPieces(c(), step())
            const [draft, setDraft] = createSignal<string | null>(null)
            const setPieces = (n: number) => {
              const v = Math.max(0, Math.min(total(), Math.round(n)))
              setDraft(null)
              if (v !== pieces()) save.mutate({ operation_id: op.id, pieces: v })
            }
            const ratio = () => (total() > 0 ? Math.min(1, pieces() / total()) : 0)
            return (
              <div class={`rounded-lg border p-3 ${na() ? 'border-dashed border-border opacity-60' : 'border-border'}`}>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p class="font-medium text-foreground">{isCutOp(op.name) ? 'Corte (sierra)' : op.name}</p>
                    <Show when={step()?.state === 'blocked'}>
                      <p class="text-xs font-medium text-orange-600 dark:text-orange-400">⏸ {step()!.note}</p>
                    </Show>
                  </div>
                  <div class="flex items-center gap-2">
                    <Show when={isSetupOp(op.name) && !na()}>
                      <button
                        type="button"
                        disabled={!props.canEdit || save.isPending || programaDone(c())}
                        class={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                          isProgrammed(op)
                            ? 'border-violet-500 bg-violet-500 text-white'
                            : 'border-border text-muted-foreground hover:bg-muted'
                        }`}
                        title={programaDone(c()) ? 'El paso "Programa" está ✔: todos los setups cuentan como programados' : step()?.programmed_by ? `Programado por ${step()!.programmed_by}` : 'Sin programa: no puede entrar a la fila de máquina'}
                        onClick={() => save.mutate({ operation_id: op.id, programmed: !isProgrammed(op) })}
                      >
                        {isProgrammed(op) ? '✔ Programado' : 'Sin programa'}
                      </button>
                    </Show>
                    <button
                      type="button"
                      disabled={!props.canEdit || save.isPending}
                      class="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                      onClick={() => save.mutate({ operation_id: op.id, state: na() ? 'pending' : 'not_applicable' })}
                    >
                      {na() ? 'Sí aplica' : 'No aplica'}
                    </button>
                  </div>
                </div>
                <Show when={!na()}>
                  <div class="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      class="h-9 w-9 rounded-lg border border-border text-lg leading-none hover:bg-muted disabled:opacity-40"
                      disabled={!props.canEdit || save.isPending || pieces() <= 0}
                      aria-label={`Una pieza menos en ${op.name}`}
                      onClick={() => setPieces(pieces() - 1)}
                    >
                      −
                    </button>
                    <input
                      class="tnum h-9 w-16 rounded-lg border border-border bg-background text-center text-base font-semibold text-foreground"
                      inputmode="numeric"
                      disabled={!props.canEdit}
                      aria-label={`Piezas en ${op.name}`}
                      value={draft() ?? String(pieces())}
                      onInput={(e) => setDraft(e.currentTarget.value)}
                      onBlur={() => {
                        const d = draft()
                        if (d == null) return
                        const n = Number(d)
                        if (d.trim() === '' || !Number.isFinite(n)) setDraft(null)
                        else setPieces(n)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    />
                    <span class="tnum text-muted-foreground">/ {total()}</span>
                    <button
                      type="button"
                      class="h-9 w-9 rounded-lg border border-border text-lg leading-none hover:bg-muted disabled:opacity-40"
                      disabled={!props.canEdit || save.isPending || pieces() >= total()}
                      aria-label={`Una pieza más en ${op.name}`}
                      onClick={() => setPieces(pieces() + 1)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      class="ml-auto rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
                      disabled={!props.canEdit || save.isPending || pieces() >= total()}
                      onClick={() => setPieces(total())}
                    >
                      Todas
                    </button>
                  </div>
                  <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div class={`h-full rounded-full ${ratio() >= 1 ? 'bg-emerald-500' : 'bg-sky-500'}`} style={{ width: `${ratio() * 100}%` }} />
                  </div>
                </Show>
              </div>
            )
          }}
        </For>
        <Show when={!rows().length}>
          <p class="text-muted-foreground">El catálogo de pasos no tiene "Material habilitado" ni setups.</p>
        </Show>
        <p class="text-xs text-muted-foreground">
          Un setup entra a la fila de una máquina solo si está programado. Las piezas cuentan como terminadas cuando calidad las
          libera.
        </p>
      </div>
    </Drawer>
  )
}
