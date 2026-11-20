// Registro de facturas (cuentas por cobrar), Daniel 2026-11-19. Admin only: it is money.
import { apiGet, apiPost, apiPostForm } from './client'

export type InvoiceState = 'pendiente' | 'parcial' | 'pagada' | 'cancelada' | 'sustituida'

export const STATE_LABEL: Record<InvoiceState, string> = {
  pendiente: 'Pendiente',
  parcial: 'Parcial',
  pagada: 'Pagada',
  cancelada: 'Cancelada',
  sustituida: 'Sustituida',
}

export interface InvoiceRow {
  id: string
  uuid: string
  serie: string
  folio: string
  issued_at: string
  due_on: string | null
  customer_name: string
  customer_rfc: string
  currency: string
  subtotal: number
  tax: number
  withholding: number
  /** What the customer owes: subtotal + VAT − withholdings. */
  total: number
  paid: number
  balance: number
  /** Share still owed: 100 = nothing paid, 0 = settled. */
  pending_pct: number
  state: InvoiceState
  payment_method: string
  days_open: number
  overdue: boolean
  payments_count: number
  files_count: number
  /** Money received that has no REP yet. */
  missing_rep: boolean
  purchase_order: string | null
  /** Projects this invoice bills (one PO can span several). */
  project_ids: string[]
  notes: string | null
}

export interface InvoicePayment {
  id: string
  paid_on: string
  amount: number
  currency: string
  exchange_rate: number
  /** Off the invoice, in the invoice currency. */
  applied: number
  source: 'rep' | 'nota_credito' | 'manual' | string
  cfdi_uuid: string | null
  installment: number | null
  balance_after: number | null
  note: string | null
}

export interface InvoiceFile {
  id: string
  kind: string
  filename: string
  size_bytes: number
  uploaded_at: string
  cfdi_uuid: string | null
  url: string
}

export interface InvoiceDetail extends InvoiceRow {
  lines: { description: string; quantity: number; unit_value: number; amount: number }[]
  payments: InvoicePayment[]
  files: InvoiceFile[]
  replaced_by: string | null
}

export interface InvoiceList {
  total: number
  items: InvoiceRow[]
}

export interface InvoiceSummary {
  totals: { currency: string; billed: number; paid: number; balance: number; invoices: number; open_invoices: number }[]
  by_month: { month: string; currency: string; billed: number; collected: number; invoices: number }[]
  aging: { bucket: '0-30' | '31-60' | '61-90' | '90+'; currency: string; balance: number; invoices: number }[]
  by_customer: {
    customer_name: string
    currency: string
    billed: number
    paid: number
    balance: number
    open_invoices: number
  }[]
  missing_rep: number
}

export interface ImportReport {
  invoices_new: number
  invoices_updated: number
  payments_new: number
  payments_updated: number
  credit_notes: number
  pdfs: number
  ignored: number
  warnings: string[]
}

export interface InvoiceFilters {
  q?: string
  state?: string
  currency?: string
  from?: string
  to?: string
}

export const FILE_KIND_LABEL: Record<string, string> = {
  factura_xml: 'Factura XML',
  factura_pdf: 'Factura PDF',
  rep_xml: 'REP XML',
  rep_pdf: 'REP PDF',
  nc_xml: 'Nota de crédito XML',
  nc_pdf: 'Nota de crédito PDF',
  otro: 'Otro',
}

export const listInvoices = (filters: InvoiceFilters = {}) => {
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries(filters)) if (v) params[k] = v
  return apiGet<InvoiceList>('/api/admin/invoices', params)
}

export const invoiceSummary = () => apiGet<InvoiceSummary>('/api/admin/invoices/summary')

export const getInvoice = (id: string) => apiGet<InvoiceDetail>(`/api/admin/invoices/${id}`)

/** Loads XML, PDF or ZIP files: invoices, REPs, credit notes and PDFs named after their UUID. */
export const importInvoiceFiles = (files: File[]) => {
  const form = new FormData()
  for (const f of files) form.append('files', f, f.name)
  return apiPostForm<ImportReport>('/api/admin/invoices/import', form)
}

/** Loads what the SAT download already archived on the server. */
export const syncInvoicesFromSat = () => apiPost<ImportReport>('/api/admin/invoices/sync_sat')

export interface PaymentInput {
  /** YYYY-MM-DD */
  paid_on: string
  amount: number
  currency?: string
  exchange_rate?: number
  note?: string
}

export const addInvoicePayment = (id: string, body: PaymentInput) =>
  apiPost<InvoiceDetail>(`/api/admin/invoices/${id}/payments`, body)

export const deleteInvoicePayment = (id: string, paymentId: string) =>
  apiPost<InvoiceDetail>(`/api/admin/invoices/${id}/payments/${paymentId}/delete`)

export interface InvoiceUpdate {
  notes?: string
  purchase_order?: string
  /** YYYY-MM-DD; empty clears it. */
  due_on?: string
  /** Replaces the whole list of linked projects. */
  project_ids?: string[]
  status?: 'active' | 'cancelled'
}

/** The paper trail of a project: its invoices with XML, PDF, REPs and payments. */
export const listProjectInvoices = (projectId: string) =>
  apiGet<InvoiceDetail[]>(`/api/admin/projects/${projectId}/invoices`)

export interface ProjectSuggestion {
  project_id: string
  title: string
  /** Invoice lines that name a part of that project. */
  matches: number
}

/** Projects whose part numbers appear in the invoice lines. */
export const invoiceProjectSuggestions = (id: string) =>
  apiGet<ProjectSuggestion[]>(`/api/admin/invoices/${id}/project_suggestions`)

export const updateInvoice = (id: string, body: InvoiceUpdate) =>
  apiPost<InvoiceDetail>(`/api/admin/invoices/${id}/update`, body)

export const addInvoiceFile = (id: string, kind: string, file: File) => {
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', file)
  return apiPostForm<InvoiceDetail>(`/api/admin/invoices/${id}/files`, form)
}
