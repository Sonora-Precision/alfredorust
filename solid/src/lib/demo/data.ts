// Demo fixtures + the request router used when isDemo() is true. Every GET the
// app makes is answered from here (no network); mutations no-op with a toast.
//
// Fixtures are plain objects cast to the API types (shapes verified against
// lib/api/types.ts). The tenant is a fictional CNC machine shop, "Aurora
// Manufactura", so the data reads believably across finance, projects and CFDI.
// IDs are stable strings and cross-referenced (category/account/status ids) so
// edit modals pre-select the right options.
import { toast } from '../../components/ui/Toast'
import type {
  Account,
  AccountDetail,
  Category,
  CategoryDetail,
  Cfdi,
  CfdiDetailResponse,
  CfdiJob,
  CfdiList,
  CompanyData,
  CompanySummary,
  ConceptStatusFull,
  Contact,
  ContactDetail,
  Forecast,
  ForecastDetail,
  GridView,
  MeResponse,
  Order,
  OrderDetail,
  PlannedEntry,
  ProfileData,
  ProjectConcept,
  ProjectRow,
  ProjectDetail,
  RecurringPlan,
  Resource,
  ResourceDetail,
  ResourceLog,
  SatConfigData,
  Transaction,
  TimelineBucket,
  UserRowData,
} from '../api/types'
import type { OnboardingStatus } from '../api/onboarding'

// --- stable ids --------------------------------------------------------------

const ACC = { bbva: 'acc-bbva', cash: 'acc-cash', sant: 'acc-santander', amex: 'acc-amex' }
const CAT = {
  ventas: 'cat-ventas',
  servicios: 'cat-servicios',
  otros: 'cat-otros-ing',
  nomina: 'cat-nomina',
  materiales: 'cat-materiales',
  renta: 'cat-renta',
  energia: 'cat-energia',
  impuestos: 'cat-impuestos',
}
const ST = {
  pedido: 'st-pedido',
  ing: 'st-ingenieria',
  cnc: 'st-cnc',
  calidad: 'st-calidad',
  entrega: 'st-entrega',
  terminado: 'st-terminado',
  cancelado: 'st-cancelado',
}
const PRJ = { a: 'prj-flecha', b: 'prj-molde', c: 'prj-herramental' }
const RES = { cnc1: 'res-cnc-1', torno: 'res-torno', cmm: 'res-cmm', grua: 'res-grua' }

// --- identity ----------------------------------------------------------------

const DEMO_COMPANIES: CompanySummary[] = [
  { id: 'demo-c001', name: 'Aurora Manufactura', slug: 'demo', active: true },
  { id: 'demo-c002', name: 'Nébula Servicios', slug: 'nebula', active: false },
]

const DEMO_ME: MeResponse = {
  username: 'demo@auroramfg.mx',
  company: 'Aurora Manufactura',
  company_slug: 'demo',
  role: 'admin',
  permissions: [],
  companies: DEMO_COMPANIES,
}

const DEMO_PROFILE: ProfileData = { id: 'demo-user-1', username: 'demo@auroramfg.mx' }

const DEMO_ONBOARDING: OnboardingStatus = {
  ready: true,
  required_done: 4,
  required_total: 4,
  steps: [
    { key: 'company', label: 'Empresa', required: true, done: true, count: 1, detail: 'Aurora Manufactura — lista', unlocks: '', route: '/companies', cta: 'Editar empresa' },
    { key: 'accounts', label: 'Cuentas', required: true, done: true, count: 4, detail: '4 cuenta(s)', unlocks: 'transacciones y planes', route: '/accounts', cta: 'Agregar cuenta' },
    { key: 'categories', label: 'Categorías', required: true, done: true, count: 8, detail: '3 de ingreso, 5 de gasto', unlocks: 'transacciones y planes', route: '/categories', cta: 'Agregar categoría' },
    { key: 'concept_statuses', label: 'Estados de concepto', required: true, done: true, count: 7, detail: '7 estado(s)', unlocks: 'proyectos y captura de tiempo', route: '/concept-statuses', cta: 'Configurar estados' },
    { key: 'contacts', label: 'Contactos', required: false, done: true, count: 6, detail: '6 contacto(s)', unlocks: 'conciliación de CFDI y planes', route: '/contacts', cta: 'Agregar contacto' },
    { key: 'sat_config', label: 'Configuración SAT', required: false, done: true, count: 1, detail: '1 FIEL configurada', unlocks: 'descarga automática de CFDI', route: '/sat-configs', cta: 'Subir e.firma' },
    { key: 'users', label: 'Equipo', required: false, done: true, count: 3, detail: '3 usuarios', unlocks: 'colaboración', route: '/users', cta: 'Invitar usuario' },
  ],
}

// --- finance -----------------------------------------------------------------

const ACCOUNTS: Account[] = [
  { id: ACC.bbva, name: 'BBVA MXN', company: 'Aurora Manufactura', account_type: 'bank', currency: 'MXN', is_active: true },
  { id: ACC.sant, name: 'Santander USD', company: 'Aurora Manufactura', account_type: 'bank', currency: 'USD', is_active: true },
  { id: ACC.cash, name: 'Caja chica', company: 'Aurora Manufactura', account_type: 'cash', currency: 'MXN', is_active: true },
  { id: ACC.amex, name: 'Amex Corporativa', company: 'Aurora Manufactura', account_type: 'credit_card', currency: 'MXN', is_active: true },
]

