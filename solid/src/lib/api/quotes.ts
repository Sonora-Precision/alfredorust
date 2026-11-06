import { apiGet, apiPost } from './client'
import type { PartMaterial } from './types'

export interface QuoteItem {
  item: number
  quantity: number
  description: string
  unit_price: number
  concept_id?: string | { $oid: string } | null
  /** What the part is cut from, for the suggested price; goes to the part on "Convertir en proyecto". */
  material?: PartMaterial | null
  weight_kg?: number | null
  multiplier?: number | null
}

export interface QuoteView {
  id: string
  /** The project the quote became (or was made from); null while not approved. */
  project_id: string | null
  project_title: string | null
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

export interface QuoteLinePayload {
  quantity: number
  description: string
  unit_price: number
  material?: PartMaterial | null
  weight_kg?: number | null
  multiplier?: number | null
}

export interface QuoteCreatePayload {
  contact_id?: string | null
  revision_of?: string | null
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
  lines?: QuoteLinePayload[]
}

export interface SuggestedLine {
  weight_kg: number | null
  weight_source: 'solidworks' | 'tocho' | null
  price_per_kg: number | null
  material_cost: number | null
  multiplier: number
  suggested_unit_price: number | null
  missing: string[]
}

export const listQuotes = () => apiGet<QuoteView[]>('/api/admin/quotes')
export const createQuote = (payload: QuoteCreatePayload) => apiPost<QuoteView>('/api/admin/quotes', payload)
export const suggestLines = (lines: { material?: PartMaterial | null; weight_kg?: number | null; multiplier?: number | null }[]) =>
  apiPost<SuggestedLine[]>('/api/admin/quotes/suggest', { lines })
export const quoteToProject = (id: string, title?: string | null) =>
  apiPost<{ project_id: string; title: string }>(`/api/admin/quotes/${id}/project`, { title: title || null })
export const listProjectQuotes = (projectId: string) => apiGet<QuoteView[]>(`/api/admin/projects/${projectId}/quotes`)
export const getQuote = (id: string) => apiGet<QuoteDocument>(`/api/admin/quotes/${id}`)
export const reviseQuote = (id: string) => apiPost<QuoteView>(`/api/admin/quotes/${id}/revise`, {})
export const markQuoteSent = (id: string) => apiPost<void>(`/api/admin/quotes/${id}/sent`, {})
export const listClientQuoteDefaults = () => apiGet<ClientQuoteDefaults[]>('/api/admin/client_quote_defaults')

/** A past price of a part: sold (a project's part), approved (quote that became a project) or quoted. */
export interface PartReference {
  kind: 'vendida' | 'aprobada' | 'cotizada'
  description: string
  unit_price: number
  quantity: number
  currency: 'MXN' | 'USD'
  client_name: string | null
  folio: string | null
  quote_id: string | null
  project_id: string | null
  project_title: string | null
  date: string
}

/** For each name, its last prices (newest first, up to 5). */
export const partReferences = (names: string[]) => apiPost<PartReference[][]>('/api/admin/quotes/references', { names })
/** Every part name that has had a price, newest first. */
export const listPartNames = () => apiGet<string[]>('/api/admin/quotes/part_names')
