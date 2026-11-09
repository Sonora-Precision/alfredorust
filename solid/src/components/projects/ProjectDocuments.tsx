// Documents of a project (Daniel, 2026-11-09): the customer's purchase order, our quote and
// any other PDF, kept with the project. Admin only: they carry prices.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { FileText, Trash2, Upload } from 'lucide-solid'
import { type JSX, For, Show, createSignal } from 'solid-js'

import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import {
  DOCUMENT_KINDS,
  type ProjectDocumentKind,
  deleteProjectDocument,
  listProjectDocuments,
  uploadProjectDocument,
} from '../../lib/api/projectDocuments'

const MAX_BYTES = 40 * 1024 * 1024
const kindLabel = (k: string) => DOCUMENT_KINDS.find((d) => d.value === k)?.label ?? 'Otro'
const kindClass = (k: string) =>
  k === 'orden_compra'
    ? 'bg-emerald-500/15 text-emerald-500'
    : k === 'cotizacion'
      ? 'bg-sky-500/15 text-sky-500'
      : 'bg-muted text-muted-foreground'
const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

export function ProjectDocuments(props: { projectId: string }): JSX.Element {
  const qc = useQueryClient()
  const key = () => ['project-documents', props.projectId]
  const docs = createQuery(() => ({ queryKey: key(), queryFn: () => listProjectDocuments(props.projectId) }))
  const [kind, setKind] = createSignal<ProjectDocumentKind>('orden_compra')
  let input: HTMLInputElement | undefined

  const upload = createMutation(() => ({
    mutationFn: (file: File) => uploadProjectDocument(props.projectId, kind(), file),
    onSuccess: (d) => {
      toast.success('Documento guardado', d.filename)
      void qc.invalidateQueries({ queryKey: key() })
    },
    onError: (err) => toast.error('No se pudo subir el documento', humanizeError(err, 'Intenta de nuevo')),
  }))
  const remove = createMutation(() => ({
    mutationFn: (id: string) => deleteProjectDocument(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key() }),
    onError: (err) => toast.error('No se pudo quitar el documento', humanizeError(err, 'Intenta de nuevo')),
  }))

  const pick = (file: File | undefined) => {
    if (!file) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('El documento debe ser PDF', file.name)
      return
    }
    if (file.size > MAX_BYTES) {
      toast.error('El documento es muy grande', 'Máximo 40 MB')
      return
    }
    upload.mutate(file)
  }

  return (
    <div class="rounded-lg border border-border px-3 py-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileText class="h-4 w-4" /> Documentos
        </p>
        <div class="flex items-center gap-2">
          <select
            class="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            aria-label="Tipo de documento"
            value={kind()}
            onChange={(e) => setKind(e.currentTarget.value as ProjectDocumentKind)}
          >
            <For each={DOCUMENT_KINDS}>{(k) => <option value={k.value}>{k.label}</option>}</For>
          </select>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            class="hidden"
            aria-label="Subir documento"
            onChange={(e) => {
              pick(e.currentTarget.files?.[0])
              e.currentTarget.value = ''
            }}
          />
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted disabled:opacity-50"
            disabled={upload.isPending}
            onClick={() => input?.click()}
          >
            <Upload class="h-3.5 w-3.5" />
            {upload.isPending ? 'Subiendo…' : 'Subir PDF'}
          </button>
        </div>
      </div>
      <Show
        when={(docs.data ?? []).length}
        fallback={
          <p class="mt-1 text-xs text-muted-foreground">
            {docs.isLoading ? 'Cargando…' : 'Sin documentos. Sube aquí la orden de compra o la cotización.'}
          </p>
        }
      >
        <ul class="mt-2 divide-y divide-border">
          <For each={docs.data}>
            {(d) => (
              <li class="flex items-center gap-2 py-1.5 text-sm">
                <span class={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${kindClass(d.kind)}`}>{kindLabel(d.kind)}</span>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener"
                  class="min-w-0 flex-1 truncate font-medium text-sky-600 hover:underline"
                  title={d.filename}
                >
                  {d.filename}
                </a>
                <span class="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {fecha(d.uploaded_at)} · {size(d.size_bytes)}
                </span>
                <button
                  type="button"
                  class="shrink-0 text-muted-foreground hover:text-rose-500 disabled:opacity-50"
                  disabled={remove.isPending}
                  aria-label={`Quitar ${d.filename}`}
                  title="Quitar documento"
                  onClick={() => {
                    if (window.confirm(`¿Quitar ${d.filename} del proyecto?`)) remove.mutate(d.id)
                  }}
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
