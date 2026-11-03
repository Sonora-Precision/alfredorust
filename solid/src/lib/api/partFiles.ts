import { apiGet, apiPost, apiPostForm } from './client'

/** A file attached to a part number; today only the PDF drawing. */
export interface PartFile {
  id: string
  concept_id: string
  kind: 'drawing' | string
  filename: string
  size_bytes: number
  uploaded_at: string
  /** Opens the PDF in the browser. */
  url: string
}

export const listProjectPartFiles = (projectId: string) =>
  apiGet<PartFile[]>(`/api/admin/projects/${projectId}/part_files`)

/** Newest drawing of every part of the company (board, plant view, quality). */
export const listCompanyPartDrawings = () => apiGet<PartFile[]>('/api/production/part_drawings')

export const uploadPartDrawing = (conceptId: string, file: File) => {
  const form = new FormData()
  form.append('file', file)
  return apiPostForm<PartFile>(`/api/admin/project_concepts/${conceptId}/drawing`, form)
}

export const deletePartFile = (id: string) => apiPost<void>(`/api/admin/part_files/${id}/delete`)