const CATEGORIES: Category[] = [
  { id: CAT.ventas, name: 'Ventas de maquinado', flow_type: 'income' },
  { id: CAT.servicios, name: 'Servicios de ingeniería', flow_type: 'income' },
  { id: CAT.otros, name: 'Otros ingresos', flow_type: 'income' },
  { id: CAT.nomina, name: 'Nómina', flow_type: 'expense' },
  { id: CAT.materiales, name: 'Materia prima', flow_type: 'expense' },
  { id: CAT.renta, name: 'Renta de nave', flow_type: 'expense' },
  { id: CAT.energia, name: 'Energía (CFE)', flow_type: 'expense' },
  { id: CAT.impuestos, name: 'Impuestos', flow_type: 'expense' },
]

const CONTACTS: Contact[] = [
  { id: 'ct-aeropartes', name: 'Aeropartes del Norte SA', kind: 'customer', email: 'compras@aeropartes.mx' },
  { id: 'ct-automotriz', name: 'Grupo Automotriz Delta', kind: 'customer', email: 'proveedores@delta.mx' },
  { id: 'ct-aceros', name: 'Aceros Especiales de México', kind: 'supplier', email: 'ventas@aceros.mx' },
  { id: 'ct-herramientas', name: 'Herramientas Sandvik', kind: 'supplier', email: 'mx@sandvik.com' },
  { id: 'ct-cfe', name: 'CFE Suministrador', kind: 'service', email: 'facturacion@cfe.mx' },
  { id: 'ct-contador', name: 'Despacho Contable Ríos', kind: 'service', email: 'contacto@rioscpa.mx' },
]

// Spread across 2026 months so the dashboard trend chart has shape.
const TRANSACTIONS: Transaction[] = [
  { id: 'tx-01', date: '2026-01-14', description: 'Anticipo lote flechas — Aeropartes', tx_type: 'income', amount: 320000, category: 'Ventas de maquinado', account_to: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-02', date: '2026-01-22', description: 'Compra acero 4140', tx_type: 'expense', amount: 88500, category: 'Materia prima', account_from: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-03', date: '2026-01-31', description: 'Nómina enero', tx_type: 'expense', amount: 210000, category: 'Nómina', account_from: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-04', date: '2026-02-05', description: 'Finiquito proyecto molde — Delta', tx_type: 'income', amount: 415000, category: 'Ventas de maquinado', account_to: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-05', date: '2026-02-12', description: 'Insertos y herramienta Sandvik', tx_type: 'expense', amount: 63200, category: 'Materia prima', account_from: 'Amex Corporativa', is_confirmed: true },
  { id: 'tx-06', date: '2026-02-18', description: 'Renta nave industrial', tx_type: 'expense', amount: 72000, category: 'Renta de nave', account_from: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-07', date: '2026-02-28', description: 'Nómina febrero', tx_type: 'expense', amount: 214500, category: 'Nómina', account_from: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-08', date: '2026-03-08', description: 'Servicio de ingeniería inversa', tx_type: 'income', amount: 95000, category: 'Servicios de ingeniería', account_to: 'Santander USD', is_confirmed: true },
  { id: 'tx-09', date: '2026-03-15', description: 'Recibo CFE', tx_type: 'expense', amount: 41800, category: 'Energía (CFE)', account_from: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-10', date: '2026-03-20', description: 'Anticipo herramental — Delta', tx_type: 'income', amount: 260000, category: 'Ventas de maquinado', account_to: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-11', date: '2026-03-31', description: 'Nómina marzo', tx_type: 'expense', amount: 218000, category: 'Nómina', account_from: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-12', date: '2026-04-10', description: 'Pago provisional ISR', tx_type: 'expense', amount: 54300, category: 'Impuestos', account_from: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-13', date: '2026-04-18', description: 'Traspaso a caja chica', tx_type: 'transfer', amount: 15000, account_from: 'BBVA MXN', account_to: 'Caja chica', is_confirmed: true },
  { id: 'tx-14', date: '2026-04-24', description: 'Venta refacciones CNC', tx_type: 'income', amount: 132000, category: 'Ventas de maquinado', account_to: 'BBVA MXN', is_confirmed: true },
  { id: 'tx-15', date: '2026-04-30', description: 'Honorarios contables', tx_type: 'expense', amount: 18500, category: 'Impuestos', account_from: 'Caja chica', is_confirmed: false },
]

const RECURRING_PLANS: RecurringPlan[] = [
  { id: 'rp-renta', name: 'Renta de nave', flow_type: 'expense', amount_estimated: 72000, frequency: 'monthly', start_date: '2026-01-01', is_active: true },
  { id: 'rp-nomina', name: 'Nómina quincenal', flow_type: 'expense', amount_estimated: 107000, frequency: 'biweekly', start_date: '2026-01-01', is_active: true },
  { id: 'rp-cfe', name: 'Recibo CFE', flow_type: 'expense', amount_estimated: 42000, frequency: 'monthly', start_date: '2026-01-15', is_active: true },
  { id: 'rp-mantto', name: 'Mantenimiento CNC', flow_type: 'expense', amount_estimated: 25000, frequency: 'quarterly', start_date: '2026-02-01', is_active: true },
]

