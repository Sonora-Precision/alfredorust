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
  user_id: string
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

export interface PersonalAccessToken {
  id: string
  name: string
  token_prefix: string
  created_at: string
  expires_at: string
  last_used_at?: string | null
  revoked_at?: string | null
}

export interface CreatePersonalAccessTokenPayload {
  name: string
  expires_in_days: number
}

export interface CreatedPersonalAccessToken {
  id: string
  name: string
  token: string
  token_prefix: string
  expires_at: string
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
  display_name?: string | null
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
  /** Shop-floor name; "" clears it. */
  display_name?: string
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
  /** OT folio number (shown as OT-0001). */
  work_order_number?: number | null
  quantity: number
  unit?: string | null
  description?: string | null
  estimated_hours?: number | null
  estimated_cost?: number | null
  /** Quoted sale price per piece (admin only). */
  unit_price?: number | null
  notes?: string | null
  position: number
  /** Pieces produced (all steps ✔ or N/A). */
  completed_quantity: number
  /** Pieces quality released (they count as finished) and rejected (made again). */
  released_quantity?: number
  /** Material and blank per piece (inches); status is derived on the server. */
  material?: PartMaterial | null
  material_status?: MaterialStatus | null
  rejected_quantity?: number
  /** Only the steps someone marked; other catalog operations are pending. */
  process_steps: PartStep[]
}

export type StepState = 'pending' | 'done' | 'not_applicable'

export interface PartStep {
  operation_id: string
  name: string
  state: StepState
  updated_by?: string | null
  updated_at?: string | null
  /** Who holds this step on the production board. */
  assignee_user_id?: string | null
}

export type WorkQueue = 'programming' | 'setup' | 'machining' | 'finishing'

export interface ProcessOperation {
  id: string
  name: string
  position: number
  is_active: boolean
  /** Production-board queue; null = checklist only. */
  queue?: WorkQueue | null
}

export interface ProcessOperationPayload {
  name: string
  position: number
  is_active: boolean
  queue?: WorkQueue | null
}

// --- production board (no money, no part description) ------------------------------

export interface WorkOrderPerson {
  id: string
  username: string
  /** Shop-floor name (display name, or the handle before the @). */
  name: string
}

export interface WorkOrder {
  id: string
  folio: string
  work_order_number: number | null
  part: string
  quantity: number
  completed_quantity: number
  unit: string | null
  project_id: string
  project: string
  client: string | null
  priority: 'urgent' | 'high' | 'medium' | 'low'
  priority_label: string
  pinned: boolean
  scheduled_at: string | null
  queue: WorkQueue
  operation_id: string
  operation: string
  assignee: WorkOrderPerson | null
}

export interface BoardMemberLoad {
  id: string
  username: string
  name: string
  is_admin: boolean
  /** Folios whose current step this person holds, in sequence order. */
  assigned: string[]
  /** The same orders in full, across every queue. */
  orders: WorkOrder[]
}

export interface WeeklyPieces {
  week_start: string
  week_end: string
  team: number
  team_previous_week: number
  /** Everyone's finished pieces (pieces only, never money); id null = no programmer yet. */
  people: { id: string | null; name: string; pieces: number; previous_week: number }[]
  mine_by_part: { id: string; folio: string; part: string; pieces: number }[]
}

export interface WorkOrderSearchHit {
  id: string
  folio: string
  part: string
  project_id: string
  project: string
  client: string | null
  assignee: WorkOrderPerson | null
  status: string
  status_label: string
  queue: WorkQueue | null
  position: number | null
  quantity: number
  /** Pieces produced. */
  completed_quantity: number
  /** Pieces quality released (they count as finished) and rejected. */
  released_quantity: number
  rejected_quantity: number
  /** Produced pieces waiting for quality ("En liberación"). */
  awaiting_release: number
}

/** A part with produced pieces waiting for quality release. No money. */
export interface QualityItem {
  id: string
  folio: string
  part: string
  project_id: string
  project: string
  client: string | null
  quantity: number
  unit: string | null
  produced: number
  released: number
  rejected: number
  awaiting: number
  /** Who programmed it (gets the credit of released pieces). */
  programmer: WorkOrderPerson | null
}

export interface QualityPayload {
  released?: number
  rejected?: number
  /** Required when rejecting. */
  reason?: string
}

export type SequenceMovePayload = { before_id: string } | { after_id: string } | { unpin: true }

// --- plant view ----------------------------------------------------------------------

export type MachineStatus = 'working' | 'setup' | 'stopped'

export interface PlacedMachine {
  resource_id: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  area: string | null
}

export interface PlantLayout {
  width: number
  height: number
  walls: [number, number][]
  rooms: [number, number][][]
  labels: { text: string; x: number; y: number }[]
  machines: PlacedMachine[]
}

export interface PlantMachine {
  resource_id: string
  name: string
  status: MachineStatus | null
  source: 'dnc' | 'movimiento' | 'manual' | 'none'
  since: string | null
  note: string | null
  program: string | null
  part_number: string | null
  order: {
    id: string
    folio: string
    part: string
    project: string
    client: string | null
    quantity: number
    completed_quantity: number
  } | null
  programmer: WorkOrderPerson | null
  /** Setup or operation set by hand ("Setup 1"). */
  label: string | null
  /** Who put it to run here. */
  running_by: WorkOrderPerson | null
  /** What runs next here, first to run first. */
  queue: MachineQueueEntry[]
}

export interface MachineQueueEntry {
  id: string
  label: string | null
  order: NonNullable<PlantMachine['order']>
}

export interface PlantView {
  layout: PlantLayout | null
  machines: PlantMachine[]
}

export interface MachineStatePayload {
  status: MachineStatus
  concept_id?: string | null
  note?: string | null
  label?: string | null
}

