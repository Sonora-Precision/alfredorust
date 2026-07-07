// DTOs for the SPA, derived from src/models.rs (backend domain types) and the
// wire shapes documented in docs/solid-migration/backend-and-api.md. These
// mirror frontend/src/api/*.rs 1:1 (row / payload / detail split per domain).
// Name mismatches between read/write shapes (documented in backend-and-api.md
// §4.6) are encapsulated in the lib/api/<domain>.ts modules, not here.

// --- shared enums -----------------------------------------------------------

export type FlowType = 'income' | 'expense'
export type AccountType = 'bank' | 'cash' | 'credit_card' | 'investment' | 'other'
export type TransactionType = 'income' | 'expense' | 'transfer'
export type ContactType = 'customer' | 'supplier' | 'service' | 'other'
export type PlannedStatus = 'planned' | 'partially_covered' | 'covered' | 'overdue' | 'cancelled'
export type OrderStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled'
export type ProjectStatus =
  | 'pedidos'
  | 'analisis'
  | 'cotizado'
  | 'orden_de_compra_mandada'
  | 'ingenieria'
  | 'produccion'
  | 'calidad'
  | 'esperando_entrega'
  | 'entregado'
  | 'cancelado'
export type ProjectPriority = 'low' | 'medium' | 'high' | 'urgent'
export type ResourceType = 'machinery' | 'vehicle' | 'equipment' | 'other'
export type CfdiDownloadType = 'issued' | 'received' | 'both'
export type CfdiJobState = 'queued' | 'running' | 'done' | 'failed'

// --- auth / bootstrap --------------------------------------------------------

export interface CompanySummary {
  id: string
  name: string
  slug: string
  active: boolean
}

/** Bootstrap payload from `GET /api/me`. */
export interface MeResponse {
  username: string
  company: string
  company_slug: string
  role: 'admin' | 'staff'
  permissions: string[]
  companies: CompanySummary[]
}

export interface LoginOk {
  ok: boolean
  redirect_url?: string | null
}

// --- own account profile -----------------------------------------------------

export interface ProfileData {
  id: string
  username: string
}

export interface ProfilePayload {
  username: string
  secret: string
}

// --- companies (admin) --------------------------------------------------------

export interface CompanyData {
  id: string
  name: string
  slug: string
  default_currency: string
  is_active: boolean
  notes?: string | null
  is_current?: boolean
}

export interface CompanyPayload {
  name: string
  slug?: string | null
  default_currency?: string | null
  is_active?: boolean | null
  notes?: string | null
}

// --- users (admin) -------------------------------------------------------------

export interface UserMembershipData {
  company_id: string
  company_name?: string
  role: string
  permissions: string[]
}

export interface UserRowData {
  id: string
  username: string
  role: string
  companies: string[]
  memberships: UserMembershipData[]
  /** Only populated on the single-user detail endpoint. */
  secret: string
}

export interface UserMembershipPayload {
  company_id: string
  role?: string | null
  permissions: string[]
}

export interface UserPayload {
  username: string
  secret?: string | null
  memberships: UserMembershipPayload[]
}

// --- accounts (finance) ---------------------------------------------------------

export interface Account {
  id: string
  name: string
  company: string
  account_type: AccountType
  currency: string
  is_active: boolean
}

export interface AccountPayload {
  name: string
  account_type: AccountType
  currency?: string | null
  is_active: boolean
  notes?: string | null
}

export interface AccountDetail {
  name: string
  account_type: AccountType
  currency: string
  is_active: boolean
  notes?: string | null
}

// --- categories -------------------------------------------------------------

export interface Category {
  id: string
  name: string
  flow_type: FlowType
  parent?: string
}

export interface CategoryPayload {
  name: string
  flow_type: FlowType
  parent_id?: string | null
  notes?: string | null
}

export interface CategoryDetail {
  name: string
  flow_type: FlowType
  parent_id?: string | null
  notes?: string | null
}

// --- contacts -----------------------------------------------------------------
// NOTE: list row uses `kind`, write payload uses `contact_type` — a real
// mismatch in the backend contract. Encapsulated in lib/api/finance.ts.

export interface Contact {
  id: string
  name: string
  kind: ContactType
  email?: string
}

export interface ContactPayload {
  name: string
  contact_type: ContactType
  rfc?: string | null
  email?: string | null
  phone?: string | null
  notes?: string | null
}

export interface ContactDetail {
  name: string
  contact_type: ContactType
  rfc?: string | null
  email?: string | null
  phone?: string | null
  notes?: string | null
}

// --- recurring plans ------------------------------------------------------------

export interface RecurringPlan {
  id: string
  name: string
  flow_type: FlowType
  amount_estimated: number
  frequency: string
  start_date: string
  is_active: boolean
}

export interface RecurringPlanPayload {
  name: string
  flow_type: FlowType
  category_id: string
  account_expected_id: string
  contact_id?: string | null
  amount_estimated: number
  frequency: string
  day_of_month?: number | null
  start_date: string
  end_date?: string | null
  is_active: boolean
  /** Load-bearing: incrementing marks existing generated PlannedEntry rows outdated. */
  version: number
  notes?: string | null
}

