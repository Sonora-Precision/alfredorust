//! Maquila JSON API: send pieces of a part to a supplier, whole or for some steps, and
//! record what comes back (Daniel, 2026-11-13).
//!
//! Only the admin sends and edits. Whoever sees projects or the board sees that a part is
//! "En maquila"; the supplier only with `view_outsourcing_supplier` (off by default), and
//! what we pay only with `view_project_money`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::NaiveDate;
use mongodb::bson::{DateTime, Document, doc, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{ContactType, OutsourceJob, OutsourceStatus, UserPermission},
    session::SessionUser,
    state::{
        AppState, delete_outsourcing_job, get_outsourcing_job, get_project_concept_by_id_for_company,
        insert_outsourcing_job, list_outsourcing_jobs, list_process_operations, replace_outsourcing_job,
        sync_outsourced_steps,
    },
};

fn can_view(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::ViewProjects) || user.has_permission(UserPermission::ViewProductionBoard)
}

#[derive(Serialize)]
pub struct OutsourceJobData {
    pub id: String,
    pub project_id: String,
    pub concept_id: String,
    /// Only with `view_outsourcing_supplier` (the admin always).
    pub supplier_id: Option<String>,
    pub supplier_name: Option<String>,
    /// Steps the supplier does; empty means the whole part.
    pub operation_ids: Vec<String>,
    pub quantity: f64,
    /// What we pay per piece; only with `view_project_money`.
    pub unit_cost: Option<f64>,
    pub material_by_us: bool,
    pub due_date: Option<String>,
    pub status: OutsourceStatus,
    pub sent_at: Option<String>,
    pub received_quantity: f64,
    pub received_at: Option<String>,
    /// Past its date and not back yet, or back after it.
    pub late: bool,
    pub notes: Option<String>,
}

#[derive(Deserialize)]
pub struct OutsourcingQuery {
    pub project_id: Option<String>,
    pub concept_id: Option<String>,
    pub supplier_id: Option<String>,
}

/// Was or is the job late: open past its date, or received after it.
pub(crate) fn job_late(job: &OutsourceJob, now: DateTime) -> bool {
    let Some(due) = job.due_date else { return false };
    // Due at the end of that day.
    let due = due.timestamp_millis() + 86_400_000;
    match job.status {
        OutsourceStatus::Planned | OutsourceStatus::Sent => now.timestamp_millis() > due,
        OutsourceStatus::Received => job.received_at.is_some_and(|at| at.timestamp_millis() > due),
        OutsourceStatus::Cancelled => false,
    }
}

/// Name shown for a supplier: its alias, else its legal name.
pub(crate) async fn supplier_names(
    state: &AppState,
    company_id: &ObjectId,
    ids: &[ObjectId],
) -> HashMap<ObjectId, String> {
    let mut names = HashMap::new();
    if ids.is_empty() {
        return names;
    }
    if let Ok(mut cursor) = state.contacts.find(doc! { "company_id": company_id, "_id": { "$in": ids } }).await {
        use futures::stream::TryStreamExt;
        while let Ok(Some(c)) = cursor.try_next().await {
            if let Some(id) = c.id {
                let name = c.profile.and_then(|p| p.alias).unwrap_or(c.name);
                names.insert(id, name);
            }
        }
    }
    names
}

pub async fn api_outsourcing_index(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(q): Query<OutsourcingQuery>,
) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let mut filter = Document::new();
    for (key, value) in [("project_id", &q.project_id), ("concept_id", &q.concept_id), ("supplier_id", &q.supplier_id)] {
        if let Some(v) = value.as_deref().filter(|v| !v.is_empty()) {
            match parse_oid(v) {
                Ok(id) => {
                    filter.insert(key, id);
                }
                Err(resp) => return resp,
            }
        }
    }
    let see_supplier = session_user.has_permission(UserPermission::ViewOutsourcingSupplier);
    let see_money = session_user.has_permission(UserPermission::ViewProjectMoney);
    if q.supplier_id.is_some() && !see_supplier {
        return StatusCode::FORBIDDEN.into_response();
    }
    let jobs = match list_outsourcing_jobs(&state, &company_id, filter).await {
        Ok(jobs) => jobs,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list maquila"),
    };
    let names = if see_supplier {
        let ids: Vec<ObjectId> = jobs.iter().map(|j| j.supplier_id).collect();
        supplier_names(&state, &company_id, &ids).await
    } else {
        HashMap::new()
    };
    let now = DateTime::now();
    let data: Vec<OutsourceJobData> = jobs
        .into_iter()
        .filter_map(|j| {
            Some(OutsourceJobData {
                id: j.id?.to_hex(),
                project_id: j.project_id.to_hex(),
                concept_id: j.concept_id.to_hex(),
                supplier_id: see_supplier.then(|| j.supplier_id.to_hex()),
                supplier_name: if see_supplier { names.get(&j.supplier_id).cloned() } else { None },
                operation_ids: j.operation_ids.iter().map(|o| o.to_hex()).collect(),
                quantity: j.quantity,
                unit_cost: if see_money { j.unit_cost } else { None },
                material_by_us: j.material_by_us,
                due_date: j.due_date.map(iso),
                status: j.status,
                sent_at: j.sent_at.map(iso),
                received_quantity: j.received_quantity,
                received_at: j.received_at.map(iso),
                late: job_late(&j, now),
                notes: if see_money { j.notes.clone() } else { crate::redact::strip_money_opt(j.notes.clone()) },
            })
        })
        .collect();
    Json(data).into_response()
}

