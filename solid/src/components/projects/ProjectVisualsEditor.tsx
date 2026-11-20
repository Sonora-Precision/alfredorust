// Admin: change or remove the project's preview image and assembly drawing (Daniel,
// 2026-11-19). A new upload replaces the previous one.
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import { Trash2, Upload } from 'lucide-solid'
import { type JSX, Show } from 'solid-js'

import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import { type VisualKind, deleteProjectDocument, uploadProjectDocument } from '../../lib/api/projectDocuments'

const RULES: Record<VisualKind, { label: string; hint: string; accept: string; max: number; ok: (f: File) => boolean }> = {
  vista_previa: {
    label: 'Vista previa',
    hint: 'PNG o JPG, máx. 5 MB',
    accept: 'image/png,image/jpeg',
    max: 5 * 1024 * 1024,
    ok: (f) => /\.(png|jpe?g)$/i.test(f.name) || f.type === 'image/png' || f.type === 'image/jpeg',
  },
  plano_ensamble: {
    label: 'Plano del ensamble',
    hint: 'PDF, máx. 40 MB',
    accept: 'application/pdf,.pdf',
    max: 40 * 1024 * 1024,
    ok: (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
  },
}

/** The document id at the end of `/api/admin/project_documents/{id}`. */
const idOf = (url: string) => url.split('/').pop() ?? ''

export function ProjectVisualsEditor(props: {
  projectId: string
  previewUrl?: string | null
  assemblyUrl?: string | null
}): JSX.Element {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['project', props.projectId] })
    void qc.invalidateQueries({ queryKey: ['projects'] })
    void qc.invalidateQueries({ queryKey: ['project-documents'] })
  }
  const upload = createMutation(() => ({
    mutationFn: (v: { kind: VisualKind; file: File }) => uploadProjectDocument(props.projectId, v.kind, v.file),
    onSuccess: (_d, v) => {
      toast.success(`${RULES[v.kind].label} guardada`, v.file.name)
      refresh()
    },
    onError: (err) => toast.error('No se pudo subir el archivo', humanizeError(err, 'Intenta de nuevo')),
  }))
  const remove = createMutation(() => ({
    mutationFn: (url: string) => deleteProjectDocument(idOf(url)),
    onSuccess: refresh,
    onError: (err) => toast.error('No se pudo quitar', humanizeError(err, 'Intenta de nuevo')),
  }))

  const Row = (p: { kind: VisualKind; url: string | null | undefined }) => {
    const rule = RULES[p.kind]
    let input: HTMLInputElement | undefined
    const pick = (file: File | undefined) => {
      if (!file) return
      if (!rule.ok(file)) return toast.error(`${rule.label}: formato no válido`, rule.hint)
      if (file.size > rule.max) return toast.error(`${rule.label}: archivo muy grande`, rule.hint)
      upload.mutate({ kind: p.kind, file })
    }
    return (
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="w-36 font-medium text-foreground">{rule.label}</span>
        <Show when={p.url} fallback={<span class="text-xs text-muted-foreground">Sin archivo · {rule.hint}</span>}>
          <a href={p.url!} target="_blank" rel="noopener" class="text-xs text-sky-500 hover:underline">
            Ver
          </a>
        </Show>
        <input
          ref={input}
          type="file"
          accept={rule.accept}
          class="hidden"
          onChange={(e) => {
            pick(e.currentTarget.files?.[0])
            e.currentTarget.value = ''
          }}
        />
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          disabled={upload.isPending}
          onClick={() => input?.click()}
        >
          <Upload class="h-3.5 w-3.5" />
          {p.url ? 'Cambiar' : 'Subir'}
        </button>
        <Show when={p.url}>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
            disabled={remove.isPending}
            onClick={() => window.confirm(`¿Quitar ${rule.label.toLowerCase()} del proyecto?`) && remove.mutate(p.url!)}
          >
            <Trash2 class="h-3.5 w-3.5" />
            Quitar
          </button>
        </Show>
      </div>
    )
  }

  return (
    <section class="rounded-lg border border-border p-3">
      <h2 class="text-sm font-semibold text-foreground">Vista del ensamble</h2>
      <p class="text-xs text-muted-foreground">
        Se muestra junto al título en la lista de proyectos; al pasar el mouse se abre el plano.
      </p>
      <div class="mt-2 space-y-1.5">
        <Row kind="vista_previa" url={props.previewUrl} />
        <Row kind="plano_ensamble" url={props.assemblyUrl} />
      </div>
    </section>
  )
}