const PLANNED_ENTRIES: PlannedEntry[] = [
  { id: 'pe-01', name: 'Renta mayo', flow_type: 'expense', amount_estimated: 72000, due_date: '2026-05-01', status: 'planned', status_label: 'Planeado' },
  { id: 'pe-02', name: 'Nómina 1ª quincena mayo', flow_type: 'expense', amount_estimated: 107000, due_date: '2026-05-15', status: 'planned', status_label: 'Planeado' },
  { id: 'pe-03', name: 'Finiquito herramental — Delta', flow_type: 'income', amount_estimated: 390000, due_date: '2026-05-20', status: 'partially_covered', status_label: 'Parcial' },
  { id: 'pe-04', name: 'ISR abril', flow_type: 'expense', amount_estimated: 51000, due_date: '2026-04-17', status: 'overdue', status_label: 'Vencido' },
  { id: 'pe-05', name: 'CFE abril', flow_type: 'expense', amount_estimated: 43000, due_date: '2026-04-15', status: 'covered', status_label: 'Cubierto' },
  { id: 'pe-06', name: 'Compra acero — cancelada', flow_type: 'expense', amount_estimated: 60000, due_date: '2026-04-05', status: 'cancelled', status_label: 'Cancelado' },
]

const FORECASTS: Forecast[] = [
  { id: 'fc-q2', currency: 'MXN', projected_net: 486000, start_date: '2026-04-01', end_date: '2026-06-30', scenario_name: 'Q2 base' },
  { id: 'fc-optim', currency: 'MXN', projected_net: 742000, start_date: '2026-04-01', end_date: '2026-06-30', scenario_name: 'Q2 optimista' },
]

// --- operations --------------------------------------------------------------

const ORDERS: Order[] = [
  { id: 'ord-01', title: 'Maquinado 200 flechas', status: 'in_progress', status_label: 'En proceso', amount: 320000, scheduled_at: '2026-04-12', contact_id: 'ct-aeropartes' },
  { id: 'ord-02', title: 'Molde de inyección serie D', status: 'confirmed', status_label: 'Confirmada', amount: 415000, scheduled_at: '2026-05-02', contact_id: 'ct-automotriz' },
  { id: 'ord-03', title: 'Herramental de estampado', status: 'pending', status_label: 'Pendiente', amount: 260000, scheduled_at: '2026-05-18', contact_id: 'ct-automotriz' },
  { id: 'ord-04', title: 'Refacciones CNC urgentes', status: 'completed', status_label: 'Completada', amount: 132000, scheduled_at: '2026-04-24', contact_id: 'ct-aeropartes' },
]

const PROJECTS: ProjectRow[] = [
  { id: PRJ.a, title: 'Lote 200 flechas — Aeropartes', description: 'Maquinado CNC de flechas de acero 4140', status: 'produccion', status_label: 'Producción', priority: 'high', priority_label: 'Alta', total_budget: 320000, scheduled_at: '2026-04-12', contact_id: 'ct-aeropartes' },
  { id: PRJ.b, title: 'Molde inyección serie D — Delta', description: 'Diseño y manufactura de molde', status: 'ingenieria', status_label: 'Ingeniería', priority: 'urgent', priority_label: 'Urgente', total_budget: 415000, scheduled_at: '2026-05-02', contact_id: 'ct-automotriz' },
  { id: PRJ.c, title: 'Herramental de estampado', description: 'Herramental progresivo', status: 'cotizado', status_label: 'Cotizado', priority: 'medium', priority_label: 'Media', total_budget: 260000, scheduled_at: '2026-05-18', contact_id: 'ct-automotriz' },
]

const CONCEPT_STATUSES: ConceptStatusFull[] = [
  { id: ST.pedido, name: 'Pedido', position: 0, color: 'slate', is_initial: true, is_terminal: false, is_cancelled: false, is_active: true },
  { id: ST.ing, name: 'Ingeniería', position: 1, color: 'sky', is_initial: false, is_terminal: false, is_cancelled: false, is_active: true },
  { id: ST.cnc, name: 'CNC', position: 2, color: 'amber', is_initial: false, is_terminal: false, is_cancelled: false, is_active: true },
  { id: ST.calidad, name: 'Calidad', position: 3, color: 'violet', is_initial: false, is_terminal: false, is_cancelled: false, is_active: true },
  { id: ST.entrega, name: 'Entrega', position: 4, color: 'emerald', is_initial: false, is_terminal: false, is_cancelled: false, is_active: true },
  { id: ST.terminado, name: 'Terminado', position: 5, color: 'green', is_initial: false, is_terminal: true, is_cancelled: false, is_active: true },
  { id: ST.cancelado, name: 'Cancelado', position: 6, color: 'rose', is_initial: false, is_terminal: false, is_cancelled: true, is_active: true },
]

