// state module: AppState, initialization, and re-exports of submodules.

use anyhow::{Context, Result};
use mongodb::{Client, Collection, IndexModel, options::IndexOptions};
use serde::{Deserialize, Serialize};
use std::env;

use crate::models::{
    Account, ApiToken, Category, Company, ConceptStatus, Contact, Forecast, MachineRun,
    PlannedEntry, ProcessOperation, Project, ProjectConcept, RecurringPlan, Resource, ResourceLog,
    ResourceUsage, ResourceUsageAllocation, SatConfig, ServiceOrder, Session, Transaction, User,
    UserCompany, WorkOrderEvent, MachineQueueEntry, MachineState, MaterialPrice, MaterialPricePoint, MaterialQuote, MaterialReceipt, PartComment, PartFile, Suggestion, PlantLayout, Quote, QuoteFile, QuoteSettings, ClientQuoteDefaults,
    ShopDailyReport, AttendanceCorrection, AttendanceEmployee, AttendanceEvent,
};
use bson::Document;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CfdiJobStatus {
    Queued,
    Running,
    Done {
        imported: usize,
        transactions_created: usize,
        transactions_updated: usize,
        transactions_skipped: usize,
        errors: Vec<String>,
    },
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CfdiJob {
    pub job_id: String,
    pub company_id: String,
    pub label: String,
    pub chunk_start: String,
    pub started_at: String,
    pub status: CfdiJobStatus,
    /// "manual" (HTTP request) or "cron" (daily scheduled pass).
    pub source: String,
    pub created_at: bson::DateTime,
}

mod api_tokens;
mod attendance;
mod cfdi_jobs;
mod companies;
mod finance;
mod machine_queue;
mod material;
mod quoting;
mod quotes;
mod machine_runs;
mod shop_reports;
mod orders;
mod plant;
mod part_files;
mod process_operations;
mod production;
mod project_concepts;
mod projects;
mod quality;
mod resource_logs;
mod resource_usages;
mod resources;
mod sat_configs;
mod seed;
mod users;

pub use api_tokens::*;
pub use attendance::*;
pub use cfdi_jobs::*;
pub use companies::*;
pub use finance::*;
pub use machine_queue::*;
pub use material::*;
pub use quoting::*;
pub use quotes::*;
pub use machine_runs::*;
pub use shop_reports::*;
pub use orders::*;
pub use plant::*;
pub use part_files::*;
pub use process_operations::*;
pub use production::*;
pub use project_concepts::*;
pub use projects::*;
pub use quality::*;
pub use resource_logs::*;
pub use resource_usages::*;
pub use resources::*;
pub use sat_configs::*;
pub use users::*;

pub const SESSION_TTL_SECONDS: u64 = 60 * 60 * 24 * 30; // 30 days
pub const PLANNED_MONTHS_AHEAD: u32 = 24;

#[derive(Clone)]
pub struct AppState {
    pub cfdi_archive_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    pub cfdi_transaction_sync_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    pub cfdi_jobs: Collection<CfdiJob>,
    pub users: Collection<User>,
    pub user_companies: Collection<UserCompany>,
    pub companies: Collection<Company>,
    pub sessions: Collection<Session>,
    pub api_tokens: Collection<ApiToken>,
    pub accounts: Collection<Account>,
    pub categories: Collection<Category>,
    pub contacts: Collection<Contact>,
    pub recurring_plans: Collection<RecurringPlan>,
    pub planned_entries: Collection<PlannedEntry>,
    pub transactions: Collection<Transaction>,
    pub forecasts: Collection<Forecast>,
    pub cfdis: Collection<Document>,
    pub sat_configs: Collection<SatConfig>,
    pub orders: Collection<ServiceOrder>,
    pub projects: Collection<Project>,
    pub concept_statuses: Collection<ConceptStatus>,
    pub project_concepts: Collection<ProjectConcept>,
    pub resources: Collection<Resource>,
    pub resource_logs: Collection<ResourceLog>,
    pub resource_usages: Collection<ResourceUsage>,
    pub resource_usage_allocations: Collection<ResourceUsageAllocation>,
    pub machine_runs: Collection<MachineRun>,
    pub process_operations: Collection<ProcessOperation>,
    /// Per-company sequences, e.g. the work-order folio.
    pub counters: Collection<Document>,
    pub work_order_events: Collection<WorkOrderEvent>,
    pub plant_layouts: Collection<PlantLayout>,
    pub machine_states: Collection<MachineState>,
    pub shop_daily_reports: Collection<ShopDailyReport>,
    pub machine_queue: Collection<MachineQueueEntry>,
    pub material_receipts: Collection<MaterialReceipt>,
    pub material_prices: Collection<MaterialPrice>,
    pub material_price_points: Collection<MaterialPricePoint>,
    pub part_comments: Collection<PartComment>,
    pub suggestions: Collection<Suggestion>,
    pub material_quotes: Collection<MaterialQuote>,
    pub quotes: Collection<Quote>,
    pub quote_settings: Collection<QuoteSettings>,
    pub client_quote_defaults: Collection<ClientQuoteDefaults>,
    pub part_files: Collection<PartFile>,
    pub quote_files: Collection<QuoteFile>,
    pub attendance_events: Collection<AttendanceEvent>,
    pub attendance_employees: Collection<AttendanceEmployee>,
    pub attendance_corrections: Collection<AttendanceCorrection>,
}

pub async fn init_state() -> Result<AppState> {
    let uri = env::var("MONGODB_URI").unwrap_or_else(|_| "mongodb://localhost:27017".to_string());
    let db_name = env::var("MONGODB_DB").unwrap_or_else(|_| "totp".to_string());

    init_state_with_db_name(&uri, &db_name).await
}

pub async fn init_state_with_db_name(uri: &str, db_name: &str) -> Result<AppState> {
    println!("Connecting to MongoDB at {}", redact_mongo_uri(uri));
    let client = Client::with_uri_str(uri).await?;
    let db = client.database(&db_name);

    seed::ensure_collections(&db).await?;

    // One-time migration: the user login identifier moved from `email` to
    // `username` (it was never a validated address, just a unique handle).
    // Idempotent and safe: rename only email-only docs, and drop any stray
    // `email` left on docs that already have a `username`.
    {
        let users = db.collection::<Document>("users");
        let _ = users
            .update_many(
                mongodb::bson::doc! { "email": { "$exists": true }, "username": { "$exists": false } },
                mongodb::bson::doc! { "$rename": { "email": "username" } },
            )
            .await;
        let _ = users
            .update_many(
                mongodb::bson::doc! { "email": { "$exists": true }, "username": { "$exists": true } },
                mongodb::bson::doc! { "$unset": { "email": "" } },
            )
            .await;
    }

    // Only seed when the database is effectively empty (no users).
    if seed::is_database_empty(&db).await? {
        let default_users = seed::load_default_users()?;
        let company_names = seed::derive_company_names(&default_users);
        let company_ids = seed::seed_default_companies(&db, &company_names).await?;
        seed::seed_default_users(&db, &default_users, &company_ids).await?;
        seed::seed_sample_finance(&db, company_ids.values().next().cloned()).await?;
    }

    // A CFDI represents one real fiscal movement per tenant. Enforce that
    // invariant in MongoDB so concurrent workers or application instances
    // cannot both pass a find-before-insert check.
    db.collection::<Document>("transactions")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "cfdi_uuid": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_company_cfdi_transaction".to_string())
                        .unique(true)
                        .partial_filter_expression(
                            mongodb::bson::doc! { "cfdi_uuid": { "$type": "string" } },
                        )
                        .build(),
                )
                .build(),
        )
        .await
        .context(
            "creating the unique CFDI transaction index; resolve existing duplicate company_id/cfdi_uuid records before restarting",
        )?;

    db.collection::<ApiToken>("api_tokens")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "public_id": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_api_token_public_id".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the unique personal access token index")?;
    db.collection::<ApiToken>("api_tokens")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "user_id": 1, "created_at": -1 })
                .options(
                    IndexOptions::builder()
                        .name("api_tokens_by_user".to_string())
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the personal access token owner index")?;

    db.collection::<ShopDailyReport>("shop_daily_reports")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "day": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_shop_daily_report".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the unique shop daily report index")?;

    // Shop-floor monitor runs are re-sent on every sync; the unique key makes that an upsert.
    db.collection::<MachineRun>("machine_runs")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "source": 1, "external_id": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_machine_run".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the unique machine run index")?;

    db.collection::<Document>("company_counters")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "name": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_company_counter".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the unique company counter index")?;
    db.collection::<WorkOrderEvent>("work_order_events")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "kind": 1, "at": 1 })
                .options(
                    IndexOptions::builder()
                        .name("work_order_events_by_kind".to_string())
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the work order events index")?;
    db.collection::<PlantLayout>("plant_layouts")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_company_plant_layout".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the plant layout index")?;
    db.collection::<MachineState>("machine_states")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "resource_id": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_machine_state".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the machine state index")?;
    db.collection::<MaterialReceipt>("material_receipts")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "received_at": -1 })
                .build(),
        )
        .await
        .context("creating the material receipt index")?;
    db.collection::<MachineQueueEntry>("machine_queue_entries")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "resource_id": 1, "rank": 1 })
                .build(),
        )
        .await
        .context("creating the machine queue index")?;
    db.collection::<PartFile>("part_files")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "concept_id": 1, "uploaded_at": -1 })
                .build(),
        )
        .await
        .context("creating the part files index")?;
    // Time-clock checks are re-sent by the agent; the unique key makes that a no-op.
    db.collection::<AttendanceEvent>("attendance_events")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "device": 1, "serial_no": 1, "at": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_attendance_event".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the unique attendance event index")?;
    db.collection::<AttendanceEvent>("attendance_events")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "at": 1 })
                .build(),
        )
        .await
        .context("creating the attendance events by time index")?;
    db.collection::<AttendanceEmployee>("attendance_employees")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "employee_no": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_attendance_employee".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the unique attendance employee index")?;
    db.collection::<AttendanceCorrection>("attendance_corrections")
        .create_index(
            IndexModel::builder()
                .keys(mongodb::bson::doc! { "company_id": 1, "employee_no": 1, "date": 1 })
                .options(
                    IndexOptions::builder()
                        .name("unique_attendance_correction".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .context("creating the unique attendance correction index")?;

    let state = AppState {
        cfdi_archive_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        cfdi_transaction_sync_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        cfdi_jobs: db.collection::<CfdiJob>("cfdi_jobs"),
        users: db.collection::<User>("users"),
        user_companies: db.collection::<UserCompany>("user_companies"),
        companies: db.collection::<Company>("company"),
        sessions: db.collection::<Session>("sessions"),
        api_tokens: db.collection::<ApiToken>("api_tokens"),
        accounts: db.collection::<Account>("accounts"),
        categories: db.collection::<Category>("categories"),
        contacts: db.collection::<Contact>("contacts"),
        recurring_plans: db.collection::<RecurringPlan>("recurring_plans"),
        planned_entries: db.collection::<PlannedEntry>("planned_entries"),
        transactions: db.collection::<Transaction>("transactions"),
        forecasts: db.collection::<Forecast>("forecasts"),
        cfdis: db.collection::<Document>("cfdis"),
        sat_configs: db.collection::<SatConfig>("sat_configs"),
        orders: db.collection::<ServiceOrder>("service_orders"),
        projects: db.collection::<Project>("projects"),
        concept_statuses: db.collection::<ConceptStatus>("concept_statuses"),
        project_concepts: db.collection::<ProjectConcept>("project_concepts"),
        resources: db.collection::<Resource>("resources"),
        resource_logs: db.collection::<ResourceLog>("resource_logs"),
        resource_usages: db.collection::<ResourceUsage>("resource_usages"),
        resource_usage_allocations: db
            .collection::<ResourceUsageAllocation>("resource_usage_allocations"),
        machine_runs: db.collection::<MachineRun>("machine_runs"),
        process_operations: db.collection::<ProcessOperation>("process_operations"),
        counters: db.collection::<Document>("company_counters"),
        work_order_events: db.collection::<WorkOrderEvent>("work_order_events"),
        plant_layouts: db.collection::<PlantLayout>("plant_layouts"),
        machine_states: db.collection::<MachineState>("machine_states"),
        shop_daily_reports: db.collection::<ShopDailyReport>("shop_daily_reports"),
        machine_queue: db.collection::<MachineQueueEntry>("machine_queue_entries"),
        material_receipts: db.collection::<MaterialReceipt>("material_receipts"),
        material_prices: db.collection::<MaterialPrice>("material_prices"),
        material_price_points: db.collection::<MaterialPricePoint>("material_price_points"),
        part_comments: db.collection::<PartComment>("part_comments"),
        suggestions: db.collection::<Suggestion>("suggestions"),
        material_quotes: db.collection::<MaterialQuote>("material_quotes"),
        quotes: db.collection::<Quote>("quotes"),
        quote_settings: db.collection::<QuoteSettings>("quote_settings"),
        client_quote_defaults: db.collection::<ClientQuoteDefaults>("client_quote_defaults"),
        part_files: db.collection::<PartFile>("part_files"),
        quote_files: db.collection::<QuoteFile>("quote_files"),
        attendance_events: db.collection::<AttendanceEvent>("attendance_events"),
        attendance_employees: db.collection::<AttendanceEmployee>("attendance_employees"),
        attendance_corrections: db.collection::<AttendanceCorrection>("attendance_corrections"),
    };

    let interrupted = fail_interrupted_cfdi_jobs(&state).await?;
    if interrupted > 0 {
        eprintln!("[cfdi] marked {interrupted} interrupted download job(s) after startup");
    }

    Ok(state)
}

fn redact_mongo_uri(uri: &str) -> String {
    let Some((scheme, rest)) = uri.split_once("://") else {
        return "<redacted>".to_string();
    };
    let host_and_options = rest.rsplit_once('@').map_or(rest, |(_, tail)| tail);
    format!("{scheme}://{host_and_options}")
}
