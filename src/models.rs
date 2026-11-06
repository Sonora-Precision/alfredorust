// models.rs
// Domain models for auth/multitenancy and finance entities (MongoDB).

use mongodb::bson::{DateTime, oid::ObjectId};
use serde::{Deserialize, Serialize};

/// ---------- AUTH / PLATFORM LAYER ----------

/// User roles for authorization (system-level).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Admin,
    Staff,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum UserPermission {
    ViewProjects,
    ViewProjectMoney,
    EditResourceUsageToday,
    ViewResourceUsageHistory,
    ViewTimeline,
    /// See the production board (work-order queues) and the plant view.
    ViewProductionBoard,
    /// Take a free work order, release your own and mark your step done.
    TakeWorkOrders,
    /// Assign work orders to anyone and change the production sequence.
    ManageProductionBoard,
    /// Quality: release or reject produced pieces. Only released pieces count as finished.
    ReleaseParts,
}

impl UserPermission {
    pub fn as_str(&self) -> &'static str {
        match self {
            UserPermission::ViewProjects => "view_projects",
            UserPermission::ViewProjectMoney => "view_project_money",
            UserPermission::EditResourceUsageToday => "edit_resource_usage_today",
            UserPermission::ViewResourceUsageHistory => "view_resource_usage_history",
            UserPermission::ViewTimeline => "view_timeline",
            UserPermission::ViewProductionBoard => "view_production_board",
            UserPermission::TakeWorkOrders => "take_work_orders",
            UserPermission::ManageProductionBoard => "manage_production_board",
            UserPermission::ReleaseParts => "release_parts",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "view_projects" => Some(UserPermission::ViewProjects),
            "view_project_money" => Some(UserPermission::ViewProjectMoney),
            "edit_resource_usage_today" => Some(UserPermission::EditResourceUsageToday),
            "view_resource_usage_history" => Some(UserPermission::ViewResourceUsageHistory),
            "view_timeline" => Some(UserPermission::ViewTimeline),
            "view_production_board" => Some(UserPermission::ViewProductionBoard),
            "take_work_orders" => Some(UserPermission::TakeWorkOrders),
            "manage_production_board" => Some(UserPermission::ManageProductionBoard),
            "release_parts" => Some(UserPermission::ReleaseParts),
            _ => None,
        }
    }
}

impl UserRole {
    pub fn default_admin() -> Self {
        UserRole::Admin
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            UserRole::Admin => "admin",
            UserRole::Staff => "staff",
        }
    }

    pub fn is_admin(&self) -> bool {
        matches!(self, UserRole::Admin)
    }
}

impl Default for UserRole {
    fn default() -> Self {
        UserRole::Staff
    }
}

/// Seed user definition as stored in users.json (company referenced by name).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedUser {
    #[serde(alias = "email")]
    pub username: String,
    pub secret: String,
    /// Primary company by name (backwards compatibility).
    pub company: String,
    /// Additional companies by name (including the primary if you want).
    #[serde(default)]
    pub companies: Vec<String>,
    #[serde(default = "UserRole::default_admin")]
    pub role: UserRole,
}

/// Company document stored in MongoDB.
/// This acts as the "tenant" or organization for all finance entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Company {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub name: String,

    /// URL-friendly identifier; must be unique.
    #[serde(default)]
    pub slug: String,

    /// Default currency for this company (tenant), e.g. "MXN", "USD".
    #[serde(default)]
    pub default_currency: String,

    /// Whether this company is active.
    #[serde(default = "default_true")]
    pub is_active: bool,

    /// Optional timestamps (you can fill these when inserting/updating).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    /// Optional notes / description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_zero() -> f64 {
    0.0
}

fn default_mxn() -> String {
    "MXN".to_string()
}