export type RecurringPlanDetail = RecurringPlanPayload

// --- planned entries --------------------------------------------------------

export interface PlannedEntry {
  id: string
  name: string
  flow_type: FlowType
  amount_estimated: number
  due_date: string
  status: PlannedStatus
  status_label?: string
}

export interface PlannedEntryPayload {
  name: string
  flow_type: FlowType
  category_id: string
  account_expected_id: string
  contact_id?: string | null
  amount_estimated: number
  due_date: string
  status: PlannedStatus
  project_id?: string | null
  notes?: string | null
}

export type PlannedEntryDetail = PlannedEntryPayload

export interface PlannedEntryPayPayload {
  paid_at: string
  amount: number
  account_id: string
  project_id?: string | null
  notes?: string | null
}

export interface PlannedEntryBulkPayPayload {
  entry_ids: string[]
  paid_at: string
  account_id: string
  project_id?: string | null
  notes?: string | null
}

// --- transactions ---------------------------------------------------------------

export interface Transaction {
  id: string
  date: string
  description: string
  tx_type: TransactionType
  amount: number
  category?: string
  account_from?: string
  account_to?: string
  is_confirmed: boolean
}

export interface TransactionPayload {
  date: string
  description: string
  transaction_type: TransactionType
  category_id: string
  account_from_id?: string | null
  account_to_id?: string | null
  amount: number
  planned_entry_id?: string | null
  is_confirmed: boolean
  notes?: string | null
}

export type TransactionDetail = TransactionPayload

// --- forecasts ------------------------------------------------------------------

export interface Forecast {
  id: string
  currency: string
  projected_net: number
  start_date: string
  end_date: string
  scenario_name?: string | null
}

export interface ForecastPayload {
  generated_at: string
  start_date: string
  end_date: string
  currency: string
  projected_income_total: number
  projected_expense_total: number
  projected_net: number
  initial_balance?: number | null
  final_balance?: number | null
  details?: string | null
  scenario_name?: string | null
  notes?: string | null
}

export interface ForecastDetail {
  generated_at: string
  start_date: string
  end_date: string
  currency: string
  projected_income_total: number
  projected_expense_total: number
  initial_balance?: number | null
  final_balance?: number | null
  details?: string | null
  scenario_name?: string | null
  notes?: string | null
}

// --- service orders ---------------------------------------------------------------

export interface OrderItem {
  description: string
  quantity: number
  unit_price: number
}

export interface Order {
  id: string
  title: string
  status: OrderStatus
  status_label?: string
  amount: number
  scheduled_at?: string | null
  contact_id?: string | null
}

export interface OrderPayload {
  title: string
  contact_id?: string | null
  category_id?: string | null
  account_id?: string | null
  status: OrderStatus
  amount: number
  scheduled_at?: string | null
  items: OrderItem[]
  notes?: string | null
}

export interface OrderDetail {
  title: string
  contact_id?: string | null
  category_id?: string | null
  account_id?: string | null
  status: OrderStatus
  amount: number
  scheduled_at?: string | null
  items: OrderItem[]
  notes?: string | null
}

// --- projects -----------------------------------------------------------------

/** Minimal shape for option pickers — same endpoint as ProjectRow, narrowed. */
export interface Project {
  id: string
  title: string
}

export interface ProjectRow {
  id: string
  title: string
  description?: string | null
  status: ProjectStatus
  status_label?: string
  priority: ProjectPriority
  priority_label?: string
  total_budget?: number | null
  scheduled_at?: string | null
  contact_id?: string | null
}

export interface ProjectPayload {
  title: string
  contact_id?: string | null
  category_id?: string | null
  description?: string | null
  priority: ProjectPriority
  total_budget?: number | null
  scheduled_at?: string | null
  notes?: string | null
}

export interface ProjectDetail {
  title: string
  contact_id?: string | null
  category_id?: string | null
  description?: string | null
  priority: ProjectPriority
  total_budget?: number | null
  scheduled_at?: string | null
  notes?: string | null
}

// --- project concepts + statuses -------------------------------------------------

export interface ProjectConcept {
  id: string
  status_id: string
  name: string
  quantity: number
  unit?: string | null
  description?: string | null
  estimated_hours?: number | null
  estimated_cost?: number | null
  position: number
}

export interface ProjectConceptPayload {
  status_id?: string | null
  name: string
  quantity: number
  unit?: string | null
  description?: string | null
  estimated_hours?: number | null
  estimated_cost?: number | null
  notes?: string | null
  position: number
}

/** Minimal shape for option pickers. */
export interface ConceptStatus {
  id: string
  name: string
}

export interface ConceptStatusFull {
  id: string
  name: string
  position: number
  color?: string | null
  is_initial: boolean
  is_terminal: boolean
  is_cancelled: boolean
  is_active: boolean
}

