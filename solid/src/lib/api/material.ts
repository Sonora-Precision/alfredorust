import { apiGet, apiPost } from './client'
import type { MaterialReceiptDetail, MaterialReceiptSummary, PartMaterial } from './types'

export const setPartMaterial = (conceptId: string, material: PartMaterial | null) =>
  apiPost<void>(`/api/admin/project_concepts/${conceptId}/material`, material)

export const listMaterialReceipts = () => apiGet<MaterialReceiptSummary[]>('/api/production/material_receipts')
export const getMaterialReceipt = (id: string) =>
  apiGet<MaterialReceiptDetail>(`/api/production/material_receipts/${id}`)
export const createMaterialReceipt = (payload: {
  cfdi_uuid?: string
  supplier?: string
  folio?: string
  lines?: { description: string; quantity?: number; unit?: string }[]
}) => apiPost<{ id: string }>('/api/production/material_receipts', payload)
export const assignReceiptLine = (id: string, line: number, conceptIds: string[]) =>
  apiPost<void>(`/api/production/material_receipts/${id}/lines/${line}/assign`, { concept_ids: conceptIds })
