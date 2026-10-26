//! Machine time from the shop floor: the monitor (taller-vision) pushes program runs read
//! from the DNC boxes; projects show the time per part number (split by pieces ordered when
//! several active projects share the part, see `PartIndex::match_run`). Time is not money, so
//! reading needs `view_projects`; writing (ingest) is admin-only, like every write here.

use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use bson::{DateTime, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::{require_active_company, require_admin_active};
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{MachineRun, UserPermission},
    session::SessionUser,
    state::{
        AppState, MAX_RUNS_PER_INGEST, NewMachineRun, RunMatch, build_part_index,
        get_project_by_id_for_company, list_machine_runs, list_project_concepts,
        upsert_machine_runs,
    },
};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct MachineRunPayload {
    /// Stable id from the sender; sending the same id again updates the run.
    pub external_id: String,
    pub machine: String,
    pub program: String,
    pub part_number: Option<String>,
    pub header_date: Option<String>,
    /// RFC 3339
    pub started_at: String,
    /// RFC 3339
    pub ended_at: String,
    pub minutes: f64,
    #[serde(default)]
    pub cutting_minutes: f64,
    #[serde(default)]
    pub cycles: i32,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct MachineRunsIngestPayload {
    /// Who sends them, e.g. "taller-vision".
    pub source: String,
    pub runs: Vec<MachineRunPayload>,
}

fn text(value: &str, field: &str, max: usize) -> Result<String, Response> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > max {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            &format!("{field} must be between 1 and {max} characters"),
        ));
    }
    Ok(v.to_string())
}

fn optional_text(
    value: Option<String>,
    field: &str,
    max: usize,
) -> Result<Option<String>, Response> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => text(v, field, max).map(Some),
    }
}

fn parse_time(value: &str, field: &str) -> Result<DateTime, Response> {
    DateTime::parse_rfc3339_str(value.trim()).map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            &format!("{field} must be RFC 3339"),
        )
    })
}

fn validate(run: MachineRunPayload) -> Result<NewMachineRun, Response> {
    let started_at = parse_time(&run.started_at, "started_at")?;
    let ended_at = parse_time(&run.ended_at, "ended_at")?;
    if ended_at < started_at {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "ended_at is before started_at",
        ));
    }
    let span_min = (ended_at.timestamp_millis() - started_at.timestamp_millis()) as f64 / 60_000.0;
    let minutes_ok = |m: f64| m.is_finite() && m >= 0.0 && m <= span_min + 1.0;
    if !minutes_ok(run.minutes)
        || !minutes_ok(run.cutting_minutes)
        || run.cutting_minutes > run.minutes + 0.01
    {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "minutes must fit the interval and cutting_minutes must not exceed minutes",
        ));
    }
    if !(0..=10_000).contains(&run.cycles) {
        return Err(json_error(StatusCode::BAD_REQUEST, "cycles out of range"));
    }
    Ok(NewMachineRun {
        external_id: text(&run.external_id, "external_id", 120)?,
        machine: text(&run.machine, "machine", 80)?,
        program: text(&run.program, "program", 120)?,
        part_number: optional_text(run.part_number, "part_number", 120)?,
        header_date: optional_text(run.header_date, "header_date", 80)?,
        started_at,
        ended_at,
        minutes: run.minutes,
        cutting_minutes: run.cutting_minutes,
        cycles: run.cycles,
    })
}