#[derive(Deserialize)]
pub struct OutsourceJobPayload {
    pub concept_id: Option<String>,
    pub supplier_id: String,
    #[serde(default)]
    pub operation_ids: Vec<String>,
    pub quantity: f64,
    pub unit_cost: Option<f64>,
    #[serde(default)]
    pub material_by_us: bool,
    /// YYYY-MM-DD.
    pub due_date: Option<String>,
    pub status: Option<OutsourceStatus>,
    #[serde(default)]
    pub received_quantity: f64,
    pub notes: Option<String>,
}

fn parse_day(value: &str) -> Option<DateTime> {
    let day = NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()?;
    // Noon in Sonora (UTC-7), so the day reads the same everywhere.
    let at = day.and_hms_opt(19, 0, 0)?.and_utc();
    Some(DateTime::from_millis(at.timestamp_millis()))
}

/// Checks and fills a job from the payload; `job` keeps what the payload does not touch.
async fn apply(
    state: &AppState,
    company_id: &ObjectId,
    job: &mut OutsourceJob,
    payload: OutsourceJobPayload,
    part_quantity: f64,
) -> Result<(), Response> {
    let supplier_id = parse_oid(&payload.supplier_id)?;
    match state.contacts.find_one(doc! { "_id": supplier_id, "company_id": company_id }).await {
        Ok(Some(c)) if c.contact_type == ContactType::Supplier || c.contact_type == ContactType::Service => {}
        Ok(_) => return Err(json_error(StatusCode::BAD_REQUEST, "that supplier is not in this company")),
        Err(_) => return Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the supplier")),
    }
    let operations = list_process_operations(state, company_id, false)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the steps"))?;
    let mut operation_ids = Vec::new();
    for raw in &payload.operation_ids {
        let id = parse_oid(raw)?;
        if !operations.iter().any(|o| o.id == Some(id)) {
            return Err(json_error(StatusCode::BAD_REQUEST, "unknown step"));
        }
        if !operation_ids.contains(&id) {
            operation_ids.push(id);
        }
    }
    if !(payload.quantity > 0.0) || payload.quantity > part_quantity * 10.0 {
        return Err(json_error(StatusCode::BAD_REQUEST, "quantity must be more than 0"));
    }
    if payload.unit_cost.is_some_and(|c| !(c >= 0.0)) {
        return Err(json_error(StatusCode::BAD_REQUEST, "invalid price"));
    }
    if !(payload.received_quantity >= 0.0) || payload.received_quantity > payload.quantity {
        return Err(json_error(StatusCode::BAD_REQUEST, "received pieces must be between 0 and the quantity sent"));
    }
    let due_date = match payload.due_date.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => Some(parse_day(d).ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "invalid date"))?),
        None => None,
    };
    let now = DateTime::now();
    let mut status = payload.status.unwrap_or(job.status);
    // Pieces back mean it was received.
    if payload.received_quantity > 0.0 && status.is_open() {
        status = OutsourceStatus::Received;
    }
    if matches!(status, OutsourceStatus::Sent | OutsourceStatus::Received) && job.sent_at.is_none() {
        job.sent_at = Some(now);
    }
    if status == OutsourceStatus::Received {
        if job.received_at.is_none() || payload.received_quantity != job.received_quantity {
            job.received_at = Some(now);
        }
    } else {
        job.received_at = None;
    }
    job.supplier_id = supplier_id;
    job.operation_ids = operation_ids;
    job.quantity = payload.quantity;
    job.unit_cost = payload.unit_cost;
    job.material_by_us = payload.material_by_us;
    job.due_date = due_date;
    job.status = status;
    job.received_quantity = if status == OutsourceStatus::Received { payload.received_quantity } else { 0.0 };
    job.notes = payload.notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    job.updated_at = Some(now);
    Ok(())
}

async fn after_change(state: &AppState, session_user: &SessionUser, company_id: &ObjectId, concept_id: &ObjectId) {
    if let Ok(operations) = list_process_operations(state, company_id, false).await {
        let who = session_user.user().username.clone();
        let _ = sync_outsourced_steps(state, company_id, concept_id, &operations, &who).await;
    }
}

