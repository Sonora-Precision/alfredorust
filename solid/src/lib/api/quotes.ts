import { apiGet, apiPost } from './client'

export interface QuoteItem {
  item: number
  quantity: number
  description: string
  unit_price: number
  concept_id?: string | null
}

export interface QuoteView {
  id: string
  project_id: string
  folio: string
  folio_base: string
  revision: number
  date: string
  client_name: string
  contact_id: string | null
  attention: string | null
  attention_initials: string | null
  client_abbreviation: string | null
  currency: 'MXN' | 'USD'
  language: 'es' | 'en'
  iva: boolean
  retention: boolean
  iva_rate: number
  retention_rate: number
  discount: number
  delivery_time: number
  delivery_unit: 'dias' | 'semanas'
  validity_days: number
  advance_pct: number
  remaining_pct: number
  notes: string[]
  lines: QuoteItem[]
  subtotal: number
  iva_amount: number
  retention_amount: number
  net: number
  sent_at: string | null
  created_at: string
}

export interface QuoteSettings {
  company_name: string
  address1: string
  address2: string
  phone: string
  email: string
  web: string
  iva_rate: number
  retention_rate: number
  logo_data_url?: string | null
}

export interface QuoteDocument extends QuoteView {
  company: QuoteSettings
}

export interface ClientQuoteDefaults {
  contact_id: string
  abbreviation: string | null
  currency: 'MXN' | 'USD'
  language: 'es' | 'en'
  iva: boolean
  retention: boolean
  validity_days: number
  advance_pct: number
  people: { name: string; initials?: string | null; email?: string | null }[]
}

export interface QuoteCreatePayload {
  attention?: string | null
  attention_initials?: string | null
  currency?: string
  language?: string
  iva?: boolean
  retention?: boolean
  discount?: number
  delivery_time?: number
  delivery_unit?: 'dias' | 'semanas'
  validity_days?: number
  advance_pct?: number
  notes?: string[]
}

export const listProjectQuotes = (projectId: string) => apiGet<QuoteView[]>(`/api/admin/projects/${projectId}/quotes`)
export const createQuote = (projectId: string, payload: QuoteCreatePayload) =>
  apiPost<QuoteView>(`/api/admin/projects/${projectId}/quotes`, payload)
export const getQuote = (id: string) => apiGet<QuoteDocument>(`/api/admin/quotes/${id}`)
export const reviseQuote = (id: string) => apiPost<QuoteView>(`/api/admin/quotes/${id}/revise`, {})
export const markQuoteSent = (id: string) => apiPost<void>(`/api/admin/quotes/${id}/sent`, {})
export const listClientQuoteDefaults = () => apiGet<ClientQuoteDefaults[]>('/api/admin/client_quote_defaults')