/// User document stored in MongoDB referencing the company by ObjectId.
/// Each user belongs to exactly one company (tenant) in this first version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    /// Login identifier — a unique handle, not a validated email address.
    /// Accepts the legacy `email` key so docs not yet touched by the rename
    /// migration still load.
    #[serde(alias = "email")]
    pub username: String,
    pub secret: String,

    /// Primary tenant the user belongs to (for compatibility).
    #[serde(rename = "company", skip_serializing_if = "Option::is_none")]
    pub company_id: Option<ObjectId>,

    /// All companies the user can access.
    #[serde(rename = "companies", default)]
    pub company_ids: Vec<ObjectId>,

    /// Name shown on the shop floor ("José Márquez") instead of the login handle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// User-company membership with per-company role.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserCompany {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub user_id: ObjectId,
    pub company_id: ObjectId,
    pub role: UserRole,

    #[serde(default)]
    pub permissions: Vec<UserPermission>,
}

/// Session document stored in MongoDB linking a token to a user and expiry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub token: String,
    pub user_email: String,
    pub expires_at: DateTime,
}

/// Revocable personal access token. Only a SHA-256 digest is persisted; the
/// plaintext token is returned exactly once when it is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToken {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub public_id: String,
    pub secret_hash: String,
    pub token_prefix: String,
    pub user_id: ObjectId,
    pub name: String,
    pub created_at: DateTime,
    pub expires_at: DateTime,
    pub last_used_at: Option<DateTime>,
    pub revoked_at: Option<DateTime>,
}

/// ---------- SHARED ENUMS FOR FINANCE DOMAIN ----------

/// Basic income/expense kind used by categories, recurring plans, planned entries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowType {
    Income,
    Expense,
}

impl FlowType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FlowType::Income => "income",
            FlowType::Expense => "expense",
        }
    }
}

/// Account type (bank, cash, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountType {
    Bank,
    Cash,
    CreditCard,
    Investment,
    Other,
}

impl AccountType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AccountType::Bank => "bank",
            AccountType::Cash => "cash",
            AccountType::CreditCard => "credit_card",
            AccountType::Investment => "investment",
            AccountType::Other => "other",
        }
    }
}

/// Transaction type: income, expense or internal transfer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransactionType {
    Income,
    Expense,
    Transfer,
}

impl TransactionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            TransactionType::Income => "income",
            TransactionType::Expense => "expense",
            TransactionType::Transfer => "transfer",
        }
    }
}

/// Contact type (customer, supplier, service, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContactType {
    Customer,
    Supplier,
    Service,
    Other,
}

impl ContactType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContactType::Customer => "customer",
            ContactType::Supplier => "supplier",
            ContactType::Service => "service",
            ContactType::Other => "other",
        }
    }
}

/// Status of a planned entry (commitment/budget item).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlannedStatus {
    Planned,
    PartiallyCovered,
    Covered,
    Overdue,
    Cancelled,
}

impl PlannedStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            PlannedStatus::Planned => "planned",
            PlannedStatus::PartiallyCovered => "partially_covered",
            PlannedStatus::Covered => "covered",
            PlannedStatus::Overdue => "overdue",
            PlannedStatus::Cancelled => "cancelled",
        }
    }
}

/// ---------- FINANCE ENTITIES (SCOPED BY COMPANY/TENANT) ----------

/// Financial account (bank account, cash, credit card, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Tenant this account belongs to.
    pub company_id: ObjectId,

    pub name: String,
    pub account_type: AccountType,

    /// ISO-like currency code, e.g. "MXN", "USD".
    pub currency: String,

    #[serde(default = "default_true")]
    pub is_active: bool,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Category for incomes/expenses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Tenant this category belongs to.
    pub company_id: ObjectId,

    pub name: String,
    pub flow_type: FlowType,

    /// Optional parent category for hierarchy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Contact: customer, supplier, service (CFE, landlord, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Tenant this contact belongs to.
    pub company_id: ObjectId,

    pub name: String,
    pub contact_type: ContactType,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rfc: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// RecurringPlan: template for recurring income/expense,
/// e.g. "Electricity CFE every month on day 10, estimated 2000 MXN".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecurringPlan {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Tenant this plan belongs to.
    pub company_id: ObjectId,

    pub name: String,
    pub flow_type: FlowType,

    pub category_id: ObjectId,
    pub account_expected_id: ObjectId,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<ObjectId>,

    pub amount_estimated: f64,

    /// Frequency: usually "monthly", "weekly", "yearly".
    pub frequency: String,

    /// Day of month (1–31) if frequency is monthly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_of_month: Option<i32>,

    pub start_date: DateTime,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_date: Option<DateTime>,

    /// Whether this recurring plan is active.
    #[serde(default = "default_true")]
    pub is_active: bool,

    /// Version number for detecting outdated PlannedEntries.
    #[serde(default = "default_one")]
    pub version: i32,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

