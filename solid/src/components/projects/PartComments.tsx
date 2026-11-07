// Comments on a part number (Daniel, 2026-11-06): scrap with how many pieces and why, notes
// to learn from (they come back when the same part number shows up in another project) and
// plain comments. Everyone who sees the project reads and writes; authors delete their own.
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { MessageSquare, Trash2 } from 'lucide-solid'
import { type JSX, For, Show, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Drawer } from '../ui/Drawer'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { createPartComment, deletePartComment } from '../../lib/api/notes'
import type { PartComment, PartCommentKind } from '../../lib/api/types'
import { useAuth } from '../../lib/auth/AuthContext'

export const COMMENT_KINDS: Record<PartCommentKind, { label: string; class: string }> = {
  comentario: { label: 'Comentario', class: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  scrap: { label: 'Scrap', class: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
  nota: { label: 'Nota para aprender', class: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
}

const fecha = (iso: string) =>
  new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })

export function PartComments(props: {
  projectId: string
  conceptId: string
  partName: string
  comments: PartComment[]
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const scrap = () => props.comments.filter((c) => c.kind === 'scrap').reduce((s, c) => s + (c.quantity ?? 0), 0)
  const notes = () => props.comments.filter((c) => c.kind === 'nota').length
  return (
    <>
      <button
        type="button"
        class="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <MessageSquare class="h-3.5 w-3.5" />
        <Show when={props.comments.length} fallback="Comentar">
          {props.comments.length} {props.comments.length === 1 ? 'comentario' : 'comentarios'}
        </Show>
        <Show when={scrap() > 0}>
          <span class="rounded bg-rose-500/15 px-1 text-[11px] font-medium text-rose-700 dark:text-rose-300">scrap {scrap()}</span>
        </Show>
        <Show when={notes() > 0}>
          <span class="rounded bg-violet-500/15 px-1 text-[11px] font-medium text-violet-700 dark:text-violet-300">
            {notes()} {notes() === 1 ? 'nota' : 'notas'}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <CommentsDrawer {...props} onClose={() => setOpen(false)} />
      </Show>
    </>
  )
}

function CommentsDrawer(props: {
  projectId: string
  conceptId: string
  partName: string
  comments: PartComment[]
  onClose: () => void
}): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()
  const [kind, setKind] = createSignal<PartCommentKind>('comentario')
  const [text, setText] = createSignal('')
  const [qty, setQty] = createSignal('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['part-comments', props.projectId] })

  const add = createMutation(() => ({
    mutationFn: () =>
      createPartComment(props.conceptId, {
        kind: kind(),
        text: text().trim(),
        quantity: kind() === 'scrap' ? Number(qty().replace(',', '.')) : null,
      }),
    onSuccess: () => {
      toast.success('Guardado', props.partName)
      setText('')
      setQty('')
      refresh()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa el comentario')),
  }))
  const remove = createMutation(() => ({
    mutationFn: (id: string) => deletePartComment(id),
    onSuccess: refresh,
    onError: (err) => toast.error('No se pudo borrar', humanizeError(err, '')),
  }))

  const field = 'w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground'
  return (
    <Drawer open onOpenChange={(o) => !o && props.onClose()} title={`Comentarios · ${props.partName}`} subtitle="Scrap, notas para aprender y comentarios">
      <div class="space-y-4 p-4 text-sm">
        <form
          class="space-y-2 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!text().trim()) return
            add.mutate()
          }}
        >
          <div class="flex flex-wrap gap-1">
            <For each={Object.entries(COMMENT_KINDS) as [PartCommentKind, { label: string; class: string }][]}>
              {([k, v]) => (
                <button
                  type="button"
                  class={`rounded-full border px-3 py-1 text-xs ${kind() === k ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}
                  onClick={() => setKind(k)}
                >
                  {v.label}
                </button>
              )}
            </For>
          </div>
          <Show when={kind() === 'scrap'}>
            <label class="block space-y-1">
              <span class="text-xs text-muted-foreground">Piezas de scrap</span>
              <input class={`${field} h-9`} inputmode="decimal" placeholder="Cuántas" value={qty()} onInput={(e) => setQty(e.currentTarget.value)} />
            </label>
          </Show>
          <label class="block space-y-1">
            <span class="text-xs text-muted-foreground">
              {kind() === 'scrap' ? '¿Por qué se generó?' : kind() === 'nota' ? 'Qué hay que tomar en cuenta la próxima vez' : 'Comentario'}
            </span>
            <textarea class={`${field} h-20 py-1`} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
          </label>
          <Show when={kind() === 'nota'}>
            <p class="text-[11px] text-muted-foreground">Las notas aparecen otra vez cuando este número de parte llegue en otro proyecto.</p>
          </Show>
          <div class="flex justify-end">
            <Button type="submit" disabled={add.isPending || !text().trim() || (kind() === 'scrap' && !(Number(qty().replace(',', '.')) > 0))}>
              {add.isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>

        <Show when={props.comments.length} fallback={<p class="text-muted-foreground">Todavía no hay comentarios.</p>}>
          <ul class="space-y-2">
            <For each={props.comments}>
              {(c) => (
                <li class="rounded-lg border border-border p-3">
                  <div class="flex flex-wrap items-center gap-2 text-xs">
                    <span class={`rounded px-1.5 py-px font-medium ${COMMENT_KINDS[c.kind].class}`}>
                      {COMMENT_KINDS[c.kind].label}
                      <Show when={c.kind === 'scrap' && c.quantity}> · {c.quantity} pzs</Show>
                    </span>
                    <span class="text-muted-foreground">
                      {c.author} · {fecha(c.created_at)}
                    </span>
                    <Show when={c.other_project}>
                      <span class="text-muted-foreground">· de {c.other_project}</span>
                    </Show>
                    <Show when={!c.other_project && (auth.isAdmin() || c.author_id === auth.userId())}>
                      <button
                        type="button"
                        class="ml-auto text-muted-foreground hover:text-destructive"
                        aria-label="Borrar comentario"
                        onClick={() => window.confirm('¿Borrar este comentario?') && remove.mutate(c.id)}
                      >
                        <Trash2 class="h-3.5 w-3.5" />
                      </button>
                    </Show>
                  </div>
                  <p class="mt-1 whitespace-pre-wrap text-foreground">{c.text}</p>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Drawer>
  )
}