pub async fn api_outsourcing_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OutsourceJobPayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let Some(concept_id) = payload.concept_id.as_deref() else {
        return json_error(StatusCode::BAD_REQUEST, "which part?");
    };
    let concept_id = match parse_oid(concept_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let concept = match get_project_concept_by_id_for_company(&state, &concept_id, &company_id).await {
        Ok(Some(c)) => c,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "part not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the part"),
    };
    let mut job = OutsourceJob {
        id: None,
        company_id,
        project_id: concept.project_id,
        concept_id,
        supplier_id: ObjectId::new(),
        operation_ids: Vec::new(),
        quantity: 0.0,
        unit_cost: None,
        material_by_us: false,
        due_date: None,
        status: OutsourceStatus::Planned,
        sent_at: None,
        received_quantity: 0.0,
        received_at: None,
        notes: None,
        created_by: Some(session_user.user().username.clone()),
        created_at: Some(DateTime::now()),
        updated_at: None,
    };
    if let Err(resp) = apply(&state, &company_id, &mut job, payload, concept.quantity).await {
        return resp;
    }
    match insert_outsourcing_job(&state, &job).await {
        Ok(id) => {
            after_change(&state, &session_user, &company_id, &concept_id).await;
            (StatusCode::CREATED, Json(serde_json::json!({ "id": id.to_hex() }))).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save"),
    }
}

pub async fn api_outsourcing_update(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<OutsourceJobPayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let mut job = match get_outsourcing_job(&state, &company_id, &id).await {
        Ok(Some(j)) => j,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load"),
    };
    let part_quantity = match get_project_concept_by_id_for_company(&state, &job.concept_id, &company_id).await {
        Ok(Some(c)) => c.quantity,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "part not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the part"),
    };
    if let Err(resp) = apply(&state, &company_id, &mut job, payload, part_quantity).await {
        return resp;
    }
    match replace_outsourcing_job(&state, &job).await {
        Ok(()) => {
            after_change(&state, &session_user, &company_id, &job.concept_id).await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save"),
    }
}

pub async fn api_outsourcing_delete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match delete_outsourcing_job(&state, &company_id, &id).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "not found"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not delete"),
    }
}

// ---------- Proveedores de maquila (admin only) ----------

#[derive(Serialize, Default)]
pub struct SupplierJobRow {
    pub id: String,
    pub project_id: String,
    pub project_title: String,
    pub concept_id: String,
    pub part: String,
    /// Empty means the whole part.
    pub steps: Vec<String>,
    pub whole: bool,
    pub quantity: f64,
    pub received_quantity: f64,
    pub unit_cost: Option<f64>,
    pub unit_price: Option<f64>,
    /// unit_cost × pieces sent.
    pub cost_total: Option<f64>,
    /// unit_price × pieces sent.
    pub sale_total: Option<f64>,
    pub status: OutsourceStatus,
    pub due_date: Option<String>,
    pub sent_at: Option<String>,
    pub received_at: Option<String>,
    pub late: bool,
}

#[derive(Serialize, Default)]
pub struct SupplierSummary {
    pub id: String,
    pub name: String,
    pub legal_name: String,
    pub rfc: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub contact_person: Option<String>,
    pub outsourcing: bool,
    pub processes: Vec<String>,
    /// Distinct part numbers (not cancelled).
    pub parts: usize,
    pub open_jobs: usize,
    pub received_jobs: usize,
    pub pieces_sent: f64,
    pub pieces_received: f64,
    /// What we pay for everything not cancelled.
    pub cost: f64,
    /// Jobs without a price yet.
    pub jobs_without_cost: usize,
    /// Whole parts: what we sell them for and what we keep.
    pub whole_cost: f64,
    pub whole_sale: f64,
    pub whole_margin: f64,
    /// Some steps only: what we pay against what the client pays for those pieces.
    pub partial_cost: f64,
    pub partial_sale: f64,
    pub on_time: usize,
    pub late: usize,
    /// Came back with fewer pieces than were sent.
    pub short: usize,
    pub jobs: Vec<SupplierJobRow>,
}

impl Default for OutsourceStatus {
    fn default() -> Self {
        OutsourceStatus::Planned
    }
}