fn default_one() -> i32 {
    1
}

/// PlannedEntry: concrete commitment/budget item with a due date,
/// used by the "traffic light" (semaphore) and to match with real transactions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedEntry {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Tenant this planned entry belongs to.
    pub company_id: ObjectId,

    /// Optional link to the recurring plan that generated this entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring_plan_id: Option<ObjectId>,

    /// Version of the RecurringPlan at the time this entry was generated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring_plan_version: Option<i32>,

    /// Optional link to the service order that generated this entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_order_id: Option<ObjectId>,

    /// Optional project this commitment belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ObjectId>,

    /// Optional estimated commitment that this real commitment helps cover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_planned_entry_id: Option<ObjectId>,

    pub name: String,
    pub flow_type: FlowType,

    pub category_id: ObjectId,
    pub account_expected_id: ObjectId,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<ObjectId>,

    pub amount_estimated: f64,

    /// Snapshot of amount_estimated before the first real payment aligned it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_amount_estimated: Option<f64>,

    /// Due date of this specific commitment (e.g. 10th of November).
    pub due_date: DateTime,

    /// Snapshot of due_date before the first real payment aligned it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_due_date: Option<DateTime>,

    pub status: PlannedStatus,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    /// UUID of the CFDI/factura that originated this commitment, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfdi_uuid: Option<String>,

    /// Currency code from the CFDI (e.g. "MXN", "USD").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,

    /// Serie-Folio of the CFDI (e.g. "REGT-474850").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfdi_folio: Option<String>,
}

/// Transaction: real movement (income, expense, transfer).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Tenant this transaction belongs to.
    pub company_id: ObjectId,

    pub date: DateTime,
    pub description: String,

    pub transaction_type: TransactionType,
    pub category_id: ObjectId,

    /// For expenses or transfers (money goes out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_from_id: Option<ObjectId>,

    /// For incomes or transfers (money goes in).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_to_id: Option<ObjectId>,

    pub amount: f64,

    /// Optional link to the planned entry this transaction is covering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_entry_id: Option<ObjectId>,

    /// Optional project this real movement belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ObjectId>,

    #[serde(default = "default_true")]
    pub is_confirmed: bool,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    /// Contact (client/supplier) linked to this transaction, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<ObjectId>,

    /// UUID of the CFDI/factura that originated this transaction, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfdi_uuid: Option<String>,

    /// Currency code from the CFDI (e.g. "MXN", "USD").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,

    /// Serie-Folio of the CFDI (e.g. "REGT-474850").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfdi_folio: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// ---------- SERVICE ORDERS ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Pending,
    Confirmed,
    InProgress,
    Completed,
    Cancelled,
}

impl OrderStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderStatus::Pending => "pending",
            OrderStatus::Confirmed => "confirmed",
            OrderStatus::InProgress => "in_progress",
            OrderStatus::Completed => "completed",
            OrderStatus::Cancelled => "cancelled",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            OrderStatus::Pending => "Pendiente",
            OrderStatus::Confirmed => "Confirmada",
            OrderStatus::InProgress => "En proceso",
            OrderStatus::Completed => "Completada",
            OrderStatus::Cancelled => "Cancelada",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct OrderItem {
    pub description: String,
    pub quantity: f64,
    pub unit_price: f64,
}

