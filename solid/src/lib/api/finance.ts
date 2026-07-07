import { apiGet, apiPost } from './client'
import type {
  Account,
  AccountDetail,
  AccountPayload,
  Category,
  CategoryDetail,
  CategoryPayload,
  Contact,
  ContactDetail,
  ContactPayload,
  Forecast,
  ForecastDetail,
  ForecastPayload,
  PlannedEntry,
  PlannedEntryBulkPayPayload,
  PlannedEntryDetail,
  PlannedEntryPayPayload,
  PlannedEntryPayload,
  RecurringPlan,
  RecurringPlanDetail,
  RecurringPlanPayload,
  Transaction,
  TransactionDetail,
  TransactionPayload,
} from './types'

// --- accounts ---------------------------------------------------------------

export const listAccounts = () => apiGet<Account[]>('/api/admin/accounts')
export const getAccount = (id: string) => apiGet<AccountDetail>(`/api/admin/accounts/${id}`)
export const createAccount = (payload: AccountPayload) =>
  apiPost<void>('/api/admin/accounts', payload)
export const updateAccount = (id: string, payload: AccountPayload) =>
  apiPost<void>(`/api/admin/accounts/${id}/update`, payload)
export const deleteAccount = (id: string) => apiPost<void>(`/api/admin/accounts/${id}/delete`)

// --- categories ---------------------------------------------------------------

export const listCategories = () => apiGet<Category[]>('/api/admin/categories')
export const getCategory = (id: string) => apiGet<CategoryDetail>(`/api/admin/categories/${id}`)
export const createCategory = (payload: CategoryPayload) =>
  apiPost<void>('/api/admin/categories', payload)
export const updateCategory = (id: string, payload: CategoryPayload) =>
  apiPost<void>(`/api/admin/categories/${id}/update`, payload)
export const deleteCategory = (id: string) => apiPost<void>(`/api/admin/categories/${id}/delete`)

// --- contacts -------------------------------------------------------------------
// Quirk (backend-and-api.md §4.6): list row field is `kind`, write payload
// field is `contact_type`. Both already typed distinctly in types.ts; nothing
// extra to paper over here beyond keeping callers on the right type.

export const listContacts = () => apiGet<Contact[]>('/api/admin/contacts')
export const getContact = (id: string) => apiGet<ContactDetail>(`/api/admin/contacts/${id}`)
export const createContact = (payload: ContactPayload) =>
  apiPost<void>('/api/admin/contacts', payload)
export const updateContact = (id: string, payload: ContactPayload) =>
  apiPost<void>(`/api/admin/contacts/${id}/update`, payload)
export const deleteContact = (id: string) => apiPost<void>(`/api/admin/contacts/${id}/delete`)

// --- recurring plans ------------------------------------------------------------

export const listRecurringPlans = () => apiGet<RecurringPlan[]>('/api/admin/recurring-plans')
export const getRecurringPlan = (id: string) =>
  apiGet<RecurringPlanDetail>(`/api/admin/recurring-plans/${id}`)
export const createRecurringPlan = (payload: RecurringPlanPayload) =>
  apiPost<void>('/api/admin/recurring-plans', payload)
export const updateRecurringPlan = (id: string, payload: RecurringPlanPayload) =>
  apiPost<void>(`/api/admin/recurring-plans/${id}/update`, payload)
export const deleteRecurringPlan = (id: string) =>
  apiPost<void>(`/api/admin/recurring-plans/${id}/delete`)
export const generateRecurringPlan = (id: string) =>
  apiPost<void>(`/api/admin/recurring-plans/${id}/generate`)

// --- planned entries ------------------------------------------------------------

export const listPlannedEntries = () => apiGet<PlannedEntry[]>('/api/admin/planned-entries')
export const getPlannedEntry = (id: string) =>
  apiGet<PlannedEntryDetail>(`/api/admin/planned-entries/${id}`)
export const createPlannedEntry = (payload: PlannedEntryPayload) =>
  apiPost<void>('/api/admin/planned-entries', payload)
export const updatePlannedEntry = (id: string, payload: PlannedEntryPayload) =>
  apiPost<void>(`/api/admin/planned-entries/${id}/update`, payload)
export const deletePlannedEntry = (id: string) =>
  apiPost<void>(`/api/admin/planned-entries/${id}/delete`)
export const payPlannedEntry = (id: string, payload: PlannedEntryPayPayload) =>
  apiPost<void>(`/api/admin/planned-entries/${id}/pay`, payload)
export const bulkPayPlannedEntries = (payload: PlannedEntryBulkPayPayload) =>
  apiPost<void>('/api/admin/planned-entries/bulk-pay', payload)

// --- transactions -----------------------------------------------------------------
// Quirk: the list endpoint lives at `/data` (unlike every other domain).

export const listTransactions = () => apiGet<Transaction[]>('/api/admin/transactions/data')
export const getTransaction = (id: string) =>
  apiGet<TransactionDetail>(`/api/admin/transactions/${id}`)
export const createTransaction = (payload: TransactionPayload) =>
  apiPost<void>('/api/admin/transactions', payload)
export const updateTransaction = (id: string, payload: TransactionPayload) =>
  apiPost<void>(`/api/admin/transactions/${id}/update`, payload)
export const deleteTransaction = (id: string) =>
  apiPost<void>(`/api/admin/transactions/${id}/delete`)

// --- forecasts --------------------------------------------------------------------

export const listForecasts = () => apiGet<Forecast[]>('/api/admin/forecasts')
export const getForecast = (id: string) => apiGet<ForecastDetail>(`/api/admin/forecasts/${id}`)
export const createForecast = (payload: ForecastPayload) =>
  apiPost<void>('/api/admin/forecasts', payload)
export const updateForecast = (id: string, payload: ForecastPayload) =>
  apiPost<void>(`/api/admin/forecasts/${id}/update`, payload)
export const deleteForecast = (id: string) => apiPost<void>(`/api/admin/forecasts/${id}/delete`)
