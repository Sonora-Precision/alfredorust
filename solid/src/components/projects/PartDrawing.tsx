// The PDF drawing of a part number: a link everyone who sees the project can open, and for
// the admin, upload / replace / remove (Daniel, 2026-11-03).
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { FileText, Trash2, Upload } from 'lucide-solid'
import { type JSX, Show } from 'solid-js'

import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { type PartFile, deletePartFile, uploadPartDrawing } from '../../lib/api/partFiles'

const MAX_BYTES = 40 * 1024 * 1024

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

  return (
    <div class="mt-0.5 flex items-center gap-2 text-xs">
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