impl OrderItem {
    pub fn subtotal(&self) -> f64 {
        self.quantity * self.unit_price
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceOrder {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_entry_id: Option<ObjectId>,

    pub title: String,
    pub status: OrderStatus,
    pub amount: f64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<ObjectId>,

    #[serde(default)]
    pub items: Vec<OrderItem>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// Forecast: optional snapshot of a projection (3, 6, 12 months, scenarios, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Forecast {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    /// Tenant this forecast belongs to.
    pub company_id: ObjectId,

    pub generated_at: DateTime,

    /// Optional user that generated this forecast.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_by_user_id: Option<ObjectId>,

    pub start_date: DateTime,
    pub end_date: DateTime,
    pub currency: String,

    pub projected_income_total: f64,
    pub projected_expense_total: f64,
    pub projected_net: f64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_balance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_balance: Option<f64>,

    /// Optional JSON/text field to store detailed breakdown
    /// (per month, per category, scenario parameters, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,

    /// Optional scenario name, e.g. "base", "reduce_restaurants_20".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_name: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// ---------- SAT ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SatConfig {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    pub rfc: String,
    pub cer_path: String,
    pub key_path: String,
    pub key_password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: DateTime,
}

/// ---------- PROJECTS ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStatus {
    Pedidos,
    Analisis,
    Cotizado,
    OrdenDeCompraMandada,
    Ingenieria,
    Produccion,
    Calidad,
    EsperandoEntrega,
    Entregado,
    Cancelado,
}

impl ProjectStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectStatus::Pedidos => "pedidos",
            ProjectStatus::Analisis => "analisis",
            ProjectStatus::Cotizado => "cotizado",
            ProjectStatus::OrdenDeCompraMandada => "orden_de_compra_mandada",
            ProjectStatus::Ingenieria => "ingenieria",
            ProjectStatus::Produccion => "produccion",
            ProjectStatus::Calidad => "calidad",
            ProjectStatus::EsperandoEntrega => "esperando_entrega",
            ProjectStatus::Entregado => "entregado",
            ProjectStatus::Cancelado => "cancelado",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            ProjectStatus::Pedidos => "Pedidos",
            ProjectStatus::Analisis => "Análisis",
            ProjectStatus::Cotizado => "Cotizado",
            ProjectStatus::OrdenDeCompraMandada => "Orden de Compra Mandada",
            ProjectStatus::Ingenieria => "Ingeniería",
            ProjectStatus::Produccion => "Producción",
            ProjectStatus::Calidad => "Calidad",
            ProjectStatus::EsperandoEntrega => "Esperando Entrega",
            ProjectStatus::Entregado => "Entregado",
            ProjectStatus::Cancelado => "Cancelado",
        }
    }
    pub fn next(&self) -> Option<Self> {
        match self {
            ProjectStatus::Pedidos => Some(ProjectStatus::Analisis),
            ProjectStatus::Analisis => Some(ProjectStatus::Cotizado),
            ProjectStatus::Cotizado => Some(ProjectStatus::OrdenDeCompraMandada),
            ProjectStatus::OrdenDeCompraMandada => Some(ProjectStatus::Ingenieria),
            ProjectStatus::Ingenieria => Some(ProjectStatus::Produccion),
            ProjectStatus::Produccion => Some(ProjectStatus::Calidad),
            ProjectStatus::Calidad => Some(ProjectStatus::EsperandoEntrega),
            ProjectStatus::EsperandoEntrega => Some(ProjectStatus::Entregado),
            ProjectStatus::Entregado => None,
            ProjectStatus::Cancelado => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProjectPriority {
    Low,
    #[default]
    Medium,
    High,
    Urgent,
}

impl ProjectPriority {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectPriority::Low => "low",
            ProjectPriority::Medium => "medium",
            ProjectPriority::High => "high",
            ProjectPriority::Urgent => "urgent",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            ProjectPriority::Low => "Baja",
            ProjectPriority::Medium => "Media",
            ProjectPriority::High => "Alta",
            ProjectPriority::Urgent => "Urgente",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<ObjectId>,

    pub title: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    pub status: ProjectStatus,

    #[serde(default)]
    pub priority: ProjectPriority,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_budget: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// ---------- CONFIGURABLE CONCEPT STATUSES ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConceptStatus {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub name: String,
    pub position: i32,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    #[serde(default)]
    pub is_initial: bool,

    #[serde(default)]
    pub is_terminal: bool,

    #[serde(default)]
    pub is_cancelled: bool,

    #[serde(default = "default_true")]
    pub is_active: bool,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// A line item/part inside a project, e.g. "Engrane A, 5 piezas".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConcept {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub project_id: ObjectId,
    pub status_id: ObjectId,
    pub name: String,

    #[serde(default = "default_one_f64")]
    pub quantity: f64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_hours: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost: Option<f64>,

    /// Quoted sale price per piece (admin only; drives "valor producido").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_price: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    #[serde(default)]
    pub position: i32,

    /// Work-order folio (OT-0142), sequential per company and never reused. Parts created
    /// before the production board get one the first time the board is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_order_number: Option<i64>,

    /// Manual place in the production sequence. Pinned orders (with a rank) go first, by
    /// rank; the rest follow the automatic order (priority, date, folio).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_rank: Option<f64>,

    /// Overrides the project priority for this part only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority_override: Option<ProjectPriority>,

    /// Pieces produced so far (all steps ✔ or N/A). They count as finished only once quality
    /// releases them; rejected ones are made again, so this may reach quantity + rejected.
    #[serde(default)]
    pub completed_quantity: f64,

    /// Pieces released by quality (0..=quantity). Project progress is Σ released ÷ Σ ordered.
    #[serde(default)]
    pub released_quantity: f64,

    /// Pieces rejected by quality.
    #[serde(default)]
    pub rejected_quantity: f64,

    /// Process steps someone has marked. Catalog operations missing here are pending, so a
    /// part created before an operation was added still shows it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub process_steps: Vec<PartStep>,

    /// Material and blank size (add-part-material §1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<PartMaterial>,

    /// Quoting inputs (admin only): SolidWorks blank weight and price multiplier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<PartQuote>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// What a part is cut from: material, shape and the blank per piece in inches (thickness ×
/// width × cut length; a round bar keeps its diameter in `thickness`). Replaces the
/// shop's material Excel (Daniel, 2026-11-03).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PartMaterial {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    /// Free text, as ordered: "1/2\" X .625\" X 80\"".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bar_to_order: Option<String>,
    #[serde(default)]
    pub customer_supplied: bool,
    #[serde(default)]
    pub ordered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// How a part is quoted (add-part-quoting): the blank weight from SolidWorks when Daniel
/// has it (else computed from the blank) and the multiplier over the material cost.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PartQuote {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight_kg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiplier: Option<f64>,
}

/// Company data printed on quotes (add-quote-document), once per company.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuoteSettings {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    #[serde(default)]
    pub company_id: ObjectId,
    #[serde(default)]
    pub company_name: String,
    #[serde(default)]
    pub address1: String,
    #[serde(default)]
    pub address2: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub web: String,
    #[serde(default = "default_iva_rate")]
    pub iva_rate: f64,
    #[serde(default = "default_retention_rate")]
    pub retention_rate: f64,
    /// Small image as a data URL ("data:image/jpeg;base64,…").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_data_url: Option<String>,
}

fn default_iva_rate() -> f64 {
    0.16
}
fn default_retention_rate() -> f64 {
    0.0125
}

/// Quote values of a client (the CLIENTES sheet of the template), keyed by its contact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClientQuoteDefaults {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    pub contact_id: ObjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abbreviation: Option<String>,
    /// "MXN" or "USD".
    pub currency: String,
    /// "es" or "en".
    pub language: String,
    pub iva: bool,
    pub retention: bool,
    pub validity_days: i32,
    /// 50 = 50 %.
    pub advance_pct: f64,
    #[serde(default)]
    pub people: Vec<ClientPerson>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClientPerson {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// A quote sent to a client; each revision is its own record. It is made before the project
/// exists (Daniel, 2026-11-06): `project_id` is set when the approved quote becomes a project
/// (older quotes were made from a project and carry it from the start).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ObjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<ObjectId>,
    pub client_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_initials: Option<String>,
    /// "261103-01"; the folio is base + "-" + revision as two digits.
    pub folio_base: String,
    pub revision: i32,
    pub date: DateTime,
    pub currency: String,
    pub language: String,
    pub iva: bool,
    pub retention: bool,
    pub iva_rate: f64,
    pub retention_rate: f64,
    pub discount: f64,
    pub delivery_time: i32,
    /// "dias" (business days) or "semanas".
    pub delivery_unit: String,
    pub validity_days: i32,
    pub advance_pct: f64,
    #[serde(default)]
    pub notes: Vec<String>,
    pub lines: Vec<QuoteItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<DateTime>,
    pub created_by: ObjectId,
    pub created_at: DateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuoteItem {
    pub item: i32,
    pub quantity: f64,
    pub description: String,
    pub unit_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concept_id: Option<ObjectId>,
    /// What the part is cut from, for the suggested price; it goes to the part when the quote
    /// becomes a project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<PartMaterial>,
    /// SolidWorks weight and multiplier, as on a part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight_kg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiplier: Option<f64>,
}

/// Price per kg of a material for the company (MXN before tax). Admin only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialPrice {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    pub material: String,
    pub price_per_kg: f64,
    /// "manual" today; "cfdi" once learned from supplier invoices.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub updated_by: ObjectId,
    pub updated_at: DateTime,
}

/// A supplier delivery read from its invoice (CFDI or captured lines). Never holds prices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialReceipt {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    pub supplier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfdi_uuid: Option<String>,
    pub received_at: DateTime,
    pub lines: Vec<ReceiptLine>,
    pub created_by: ObjectId,
    pub created_at: DateTime,
}

