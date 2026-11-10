//! Shop-floor progress per part number: the company's checklist of process operations and,
//! per part, finished pieces and step states. Reading the catalog needs `view_projects`;
//! every write is admin-only for now (a narrower progress permission is planned, see
//! openspec/changes/add-shop-floor-tracking).

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use super::finance::helpers::{require_active_company, require_admin_active};
use super::project_backend::{iso, json_error, parse_oid, project_concept_data};
use crate::{
    models::{
        ProcessOperation, ProjectConcept, StepState, UserPermission, WorkOrderEvent,
        WorkOrderEventKind, WorkQueue,
    },
    session::SessionUser,
    state::{
        AppState, PartProgressUpdate, create_process_operation, delete_process_operation,
        get_project_concept_by_id_for_company, list_process_operations, log_work_order_event,
        update_part_progress, update_process_operation,
    },
};
use mongodb::bson::oid::ObjectId;

#[derive(Serialize)]
pub struct ProcessOperationData {
    pub id: String,
    pub name: String,
    pub position: i32,
    pub is_active: bool,
    /// Production-board queue ("programming", "setup", …) or null.
    pub queue: Option<&'static str>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

fn process_operation_data(op: ProcessOperation) -> Option<ProcessOperationData> {
    Some(ProcessOperationData {
        id: op.id?.to_hex(),
        name: op.name,
        position: op.position,
        is_active: op.is_active,
        queue: op.queue.map(|q| q.as_str()),
        created_at: op.created_at.map(iso),
        updated_at: op.updated_at.map(iso),
    })
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ProcessOperationPayload {
    pub name: String,
    #[serde(default)]
    pub position: i32,
    #[serde(default = "super::project_backend::default_true")]
    pub is_active: bool,
    /// "programming", "setup", "machining", "finishing" or null.
    #[serde(default)]
    pub queue: Option<String>,
}

fn parse_queue(value: Option<&str>) -> Result<Option<WorkQueue>, Response> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) => WorkQueue::parse(v).map(Some).ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "queue must be programming, setup, machining or finishing",
            )
        }),
    }
}

#[utoipa::path(
    get,
    path = "/api/admin/process_operations",
    tag = "operations",
    responses(
        (status = 200, description = "Process operations of the active company, by position"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden")
    ),
    security(("session" = []))
)]
pub async fn api_process_operations_index(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !session_user.has_permission(UserPermission::ViewProjects) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    // Admins also see inactive operations so they can switch them back on.
    match list_process_operations(&state, &company_id, session_user.is_admin()).await {
        Ok(items) => Json(
            items
                .into_iter()
                .filter_map(process_operation_data)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not list process operations",
        ),
    }
}

#[utoipa::path(
    post,
    path = "/api/admin/process_operations",
    tag = "operations",
    request_body = ProcessOperationPayload,
    responses(
        (status = 201, description = "Process operation created"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_process_operations_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ProcessOperationPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let queue = match parse_queue(payload.queue.as_deref()) {
        Ok(q) => q,
        Err(resp) => return resp,
    };
    match create_process_operation(&state, &company_id, &payload.name, payload.position, queue)
        .await
    {
        Ok(id) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "id": id.to_hex() })),
        )
            .into_response(),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/admin/process_operations/{id}/update",
    tag = "operations",
    params(("id" = String, Path, description = "Process operation id")),
    request_body = ProcessOperationPayload,
    responses(
        (status = 200, description = "Process operation updated"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only"),
        (status = 404, description = "Not found")
    ),
    security(("session" = []))
)]
pub async fn api_process_operations_update(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<ProcessOperationPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let queue = match parse_queue(payload.queue.as_deref()) {
        Ok(q) => q,
        Err(resp) => return resp,
    };
    match update_process_operation(
        &state,
        &id,
        &company_id,
        &payload.name,
        payload.position,
        payload.is_active,
        queue,
    )
    .await
    {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "process operation not found"),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/admin/process_operations/{id}/delete",
    tag = "operations",
    params(("id" = String, Path, description = "Process operation id")),
    responses(
        (status = 200, description = "Process operation deleted; recorded steps are kept"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only"),
        (status = 404, description = "Not found")
    ),
    security(("session" = []))
)]
pub async fn api_process_operations_delete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match delete_process_operation(&state, &id, &company_id).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "process operation not found"),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not delete process operation",
        ),
    }
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct PartProgressPayload {
    /// Finished pieces, 0..=quantity.
    pub completed_quantity: Option<f64>,
    /// Step to mark, together with `state`.
    pub operation_id: Option<String>,
    /// "pending", "done", "not_applicable" or "blocked" (with `note`).
    pub state: Option<String>,
    /// What holds a blocked step up ("falta machuelo 1/4-20").
    #[serde(default)]
    pub note: Option<String>,
    /// Pieces through the step of `operation_id` (cut 12/30, Setup 1 6/30).
    #[serde(default)]
    pub pieces: Option<f64>,
    /// The setup of `operation_id` has its program ready.
    #[serde(default)]
    pub programmed: Option<bool>,
}

