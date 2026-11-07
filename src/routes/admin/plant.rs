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
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::{require_active_company, require_admin_active};
use super::production::{PersonData, member_names, person};
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{
        MachineQueueEntry, MachineState, MachineStatus, PartMaterial, PlacedMachine, PlantLabel, PlantLayout,
        Project, ProjectConcept, ResourceType, UserPermission,
    },
    session::SessionUser,
    state::{
        AppState, RunMatch, add_machine_queue_entry, build_part_index, get_machine_queue_entry,
        get_plant_layout, latest_runs_by_machine, list_board_members, list_machine_queues,
        list_machine_states, list_resources, machine_key, move_machine_queue_entry, programmer_of, QueueMove,
        remove_machine_queue_entry, resolve_status, save_plant_layout, set_machine_state,
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

#[derive(Serialize, Clone)]
pub struct MachineOrderData {
    pub id: String,
    pub folio: String,
    pub part: String,
    pub project: String,
    pub client: Option<String>,
    pub quantity: f64,
    pub completed_quantity: f64,
    /// Material and blank (stock) size, so the operator sees what to load.
    pub material: Option<PartMaterial>,
    /// Cuts from each assigned bar (same as the cut list): for the saw.
    pub cuts: Vec<MachineCutData>,
}

#[derive(Serialize, Clone)]
pub struct MachineCutData {
    pub thickness: Option<f64>,
    pub width: Option<f64>,
    pub length: f64,
    pub cuts: i64,
    pub leftover: f64,
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
    /// Setup or operation of the order set by hand ("Setup 1").
    pub label: Option<String>,
    /// Who put it to run here (a programmer picks the machine they work on).
    pub running_by: Option<PersonData>,
    pub programmer: Option<PersonData>,
    /// What runs next here, first to run first.
    pub queue: Vec<QueueEntryData>,
}

#[derive(Serialize)]
pub struct QueueEntryData {
    pub id: String,
    pub label: Option<String>,
    pub order: MachineOrderData,
}

#[derive(Serialize)]
pub struct PlantData {
    pub layout: Option<PlantLayoutData>,
    pub machines: Vec<MachineData>,
}

/// Order cards for the given parts in three queries (running orders plus every queue).
async fn orders_by_id(
    state: &AppState,
    company_id: &ObjectId,
    ids: &[ObjectId],
) -> HashMap<ObjectId, MachineOrderData> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return out;
    }
    let concepts: Vec<ProjectConcept> = match state
        .project_concepts
        .find(doc! { "_id": { "$in": ids }, "company_id": company_id })
        .await
    {
        Ok(c) => c.try_collect().await.unwrap_or_default(),
        Err(_) => return out,
    };
    let project_ids: Vec<ObjectId> = concepts.iter().map(|c| c.project_id).collect();
    let projects: HashMap<ObjectId, Project> = match state
        .projects
        .find(doc! { "_id": { "$in": &project_ids }, "company_id": company_id })
        .await
    {
        Ok(c) => c
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.id.map(|id| (id, p)))
            .collect(),
        Err(_) => HashMap::new(),
    };
    let contact_ids: Vec<ObjectId> = projects.values().filter_map(|p| p.contact_id).collect();
    let contacts: HashMap<ObjectId, String> = match state
        .contacts
        .find(doc! { "_id": { "$in": &contact_ids }, "company_id": company_id })
        .await
    {
        Ok(c) => c
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|c| c.id.map(|id| (id, c.name)))
            .collect(),
        Err(_) => HashMap::new(),
    };
    let mut plan = match super::material::load_cut_plan(state, company_id).await {
        Ok(p) => p.plan,
        Err(_) => HashMap::new(),
    };
    for concept in concepts {
        let (Some(id), Some(project)) = (concept.id, projects.get(&concept.project_id)) else {
            continue;
        };
        let cuts = plan
            .remove(&id)
            .unwrap_or_default()
            .into_iter()
            .map(|b| MachineCutData {
                thickness: b.thickness,
                width: b.width,
                length: b.length,
                cuts: b.cuts,
                leftover: b.leftover,
            })
            .collect();
        out.insert(
            id,
            MachineOrderData {
                id: id.to_hex(),
                folio: concept
                    .work_order_number
                    .map(|n| format!("OT-{n:04}"))
                    .unwrap_or_else(|| "OT-?".to_string()),
                part: concept.name,
                project: project.title.clone(),
                client: project.contact_id.and_then(|c| contacts.get(&c).cloned()),
                quantity: concept.quantity,
                completed_quantity: concept.completed_quantity,
                material: concept.material,
                cuts,
            },
        );
    }
    out
}