/// One invoice line read as a bar.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReceiptLine {
    pub line: i32,
    pub description: String,
    pub quantity: f64,
    pub unit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    /// Bars in the line ("( 1 pz )").
    #[serde(default = "default_one_f64")]
    pub pieces: f64,
    /// Parts Daniel assigned this bar to.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub concept_ids: Vec<ObjectId>,
}

fn default_one_f64() -> f64 {
    1.0
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Pending,
    Done,
    NotApplicable,
}

impl StepState {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(StepState::Pending),
            "done" => Some(StepState::Done),
            "not_applicable" => Some(StepState::NotApplicable),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            StepState::Pending => "pending",
            StepState::Done => "done",
            StepState::NotApplicable => "not_applicable",
        }
    }
}

/// One step of a part's process route. `name` is a snapshot, so renaming or deactivating the
/// catalog operation keeps the recorded history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartStep {
    pub operation_id: ObjectId,
    pub name: String,
    pub state: StepState,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,

    /// Who is responsible for this step on the production board.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_user_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_at: Option<DateTime>,
}

/// Production-board queue an operation belongs to. Operations without a queue (e.g.
/// Material) stay in the checklist but never put a part on the board.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WorkQueue {
    Programming,
    Setup,
    Machining,
    Finishing,
}

