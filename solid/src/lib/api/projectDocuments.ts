import { apiGet, apiPost, apiPostForm } from './client'

export type ProjectDocumentKind = 'orden_compra' | 'cotizacion' | 'otro'

export const DOCUMENT_KINDS: { value: ProjectDocumentKind; label: string }[] = [
  { value: 'orden_compra', label: 'Orden de compra' },
  { value: 'cotizacion', label: 'Cotización' },
  { value: 'otro', label: 'Otro' },
]

/** A PDF kept with a project (purchase order, quote…). Admin only. */
export interface ProjectDocument {
  id: string
  kind: ProjectDocumentKind | string
  filename: string
  size_bytes: number
  uploaded_at: string
  /** Opens the PDF in the browser. */
  url: string
}

export const listProjectDocuments = (projectId: string) =>
  apiGet<ProjectDocument[]>(`/api/admin/projects/${projectId}/documents`)

export const uploadProjectDocument = (projectId: string, kind: ProjectDocumentKind, file: File) => {
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', file)
  return apiPostForm<ProjectDocument>(`/api/admin/projects/${projectId}/documents`, form)
}

export const deleteProjectDocument = (id: string) => apiPost<void>(`/api/admin/project_documents/${id}/delete`)