/// Who may say what runs on a machine and edit its queue: programmers too (Daniel,
/// 2026-11-03: "También programadores").
fn can_edit_machines(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::TakeWorkOrders)
        || user.has_permission(UserPermission::ManageProductionBoard)
}

/// "Setup 1", "Op 20": trimmed, at most 40 characters, empty → none.
fn clean_label(label: Option<String>) -> Option<String> {
    label
        .map(|l| l.trim().chars().take(40).collect::<String>())
        .filter(|l| !l.is_empty())
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
        list_machine_queues(&state, &company_id),
    );
    let Ok((layout, resources, runs, manual, index, members, mut queues)) = loaded else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the plant");
    };
    let names = member_names(&members);
    let now = DateTime::now();

    // Every part a machine runs or has queued, loaded at once.
    let mut wanted: Vec<ObjectId> = queues.values().flatten().map(|e| e.concept_id).collect();
    wanted.extend(manual.values().filter_map(|m| m.concept_id));
    let mut orders = orders_by_id(&state, &company_id, &wanted).await;

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
            Some(c) if !orders.contains_key(&c) => {
                let more = orders_by_id(&state, &company_id, &[c]).await;
                orders.extend(more);
                orders.get(&c).cloned()
            }
            Some(c) => orders.get(&c).cloned(),
            None => None,
        };
        let by_hand = resolved.source == "manual" && order.is_some();
        let label = manual_state.filter(|_| by_hand).and_then(|m| m.label.clone());
        let running_by = manual_state.filter(|_| by_hand).map(|m| person(m.set_by, &names));
        let queue = queues
            .remove(&resource_id)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| {
                Some(QueueEntryData {
                    id: e.id?.to_hex(),
                    label: e.label,
                    order: orders.get(&e.concept_id)?.clone(),
                })
            })
            .collect();
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
            label,
            running_by,
            programmer,
            queue,
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
    /// Setup or operation it runs ("Setup 1").
    #[serde(default)]
    pub label: Option<String>,
}

/// Sets a machine's state by hand, with the order and setup it runs (programmers and whoever
/// manages the board).
pub async fn api_machine_state_set(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<MachineStatePayload>,
) -> Response {
    if !can_edit_machines(&session_user) {
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
        label: if concept_id.is_some() { clean_label(payload.label) } else { None },
        set_by: *session_user.user_id(),
        at: DateTime::now(),
    };
    match set_machine_state(&state, machine_state).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the state"),
    }
}

/// "Terminar trabajo": whoever runs it closes the job on that machine; it shows stopped with
/// a note of who finished what, so the next queued order can be moved in.
pub async fn api_machine_finish(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !can_edit_machines(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let resource_id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match machine_exists(&state, &company_id, &resource_id).await {
        Ok(true) => {}
        Ok(false) => return json_error(StatusCode::NOT_FOUND, "machine not found"),
        Err(resp) => return resp,
    }
    let current = list_machine_states(&state, &company_id)
        .await
        .ok()
        .and_then(|mut m| m.remove(&resource_id));
    let finished = match current.as_ref().and_then(|m| m.concept_id) {
        Some(c) => orders_by_id(&state, &company_id, &[c]).await.remove(&c).map(|o| {
            let label = current.as_ref().and_then(|m| m.label.clone());
            match label {
                Some(l) => format!("Terminó {} {} ({l})", o.folio, o.part),
                None => format!("Terminó {} {}", o.folio, o.part),
            }
        }),
        None => None,
    };
    // On the band saw, finishing the job means the part's cut is done.
    if let Some(c) = current.as_ref().and_then(|m| m.concept_id) {
        super::material::saw_job_finished(&state, &company_id, &resource_id, &c, &session_user.user().username)
            .await;
    }
    let machine_state = MachineState {
        id: None,
        company_id,
        resource_id,
        status: MachineStatus::Stopped,
        concept_id: None,
        note: finished,
        label: None,
        set_by: *session_user.user_id(),
        at: DateTime::now(),
    };
    match set_machine_state(&state, machine_state).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the state"),
    }
}