impl WorkQueue {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "programming" => Some(WorkQueue::Programming),
            "setup" => Some(WorkQueue::Setup),
            "machining" => Some(WorkQueue::Machining),
            "finishing" => Some(WorkQueue::Finishing),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            WorkQueue::Programming => "programming",
            WorkQueue::Setup => "setup",
            WorkQueue::Machining => "machining",
            WorkQueue::Finishing => "finishing",
        }
    }
}

/// Per-company catalog of process operations (Material, Programa, Setup 1, …) shown as the
/// checklist of every part.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessOperation {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub name: String,
    pub position: i32,

    #[serde(default = "default_true")]
    pub is_active: bool,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<WorkQueue>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkOrderEventKind {
    Assigned,
    Unassigned,
    Taken,
    Released,
    StepDone,
    StepReopened,
    Pinned,
    Unpinned,
    /// Produced pieces changed; see `pieces_delta`.
    PiecesRecorded,
    /// Quality released pieces (`pieces_delta`); only these count as finished.
    PiecesReleased,
    /// Quality rejected pieces (`pieces_delta`, `reason`); they must be made again.
    PiecesRejected,
}

/// Append-only log of what happened to a work order; the weekly report and the plant view
/// read from it, so nothing is captured twice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkOrderEvent {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub concept_id: ObjectId,
    pub project_id: ObjectId,
    pub kind: WorkOrderEventKind,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_name: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<WorkQueue>,

    pub actor_user_id: ObjectId,

    /// Assigned / Taken: the new assignee. StepDone: who gets the credit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_user_id: Option<ObjectId>,

    /// Taken next to a similar part: the order it was grouped with, and why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub related_to: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,

    /// PiecesRecorded: finished pieces added (negative = corrected down). The actor is who
    /// ticked it, not who earns it: the weekly value goes to the people of each step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pieces_delta: Option<f64>,

    /// PiecesRecorded: the part's price per piece at that moment, frozen for the report.
    /// Never sent to users who cannot see money.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_price: Option<f64>,

    pub at: DateTime,
}

