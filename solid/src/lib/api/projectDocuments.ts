import { apiGet, apiPost, apiPostForm } from './client'

export type ProjectDocumentKind = 'orden_compra' | 'cotizacion' | 'otro'

export const DOCUMENT_KINDS: { value: ProjectDocumentKind; label: string }[] = [
  { value: 'orden_compra', label: 'Orden de compra' },
  { value: 'cotizacion', label: 'Cotización' },
  { value: 'otro', label: 'Otro' },
]

/** A PDF kept with a project (purchase order, quote…). Admin only. */
export interface ProjectDocument {
  project_id: string
  id: string
  kind: ProjectDocumentKind | string
  filename: string
  size_bytes: number
  uploaded_at: string
  /** Opens the PDF in the browser. */
  url: string
  /** Set when this is the quote the project was made from (not an uploaded file): the link
   * opens the quote document, which prints its PDF, and it cannot be removed. */
  quote_id?: string
}

export const listProjectDocuments = (projectId: string) =>
  apiGet<ProjectDocument[]>(`/api/admin/projects/${projectId}/documents`)

/** Every document of the company (projects list). */
export const listCompanyProjectDocuments = () => apiGet<ProjectDocument[]>('/api/admin/project_documents')

export const uploadProjectDocument = (projectId: string, kind: ProjectDocumentKind, file: File) => {
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', file)
  return apiPostForm<ProjectDocument>(`/api/admin/projects/${projectId}/documents`, form)
}

export const deleteProjectDocument = (id: string) => apiPost<void>(`/api/admin/project_documents/${id}/delete`)