const PROJECT_CONCEPTS: Record<string, ProjectConcept[]> = {
  [PRJ.a]: [
    { id: 'pc-a1', status_id: ST.cnc, name: 'Desbaste flechas', quantity: 200, unit: 'pza', description: 'Careado y cilindrado', estimated_hours: 60, estimated_cost: 90000, position: 0 },
    { id: 'pc-a2', status_id: ST.calidad, name: 'Inspección dimensional', quantity: 200, unit: 'pza', estimated_hours: 16, estimated_cost: 24000, position: 1 },
    { id: 'pc-a3', status_id: ST.pedido, name: 'Tratamiento térmico', quantity: 200, unit: 'pza', estimated_hours: 8, estimated_cost: 40000, position: 2 },
  ],
  [PRJ.b]: [
    { id: 'pc-b1', status_id: ST.ing, name: 'Diseño de molde', quantity: 1, unit: 'job', estimated_hours: 80, estimated_cost: 120000, position: 0 },
    { id: 'pc-b2', status_id: ST.pedido, name: 'Compra de acero P20', quantity: 1, unit: 'lote', estimated_hours: 0, estimated_cost: 95000, position: 1 },
  ],
  [PRJ.c]: [
    { id: 'pc-c1', status_id: ST.pedido, name: 'Cotización de componentes', quantity: 1, unit: 'job', estimated_hours: 12, estimated_cost: 18000, position: 0 },
  ],
}

const RESOURCES: Resource[] = [
  { id: RES.cnc1, name: 'Centro CNC Haus VF-4', resource_type: 'machinery', resource_type_label: 'Maquinaria', is_active: true, hourly_cost: 850, currency: 'MXN', allowed_status_ids: [ST.cnc, ST.calidad] },
  { id: RES.torno, name: 'Torno CNC Mazak', resource_type: 'machinery', resource_type_label: 'Maquinaria', is_active: true, hourly_cost: 780, currency: 'MXN', allowed_status_ids: [ST.cnc] },
  { id: RES.cmm, name: 'CMM Zeiss', resource_type: 'equipment', resource_type_label: 'Equipo', is_active: true, hourly_cost: 620, currency: 'MXN', allowed_status_ids: [ST.calidad] },
  { id: RES.grua, name: 'Grúa viajera 5T', resource_type: 'equipment', resource_type_label: 'Equipo', is_active: true, hourly_cost: 300, currency: 'MXN', allowed_status_ids: [ST.entrega] },
]

const RESOURCE_LOGS: ResourceLog[] = [
  { id: 'rl-01', project_id: PRJ.a, phase: 'CNC', resource_name: 'Centro CNC Haus VF-4', started_at: '2026-04-20T08:00:00Z', ended_at: '2026-04-20T14:30:00Z', duration_hours: 6.5, operator_name: 'J. Domínguez' },
  { id: 'rl-02', project_id: PRJ.a, phase: 'CNC', resource_name: 'Torno CNC Mazak', started_at: '2026-04-20T09:00:00Z', ended_at: '2026-04-20T13:00:00Z', duration_hours: 4, operator_name: 'R. Salas' },
  { id: 'rl-03', project_id: PRJ.a, phase: 'Calidad', resource_name: 'CMM Zeiss', started_at: '2026-04-21T10:00:00Z', ended_at: '2026-04-21T12:00:00Z', duration_hours: 2, operator_name: 'M. Ávila' },
  { id: 'rl-04', project_id: PRJ.b, phase: 'Ingeniería', resource_name: 'Centro CNC Haus VF-4', started_at: '2026-04-22T08:00:00Z', ended_at: null, duration_hours: null, operator_name: 'J. Domínguez' },
]

function buildGrid(): GridView {
  const hours = Array.from({ length: 13 }, (_, i) => i + 6) // 6:00–18:00
  const cellFor = (selectedIds: string[]) =>
    hours.map((hour) => ({
      hour,
      is_work_hour: hour >= 8 && hour <= 17,
      resources: [
        { resource_id: RES.cnc1, label: 'CNC VF-4', selected: selectedIds.includes(RES.cnc1) && hour >= 8 && hour <= 13 },
        { resource_id: RES.torno, label: 'Torno', selected: selectedIds.includes(RES.torno) && hour >= 9 && hour <= 12 },
        { resource_id: RES.cmm, label: 'CMM', selected: selectedIds.includes(RES.cmm) && hour >= 10 && hour <= 11 },
      ],
    }))
  return {
    date: '2026-04-20',
    can_edit: true,
    statuses: [
      { id: ST.cnc, name: 'CNC' },
      { id: ST.calidad, name: 'Calidad' },
    ],
    rows: [
      { concept_id: 'pc-a1', project_id: PRJ.a, project_title: 'Lote 200 flechas', status_name: 'CNC', concept_name: 'Desbaste flechas', quantity: 200, unit: 'pza', cells: cellFor([RES.cnc1, RES.torno]) },
      { concept_id: 'pc-a2', project_id: PRJ.a, project_title: 'Lote 200 flechas', status_name: 'Calidad', concept_name: 'Inspección dimensional', quantity: 200, unit: 'pza', cells: cellFor([RES.cmm]) },
    ],
  }
}

// --- fiscal ------------------------------------------------------------------

const SAT_CONFIGS: SatConfigData[] = [
  { id: 'sat-1', company_id: 'demo-c001', rfc: 'AMA160101AB2', label: 'FIEL Aurora Manufactura', created_at: '2026-01-05T12:00:00Z' },
]