/// ---------- PART FILES ----------

/// A file attached to a part number. Today only the PDF drawing (Daniel, 2026-11-03); the
/// kind leaves room for CAD, CNC programs and tool lists. Every upload is kept; the newest
/// one not deleted is the current drawing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartFile {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub project_id: ObjectId,
    pub concept_id: ObjectId,
    /// "drawing".
    pub kind: String,
    pub original_filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    /// Path under the file store root: `{company}/{concept}/{file}.pdf`.
    pub storage_key: String,
    pub uploaded_by: ObjectId,
    pub uploaded_at: DateTime,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<DateTime>,
}

/// ---------- PLANT VIEW ----------

/// Where a machine sits on the plant drawing (layout units; `rotation` in degrees).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlacedMachine {
    pub resource_id: ObjectId,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub rotation: f64,
    /// "Corte", "Tornos CNC", "Centros de maquinado"… for the legend and grouping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlantLabel {
    pub text: String,
    pub x: f64,
    pub y: f64,
}

/// The company's shop drawn from above: outer walls, inner walls and machine places. One
/// per company; the admin replaces it as a whole.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlantLayout {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    pub width: f64,
    pub height: f64,
    /// Outer wall polygon.
    pub walls: Vec<[f64; 2]>,
    /// Inner walls / rooms as open polylines.
    #[serde(default)]
    pub rooms: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    pub labels: Vec<PlantLabel>,
    #[serde(default)]
    pub machines: Vec<PlacedMachine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MachineStatus {
    Working,
    Setup,
    Stopped,
}

impl MachineStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "working" => Some(MachineStatus::Working),
            "setup" => Some(MachineStatus::Setup),
            "stopped" => Some(MachineStatus::Stopped),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            MachineStatus::Working => "working",
            MachineStatus::Setup => "setup",
            MachineStatus::Stopped => "stopped",
        }
    }
}

/// Last state someone set by hand on a machine (needed for machines without DNC; also
/// "setup", which the DNC cannot tell apart from a stop). One per machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineState {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    pub resource_id: ObjectId,
    pub status: MachineStatus,
    /// The order it is working on, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concept_id: Option<ObjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Setup or operation it is running ("Setup 1", "Op 20").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub set_by: ObjectId,
    pub at: DateTime,
}

/// A work order waiting to run on a machine, in order (Daniel, 2026-11-03, design §9c). One
/// order can have several entries on the same machine (Setup 1, 2, 3) and be queued on
/// several machines at once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineQueueEntry {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub company_id: ObjectId,
    pub resource_id: ObjectId,
    pub concept_id: ObjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Lower runs first.
    pub rank: i64,
    pub added_by: ObjectId,
    pub added_at: DateTime,
}

/// ---------- RESOURCES ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    Machinery,
    Vehicle,
    Equipment,
    Other,
}

impl ResourceType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ResourceType::Machinery => "machinery",
            ResourceType::Vehicle => "vehicle",
            ResourceType::Equipment => "equipment",
            ResourceType::Other => "other",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            ResourceType::Machinery => "Maquinaria",
            ResourceType::Vehicle => "Vehículo",
            ResourceType::Equipment => "Equipo",
            ResourceType::Other => "Otro",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,

    pub name: String,

    pub resource_type: ResourceType,

    #[serde(default = "default_true")]
    pub is_active: bool,

    #[serde(default = "default_zero")]
    pub hourly_cost: f64,

    #[serde(default = "default_mxn")]
    pub currency: String,

    /// If empty, this resource is available for every concept status.
    #[serde(default)]
    pub allowed_status_ids: Vec<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// ---------- RESOURCE LOGS ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceLog {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<ObjectId>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_name: Option<String>,

    pub started_at: DateTime,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_hours: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,
}