#[utoipa::path(
    post,
    path = "/api/admin/machine_runs/ingest",
    tag = "operations",
    request_body = MachineRunsIngestPayload,
    responses(
        (status = 200, description = "Runs inserted or updated"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_machine_runs_ingest(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<MachineRunsIngestPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let source = match text(&payload.source, "source", 60) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    if payload.runs.len() > MAX_RUNS_PER_INGEST {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("at most {MAX_RUNS_PER_INGEST} runs per request"),
        );
    }
    let received = payload.runs.len();
    let mut runs = Vec::with_capacity(received);
    for run in payload.runs {
        match validate(run) {
            Ok(run) => runs.push(run),
            Err(resp) => return resp,
        }
    }
    match upsert_machine_runs(&state, &company_id, &source, runs).await {
        Ok((inserted, updated)) => Json(serde_json::json!({
            "received": received,
            "inserted": inserted,
            "updated": updated,
        }))
        .into_response(),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

#[derive(Serialize, Default)]
pub struct ConceptMachineTime {
    pub concept_id: String,
    pub name: String,
    pub quantity: f64,
    pub estimated_hours: Option<f64>,
    pub minutes: f64,
    pub cutting_minutes: f64,
    /// Fractional when the part was split with other projects.
    pub cycles: f64,
    /// Part of `minutes` that came from runs split with other projects (estimate by pieces).
    pub shared_minutes: f64,
    pub runs: usize,
    pub machines: Vec<String>,
    pub programs: Vec<String>,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectMachineTime {
    pub project_id: String,
    pub minutes: f64,
    pub cutting_minutes: f64,
    pub cycles: f64,
    pub runs: usize,
    pub last_at: Option<String>,
    pub concepts: Vec<ConceptMachineTime>,
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[utoipa::path(
    get,
    path = "/api/admin/projects/{id}/machine_time",
    tag = "operations",
    params(("id" = String, Path, description = "Project id")),
    responses(
        (status = 200, description = "Machine time per part number of the project"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "Not found")
    ),
    security(("session" = []))
)]
pub async fn api_project_machine_time(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !session_user.has_permission(UserPermission::ViewProjects) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let project_id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match get_project_by_id_for_company(&state, &project_id, &company_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "project not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load project"),
    }
    let (concepts, index, runs) = match tokio::try_join!(
        list_project_concepts(&state, &company_id, &project_id),
        build_part_index(&state, &company_id),
        list_machine_runs(&state, &company_id, None, None),
    ) {
        Ok(v) => v,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not load machine time",
            );
        }
    };
    let pid = project_id.to_hex();
    let mut rows: Vec<ConceptMachineTime> = concepts
        .iter()
        .filter_map(|c| {
            Some(ConceptMachineTime {
                concept_id: c.id?.to_hex(),
                name: c.name.clone(),
                quantity: c.quantity,
                estimated_hours: c.estimated_hours,
                ..Default::default()
            })
        })
        .collect();
    let pos: HashMap<String, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.concept_id.clone(), i))
        .collect();
    let mut sets: Vec<(BTreeSet<String>, BTreeSet<String>)> = vec![Default::default(); rows.len()];
    for run in &runs {
        let RunMatch::Matched { shares } = index.match_run(run.part_key.as_deref(), run.started_at)
        else {
            continue;
        };
        let split = shares.len() > 1;
        for share in shares.iter().filter(|s| s.project_id == pid) {
            let Some(&i) = pos.get(&share.concept_id) else {
                continue;
            };
            let r = &mut rows[i];
            r.minutes += run.minutes * share.ratio;
            r.cutting_minutes += run.cutting_minutes * share.ratio;
            r.cycles += f64::from(run.cycles) * share.ratio;
            if split {
                r.shared_minutes += run.minutes * share.ratio;
            }
            r.runs += 1;
            r.first_at.get_or_insert_with(|| iso(run.started_at));
            r.last_at = Some(iso(run.ended_at));
            sets[i].0.insert(run.machine.clone());
            sets[i].1.insert(run.program.clone());
        }
    }
    for (r, (machines, programs)) in rows.iter_mut().zip(sets) {
        r.minutes = round1(r.minutes);
        r.cutting_minutes = round1(r.cutting_minutes);
        r.cycles = round1(r.cycles);
        r.shared_minutes = round1(r.shared_minutes);
        r.machines = machines.into_iter().collect();
        r.programs = programs.into_iter().collect();
    }
    Json(ProjectMachineTime {
        project_id: pid,
        minutes: round1(rows.iter().map(|r| r.minutes).sum()),
        cutting_minutes: round1(rows.iter().map(|r| r.cutting_minutes).sum()),
        cycles: round1(rows.iter().map(|r| r.cycles).sum()),
        runs: rows.iter().map(|r| r.runs).sum(),
        last_at: rows.iter().filter_map(|r| r.last_at.clone()).max(),
        concepts: rows,
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct MachineRunsQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    /// matched | no_part | not_found
    pub status: Option<String>,
}

#[derive(Serialize)]
pub struct MachineRunData {
    pub id: String,
    pub source: String,
    pub external_id: String,
    pub machine: String,
    pub program: String,
    pub part_number: Option<String>,
    pub header_date: Option<String>,
    pub started_at: String,
    pub ended_at: String,
    pub minutes: f64,
    pub cutting_minutes: f64,
    pub cycles: i32,
    #[serde(rename = "match")]
    pub matched: RunMatch,
}

fn run_data(run: MachineRun, matched: RunMatch) -> Option<MachineRunData> {
    Some(MachineRunData {
        id: run.id?.to_hex(),
        source: run.source,
        external_id: run.external_id,
        machine: run.machine,
        program: run.program,
        part_number: run.part_number,
        header_date: run.header_date,
        started_at: iso(run.started_at),
        ended_at: iso(run.ended_at),
        minutes: run.minutes,
        cutting_minutes: run.cutting_minutes,
        cycles: run.cycles,
        matched,
    })
}

fn match_status(m: &RunMatch) -> &'static str {
    match m {
        RunMatch::Matched { .. } => "matched",
        RunMatch::NoPart => "no_part",
        RunMatch::NotFound => "not_found",
    }
}

#[utoipa::path(
    get,
    path = "/api/admin/machine_runs",
    tag = "operations",
    params(
        ("from" = Option<String>, Query, description = "RFC 3339, runs started at or after"),
        ("to" = Option<String>, Query, description = "RFC 3339, runs started before"),
        ("status" = Option<String>, Query, description = "matched | no_part | not_found")
    ),
    responses(
        (status = 200, description = "Machine runs with their project part, if any"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden")
    ),
    security(("session" = []))
)]
pub async fn api_machine_runs_index(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(q): Query<MachineRunsQuery>,
) -> Response {
    if !session_user.has_permission(UserPermission::ViewProjects) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id: ObjectId = require_active_company(&session_user);
    let from = match q
        .from
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(|v| parse_time(v, "from"))
    {
        Some(Err(resp)) => return resp,
        other => other.and_then(Result::ok),
    };
    let to = match q
        .to
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(|v| parse_time(v, "to"))
    {
        Some(Err(resp)) => return resp,
        other => other.and_then(Result::ok),
    };
    let (index, runs) = match tokio::try_join!(
        build_part_index(&state, &company_id),
        list_machine_runs(&state, &company_id, from, to),
    ) {
        Ok(v) => v,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not load machine runs",
            );
        }
    };
    let items: Vec<MachineRunData> = runs
        .into_iter()
        .filter_map(|run| {
            let m = index.match_run(run.part_key.as_deref(), run.started_at);
            if q.status.as_deref().is_some_and(|s| s != match_status(&m)) {
                return None;
            }
            run_data(run, m)
        })
        .collect();
    Json(items).into_response()
}