const CFDIS: Cfdi[] = [
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000001', folio: 'A-1042', tipo: 'I', fecha: '2026-04-24', total: 132000, moneda: 'MXN', emisor_nombre: 'Aurora Manufactura', receptor_nombre: 'Aeropartes del Norte SA', es_emitido: true },
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000002', folio: 'A-1041', tipo: 'I', fecha: '2026-03-20', total: 260000, moneda: 'MXN', emisor_nombre: 'Aurora Manufactura', receptor_nombre: 'Grupo Automotriz Delta', es_emitido: true },
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000003', folio: 'F-8890', tipo: 'I', fecha: '2026-02-12', total: 63200, moneda: 'MXN', emisor_nombre: 'Herramientas Sandvik', receptor_nombre: 'Aurora Manufactura', es_emitido: false },
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000004', folio: 'F-2201', tipo: 'I', fecha: '2026-01-22', total: 88500, moneda: 'MXN', emisor_nombre: 'Aceros Especiales de México', receptor_nombre: 'Aurora Manufactura', es_emitido: false },
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000005', folio: 'CFE-771', tipo: 'I', fecha: '2026-03-15', total: 41800, moneda: 'MXN', emisor_nombre: 'CFE Suministrador', receptor_nombre: 'Aurora Manufactura', es_emitido: false },
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000006', folio: 'A-1040', tipo: 'I', fecha: '2026-02-05', total: 415000, moneda: 'MXN', emisor_nombre: 'Aurora Manufactura', receptor_nombre: 'Grupo Automotriz Delta', es_emitido: true },
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000007', folio: 'A-1039', tipo: 'I', fecha: '2026-01-14', total: 320000, moneda: 'MXN', emisor_nombre: 'Aurora Manufactura', receptor_nombre: 'Aeropartes del Norte SA', es_emitido: true },
  { uuid: 'a1b2c3d4-0001-4a1a-9b2c-000000000008', folio: 'E-0007', tipo: 'E', fecha: '2026-03-28', total: 12000, moneda: 'MXN', emisor_nombre: 'Aurora Manufactura', receptor_nombre: 'Grupo Automotriz Delta', es_emitido: true },
]

const CFDI_LIST: CfdiList = {
  company_rfcs: ['AMA160101AB2'],
  items: CFDIS,
}

const CFDI_JOBS: CfdiJob[] = [
  { job_id: 'job-2026-04', label: 'Abril 2026', chunk_start: '2026-04-01', started_at: '2026-05-01T05:00:00Z', status: { status: 'done', imported: 34, transactions_created: 12, transactions_updated: 3, transactions_skipped: 19, errors: [] } },
  { job_id: 'job-2026-03', label: 'Marzo 2026', chunk_start: '2026-03-01', started_at: '2026-04-01T05:00:00Z', status: { status: 'done', imported: 41, transactions_created: 15, transactions_updated: 1, transactions_skipped: 25, errors: [] } },
]

// --- timeline (tiempo) -------------------------------------------------------

// --- timeline (tiempo) --------------------------------------------------------
// The Tiempo page is a virtualized scroller: it fetches buckets for a moving
// [from,to) window and keys them by `start` (which must equal bucketAtIndex's
// ISO). So the demo generates buckets on the fly for whatever range is asked,
// with values that read as a real story: actuals (real_*) up to "now" then stop,
// and a plan that continues into the future — so the two accumulated lines
// visibly diverge past today as you scroll.
type TLMode = 'day' | 'week' | 'month' | 'year'

// Replicated 1:1 from Tiempo.tsx bucketStart/bucketAtIndex so the ISO keys match.
function tlBucketStart(date: Date, mode: TLMode): Date {
  const d = new Date(date.getTime())
  switch (mode) {
    case 'day':
      d.setUTCHours(0, 0, 0, 0)
      return d
    case 'week': {
      const weekday = (d.getUTCDay() + 6) % 7
      d.setUTCDate(d.getUTCDate() - weekday)
      d.setUTCHours(0, 0, 0, 0)
      return d
    }
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  }
}
function tlStep(anchor: Date, mode: TLMode, n: number): Date {
  const d = new Date(anchor.getTime())
  switch (mode) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + n)
      return d
    case 'week':
      d.setUTCDate(d.getUTCDate() + n * 7)
      return d
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear() + n, 0, 1))
  }
}
// Deterministic 0..1 pseudo-random (stable across reloads — no Math.random).
function tlSeed(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}
const TX_INCOME = ['Anticipo lote flechas — Aeropartes', 'Finiquito molde — Delta', 'Venta refacciones CNC', 'Servicio de ingeniería', 'Maquinado herramental', 'Venta de piezas torneadas']
const TX_EXPENSE = ['Compra acero 4140', 'Nómina', 'Insertos Sandvik', 'Renta de nave', 'Recibo CFE', 'Mantenimiento CNC', 'Honorarios contables', 'Materia prima']
const PLAN_INCOME = ['Cobro proyecto', 'Anticipo cliente', 'Finiquito orden']
const PLAN_EXPENSE = ['Nómina quincenal', 'Renta de nave', 'Recibo CFE', 'Compra de acero', 'Pago a proveedores', 'ISR provisional']

interface TLItem { id: string; ms: number; iso: string; amount: number; income: boolean; label: string }