/// Real time window where one resource was used. Cost is snapshotted here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceUsage {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub resource_id: ObjectId,
    pub resource_name_snapshot: String,
    pub started_at: DateTime,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_hours: Option<f64>,

    #[serde(default = "default_zero")]
    pub hourly_cost_snapshot: f64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost: Option<f64>,

    #[serde(default = "default_mxn")]
    pub currency: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// Cost/time allocation from one resource usage to one project concept.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceUsageAllocation {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub usage_id: ObjectId,
    pub project_id: ObjectId,
    pub concept_id: ObjectId,
    pub allocation_ratio: f64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allocated_hours: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allocated_cost: Option<f64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// ---------- MACHINE RUNS (shop floor, automatic) ----------

/// One interval in which a machine ran one CNC program, reported automatically by
/// the shop-floor monitor (taller-vision reads the DNC boxes). Stored as intervals,
/// not per-second samples. Idempotent by (`company_id`, `source`, `external_id`).
/// The run is linked at read time by `part_key` (the part number written in the program
/// header) to that part in every project active when it ran, split by pieces ordered, so
/// parts created later still pick up old time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineRun {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    pub source: String,
    pub external_id: String,
    pub machine: String,
    pub program: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_number: Option<String>,

    /// Normalized `part_number` (uppercase, no spaces) used to match concept names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_key: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_date: Option<String>,

    pub started_at: DateTime,
    pub ended_at: DateTime,

    /// Minutes the program was active on the machine (running or waiting for cycle start).
    #[serde(default = "default_zero")]
    pub minutes: f64,

    /// Minutes actually running (subset of `minutes`).
    #[serde(default = "default_zero")]
    pub cutting_minutes: f64,

    #[serde(default)]
    pub cycles: i32,

    /// Estimated, not measured: activity seen at the machine with the DNC box idle, so it is
    /// assumed to keep running the last program loaded (the box cannot see memory runs).
    #[serde(default)]
    pub inferred: bool,

    /// For an inferred run, when that last program was loaded (can be days earlier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program_loaded_at: Option<DateTime>,

    /// What the program header says when it is not a part number ("ALTURA 2.115").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_name: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

/// The shop-floor monitor's complete report of one day, for admins. Opaque JSON: its shape
/// belongs to the monitor and grows there. Numbers only, never images.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShopDailyReport {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,

    pub company_id: ObjectId,
    /// YYYY-MM-DD, shop time.
    pub day: String,
    pub source: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    #[serde(default)]
    pub kpis_json: String,

    /// Left out of listings.
    #[serde(default)]
    pub report_json: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_role_defaults_to_admin_and_maps_strings() {
        assert_eq!(UserRole::default(), UserRole::Staff);
        assert!(UserRole::Admin.is_admin());
        assert!(!UserRole::Staff.is_admin());
        assert_eq!(UserRole::Admin.as_str(), "admin");
        assert_eq!(UserRole::Staff.as_str(), "staff");
    }

    #[test]
    fn order_item_subtotal_multiplies_quantity_and_price() {
        let item = OrderItem {
            description: "Part".into(),
            quantity: 3.0,
            unit_price: 12.5,
        };

        assert_eq!(item.subtotal(), 37.5);
    }

    #[test]
    fn project_status_advances_until_terminal_states() {
        assert_eq!(ProjectStatus::Pedidos.next(), Some(ProjectStatus::Analisis));
        assert_eq!(
            ProjectStatus::EsperandoEntrega.next(),
            Some(ProjectStatus::Entregado)
        );
        assert_eq!(ProjectStatus::Entregado.next(), None);
        assert_eq!(ProjectStatus::Cancelado.next(), None);
    }

    #[test]
    fn project_priority_and_resource_type_expose_form_values() {
        assert_eq!(ProjectPriority::Urgent.as_str(), "urgent");
        assert_eq!(ProjectPriority::Urgent.label(), "Urgente");
        assert_eq!(ResourceType::Vehicle.as_str(), "vehicle");
        assert_eq!(ResourceType::Vehicle.label(), "Vehículo");
    }
}
