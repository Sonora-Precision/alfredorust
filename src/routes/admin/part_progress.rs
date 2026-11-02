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
    models::{ProcessOperation, StepState, UserPermission},
    session::SessionUser,
    state::{
        AppState, PartProgressUpdate, create_process_operation, delete_process_operation,
        list_process_operations, update_part_progress, update_process_operation,
    },
};

#[derive(Serialize)]
pub struct ProcessOperationData {
    pub id: String,
    pub name: String,
    pub position: i32,
    pub is_active: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

fn process_operation_data(op: ProcessOperation) -> Option<ProcessOperationData> {
    Some(ProcessOperationData {
        id: op.id?.to_hex(),
        name: op.name,
        position: op.position,
        is_active: op.is_active,
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
    match create_process_operation(&state, &company_id, &payload.name, payload.position).await {
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
    match update_process_operation(
        &state,
        &id,
        &company_id,
        &payload.name,
        payload.position,
        payload.is_active,
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
    /// "pending", "done" or "not_applicable".
    pub state: Option<String>,
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
        (status = 403, description = "Admin only"),
        (status = 404, description = "Not found")
    ),
    security(("session" = []))
)]
pub async fn api_project_concept_progress(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<PartProgressPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let step = match (payload.operation_id.as_deref(), payload.state.as_deref()) {
        (None, None) => None,
        (Some(op), Some(st)) => {
            let op = match parse_oid(op) {
                Ok(op) => op,
                Err(resp) => return resp,
            };
            let Some(st) = StepState::parse(st) else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "state must be pending, done or not_applicable",
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
    if step.is_none() && payload.completed_quantity.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "nothing to update");
    }
    let username = session_user.user().username.clone();
    let update = PartProgressUpdate {
        completed_quantity: payload.completed_quantity,
        step,
    };
    match update_part_progress(&state, &id, &company_id, update, &username).await {
        Ok(Some(concept)) => match project_concept_data(concept) {
            Some(data) => Json(data).into_response(),
            None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "concept missing id"),
        },
        Ok(None) => json_error(StatusCode::NOT_FOUND, "concept not found"),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}
