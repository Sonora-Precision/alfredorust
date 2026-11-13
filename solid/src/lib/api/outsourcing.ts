// Maquila: pieces of a part sent to a supplier, whole or for some steps.
import { apiGet, apiPost } from './client'

export type OutsourceStatus = 'planned' | 'sent' | 'received' | 'cancelled'

export interface OutsourceJob {
  id: string
  project_id: string
  concept_id: string
  /** Only with "Ver proveedor de maquila" (the admin always). */
  supplier_id?: string | null
  supplier_name?: string | null
  /** Steps the supplier does; empty means the whole part. */
  operation_ids: string[]
  quantity: number
  /** What we pay per piece; admins only. */
  unit_cost?: number | null
  material_by_us: boolean
  due_date?: string | null
  status: OutsourceStatus
  sent_at?: string | null
  received_quantity: number
  received_at?: string | null
  late: boolean
  notes?: string | null
}

export interface OutsourceJobPayload {
  concept_id?: string
  supplier_id: string
  operation_ids: string[]
  quantity: number
  unit_cost: number | null
  material_by_us: boolean
  /** YYYY-MM-DD */
  due_date: string | null
  status: OutsourceStatus
  received_quantity: number
  notes: string | null
}

export const STATUS_LABEL: Record<OutsourceStatus, string> = {
  planned: 'Por enviar',
  sent: 'Con el proveedor',
  received: 'Recibida',
  cancelled: 'Cancelada',
}

export const listProjectOutsourcing = (projectId: string) =>
  apiGet<OutsourceJob[]>('/api/admin/outsourcing', { project_id: projectId })
export const createOutsourcing = (payload: OutsourceJobPayload) =>
  apiPost<{ id: string }>('/api/admin/outsourcing', payload)
export const updateOutsourcing = (id: string, payload: OutsourceJobPayload) =>
  apiPost<void>(`/api/admin/outsourcing/${id}/update`, payload)
export const deleteOutsourcing = (id: string) => apiPost<void>(`/api/admin/outsourcing/${id}/delete`)