/** Deterministic item pool spread over [monthsBack ago, monthsFwd ahead). */
function genTimelineItems(monthsBack: number, monthsFwd: number, density: number, prefix: string, inc: string[], exp: string[]): TLItem[] {
  const items: TLItem[] = []
  const now = new Date()
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFwd, 1)
  const cur = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1))
  let d = 0
  while (cur.getTime() < end) {
    if (tlSeed(d * 1.7 + prefix.length) < density) {
      const n = 1 + Math.floor(tlSeed(d * 2.3) * 2)
      for (let j = 0; j < n; j++) {
        const income = tlSeed(d * 3.1 + j * 9.7) > 0.6
        const amount = income
          ? Math.round(50_000 + tlSeed(d + j * 5) * 300_000)
          : Math.round(6_000 + tlSeed(d * 5 + j) * 95_000)
        const labels = income ? inc : exp
        items.push({
          id: `${prefix}-${d}-${j}`,
          ms: cur.getTime(),
          iso: cur.toISOString(),
          amount,
          income,
          label: labels[Math.floor(tlSeed(d * 7 + j * 2) * labels.length)],
        })
      }
    }
    cur.setUTCDate(cur.getUTCDate() + 1)
    d++
  }
  return items
}

// Actuals span the past ~30 months; the plan/budget spans the FULL ~4.3-year
// window (past 30 + next 22 months) so every period in range shows both real
// (past) and plan items — no empty buckets until you scroll past the data.
const TL_TX = genTimelineItems(42, 0, 0.62, 'dtx', TX_INCOME, TX_EXPENSE)
const TL_PLAN = genTimelineItems(42, 40, 0.58, 'dpe', PLAN_INCOME, PLAN_EXPENSE)

// Precomputed sorted cumulative nets → O(log n) "net of all items before a time"
// (called per visible bucket per fetch, so keep it cheap regardless of pool size).
function tlCum(items: TLItem[]): { ms: number[]; acc: number[] } {
  const s = [...items].sort((a, b) => a.ms - b.ms)
  const ms: number[] = []
  const acc: number[] = []
  let run = 0
  for (const it of s) {
    run += it.income ? it.amount : -it.amount
    ms.push(it.ms)
    acc.push(run)
  }
  return { ms, acc }
}
const TX_CUM = tlCum(TL_TX)
const PLAN_CUM = tlCum(TL_PLAN)
function tlNetBefore(cum: { ms: number[]; acc: number[] }, ltMs: number): number {
  let lo = 0
  let hi = cum.ms.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (cum.ms[m] < ltMs) lo = m + 1
    else hi = m
  }
  return lo > 0 ? cum.acc[lo - 1] : 0
}

/** Aggregate the item pool into buckets for the requested mode/range — so the
 * chart is populated by real items and switching day/week/month/year reflows. */
function buildTimelineRange(modeRaw: string, fromIso: string, toIso: string): TimelineBucket[] {
  const mode = (['day', 'week', 'month', 'year'].includes(modeRaw) ? modeRaw : 'month') as TLMode
  const to = new Date(toIso).getTime()
  const nowMs = Date.now()
  const realAtNow = tlNetBefore(TX_CUM, nowMs)
  const planBeforeNow = tlNetBefore(PLAN_CUM, nowMs)
  const out: TimelineBucket[] = []
  let cur = tlBucketStart(new Date(fromIso), mode)
  let guard = 0
  const sumInc = (a: TLItem[]) => a.reduce((s, i) => s + (i.income ? i.amount : 0), 0)
  const sumExp = (a: TLItem[]) => a.reduce((s, i) => s + (i.income ? 0 : i.amount), 0)
  while (cur.getTime() < to && guard++ < 4000) {
    const bs = cur.getTime()
    const be = tlStep(cur, mode, 1).getTime()
    const txs = TL_TX.filter((t) => t.ms >= bs && t.ms < be)
    const pes = TL_PLAN.filter((t) => t.ms >= bs && t.ms < be)
    const real_income = sumInc(txs)
    const real_expense = sumExp(txs)
    const planned_income = sumInc(pes)
    const planned_expense = sumExp(pes)
    // Real accumulates through the past then flatlines after now; plan =
    // real-at-now + future plan, so the lines coincide until today then diverge.
    const cumulative_real = Math.round(tlNetBefore(TX_CUM, be))
    const cumulative_planned = Math.round(
      be <= nowMs ? tlNetBefore(TX_CUM, be) : realAtNow + (tlNetBefore(PLAN_CUM, be) - planBeforeNow),
    )
    out.push({
      start: cur.toISOString(),
      end: tlStep(cur, mode, 1).toISOString(),
      real_income,
      real_expense,
      planned_income,
      planned_expense,
      net_real: real_income - real_expense,
      net_planned: planned_income - planned_expense,
      cumulative_real,
      cumulative_planned,
      transactions: txs.map((t) => ({ id: t.id, description: t.label, amount: t.amount, date: t.iso, type: t.income ? 'income' : 'expense' })),
      planned_entries: pes.map((t) => ({ id: t.id, name: t.label, amount_estimated: t.amount, due_date: t.iso, flow_type: t.income ? 'income' : 'expense', status: 'planned' })),
    })
    cur = tlStep(cur, mode, 1)
  }
  return out
}

// --- admin -------------------------------------------------------------------