async fn machine_exists(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<bool, Response> {
    match state.resources.find_one(doc! { "_id": id, "company_id": company_id }).await {
        Ok(found) => Ok(found.is_some()),
        Err(_) => Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load machine")),
    }
}

#[derive(Debug, Deserialize)]
pub struct QueueAddPayload {
    pub concept_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// Adds an order at the end of a machine's queue.
pub async fn api_machine_queue_add(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<QueueAddPayload>,
) -> Response {
    if !can_edit_machines(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let (resource_id, concept_id) = match (parse_oid(&id), parse_oid(&payload.concept_id)) {
        (Ok(r), Ok(c)) => (r, c),
        (Err(resp), _) | (_, Err(resp)) => return resp,
    };
    match machine_exists(&state, &company_id, &resource_id).await {
        Ok(true) => {}
        Ok(false) => return json_error(StatusCode::NOT_FOUND, "machine not found"),
        Err(resp) => return resp,
    }
    match state
        .project_concepts
        .find_one(doc! { "_id": concept_id, "company_id": company_id })
        .await
    {
        Ok(None) => return json_error(StatusCode::BAD_REQUEST, "order not found"),
        Ok(Some(concept)) => {
            // The saw only cuts material already in the shop (Daniel, 2026-11-06).
            let on_saw = super::material::find_saw(&state, &company_id).await == Some(resource_id);
            if on_saw && super::material::is_plate(&concept) {
                return json_error(StatusCode::BAD_REQUEST, super::material::PLATE_NO_SAW);
            }
            if on_saw
                && !super::material::material_in_shop(&state, &company_id, &concept).await
            {
                return json_error(StatusCode::BAD_REQUEST, super::material::NOT_IN_SHOP);
            }
        }
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load order"),
    }
    match add_machine_queue_entry(
        &state,
        company_id,
        resource_id,
        concept_id,
        clean_label(payload.label),
        *session_user.user_id(),
    )
    .await
    {
        Ok(e) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "id": e.id.map(|i| i.to_hex()), "rank": e.rank })),
        )
            .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not queue the order"),
    }
}

/// The entry of the path, checked against the session's company.
async fn queue_entry(
    session_user: &SessionUser,
    state: &AppState,
    id: &str,
) -> Result<(ObjectId, MachineQueueEntry), Response> {
    if !can_edit_machines(session_user) {
        return Err(StatusCode::FORBIDDEN.into_response());
    }
    let company_id = require_active_company(session_user);
    let id = parse_oid(id)?;
    match get_machine_queue_entry(state, &company_id, &id).await {
        Ok(Some(e)) => Ok((company_id, e)),
        Ok(None) => Err(json_error(StatusCode::NOT_FOUND, "queue entry not found")),
        Err(_) => Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the queue")),
    }
}

pub async fn api_machine_queue_remove(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let (company_id, entry) = match queue_entry(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match remove_machine_queue_entry(&state, &company_id, &entry.id.unwrap_or_default()).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not remove the entry"),
    }
}

#[derive(Debug, Deserialize)]
pub struct QueueMovePayload {
    /// true = one place earlier.
    #[serde(default)]
    pub up: bool,
    /// 0-based place to drop it at; wins over `up`.
    #[serde(default)]
    pub to: Option<usize>,
}

pub async fn api_machine_queue_move(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<QueueMovePayload>,
) -> Response {
    let (company_id, entry) = match queue_entry(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match move_machine_queue_entry(
        &state,
        &company_id,
        &entry,
        match (payload.to, payload.up) {
            (Some(i), _) => QueueMove::To(i),
            (None, true) => QueueMove::Up,
            (None, false) => QueueMove::Down,
        },
    ).await {
        Ok(moved) => Json(serde_json::json!({ "ok": true, "moved": moved })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not move the entry"),
    }
}

/// "Pasar a producción": the entry becomes what the machine runs (manual state "working",
/// with its order and setup) and leaves the queue. Only when someone asks; never automatic.
pub async fn api_machine_queue_start(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let (company_id, entry) = match queue_entry(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let machine_state = MachineState {
        id: None,
        company_id,
        resource_id: entry.resource_id,
        status: MachineStatus::Working,
        concept_id: Some(entry.concept_id),
        note: None,
        label: entry.label.clone(),
        set_by: *session_user.user_id(),
        at: DateTime::now(),
    };
    if set_machine_state(&state, machine_state).await.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the state");
    }
    match remove_machine_queue_entry(&state, &company_id, &entry.id.unwrap_or_default()).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not update the queue"),
    }
}
