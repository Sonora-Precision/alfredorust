//! Quality release JSON API: the parts with produced pieces waiting for quality, and
//! releasing or rejecting them. Only released pieces count as finished (Daniel, 2026-11-03).
//! No money: quality staff do not see prices.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mongodb::bson::{DateTime, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::production::{PersonData, folio, member_names, person};
use super::project_backend::{json_error, parse_oid};
use crate::{
    models::{ProjectConcept, UserPermission, WorkOrderEvent, WorkOrderEventKind},
    session::SessionUser,
    state::{
        AppState, awaiting_release, list_board_members, list_quality_queue, log_work_order_event,
        programmer_of, record_quality,
    },
};

fn can_release(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::ReleaseParts)
}

#[derive(Serialize)]
pub struct QualityItemData {
    pub id: String,
    pub folio: String,
    pub part: String,
    pub project_id: String,
    pub project: String,
    pub client: Option<String>,
    pub quantity: f64,
    pub unit: Option<String>,
    pub produced: f64,
    pub released: f64,
    pub rejected: f64,
    /// Produced pieces quality has not released or rejected yet.
    pub awaiting: f64,
    /// Who programmed the part (gets the credit of released pieces).
    pub programmer: Option<PersonData>,
}

/// Parts with produced pieces waiting for quality ("En liberación"), oldest folio first.
pub async fn api_quality_queue(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !(can_release(&session_user)
        || session_user.has_permission(UserPermission::ViewProductionBoard))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let loaded = tokio::try_join!(
        list_quality_queue(&state, &company_id),
        list_board_members(&state, &company_id),
    );
    let Ok((items, members)) = loaded else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load quality queue");
    };
    let names = member_names(&members);
    let mut clients: HashMap<ObjectId, Option<String>> = HashMap::new();
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.concept.id else { continue };
        let client = match item.project.contact_id {
            Some(contact) => {
                if !clients.contains_key(&contact) {
                    let name = state
                        .contacts
                        .find_one(mongodb::bson::doc! { "_id": contact, "company_id": company_id })
                        .await
                        .ok()
                        .flatten()
                        .map(|c| c.name);
                    clients.insert(contact, name);
                }
                clients[&contact].clone()
            }
            None => None,
        };
        let programmer = programmer_of(&state, &company_id, &id)
            .await
            .ok()
            .flatten()
            .map(|p| person(p, &names));
        out.push(quality_item_data(&item.concept, item.project.title.clone(), client, programmer));
    }
    Json(out).into_response()
}

fn quality_item_data(
    c: &ProjectConcept,
    project: String,
    client: Option<String>,
    programmer: Option<PersonData>,
) -> QualityItemData {
    QualityItemData {
        id: c.id.map(|i| i.to_hex()).unwrap_or_default(),
        folio: folio(c.work_order_number),
        part: c.name.clone(),
        project_id: c.project_id.to_hex(),
        project,
        client,
        quantity: c.quantity,
        unit: c.unit.clone(),
        produced: c.completed_quantity,
        released: c.released_quantity,
        rejected: c.rejected_quantity,
        awaiting: awaiting_release(c),
        programmer,
    }
}

#[derive(Debug, Deserialize)]
pub struct QualityPayload {
    /// Pieces to release now (negative = correction, board managers only).
    #[serde(default)]
    pub released: f64,
    /// Pieces to reject now (negative = correction, board managers only).
    #[serde(default)]
    pub rejected: f64,
    /// Why pieces were rejected; required when `rejected` > 0.
    pub reason: Option<String>,
}

/// Releases and/or rejects produced pieces of a part. Quality (release_parts) and the admin
/// can do it; each change is logged with who and when, released pieces credited to whoever
/// programmed the part with the price frozen for the weekly value.
pub async fn api_quality_record(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<QualityPayload>,
) -> Response {
    if !can_release(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if (payload.released < 0.0 || payload.rejected < 0.0)
        && !session_user.has_permission(UserPermission::ManageProductionBoard)
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "solo el administrador puede corregir piezas liberadas o rechazadas",
        );
    }
    let reason = payload
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_string);
    if payload.rejected > 0.0 && reason.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "escribe el motivo del rechazo");
    }
    let concept = match record_quality(&state, &id, &company_id, payload.released, payload.rejected).await {
        Ok(Some(c)) => c,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "concept not found"),
        Err(err) => return json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    };

    let programmer = programmer_of(&state, &company_id, &id).await.ok().flatten();
    let actor = *session_user.user_id();
    let now = DateTime::now();
    for (kind, delta) in [
        (WorkOrderEventKind::PiecesReleased, payload.released),
        (WorkOrderEventKind::PiecesRejected, payload.rejected),
    ] {
        if delta == 0.0 {
            continue;
        }
        let released = kind == WorkOrderEventKind::PiecesReleased;
        let event = WorkOrderEvent {
            id: None,
            company_id,
            concept_id: id,
            project_id: concept.project_id,
            kind,
            operation_id: None,
            operation_name: None,
            queue: None,
            actor_user_id: actor,
            subject_user_id: programmer,
            related_to: None,
            reason: if released { None } else { reason.clone() },
            pieces_delta: Some(delta),
            unit_price: if released { concept.unit_price } else { None },
            at: now,
        };
        if let Err(err) = log_work_order_event(&state, event).await {
            eprintln!("[quality] could not log {kind:?}: {err}");
        }
    }

    let names = list_board_members(&state, &company_id)
        .await
        .map(|m| member_names(&m))
        .unwrap_or_default();
    let project = state
        .projects
        .find_one(mongodb::bson::doc! { "_id": concept.project_id, "company_id": company_id })
        .await
        .ok()
        .flatten()
        .map(|p| p.title)
        .unwrap_or_default();
    Json(quality_item_data(
        &concept,
        project,
        None,
        programmer.map(|p| person(p, &names)),
    ))
    .into_response()
}
