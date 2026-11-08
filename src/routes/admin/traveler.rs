//! Traveler (Daniel, 2026-11-08): where every part of every open project is, in one read.
//! The open projects with their parts (counts per step, programs, material) and the active
//! checklist, so the page groups them by stage. Whoever sees the production board sees it;
//! never money.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::stream::TryStreamExt;
use mongodb::bson::{self, doc, oid::ObjectId};
use serde::Serialize;

use super::finance::helpers::require_active_company;
use super::project_backend::{ProjectConceptData, iso, json_error, project_concept_data};
use crate::{
    models::{Contact, ProjectConcept, ProjectStatus, UserPermission},
    session::SessionUser,
    state::{AppState, list_process_operations, material_status, parts_with_received_material},
};

#[derive(Serialize)]
pub struct TravelerOperation {
    pub id: String,
    pub name: String,
    pub position: i32,
    pub is_active: bool,
}

#[derive(Serialize)]
pub struct TravelerProject {
    pub id: String,
    pub title: String,
    pub client: Option<String>,
    pub priority: &'static str,
    pub priority_label: &'static str,
    /// Delivery date.
    pub scheduled_at: Option<String>,
    pub parts: Vec<ProjectConceptData>,
}

#[derive(Serialize)]
pub struct TravelerData {
    pub operations: Vec<TravelerOperation>,
    pub projects: Vec<TravelerProject>,
}

pub async fn api_traveler(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !session_user.has_permission(UserPermission::ViewProductionBoard) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    match load(&state, &company_id).await {
        Ok(data) => Json(data).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the traveler"),
    }
}

async fn load(state: &AppState, company_id: &ObjectId) -> anyhow::Result<TravelerData> {
    let operations = list_process_operations(state, company_id, false).await?;

    let closed: Vec<bson::Bson> =
        [ProjectStatus::Entregado, ProjectStatus::Cancelado].iter().map(bson::to_bson).collect::<Result<_, _>>()?;
    let projects: Vec<crate::models::Project> = state
        .projects
        .find(doc! { "company_id": company_id, "status": { "$nin": closed }, "completed_at": null })
        .sort(doc! { "scheduled_at": 1, "created_at": 1 })
        .await?
        .try_collect()
        .await?;

    let cancelled: Vec<ObjectId> = state
        .concept_statuses
        .find(doc! { "company_id": company_id, "is_cancelled": true })
        .await?
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .filter_map(|s| s.id)
        .collect();

    let contact_ids: Vec<ObjectId> = projects.iter().filter_map(|p| p.contact_id).collect();
    let mut clients = HashMap::new();
    if !contact_ids.is_empty() {
        let mut cursor = state.contacts.find(doc! { "company_id": company_id, "_id": { "$in": &contact_ids } }).await?;
        while let Some(Contact { id: Some(id), name, .. }) = cursor.try_next().await? {
            clients.insert(id, name);
        }
    }

    let project_ids: Vec<ObjectId> = projects.iter().filter_map(|p| p.id).collect();
    let concepts: Vec<ProjectConcept> = state
        .project_concepts
        .find(doc! { "company_id": company_id, "project_id": { "$in": &project_ids }, "status_id": { "$nin": &cancelled } })
        .sort(doc! { "position": 1, "created_at": 1 })
        .await?
        .try_collect()
        .await?;
    let ids: Vec<ObjectId> = concepts.iter().filter_map(|c| c.id).collect();
    let received = parts_with_received_material(state, company_id, &ids).await.unwrap_or_default();

    let mut by_project: HashMap<ObjectId, Vec<ProjectConceptData>> = HashMap::new();
    for c in concepts {
        let project_id = c.project_id;
        let status = material_status(&c, c.id.is_some_and(|id| received.contains(&id)));
        if let Some(mut d) = project_concept_data(c) {
            d.material_status = status;
            // Never money here.
            d.unit_price = None;
            d.estimated_cost = None;
            d.description = crate::redact::strip_money_opt(d.description);
            d.notes = crate::redact::strip_money_opt(d.notes);
            by_project.entry(project_id).or_default().push(d);
        }
    }

    Ok(TravelerData {
        operations: operations
            .into_iter()
            .filter_map(|op| Some(TravelerOperation { id: op.id?.to_hex(), name: op.name, position: op.position, is_active: op.is_active }))
            .collect(),
        projects: projects
            .into_iter()
            .filter_map(|p| {
                let id = p.id?;
                Some(TravelerProject {
                    id: id.to_hex(),
                    title: p.title,
                    client: p.contact_id.and_then(|c| clients.get(&c).cloned()),
                    priority: p.priority.as_str(),
                    priority_label: p.priority.label(),
                    scheduled_at: p.scheduled_at.map(iso),
                    parts: by_project.remove(&id).unwrap_or_default(),
                })
            })
            .collect(),
    })
}