#[utoipa::path(
    post,
    path = "/api/admin/project_concepts/{id}/progress",
    tag = "operations",
    params(("id" = String, Path, description = "Project concept id")),
    request_body = PartProgressPayload,
    responses(
        (status = 200, description = "Updated part with its finished pieces and steps"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Needs take_work_orders or admin"),
        (status = 404, description = "Not found")
    ),
    security(("session" = []))
)]
/// Ticks process steps and finished pieces. Programmers can do it (Daniel, 2026-11-02:
/// "Pasos y piezas"); each change keeps who and when, and the answer carries no money.
pub async fn api_project_concept_progress(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<PartProgressPayload>,
) -> Response {
    if !session_user.has_permission(UserPermission::TakeWorkOrders) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let can_view_money = session_user.has_permission(UserPermission::ViewProjectMoney);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    // Pieces and "programmed" go on one step, with or without a state.
    let extra_op = if payload.pieces.is_some() || payload.programmed.is_some() {
        let Some(op) = payload.operation_id.as_deref() else {
            return json_error(StatusCode::BAD_REQUEST, "pieces and programmed need operation_id");
        };
        match parse_oid(op) {
            Ok(op) => Some(op),
            Err(resp) => return resp,
        }
    } else {
        None
    };
    let step = match (payload.operation_id.as_deref(), payload.state.as_deref()) {
        (None, None) => None,
        (Some(_), None) if extra_op.is_some() => None,
        (Some(op), Some(st)) => {
            let op = match parse_oid(op) {
                Ok(op) => op,
                Err(resp) => return resp,
            };
            let Some(st) = StepState::parse(st) else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "state must be pending, done, not_applicable or blocked",
                );
            };
            Some((op, st))
        }
        _ => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "operation_id and state go together",
            );
        }
    };
    if step.is_none() && payload.completed_quantity.is_none() && extra_op.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "nothing to update");
    }
    let username = session_user.user().username.clone();
    // A blocked step says what holds it up (Daniel, 2026-11-06).
    let note = payload.note.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(300).collect::<String>());
    if matches!(step, Some((_, StepState::Blocked))) && note.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "di qué falta para continuar (por ejemplo, la herramienta)");
    }
    let update = PartProgressUpdate {
        completed_quantity: payload.completed_quantity,
        step,
        note,
        pieces: extra_op.zip(payload.pieces),
        programmed: extra_op.zip(payload.programmed),
    };
    let before = get_project_concept_by_id_for_company(&state, &id, &company_id)
        .await
        .ok()
        .flatten();
    // Programmers tick only their own parts: those where they hold a step (Daniel,
    // 2026-11-02). Whoever manages the board can tick any part.
    if !session_user.has_permission(UserPermission::ManageProductionBoard) {
        let me = *session_user.user_id();
        let holds_a_step = before.as_ref().is_some_and(|c| {
            c.process_steps
                .iter()
                .any(|s| s.assignee_user_id == Some(me))
        });
        if before.is_some() && !holds_a_step {
            return json_error(
                StatusCode::FORBIDDEN,
                "solo puedes palomear los números de parte que tienes asignados",
            );
        }
    }
    match update_part_progress(&state, &id, &company_id, update, &username).await {
        Ok(Some(concept)) => {
            if let Some(before) = &before {
                if let Some((operation_id, new_state)) = step {
                    log_step_change(&state, &session_user, before, &concept, operation_id, new_state)
                        .await;
                }
                log_pieces_change(&state, &session_user, before, &concept).await;
            }
            match project_concept_data(concept) {
                Some(mut data) => {
                    if !can_view_money {
                        data.estimated_cost = None;
                        data.unit_price = None;
                        data.description = crate::redact::strip_money_opt(data.description);
                        data.notes = crate::redact::strip_money_opt(data.notes);
                    }
                    Json(data).into_response()
                }
                None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "concept missing id"),
            }
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "concept not found"),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// Logs a change in finished pieces with who ticked it and the price at that moment, so the
/// weekly report can value pieces per week and Daniel can audit every tick.
pub(crate) async fn log_pieces_change(
    state: &AppState,
    session_user: &SessionUser,
    before: &ProjectConcept,
    after: &ProjectConcept,
) {
    let delta = after.completed_quantity - before.completed_quantity;
    if delta == 0.0 {
        return;
    }
    let Some(concept_id) = after.id else { return };
    let event = WorkOrderEvent {
        id: None,
        company_id: after.company_id,
        concept_id,
        project_id: after.project_id,
        kind: WorkOrderEventKind::PiecesRecorded,
        operation_id: None,
        operation_name: None,
        queue: None,
        actor_user_id: *session_user.user_id(),
        subject_user_id: None,
        related_to: None,
        reason: None,
        pieces_delta: Some(delta),
        unit_price: after.unit_price,
        previous_user_id: None,
        at: mongodb::bson::DateTime::now(),
    };
    if let Err(err) = log_work_order_event(state, event).await {
        eprintln!("[production] could not log pieces change: {err}");
    }
}

