import { apiGet, apiPost, apiPostBlob, apiPostForm } from './client'
import type {
  Cfdi,
  CfdiArchivedCount,
  CfdiCronStatus,
  CfdiDetailResponse,
  CfdiDownloadPayload,
  CfdiEstatusResponse,
  CfdiJob,
  CfdiJobStatus,
  CfdiList,
  BulkCfdiTransactionsPayload,
  BulkCfdiTransactionsResponse,
  SatConfigData,
  SatConfigPayload,
  StartedJobs,
} from './types'

// --- CFDI download jobs (per company) ----------------------------------------------
// Quirk: async job pattern — start a download, then poll `.../cfdi/jobs` (list)
// or `.../cfdi/jobs/{id}` (single) until every job's status is done/failed.
// Callers (e.g. a createQuery with refetchInterval) own the poll loop + cleanup.

export const startCfdiDownload = (companyId: string, payload: CfdiDownloadPayload) =>
  apiPost<StartedJobs>(`/api/admin/companies/${companyId}/cfdi/download`, payload)

export const listCfdiJobs = (companyId: string) =>
  apiGet<CfdiJob[]>(`/api/admin/companies/${companyId}/cfdi/jobs`)

export const getCfdiJob = (companyId: string, jobId: string) =>
  apiGet<CfdiJobStatus>(`/api/admin/companies/${companyId}/cfdi/jobs/${jobId}`)

// Cron status for the "Actualización automática" card, and the archived-XML
// count for the "Respaldo XML activo" indicator (both company-scoped, admin).
export const getCfdiCron = (companyId: string) =>
  apiGet<CfdiCronStatus>(`/api/admin/companies/${companyId}/cfdi/cron`)

export const getCfdiArchivedCount = (companyId: string) =>
  apiGet<CfdiArchivedCount>(`/api/admin/companies/${companyId}/cfdis/archived`)

// Live SAT status check for one CFDI (vigente/cancelado); persists the result.
export const checkCfdiStatus = (uuid: string) =>
  apiPost<CfdiEstatusResponse>(`/api/admin/cfdis/${uuid}/check-status`)

// --- CFDIs (read-only listing) -------------------------------------------------------

export const listCfdis = () => apiGet<CfdiList>('/api/admin/cfdis/data')
export const getCfdi = (uuid: string) => apiGet<CfdiDetailResponse>(`/api/admin/cfdis/${uuid}`)
export const syncCfdiTransactions = (payload: BulkCfdiTransactionsPayload) =>
  apiPost<BulkCfdiTransactionsResponse>('/api/admin/cfdis/transactions/bulk', payload)
export const downloadCfdiArchive = (uuids: string[]) =>
  apiPostBlob('/api/admin/cfdis/archive', { uuids })

// --- Manual CFDI upload (per company) ------------------------------------------------
// Drop `.xml` CFDIs or a `.zip` of XMLs; each is upserted by UUID into the same
// DB + on-disk store the SAT download uses, so re-uploading a UUID just updates it.

export interface CfdiUploadResult {
  files: number
  imported: number
  failed: number
  errors: string[]
}

export function uploadCfdis(companyId: string, files: File[]): Promise<CfdiUploadResult> {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  return apiPostForm<CfdiUploadResult>(`/api/admin/companies/${companyId}/cfdis/upload`, form)
}

// --- SAT fiscal configs ---------------------------------------------------------------

export const listSatConfigs = () => apiGet<SatConfigData[]>('/api/admin/sat-configs')
export const getSatConfig = (id: string) => apiGet<SatConfigData>(`/api/admin/sat-configs/${id}`)
export const createSatConfig = (payload: SatConfigPayload) =>
  apiPost<void>('/api/admin/sat-configs', payload)
export const updateSatConfig = (id: string, payload: SatConfigPayload) =>
  apiPost<void>(`/api/admin/sat-configs/${id}/update`, payload)
export const deleteSatConfig = (id: string) =>
  apiPost<void>(`/api/admin/sat-configs/${id}/delete`)

/**
 * Upload a new SAT config via multipart. Part names must match the backend:
 * `rfc`, `label`, `key_password`, `cer_file`, `key_file`.
 */
export function uploadSatConfig(
  rfc: string,
  label: string,
  keyPassword: string,
  cerFile: File,
  keyFile: File,
): Promise<void> {
  const form = new FormData()
  form.set('rfc', rfc)
  form.set('label', label)
  form.set('key_password', keyPassword)
  form.set('cer_file', cerFile)
  form.set('key_file', keyFile)
  return apiPostForm<void>('/api/admin/sat-configs/upload', form)
}

// Re-exported for convenience so pages don't need to import from ../types too.
export type { BulkCfdiTransactionsResponse, Cfdi }
