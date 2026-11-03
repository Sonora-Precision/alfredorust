//! Plant view JSON API: the shop layout plus, per machine, a traffic-light status (DNC run
//! or manual state), the order it runs and who programmed it. No money.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::{require_active_company, require_admin_active};
use super::production::{PersonData, member_names, person};
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{
        MachineState, MachineStatus, PlacedMachine, PlantLabel, PlantLayout, ResourceType,
        UserPermission,
    },
    session::SessionUser,
    state::{
        AppState, RunMatch, build_part_index, get_plant_layout, latest_runs_by_machine,
        list_board_members, list_machine_states, list_resources, machine_key, programmer_of,
        resolve_status, save_plant_layout, set_machine_state,
    },
};

#[derive(Serialize)]
pub struct PlacedMachineData {
    pub resource_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rotation: f64,
    pub area: Option<String>,
}

#[derive(Serialize)]
pub struct PlantLayoutData {
    pub width: f64,
    pub height: f64,
    pub walls: Vec<[f64; 2]>,
    pub rooms: Vec<Vec<[f64; 2]>>,
    pub labels: Vec<PlantLabel>,
    pub machines: Vec<PlacedMachineData>,
}

fn layout_data(l: PlantLayout) -> PlantLayoutData {
    PlantLayoutData {
        width: l.width,
        height: l.height,
        walls: l.walls,
        rooms: l.rooms,
        labels: l.labels,
        machines: l
            .machines
            .into_iter()
            .map(|m| PlacedMachineData {
                resource_id: m.resource_id.to_hex(),
                x: m.x,
                y: m.y,
                w: m.w,
                h: m.h,
                rotation: m.rotation,
                area: m.area,
            })
            .collect(),
    }
}

#[derive(Serialize)]
pub struct MachineOrderData {
    pub id: String,
    pub folio: String,
    pub part: String,
    pub project: String,
    pub client: Option<String>,
    pub quantity: f64,
    pub completed_quantity: f64,
}

#[derive(Serialize)]
pub struct MachineData {
    pub resource_id: String,
    pub name: String,
    /// "working", "setup", "stopped" or null (no data yet).
    pub status: Option<&'static str>,
    /// "dnc", "manual" or "none".
    pub source: &'static str,
    pub since: Option<String>,
    pub note: Option<String>,
    /// Program and part from the last DNC run.
    pub program: Option<String>,
    pub part_number: Option<String>,
    pub order: Option<MachineOrderData>,
    pub programmer: Option<PersonData>,
}

#[derive(Serialize)]
pub struct PlantData {
    pub layout: Option<PlantLayoutData>,
    pub machines: Vec<MachineData>,
}

async fn order_data(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
) -> Option<MachineOrderData> {
    let concept = state
        .project_concepts
        .find_one(doc! { "_id": concept_id, "company_id": company_id })
        .await
        .ok()??;
    let project = state
        .projects
        .find_one(doc! { "_id": concept.project_id, "company_id": company_id })
        .await
        .ok()??;
    let client = match project.contact_id {
        Some(c) => state
            .contacts
            .find_one(doc! { "_id": c, "company_id": company_id })
            .await
            .ok()
            .flatten()
            .map(|c| c.name),
        None => None,
    };
    Some(MachineOrderData {
        id: concept_id.to_hex(),
        folio: concept
            .work_order_number
            .map(|n| format!("OT-{n:04}"))
            .unwrap_or_else(|| "OT-?".to_string()),
        part: concept.name,
        project: project.title,
        client,
        quantity: concept.quantity,
        completed_quantity: concept.completed_quantity,
    })
}