/// Logs StepDone (credited to the step's assignee, or to whoever marked it when nobody held
/// it) and StepReopened (Done → anything else) so the weekly report stays net of mistakes.
pub(crate) async fn log_step_change(
    state: &AppState,
    session_user: &SessionUser,
    before: &ProjectConcept,
    after: &ProjectConcept,
    operation_id: ObjectId,
    new_state: StepState,
) {
    let was_done = before
        .process_steps
        .iter()
        .any(|s| s.operation_id == operation_id && s.state == StepState::Done);
    let kind = match (was_done, new_state) {
        (false, StepState::Done) => WorkOrderEventKind::StepDone,
        (true, StepState::Pending) | (true, StepState::NotApplicable) => {
            WorkOrderEventKind::StepReopened
        }
        _ => return,
    };
    let step = after.process_steps.iter().find(|s| s.operation_id == operation_id);
    let queue = state
        .process_operations
        .find_one(mongodb::bson::doc! { "_id": operation_id, "company_id": after.company_id })
        .await
        .ok()
        .flatten()
        .and_then(|op| op.queue);
    let actor = *session_user.user_id();
    let subject = match kind {
        WorkOrderEventKind::StepDone => Some(step.and_then(|s| s.assignee_user_id).unwrap_or(actor)),
        _ => step.and_then(|s| s.assignee_user_id),
    };
    let Some(concept_id) = after.id else { return };
    let event = WorkOrderEvent {
        id: None,
        company_id: after.company_id,
        concept_id,
        project_id: after.project_id,
        kind,
        operation_id: Some(operation_id),
        operation_name: step.map(|s| s.name.clone()),
        queue,
        actor_user_id: actor,
        subject_user_id: subject,
        related_to: None,
        reason: None,
        pieces_delta: None,
        unit_price: None,
        previous_user_id: None,
        at: mongodb::bson::DateTime::now(),
    };
    if let Err(err) = log_work_order_event(state, event).await {
        eprintln!("[production] could not log step change: {err}");
    }
}