pub async fn api_outsourcing_suppliers(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    use futures::stream::TryStreamExt;
    let company_id = require_active_company(&session_user);
    let jobs = match list_outsourcing_jobs(&state, &company_id, Document::new()).await {
        Ok(jobs) => jobs,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list maquila"),
    };
    let with_jobs: Vec<ObjectId> = jobs.iter().map(|j| j.supplier_id).collect();
    // Suppliers marked "hace maquila" plus whoever has jobs.
    let contact_filter = doc! {
        "company_id": &company_id,
        "$or": [ { "_id": { "$in": &with_jobs } }, { "profile.outsourcing": true } ],
    };
    let mut contacts = Vec::new();
    match state.contacts.find(contact_filter).await {
        Ok(mut cursor) => {
            while let Ok(Some(c)) = cursor.try_next().await {
                contacts.push(c);
            }
        }
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load suppliers"),
    }
    let concept_ids: Vec<ObjectId> = jobs.iter().map(|j| j.concept_id).collect();
    let mut concepts = HashMap::new();
    if let Ok(mut cursor) =
        state.project_concepts.find(doc! { "company_id": &company_id, "_id": { "$in": &concept_ids } }).await
    {
        while let Ok(Some(c)) = cursor.try_next().await {
            if let Some(id) = c.id {
                concepts.insert(id, c);
            }
        }
    }
    let project_ids: Vec<ObjectId> = jobs.iter().map(|j| j.project_id).collect();
    let mut projects = HashMap::new();
    if let Ok(mut cursor) = state.projects.find(doc! { "company_id": &company_id, "_id": { "$in": &project_ids } }).await {
        while let Ok(Some(p)) = cursor.try_next().await {
            if let Some(id) = p.id {
                projects.insert(id, p.title);
            }
        }
    }
    let step_names: HashMap<ObjectId, String> = list_process_operations(&state, &company_id, true)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|o| Some((o.id?, o.name)))
        .collect();

    let now = DateTime::now();
    let mut out: Vec<SupplierSummary> = contacts
        .into_iter()
        .filter_map(|c| {
            let id = c.id?;
            let profile = c.profile.clone().unwrap_or_default();
            let mut s = SupplierSummary {
                id: id.to_hex(),
                name: profile.alias.clone().unwrap_or_else(|| c.name.clone()),
                legal_name: c.name.clone(),
                rfc: c.rfc.clone(),
                phone: c.phone.clone(),
                email: c.email.clone(),
                contact_person: profile.contact_person.clone(),
                outsourcing: profile.outsourcing,
                processes: profile.processes.clone(),
                ..Default::default()
            };
            let mut parts = std::collections::HashSet::new();
            for j in jobs.iter().filter(|j| j.supplier_id == id) {
                let Some(job_id) = j.id else { continue };
                let concept = concepts.get(&j.concept_id);
                let unit_price = concept.and_then(|c| c.unit_price);
                let whole = j.operation_ids.is_empty();
                let cost_total = j.unit_cost.map(|u| u * j.quantity);
                let sale_total = unit_price.map(|u| u * j.quantity);
                let late = job_late(j, now);
                if j.status != OutsourceStatus::Cancelled {
                    parts.insert(j.concept_id);
                    s.pieces_sent += j.quantity;
                    s.pieces_received += j.received_quantity;
                    if j.status.is_open() {
                        s.open_jobs += 1;
                    } else {
                        s.received_jobs += 1;
                        if j.received_quantity < j.quantity {
                            s.short += 1;
                        }
                        if j.due_date.is_some() && !late {
                            s.on_time += 1;
                        }
                    }
                    if late {
                        s.late += 1;
                    }
                    match cost_total {
                        Some(cost) => s.cost += cost,
                        None => s.jobs_without_cost += 1,
                    }
                    if whole {
                        s.whole_cost += cost_total.unwrap_or(0.0);
                        s.whole_sale += sale_total.unwrap_or(0.0);
                    } else {
                        s.partial_cost += cost_total.unwrap_or(0.0);
                        s.partial_sale += sale_total.unwrap_or(0.0);
                    }
                }
                s.jobs.push(SupplierJobRow {
                    id: job_id.to_hex(),
                    project_id: j.project_id.to_hex(),
                    project_title: projects.get(&j.project_id).cloned().unwrap_or_default(),
                    concept_id: j.concept_id.to_hex(),
                    part: concept.map(|c| c.name.clone()).unwrap_or_default(),
                    steps: j.operation_ids.iter().filter_map(|o| step_names.get(o).cloned()).collect(),
                    whole,
                    quantity: j.quantity,
                    received_quantity: j.received_quantity,
                    unit_cost: j.unit_cost,
                    unit_price,
                    cost_total,
                    sale_total,
                    status: j.status,
                    due_date: j.due_date.map(iso),
                    sent_at: j.sent_at.map(iso),
                    received_at: j.received_at.map(iso),
                    late,
                });
            }
            s.parts = parts.len();
            s.whole_margin = s.whole_sale - s.whole_cost;
            // Open first, then newest.
            s.jobs.sort_by(|a, b| b.status.is_open().cmp(&a.status.is_open()).then(b.sent_at.cmp(&a.sent_at)));
            Some(s)
        })
        .collect();
    out.sort_by(|a, b| b.cost.total_cmp(&a.cost).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Json(out).into_response()
}
