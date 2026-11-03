// The PDF drawing of a part number: a link everyone who sees the project can open, and for
// the admin, upload / replace / remove (Daniel, 2026-11-03).
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { FileText, Trash2, Upload } from 'lucide-solid'
import { type JSX, Show, createSignal, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'

import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { type PartFile, deletePartFile, uploadPartDrawing } from '../../lib/api/partFiles'

const MAX_BYTES = 40 * 1024 * 1024
const PREVIEW_W = 560
const PREVIEW_H = 420

export function PartDrawing(props: {
  projectId: string
  conceptId: string
  partName: string
  /** Newest drawing of the part, if any. */
  file: PartFile | undefined
  canUpload: boolean
}): JSX.Element {
  const qc = useQueryClient()
  let input: HTMLInputElement | undefined
  const refresh = () => void qc.invalidateQueries({ queryKey: ['part-files', props.projectId] })

  const upload = createMutation(() => ({
    mutationFn: (file: File) => uploadPartDrawing(props.conceptId, file),
    onSuccess: () => {
      toast.success('Plano guardado', props.partName)
      refresh()
    },
    onError: (err) => toast.error('No se pudo subir el plano', humanizeError(err, 'Intenta de nuevo')),
  }))
  const remove = createMutation(() => ({
    mutationFn: (id: string) => deletePartFile(id),
    onSuccess: refresh,
    onError: (err) => toast.error('No se pudo quitar el plano', humanizeError(err, 'Intenta de nuevo')),
  }))

  const pick = (file: File | undefined) => {
    if (!file) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('El plano debe ser PDF', file.name)
      return
    }
    if (file.size > MAX_BYTES) {
      toast.error('El plano es muy grande', 'Máximo 40 MB')
      return
    }
    upload.mutate(file)
  }

  // Hover preview: after a short pause the PDF opens in a floating panel beside the link,
  // so moving the mouse across the table does not load every drawing.
  const [preview, setPreview] = createSignal<{ top: number; left: number } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const showPreview = (el: HTMLElement) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const r = el.getBoundingClientRect()
      const room = window.innerWidth - r.right
      const left = room > PREVIEW_W + 16 ? r.right + 8 : Math.max(8, r.left - PREVIEW_W - 8)
      const top = Math.min(Math.max(8, r.top - PREVIEW_H / 2), window.innerHeight - PREVIEW_H - 8)
      setPreview({ top, left })
    }, 300)
  }
  const hidePreview = () => {
    clearTimeout(timer)
    setPreview(null)
  }
  onCleanup(() => clearTimeout(timer))

  return (
    <div class="mt-0.5 flex items-center gap-2 text-xs">
      <Show when={preview() && props.file}>
        <Portal>
          <div
            class="pointer-events-none fixed z-50 overflow-hidden rounded-lg border border-border bg-white shadow-2xl"
            style={{
              top: `${preview()!.top}px`,
              left: `${preview()!.left}px`,
              width: `${PREVIEW_W}px`,
              height: `${PREVIEW_H}px`,
            }}
          >
            <iframe
              src={`${props.file!.url}#toolbar=0&navpanes=0&view=Fit`}
              title={`Vista previa de ${props.partName}`}
              class="h-full w-full"
            />
          </div>
        </Portal>
      </Show>
      <Show
        when={props.file}
        fallback={<Show when={!props.canUpload}><span class="text-muted-foreground">Sin plano</span></Show>}
      >
        {(f) => (
          <a
            href={f().url}
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-1 font-medium text-sky-600 hover:underline"
            title={f().filename}
            onMouseEnter={(e) => showPreview(e.currentTarget)}
            onMouseLeave={hidePreview}
          >
            <FileText class="h-3.5 w-3.5" />
            Plano
          </a>
        )}
      </Show>
      <Show when={props.canUpload}>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          class="hidden"
          aria-label={`Subir plano de ${props.partName}`}
          onChange={(e) => {
            pick(e.currentTarget.files?.[0])
            e.currentTarget.value = ''
          }}
        />
        <button
          type="button"
          class="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={upload.isPending}
          onClick={() => input?.click()}
        >
          <Upload class="h-3.5 w-3.5" />
          {upload.isPending ? 'Subiendo…' : props.file ? 'Reemplazar' : 'Subir plano'}
        </button>
        <Show when={props.file}>
          {(f) => (
            <button
              type="button"
              class="text-muted-foreground hover:text-rose-500 disabled:opacity-50"
              disabled={remove.isPending}
              aria-label={`Quitar plano de ${props.partName}`}
              title="Quitar plano"
              onClick={() => {
                if (window.confirm(`¿Quitar el plano de ${props.partName}?`)) remove.mutate(f().id)
              }}
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          )}
        </Show>
      </Show>
    </div>
  )
}
