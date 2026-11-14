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

// ---------- Proveedores de maquila (admin only) ----------

export interface SupplierJobRow {
  id: string
  project_id: string
  project_title: string
  concept_id: string
  part: string
  steps: string[]
  whole: boolean
  quantity: number
  received_quantity: number
  unit_cost?: number | null
  unit_price?: number | null
  cost_total?: number | null
  sale_total?: number | null
  status: OutsourceStatus
  due_date?: string | null
  sent_at?: string | null
  received_at?: string | null
  late: boolean
}

export interface SupplierSummary {
  id: string
  name: string
  legal_name: string
  rfc?: string | null
  phone?: string | null
  email?: string | null
  contact_person?: string | null
  outsourcing: boolean
  processes: string[]
  parts: number
  open_jobs: number
  received_jobs: number
  pieces_sent: number
  pieces_received: number
  cost: number
  jobs_without_cost: number
  whole_cost: number
  whole_sale: number
  whole_margin: number
  partial_cost: number
  partial_sale: number
  on_time: number
  late: number
  short: number
  jobs: SupplierJobRow[]
}

export const listOutsourcingSuppliers = () => apiGet<SupplierSummary[]>('/api/admin/outsourcing/suppliers')
