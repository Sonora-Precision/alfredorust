import { apiGet, apiPost } from './client'

export interface MaterialPrice {
  material: string
  price_per_kg: number
  source: string
  note: string | null
  updated_at: string
  /** Date the price is good for (invoice date or when it was written). */
  as_of: string
  /** What it cost on the latest invoices, newest first. */
  history: { price_per_kg: number; supplier: string; folio: string | null; at: string; kg: number; kg_source: string }[]
}

export interface QuoteLine {
  concept_id: string
  folio: string
  part: string
  quantity: number
  material: string | null
  shape: string | null
  thickness: number | null
  width: number | null
  length: number | null
  weight_kg: number | null
  /** "solidworks" (entered) or "tocho" (computed from the blank). */
  weight_source: 'solidworks' | 'tocho' | null
  entered_weight_kg: number | null
  entered_multiplier: number | null
  price_per_kg: number | null
  material_cost: number | null
  multiplier: number
  suggested_unit_price: number | null
  /** The quoted price (Daniel's last word). */
  unit_price: number | null
  missing: string[]
}

export interface ProjectQuote {
  lines: QuoteLine[]
  material_total: number
  suggested_total: number
  quoted_total: number
}

export const listMaterialPrices = () => apiGet<MaterialPrice[]>('/api/admin/material_prices')
export const setMaterialPrice = (material: string, pricePerKg: number | null, note?: string) =>
  apiPost<void>('/api/admin/material_prices', { material, price_per_kg: pricePerKg, note })
export const getProjectQuote = (projectId: string) => apiGet<ProjectQuote>(`/api/admin/projects/${projectId}/quote`)
export const setPartQuote = (conceptId: string, quote: { weight_kg: number | null; multiplier: number | null }) =>
  apiPost<void>(`/api/admin/project_concepts/${conceptId}/quote`, quote)
export const applySuggestedPrices = (projectId: string, conceptIds: string[]) =>
  apiPost<{ applied: number; skipped: string[] }>(`/api/admin/projects/${projectId}/quote/apply`, { concept_ids: conceptIds })

/** What the supplier invoices downloaded from the SAT say each material costs. */
export interface CfdiPrices {
  materials: {
    material: string
    price_per_kg: number
    date: string
    supplier: string
    folio: string | null
    min: number
    max: number
    lines: number
  }[]
  lines: {
    material: string
    supplier: string
    folio: string | null
    date: string
    amount: number
    kg: number
    price_per_kg: number
    kg_source: string
  }[]
  /** Materials that took a new price (only when saved). */
  updated: number | null
}

export const pricesFromInvoices = (apply: boolean) =>
  apiPost<CfdiPrices>('/api/admin/material_prices/from_cfdis', { apply })

/** Price per piece set by hand while costing a part (admin). */
export const setUnitPrice = (conceptId: string, unitPrice: number | null) =>
  apiPost<void>(`/api/admin/project_concepts/${conceptId}/unit_price`, { unit_price: unitPrice })

/** Density and $/kg of a material the project uses (Daniel, 2026-11-07). */
export interface MaterialRate {
  material: string
  density_g_cm3: number | null
  price_per_kg: number | null
  priced_as: string | null
  as_of: string | null
}
export const projectMaterialRates = (projectId: string) => apiGet<MaterialRate[]>(`/api/admin/projects/${projectId}/material_rates`)

export interface MaterialQuoteLine {
  stock: string
  kg?: number | null
  estimate?: number | null
  quoted?: number | null
  /** The material, to compare suppliers material by material. */
  material?: string | null
}
/** What a supplier quoted for the material, next to what we expected. */
export interface MaterialQuote {
  id: string
  supplier: string
  total: number
  estimate_total: number
  lines: MaterialQuoteLine[]
  note: string | null
  created_by: string
  created_at: string
}
export const projectMaterialQuotes = (projectId: string) => apiGet<MaterialQuote[]>(`/api/admin/projects/${projectId}/material_quotes`)
export const createMaterialQuote = (
  projectId: string,
  body: { supplier: string; total: number; estimate_total: number; lines: MaterialQuoteLine[]; note?: string | null },
) => apiPost<{ ok: boolean; id: string }>(`/api/admin/projects/${projectId}/material_quotes`, body)
export const deleteMaterialQuote = (id: string) => apiPost<void>(`/api/admin/material_quotes/${id}/delete`, {})

/** The multiplier on material a part is quoted at unless set (backend DEFAULT_MULTIPLIER). */
export const DEFAULT_MULTIPLIER = 3.5