export interface ConceptStatusPayload {
  name: string
  position: number
  color?: string | null
  is_initial: boolean
  is_terminal: boolean
  is_cancelled: boolean
  is_active: boolean
}

// --- resources ------------------------------------------------------------------

export interface Resource {
  id: string
  name: string
  resource_type: ResourceType
  resource_type_label?: string
  is_active: boolean
  hourly_cost: number
  currency: string
  allowed_status_ids: string[]
}

export interface ResourcePayload {
  name: string
  resource_type: ResourceType
  is_active: boolean
  hourly_cost: number
  currency?: string | null
  allowed_status_ids: string[]
  notes?: string | null
}

export interface ResourceDetail {
  name: string
  resource_type: ResourceType
  is_active: boolean
  hourly_cost: number
  currency: string
  allowed_status_ids: string[]
  notes?: string | null
}

// --- resource logs -----------------------------------------------------------------

export interface ResourceLog {
  id: string
  project_id?: string | null
  phase?: string | null
  resource_name?: string | null
  started_at: string
  ended_at?: string | null
  duration_hours?: number | null
  operator_name?: string | null
}

export interface ResourceLogPayload {
  project_id?: string | null
  phase?: string | null
  resource_id?: string | null
  started_at: string
  ended_at?: string | null
  operator_name?: string | null
  notes?: string | null
}

export interface ResourceLogEndPayload {
  ended_at?: string | null
}

export interface ResourceLogDetail {
  project_id?: string | null
  phase?: string | null
  resource_id?: string | null
  started_at: string
  ended_at?: string | null
  operator_name?: string | null
  notes?: string | null
}

// --- resource usages: hourly grid ---------------------------------------------------

export interface GridResource {
  resource_id: string
  label: string
  selected: boolean
}

export interface GridCell {
  hour: number
  is_work_hour: boolean
  resources: GridResource[]
}

export interface GridRow {
  concept_id: string
  project_id?: string
  project_title?: string
  status_name?: string
  concept_name: string
  quantity: number
  unit?: string
  cells: GridCell[]
}

export interface GridStatus {
  id: string
  name: string
}

export interface GridView {
  date: string
  can_edit: boolean
  statuses: GridStatus[]
  rows: GridRow[]
}

export interface GridSelection {
  concept_id: string
  hour: number
  resource_id: string
}

export interface GridSavePayload {
  date: string
  status_id?: string | null
  selections: GridSelection[]
}

// --- fiscal: SAT configs -------------------------------------------------------------

export interface SatConfigData {
  id: string
  company_id: string
  rfc: string
  label?: string | null
  created_at: string
}

export interface SatConfigPayload {
  rfc: string
  cer_path: string
  key_path: string
  key_password: string
  label?: string | null
}

// --- fiscal: CFDI download jobs ------------------------------------------------------

export interface CfdiDownloadPayload {
  sat_config_id: string
  start: string
  end: string
  download_type: CfdiDownloadType
  auto_create_payments: boolean
}

export type CfdiJobStatus =
  | { status: 'queued' | 'running' }
  | {
      status: 'done'
      imported: number
      transactions_created: number
      transactions_updated: number
      transactions_skipped: number
      errors: string[]
    }
  | { status: 'failed'; error: string }

export interface CfdiJob {
  job_id: string
  label?: string
  chunk_start?: string
  started_at?: string
  status: CfdiJobStatus
}

export interface StartedJobs {
  jobs: { job_id: string; label: string }[]
}

// --- fiscal: CFDIs (read-only listing) ------------------------------------------------

export interface Cfdi {
  uuid: string
  folio?: string
  tipo?: string
  fecha?: string
  total: number
  moneda?: string
  emisor_nombre?: string
  receptor_nombre?: string
  es_emitido: boolean
}

export interface CfdiConceptData {
  descripcion?: string
  cantidad?: number
  valor_unitario?: number
  importe?: number
  clave_prod_serv?: string
  unidad?: string
}

export interface CfdiList {
  company_rfcs: string[]
  items: Cfdi[]
}

export interface CfdiDetailResponse extends Cfdi {
  conceptos: CfdiConceptData[]
}

// --- tiempo (timeline) ----------------------------------------------------------------

export interface TxItem {
  id: string
  description?: string
  amount: number
  date?: string
  type?: TransactionType | string
}

export interface PlannedItem {
  id: string
  name?: string
  amount_estimated: number
  due_date?: string
  flow_type?: FlowType | string
  status?: string
}

export interface TimelineBucket {
  start: string
  end: string
  real_income: number
  real_expense: number
  planned_income: number
  planned_expense: number
  net_real: number
  net_planned: number
  cumulative_real: number
  cumulative_planned: number
  transactions: TxItem[]
  planned_entries: PlannedItem[]
}

export type TimelineMode = 'day' | 'week' | 'month' | 'year'

// --- PDF preview -----------------------------------------------------------------------

export interface PdfPreviewResponse {
  ok: boolean
  pdf_base64: string | null
  error: string | null
}