export interface TakeWorkOrderPayload {
  related_to?: string
  reason?: string
}

export interface PartProgressPayload {
  completed_quantity?: number
  operation_id?: string
  state?: StepState
}

// --- machine time from the shop floor (DNC runs pushed by taller-vision) -------------

export interface ConceptMachineTime {
  concept_id: string
  name: string
  quantity: number
  estimated_hours?: number | null
  minutes: number
  cutting_minutes: number
  /** fractional when the part was shared with other projects */
  cycles: number
  /** minutes that came from runs split with other projects by pieces ordered (estimate) */
  shared_minutes: number
  /** minutes estimated from activity at the machine with the DNC idle, on the last program loaded */
  inferred_minutes: number
  runs: number
  machines: string[]
  programs: string[]
  first_at?: string | null
  last_at?: string | null
}

// --- daily shop-floor report pushed by taller-vision (only what the page reads) ------

export interface ShopKpis {
  inicio_min?: number | null
  fin_min?: number | null
  gente_min?: number | null
  trabajo_maquinas_min?: number | null
  cortando_min?: number | null
  medido_min?: number | null
  estimado_min?: number | null
  corridas?: number
  alarmas?: number
}

export interface ShopRun {
  external_id: string
  machine: string
  program: string
  part_number?: string | null
  nombre_cabecera?: string | null
  started_at: string
  ended_at: string
  minutes: number
  cutting_minutes: number
  cycles: number
  inferred: boolean
  program_loaded_at?: string | null
}

export interface ShopZone {
  ref: string
  name: string
  maquina?: string | number | null
  trabajo_min?: number
  sesiones?: { n: number }
  dnc?: { nombre: string; cortando_min: number; ciclos: number } | null
}

export interface ShopReportItem {
  day: string
  summary?: string | null
  kpis?: ShopKpis | null
  updated_at?: string | null
}

export interface ShopReportDetail extends ShopReportItem {
  report: {
    zonas?: ShopZone[]
    maquinas?: { ref: string | number; name: string }[]
    corridas?: ShopRun[]
    alarmas?: { inicio: string; cam?: string; maquina?: string; name?: string }[]
  }
}

export interface ProjectMachineTime {
  project_id: string
  minutes: number
  cutting_minutes: number
  cycles: number
  runs: number
  last_at?: string | null
  concepts: ConceptMachineTime[]
}

export interface ProjectConceptPayload {
  status_id?: string | null
  name: string
  quantity: number
  unit?: string | null
  description?: string | null
  estimated_hours?: number | null
  estimated_cost?: number | null
  /** Quoted sale price per piece (admin only). */
  unit_price?: number | null
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
  /** "manual" (HTTP request) or "cron" (daily scheduled pass). */
  source?: string
}

export interface CfdiCronStatus {
  enabled: boolean
  mode: string
  next_run: string
  last_run: string | null
  last_new: number
}

export interface CfdiArchivedCount {
  count: number
}

export interface CfdiEstatusResponse {
  /** "vigente" | "cancelado" | "no_encontrado" */
  estatus: string
  es_cancelable?: string | null
  estatus_cancelacion?: string | null
  codigo?: string | null
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
  subtotal?: number
  iva?: number
  total: number
  moneda?: string
  forma_pago?: string
  metodo_pago?: string
  emisor_rfc?: string
  emisor_nombre?: string
  receptor_rfc?: string
  receptor_nombre?: string
  concepto?: string
  /** "vigente" | "cancelado" — defaults to "vigente" until a status check. */
  estatus?: string
  es_emitido: boolean
  has_transaction?: boolean
}

export interface BulkCfdiTransactionsPayload {
  uuids: string[]
}

export interface BulkCfdiTransactionError {
  uuid: string
  error: string
}

export interface BulkCfdiTransactionsResponse {
  requested: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  errors: BulkCfdiTransactionError[]
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
  total: number
  items: Cfdi[]
}

export interface CfdiDetailResponse extends Cfdi {
  company_id?: string
  serie?: string
  uso_cfdi?: string
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

// --- part material and material receipts (openspec add-part-material) ---------------

export type MaterialStatus = 'surtido_por_cliente' | 'cortado' | 'recibido' | 'pedido' | 'pendiente'

export interface PartMaterial {
  material?: string | null
  shape?: string | null
  thickness?: number | null
  width?: number | null
  /** Cut length per piece. */
  length?: number | null
  bar_to_order?: string | null
  customer_supplied?: boolean
  ordered?: boolean
  notes?: string | null
}

export interface MaterialReceiptSummary {
  id: string
  supplier: string
  folio: string | null
  cfdi_uuid: string | null
  received_at: string
  lines: number
  assigned_lines: number
}

export interface ReceiptPartRef {
  concept_id: string
  folio: string
  part: string
  project_id: string
}

export interface ReceiptSuggestion extends ReceiptPartRef {
  fit: 'exact' | 'larger'
  note: string | null
  /** Blanks the bar yields at a 1/16" cut. */
  pieces: number
  needed: number
  /** Other bars of the receipt that suit the same part (assigned to it or still free). */
  other_bars: { line: number; pieces: number; assigned: boolean }[]
}

export interface ReceiptLineView {
  line: number
  description: string
  quantity: number
  unit: string
  material: string | null
  shape: string | null
  thickness: number | null
  width: number | null
  length: number | null
  pieces: number
  assigned: ReceiptPartRef[]
  suggestions: ReceiptSuggestion[]
}

export interface MaterialReceiptDetail {
  id: string
  supplier: string
  folio: string | null
  cfdi_uuid: string | null
  received_at: string
  lines: ReceiptLineView[]
  parts: (ReceiptPartRef & { needed: number; available: number })[]
}
