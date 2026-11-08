//! Shop right now (Daniel, 2026-11-08): who is in today and which work orders each person
//! holds. The machines come from the plant view; this adds the people, so the page can say
//! who has nothing to do. Whoever sees the production board sees it; the time clock (who came
//! and when) only reaches admins, like the attendance report. No money.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mongodb::bson::{DateTime, oid::ObjectId};
use serde::Serialize;

use super::attendance::{DayData, build_report, shop_date, shop_midnight};
use super::finance::helpers::{require_active_company, require_admin_active};
use super::production::folio;
use super::project_backend::json_error;
use crate::{
    models::{AttendanceEmployee, AttendanceEvent, UserPermission},
    session::SessionUser,
    state::{AppState, BoardMember, WorkOrder, list_attendance_employees, list_attendance_events, list_board_members, list_work_orders},
};

#[derive(Serialize)]
pub struct FloorOrder {
    pub id: String,
    pub folio: String,
    pub part: String,
    pub project: String,
    pub project_id: String,
    /// Step it waits on: "Programa", "Setup 1"…
    pub step: String,
    pub queue: &'static str,
}

#[derive(Serialize)]
pub struct FloorAttendance {
    /// "HH:MM" of every check today.
    pub checks: Vec<String>,
    /// Same values as the attendance report: "ok", "retardo", "falta", "pendiente",
    /// "incompleto", "descanso", "extra", "sin_horario".
    pub status: String,
    /// "HH:MM–HH:MM" of today's shift.
    pub window: Option<String>,
    pub late_min: i64,
}

#[derive(Serialize)]
pub struct FloorPerson {
    /// Platform user, when they have one (links them to machines and orders).
    pub user_id: Option<String>,
    pub name: String,
    /// Registered in the time clock (admins only see the checks).
    pub in_clock: bool,
    pub attendance: Option<FloorAttendance>,
    pub orders: Vec<FloorOrder>,
}

#[derive(Serialize)]
pub struct FloorData {
    /// YYYY-MM-DD, shop time.
    pub date: String,
    /// Whether `attendance` was filled (admins).
    pub with_attendance: bool,
    pub people: Vec<FloorPerson>,
}

fn order_data(o: &WorkOrder) -> FloorOrder {
    FloorOrder {
        id: o.concept_id().to_hex(),
        folio: folio(o.concept.work_order_number),
        part: o.concept.name.clone(),
        project: o.project.title.clone(),
        project_id: o.concept.project_id.to_hex(),
        step: o.operation.name.clone(),
        queue: o.queue.as_str(),
    }
}

fn attendance_of(day: &DayData) -> FloorAttendance {
    FloorAttendance {
        checks: day.checks.clone(),
        status: day.status.clone(),
        window: day.window.clone(),
        late_min: day.late_min,
    }
}

/// People of the shop: everyone in the time clock (active), then board members who are not in
/// it. Pure, so it is tested without a database.
pub fn build_people(
    employees: &[AttendanceEmployee],
    events: &[AttendanceEvent],
    members: &[BoardMember],
    orders: &[WorkOrder],
    with_attendance: bool,
    now: DateTime,
) -> Vec<FloorPerson> {
    let today = shop_date(now);
    let report = build_report(employees, events, today, today, now);
    let days: HashMap<&str, &DayData> = report
        .employees
        .iter()
        .filter_map(|e| e.days.first().map(|d| (e.employee_no.as_str(), d)))
        .collect();
    let mut by_user: HashMap<ObjectId, Vec<FloorOrder>> = HashMap::new();
    for o in orders {
        if let Some(u) = o.assignee_user_id {
            by_user.entry(u).or_default().push(order_data(o));
        }
    }
    let member_names: HashMap<ObjectId, &str> = members.iter().map(|m| (m.user_id, m.name.as_str())).collect();

    let mut seen = HashSet::new();
    let mut people = Vec::new();
    for e in employees.iter().filter(|e| e.active) {
        if let Some(u) = e.user_id {
            seen.insert(u);
        }
        people.push(FloorPerson {
            user_id: e.user_id.map(|u| u.to_hex()),
            name: e.user_id.and_then(|u| member_names.get(&u).map(|n| n.to_string())).unwrap_or_else(|| e.name.clone()),
            in_clock: true,
            attendance: with_attendance
                .then(|| days.get(e.employee_no.as_str()).map(|d| attendance_of(d)))
                .flatten(),
            orders: e.user_id.and_then(|u| by_user.remove(&u)).unwrap_or_default(),
        });
    }
    for m in members.iter().filter(|m| !seen.contains(&m.user_id)) {
        people.push(FloorPerson {
            user_id: Some(m.user_id.to_hex()),
            name: m.name.clone(),
            in_clock: false,
            attendance: None,
            orders: by_user.remove(&m.user_id).unwrap_or_default(),
        });
    }
    people.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    people
}

pub async fn api_production_floor(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !session_user.has_permission(UserPermission::ViewProductionBoard) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let with_attendance = require_admin_active(&session_user).is_ok();
    let now = DateTime::now();
    let today = shop_date(now);
    let loaded = tokio::try_join!(
        list_attendance_employees(&state, &company_id),
        list_attendance_events(&state, &company_id, shop_midnight(today), shop_midnight(today + chrono::Duration::days(1))),
        list_board_members(&state, &company_id),
        list_work_orders(&state, &company_id),
    );
    let Ok((employees, events, members, orders)) = loaded else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the shop");
    };
    Json(FloorData {
        date: today.format("%Y-%m-%d").to_string(),
        with_attendance,
        people: build_people(&employees, &events, &members, &orders, with_attendance, now),
    })
    .into_response()
}
