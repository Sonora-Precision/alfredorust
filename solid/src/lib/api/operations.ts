import { apiGet, apiPost } from './client'
import type {
  ConceptStatusFull,
  ConceptStatusPayload,
  GridSavePayload,
  GridView,
  Order,
  OrderDetail,
  OrderPayload,
  Project,
  ProjectConcept,
  ProjectConceptPayload,
  ProjectDetail,
  ProjectPayload,
  ProjectRow,
  Resource,
  ResourceDetail,
  ResourceLog,
  ResourceLogDetail,
  ResourceLogEndPayload,
  ResourceLogPayload,
  ResourcePayload,
} from './types'

// --- service orders --------------------------------------------------------------

export const listOrders = () => apiGet<Order[]>('/api/admin/orders')
export const getOrder = (id: string) => apiGet<OrderDetail>(`/api/admin/orders/${id}`)
export const createOrder = (payload: OrderPayload) => apiPost<void>('/api/admin/orders', payload)
export const updateOrder = (id: string, payload: OrderPayload) =>
  apiPost<void>(`/api/admin/orders/${id}/update`, payload)
export const deleteOrder = (id: string) => apiPost<void>(`/api/admin/orders/${id}/delete`)
export const completeOrder = (id: string) => apiPost<void>(`/api/admin/orders/${id}/complete`)

// --- projects ----------------------------------------------------------------------

/** Full rows; narrow to `Project` (id/title) client-side for option pickers. */
export const listProjects = () => apiGet<ProjectRow[]>('/api/admin/projects')
export const listProjectOptions = async (): Promise<Project[]> =>
  (await listProjects()).map((p) => ({ id: p.id, title: p.title }))
export const getProject = (id: string) => apiGet<ProjectDetail>(`/api/admin/projects/${id}`)
export const createProject = (payload: ProjectPayload) =>
  apiPost<void>('/api/admin/projects', payload)
export const updateProject = (id: string, payload: ProjectPayload) =>
  apiPost<void>(`/api/admin/projects/${id}/update`, payload)
export const deleteProject = (id: string) => apiPost<void>(`/api/admin/projects/${id}/delete`)
export const advanceProject = (id: string) => apiPost<void>(`/api/admin/projects/${id}/advance`)

// --- project concepts + status summary ----------------------------------------------
// Quirk: create is nested under the project (`/projects/{id}/concepts`); update/
// advance/delete live under the flat `/project_concepts/{id}/...` root.

export const listProjectConcepts = (projectId: string) =>
  apiGet<ProjectConcept[]>(`/api/admin/projects/${projectId}/concepts`)
export const createProjectConcept = (projectId: string, payload: ProjectConceptPayload) =>
  apiPost<void>(`/api/admin/projects/${projectId}/concepts`, payload)
export const getProjectStatusSummary = (projectId: string) =>
  apiGet<Record<string, number>>(`/api/admin/projects/${projectId}/status_summary`)
export const updateProjectConcept = (id: string, payload: ProjectConceptPayload) =>
  apiPost<void>(`/api/admin/project_concepts/${id}/update`, payload)
export const advanceProjectConcept = (id: string) =>
  apiPost<void>(`/api/admin/project_concepts/${id}/advance`)
export const deleteProjectConcept = (id: string) =>
  apiPost<void>(`/api/admin/project_concepts/${id}/delete`)

// --- concept statuses ----------------------------------------------------------------

export const listConceptStatuses = () =>
  apiGet<ConceptStatusFull[]>('/api/admin/concept_statuses')
export const createConceptStatus = (payload: ConceptStatusPayload) =>
  apiPost<void>('/api/admin/concept_statuses', payload)
export const updateConceptStatus = (id: string, payload: ConceptStatusPayload) =>
  apiPost<void>(`/api/admin/concept_statuses/${id}/update`, payload)
export const deleteConceptStatus = (id: string) =>
  apiPost<void>(`/api/admin/concept_statuses/${id}/delete`)

// --- resources -------------------------------------------------------------------------

export const listResources = () => apiGet<Resource[]>('/api/admin/resources')
export const getResource = (id: string) => apiGet<ResourceDetail>(`/api/admin/resources/${id}`)
export const createResource = (payload: ResourcePayload) =>
  apiPost<void>('/api/admin/resources', payload)
export const updateResource = (id: string, payload: ResourcePayload) =>
  apiPost<void>(`/api/admin/resources/${id}/update`, payload)
export const deleteResource = (id: string) => apiPost<void>(`/api/admin/resources/${id}/delete`)

// --- resource logs -----------------------------------------------------------------------

export const listResourceLogs = () => apiGet<ResourceLog[]>('/api/admin/resource_logs')
export const getResourceLog = (id: string) =>
  apiGet<ResourceLogDetail>(`/api/admin/resource_logs/${id}`)
export const createResourceLog = (payload: ResourceLogPayload) =>
  apiPost<void>('/api/admin/resource_logs', payload)
export const updateResourceLog = (id: string, payload: ResourceLogPayload) =>
  apiPost<void>(`/api/admin/resource_logs/${id}/update`, payload)
export const deleteResourceLog = (id: string) =>
  apiPost<void>(`/api/admin/resource_logs/${id}/delete`)
export const endResourceLog = (id: string, payload: ResourceLogEndPayload) =>
  apiPost<void>(`/api/admin/resource_logs/${id}/end`, payload)

// --- resource usages: hourly grid -----------------------------------------------------
// Quirk (backend-and-api.md §3.21 / §4.8): the client scrapes the FULL current
// selection state and POSTs it wholesale — not incremental per-checkbox
// toggles. Build the page state with createStore mirroring this "read whole
// grid, save whole grid" contract.

export const getResourceUsageGrid = (date: string, statusId: string) =>
  apiGet<GridView>('/api/admin/resource_usages/grid', { date, status_id: statusId })
export const saveResourceUsageGrid = (payload: GridSavePayload) =>
  apiPost<void>('/api/admin/resource_usages/grid', payload)