const COMPANY_DATA: CompanyData[] = [
  { id: 'demo-c001', name: 'Aurora Manufactura', slug: 'demo', default_currency: 'MXN', is_active: true, notes: 'Taller de maquinado CNC', is_current: true },
  { id: 'demo-c002', name: 'Nébula Servicios', slug: 'nebula', default_currency: 'MXN', is_active: true, notes: null, is_current: false },
]

const USERS: UserRowData[] = [
  { id: 'demo-user-1', username: 'demo@auroramfg.mx', role: 'admin', companies: ['Aurora Manufactura'], memberships: [{ company_id: 'demo-c001', company_name: 'Aurora Manufactura', role: 'admin', permissions: [] }], secret: '' },
  { id: 'demo-user-2', username: 'ingenieria@auroramfg.mx', role: 'staff', companies: ['Aurora Manufactura'], memberships: [{ company_id: 'demo-c001', company_name: 'Aurora Manufactura', role: 'staff', permissions: ['view_projects', 'view_timeline'] }], secret: '' },
  { id: 'demo-user-3', username: 'piso@auroramfg.mx', role: 'staff', companies: ['Aurora Manufactura'], memberships: [{ company_id: 'demo-c001', company_name: 'Aurora Manufactura', role: 'staff', permissions: ['edit_resource_usage_today'] }], secret: '' },
]

// --- detail projections (edit modals) ----------------------------------------

const accountDetail = (id: string): AccountDetail => {
  const a = ACCOUNTS.find((x) => x.id === id) ?? ACCOUNTS[0]
  return { name: a.name, account_type: a.account_type, currency: a.currency, is_active: a.is_active, notes: null }
}
const categoryDetail = (id: string): CategoryDetail => {
  const c = CATEGORIES.find((x) => x.id === id) ?? CATEGORIES[0]
  return { name: c.name, flow_type: c.flow_type, parent_id: null, notes: null }
}
const contactDetail = (id: string): ContactDetail => {
  const c = CONTACTS.find((x) => x.id === id) ?? CONTACTS[0]
  return { name: c.name, contact_type: c.kind, rfc: null, email: c.email ?? null, phone: null, notes: null }
}
const forecastDetail = (id: string): ForecastDetail => {
  const f = FORECASTS.find((x) => x.id === id) ?? FORECASTS[0]
  return { generated_at: f.start_date, start_date: f.start_date, end_date: f.end_date, currency: f.currency, projected_income_total: f.projected_net + 400000, projected_expense_total: 400000, initial_balance: 250000, final_balance: 250000 + f.projected_net, details: null, scenario_name: f.scenario_name ?? null, notes: null }
}
const orderDetail = (id: string): OrderDetail => {
  const o = ORDERS.find((x) => x.id === id) ?? ORDERS[0]
  return { title: o.title, contact_id: o.contact_id ?? null, category_id: CAT.ventas, account_id: ACC.bbva, status: o.status, amount: o.amount, scheduled_at: o.scheduled_at ?? null, items: [{ description: 'Maquinado', quantity: 1, unit_price: o.amount }], notes: null }
}
const projectDetail = (id: string): ProjectDetail => {
  const p = PROJECTS.find((x) => x.id === id) ?? PROJECTS[0]
  return { title: p.title, contact_id: p.contact_id ?? null, category_id: CAT.ventas, description: p.description ?? null, priority: p.priority, total_budget: p.total_budget ?? null, scheduled_at: p.scheduled_at ?? null, notes: null }
}
const resourceDetail = (id: string): ResourceDetail => {
  const r = RESOURCES.find((x) => x.id === id) ?? RESOURCES[0]
  return { name: r.name, resource_type: r.resource_type, is_active: r.is_active, hourly_cost: r.hourly_cost, currency: r.currency, allowed_status_ids: r.allowed_status_ids, notes: null }
}
const cfdiDetail = (uuid: string): CfdiDetailResponse => {
  const c = CFDIS.find((x) => x.uuid === uuid) ?? CFDIS[0]
  return {
    ...c,
    conceptos: [
      { descripcion: 'Servicio de maquinado CNC', cantidad: 1, valor_unitario: c.total, importe: c.total, clave_prod_serv: '81111500', unidad: 'Servicio' },
    ],
  }
}

// --- request router ----------------------------------------------------------

const seg = (path: string): string[] => path.split('/').filter(Boolean)