pub async fn api_production_plant(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !session_user.has_permission(UserPermission::ViewProductionBoard) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let loaded = tokio::try_join!(
        get_plant_layout(&state, &company_id),
        list_resources(&state, &company_id),
        latest_runs_by_machine(&state, &company_id, 30),
        list_machine_states(&state, &company_id),
        build_part_index(&state, &company_id),
        list_board_members(&state, &company_id),
    );
    let Ok((layout, resources, runs, manual, index, members)) = loaded else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the plant");
    };
    let names = member_names(&members);
    let now = DateTime::now();

    let mut machines = Vec::new();
    for r in resources
        .iter()
        .filter(|r| r.is_active && r.resource_type == ResourceType::Machinery)
    {
        let Some(resource_id) = r.id else { continue };
        let run = runs.get(&machine_key(&r.name));
        let manual_state = manual.get(&resource_id);
        let resolved = resolve_status(run, manual_state, now);
        let active = matches!(
            resolved.status,
            Some(MachineStatus::Working) | Some(MachineStatus::Setup)
        );

        // The order: from the live run's part number, else the one set by hand.
        let concept_id = match (resolved.source, run) {
            ("dnc" | "movimiento", Some(run)) if active => match index.match_run(run.part_key.as_deref(), run.started_at) {
                RunMatch::Matched { shares } => shares
                    .first()
                    .and_then(|s| ObjectId::parse_str(&s.concept_id).ok()),
                _ => None,
            },
            ("manual", _) if active => manual_state.and_then(|m| m.concept_id),
            _ => None,
        };
        let order = match concept_id {
            Some(c) => order_data(&state, &company_id, &c).await,
            None => None,
        };
        let programmer = match concept_id {
            Some(c) => programmer_of(&state, &company_id, &c)
                .await
                .ok()
                .flatten()
                .map(|u| person(u, &names)),
            None => None,
        };
        machines.push(MachineData {
            resource_id: resource_id.to_hex(),
            name: r.name.clone(),
            status: resolved.status.map(|s| s.as_str()),
            source: resolved.source,
            since: resolved.since.map(iso),
            note: if resolved.source == "manual" {
                manual_state.and_then(|m| m.note.clone())
            } else {
                None
            },
            program: run.map(|r| r.program.clone()),
            part_number: run.and_then(|r| r.part_number.clone()),
            order,
            programmer,
        });
    }
    machines.sort_by(|a, b| a.name.cmp(&b.name));

    Json(PlantData {
        layout: layout.map(layout_data),
        machines,
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct PlacedMachinePayload {
    pub resource_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub area: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PlantLayoutPayload {
    pub width: f64,
    pub height: f64,
    pub walls: Vec<[f64; 2]>,
    #[serde(default)]
    pub rooms: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    pub labels: Vec<PlantLabel>,
    #[serde(default)]
    pub machines: Vec<PlacedMachinePayload>,
}

/// Replaces the company's plant layout (admin only). Every machine must be a resource of
/// the company.
pub async fn api_plant_layout_save(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PlantLayoutPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let finite = |v: f64| v.is_finite();
    if !(finite(payload.width) && finite(payload.height) && payload.width > 0.0 && payload.height > 0.0)
        || payload.walls.len() < 3
        || payload.walls.iter().flatten().any(|v| !v.is_finite())
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "layout needs a positive size and a wall polygon of at least 3 points",
        );
    }
    let resources = match list_resources(&state, &company_id).await {
        Ok(r) => r,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load machines"),
    };
    let own: HashMap<ObjectId, ()> = resources.iter().filter_map(|r| r.id).map(|id| (id, ())).collect();
    let mut machines = Vec::new();
    for m in payload.machines {
        let id = match parse_oid(&m.resource_id) {
            Ok(id) => id,
            Err(resp) => return resp,
        };
        if !own.contains_key(&id) {
            return json_error(StatusCode::BAD_REQUEST, "machine is not a resource of this company");
        }
        if ![m.x, m.y, m.w, m.h, m.rotation].iter().all(|v| v.is_finite()) || m.w <= 0.0 || m.h <= 0.0 {
            return json_error(StatusCode::BAD_REQUEST, "machine places need a positive size");
        }
        machines.push(PlacedMachine {
            resource_id: id,
            x: m.x,
            y: m.y,
            w: m.w,
            h: m.h,
            rotation: m.rotation,
            area: m.area.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()),
        });
    }
    let layout = PlantLayout {
        id: None,
        company_id,
        width: payload.width,
        height: payload.height,
        walls: payload.walls,
        rooms: payload.rooms,
        labels: payload.labels,
        machines,
        updated_at: None,
    };
    match save_plant_layout(&state, layout).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the layout"),
    }
}

#[derive(Debug, Deserialize)]
pub struct MachineStatePayload {
    /// "working", "setup" or "stopped".
    pub status: String,
    pub concept_id: Option<String>,
    pub note: Option<String>,
}

/// Sets a machine's state by hand (whoever manages the board).
pub async fn api_machine_state_set(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<MachineStatePayload>,
) -> Response {
    if !session_user.has_permission(UserPermission::ManageProductionBoard) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let resource_id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Some(status) = MachineStatus::parse(payload.status.trim()) else {
        return json_error(StatusCode::BAD_REQUEST, "status must be working, setup or stopped");
    };
    match state
        .resources
        .find_one(doc! { "_id": resource_id, "company_id": company_id })
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "machine not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load machine"),
    }
    let concept_id = match payload.concept_id.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => match parse_oid(c) {
            Ok(c) => {
                match state
                    .project_concepts
                    .find_one(doc! { "_id": c, "company_id": company_id })
                    .await
                {
                    Ok(Some(_)) => Some(c),
                    _ => return json_error(StatusCode::BAD_REQUEST, "order not found"),
                }
            }
            Err(resp) => return resp,
        },
        None => None,
    };
    let note = payload
        .note
        .map(|n| n.trim().chars().take(200).collect::<String>())
        .filter(|n| !n.is_empty());
    let machine_state = MachineState {
        id: None,
        company_id,
        resource_id,
        status,
        concept_id,
        note,
        set_by: *session_user.user_id(),
        at: DateTime::now(),
    };
    match set_machine_state(&state, machine_state).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the state"),
    }
}
