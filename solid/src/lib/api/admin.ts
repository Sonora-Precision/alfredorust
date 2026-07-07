import { apiGet, apiPost } from './client'
import type {
  CompanyData,
  CompanyPayload,
  ProfileData,
  ProfilePayload,
  UserPayload,
  UserRowData,
} from './types'

// --- companies ----------------------------------------------------------------

export const listCompanies = () => apiGet<CompanyData[]>('/api/admin/companies')
export const getCompany = (id: string) => apiGet<CompanyData>(`/api/admin/companies/${id}`)
export const createCompany = (payload: CompanyPayload) =>
  apiPost<void>('/api/admin/companies', payload)
export const updateCompany = (id: string, payload: CompanyPayload) =>
  apiPost<void>(`/api/admin/companies/${id}/update`, payload)
export const deleteCompany = (id: string) => apiPost<void>(`/api/admin/companies/${id}/delete`)
export const deleteAllCompanyCfdis = (id: string) =>
  apiPost<void>(`/api/admin/companies/${id}/cfdis/delete_all`)
export const deleteAllCompanyTransactions = (id: string) =>
  apiPost<void>(`/api/admin/companies/${id}/transactions/delete_all`)

// --- users --------------------------------------------------------------------

export const listUsers = () => apiGet<UserRowData[]>('/api/admin/users')
export const getUser = (id: string) => apiGet<UserRowData>(`/api/admin/users/${id}`)
export const createUser = (payload: UserPayload) => apiPost<void>('/api/admin/users', payload)
export const updateUser = (id: string, payload: UserPayload) =>
  apiPost<void>(`/api/admin/users/${id}/update`, payload)
export const deleteUser = (id: string) => apiPost<void>(`/api/admin/users/${id}/delete`)

// --- own account profile --------------------------------------------------------

export const getAccountProfile = () => apiGet<ProfileData>('/api/account')
export const updateAccountProfile = (payload: ProfilePayload) =>
  apiPost<void>('/api/account', payload)