/** Resolve a GET to its fixture. Ordered from most specific to generic. */
function resolve(path: string): unknown {
  // identity / misc
  if (path === '/api/me') return DEMO_ME
  if (path === '/api/account') return DEMO_PROFILE
  if (path === '/api/onboarding/status') return DEMO_ONBOARDING
  // /api/tiempo is handled in demoGet (needs the mode/from/to params).

  // fiscal (non-conventional /data + nested jobs)
  if (path === '/api/admin/cfdis/data') return CFDI_LIST
  if (path.startsWith('/api/admin/cfdis/')) return cfdiDetail(seg(path).pop() as string)
  if (path.includes('/cfdi/jobs')) return CFDI_JOBS
  if (path === '/api/admin/sat-configs') return SAT_CONFIGS
  if (path.startsWith('/api/admin/sat-configs/')) return SAT_CONFIGS[0]

  // transactions (list at /data)
  if (path === '/api/admin/transactions/data') return TRANSACTIONS
  if (path.startsWith('/api/admin/transactions/')) {
    const t = TRANSACTIONS.find((x) => x.id === seg(path).pop())
    return t ? { date: t.date, description: t.description, transaction_type: t.tx_type, category_id: CAT.ventas, account_from_id: ACC.bbva, account_to_id: null, amount: t.amount, planned_entry_id: null, is_confirmed: t.is_confirmed, notes: null } : {}
  }

  // resource usage grid (query params)
  if (path.startsWith('/api/admin/resource_usages/grid')) return buildGrid()

  // projects: list, then nested concepts / status_summary, then detail
  if (path === '/api/admin/projects') return PROJECTS
  if (path.endsWith('/status_summary')) return {}
  if (path.endsWith('/concepts')) {
    const pid = seg(path)[seg(path).length - 2]
    return PROJECT_CONCEPTS[pid] ?? []
  }
  if (path.startsWith('/api/admin/projects/')) return projectDetail(seg(path).pop() as string)

  // finance + operations lists and details
  if (path === '/api/admin/accounts') return ACCOUNTS
  if (path.startsWith('/api/admin/accounts/')) return accountDetail(seg(path).pop() as string)
  if (path === '/api/admin/categories') return CATEGORIES
  if (path.startsWith('/api/admin/categories/')) return categoryDetail(seg(path).pop() as string)
  if (path === '/api/admin/contacts') return CONTACTS
  if (path.startsWith('/api/admin/contacts/')) return contactDetail(seg(path).pop() as string)
  if (path === '/api/admin/recurring-plans') return RECURRING_PLANS
  if (path.startsWith('/api/admin/recurring-plans/')) {
    const r = RECURRING_PLANS.find((x) => x.id === seg(path).pop()) ?? RECURRING_PLANS[0]
    return { name: r.name, flow_type: r.flow_type, category_id: CAT.renta, account_expected_id: ACC.bbva, contact_id: null, amount_estimated: r.amount_estimated, frequency: r.frequency, day_of_month: 1, start_date: r.start_date, end_date: null, is_active: r.is_active, version: 1, notes: null }
  }
  if (path === '/api/admin/planned-entries') return PLANNED_ENTRIES
  if (path.startsWith('/api/admin/planned-entries/')) {
    const p = PLANNED_ENTRIES.find((x) => x.id === seg(path).pop()) ?? PLANNED_ENTRIES[0]
    return { name: p.name, flow_type: p.flow_type, category_id: CAT.renta, account_expected_id: ACC.bbva, contact_id: null, amount_estimated: p.amount_estimated, due_date: p.due_date, status: p.status, project_id: null, notes: null }
  }
  if (path === '/api/admin/forecasts') return FORECASTS
  if (path.startsWith('/api/admin/forecasts/')) return forecastDetail(seg(path).pop() as string)
  if (path === '/api/admin/orders') return ORDERS
  if (path.startsWith('/api/admin/orders/')) return orderDetail(seg(path).pop() as string)
  if (path === '/api/admin/concept_statuses') return CONCEPT_STATUSES
  if (path === '/api/admin/resources') return RESOURCES
  if (path.startsWith('/api/admin/resources/')) return resourceDetail(seg(path).pop() as string)
  if (path === '/api/admin/resource_logs') return RESOURCE_LOGS
  if (path.startsWith('/api/admin/resource_logs/')) {
    const l = RESOURCE_LOGS.find((x) => x.id === seg(path).pop()) ?? RESOURCE_LOGS[0]
    return { project_id: l.project_id ?? null, phase: l.phase ?? null, resource_id: RES.cnc1, started_at: l.started_at, ended_at: l.ended_at ?? null, operator_name: l.operator_name ?? null, notes: null }
  }

  // admin
  if (path === '/api/admin/companies') return COMPANY_DATA
  if (path.startsWith('/api/admin/companies/')) return COMPANY_DATA[0]
  if (path === '/api/admin/users') return USERS
  if (path.startsWith('/api/admin/users/')) return USERS[0]

  return null
}

export async function demoGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const p = path.split('?')[0]
  // Timeline needs the requested range (mode/from/to) to generate matching buckets.
  if (p === '/api/tiempo' && params) {
    return buildTimelineRange(
      String(params.mode ?? 'month'),
      String(params.from ?? ''),
      String(params.to ?? ''),
    ) as T
  }
  const v = resolve(p)
  // Unknown endpoints default to an empty list, which renders cleanly.
  return (v ?? []) as T
}

/** Mutations are disabled in the demo — no-op and tell the user (throttled). */
let mutationToastAt = -100000
export async function demoMutation<T>(_path: string): Promise<T> {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (now - mutationToastAt > 1500) {
    mutationToastAt = now
    toast.info('Demo de solo lectura', 'Aquí no se guardan cambios. Solicita acceso para usarlo con tus datos.')
  }
  // Resolve with a benign shape; callers that read a field just get undefined.
  return {} as T
}

/** QR/image blobs — return a 1x1 transparent PNG so <img> doesn't error. */
export async function demoBlob(_path: string): Promise<Blob> {
  const bytes = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  )
  return new Blob([bytes], { type: 'image/png' })
}
