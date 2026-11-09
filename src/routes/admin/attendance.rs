//! Asistencia: checks from the shop's time clock (Hikvision fingerprint terminal), pushed by the
//! agent on the shop PC, plus the employees and their shifts, and the weekly report (entry, exit,
//! lateness, hours, absences). It says who came and when, so everything here is admin-only.
//!
//! The terminal does not mark "in" or "out": the first check of the day is the entry and the last
//! one the exit. Checks a couple of minutes apart are one (people press twice). Shop time is
//! Hermosillo, UTC-7 all year.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use bson::{DateTime, oid::ObjectId};
use chrono::{Datelike, Duration, NaiveDate, NaiveTime, Timelike};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_admin_active;
use super::project_backend::{iso, json_error};
use crate::{
    models::{
        AttendanceCorrection, AttendanceEmployee, AttendanceEvent, AttendanceShift, ShiftWindow,
    },
    session::SessionUser,
    state::{
        AppState, MANUAL_DEVICE, MAX_EVENTS_PER_INGEST, NewAttendanceEvent,
        delete_attendance_correction, delete_attendance_employee, delete_manual_attendance_event,
        insert_attendance_events, insert_manual_attendance_event, last_attendance_event_at,
        list_attendance_corrections, list_attendance_employees, list_attendance_events,
        upsert_attendance_correction, upsert_attendance_employee,
    },
};

/// Hermosillo is UTC-7 all year (no daylight saving).
const SHOP_UTC_OFFSET_MS: i64 = -7 * 3_600_000;
/// Checks closer than this to the previous one are the same check.
const DOUBLE_CHECK_MS: i64 = 2 * 60_000;
/// At most this many days per report.
const MAX_REPORT_DAYS: i64 = 62;

// ---------- ingest (agent) ----------

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct AttendanceEventPayload {
    /// Event serial number in the terminal.
    pub serial_no: i64,
    pub employee_no: String,
    /// RFC 3339, with the terminal's offset.
    pub time: String,
    /// "huella", "tarjeta", "pin", "rostro"; anything else is stored as "otro".
    #[serde(default)]
    pub method: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct AttendanceIngestPayload {
    /// Terminal serial number, e.g. "GL5045172".
    pub device: String,
    pub events: Vec<AttendanceEventPayload>,
}

fn valid_code(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn method_of(value: Option<&str>) -> String {
    match value.map(|m| m.trim().to_lowercase()).as_deref() {
        Some(m @ ("huella" | "tarjeta" | "pin" | "rostro")) => m.to_string(),
        _ => "otro".to_string(),
    }
}

#[utoipa::path(
    post,
    path = "/api/admin/attendance/ingest",
    tag = "operations",
    request_body = AttendanceIngestPayload,
    responses(
        (status = 200, description = "Checks stored; already stored ones are ignored"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_ingest(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AttendanceIngestPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let device = payload.device.trim();
    if !valid_code(device, 60) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "device must be 1-60 letters, digits, - or _",
        );
    }
    if payload.events.len() > MAX_EVENTS_PER_INGEST {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("at most {MAX_EVENTS_PER_INGEST} events per request"),
        );
    }
    let received = payload.events.len();
    let mut events = Vec::with_capacity(received);
    for e in payload.events {
        let employee_no = e.employee_no.trim();
        if !valid_code(employee_no, 32) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "employee_no must be 1-32 letters or digits",
            );
        }
        if e.serial_no < 0 {
            return json_error(StatusCode::BAD_REQUEST, "serial_no must not be negative");
        }
        let Ok(at) = DateTime::parse_rfc3339_str(e.time.trim()) else {
            return json_error(StatusCode::BAD_REQUEST, "time must be RFC 3339");
        };
        events.push(NewAttendanceEvent {
            serial_no: e.serial_no,
            employee_no: employee_no.to_string(),
            at,
            method: method_of(e.method.as_deref()),
        });
    }
    match insert_attendance_events(&state, &company_id, device, events).await {
        Ok(inserted) => {
            Json(serde_json::json!({ "received": received, "inserted": inserted })).into_response()
        }
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct LastQuery {
    pub device: String,
}

#[utoipa::path(
    get,
    path = "/api/admin/attendance/last",
    tag = "operations",
    params(("device" = String, Query, description = "Terminal serial number")),
    responses(
        (status = 200, description = "Time of the newest stored check of that terminal (null if none)"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_last(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(q): Query<LastQuery>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    match last_attendance_event_at(&state, &company_id, q.device.trim()).await {
        Ok(at) => Json(serde_json::json!({ "last_at": at.map(iso) })).into_response(),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

// ---------- employees ----------

#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ShiftWindowData {
    pub days: Vec<u8>,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ShiftData {
    pub start: String,
    pub end: String,
    pub days: Vec<u8>,
    pub tolerance_min: i32,
    /// Days with a different window, e.g. Saturday 12:00–17:00.
    #[serde(default)]
    pub other: Vec<ShiftWindowData>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeData {
    pub employee_no: String,
    pub name: String,
    pub user_id: Option<String>,
    pub shift: Option<ShiftData>,
    pub alternates: Vec<ShiftData>,
    pub active: bool,
    pub start_date: Option<String>,
}

fn shift_data(s: &AttendanceShift) -> ShiftData {
    ShiftData {
        start: s.start.clone(),
        end: s.end.clone(),
        days: s.days.clone(),
        tolerance_min: s.tolerance_min,
        other: s
            .other
            .iter()
            .map(|w| ShiftWindowData {
                days: w.days.clone(),
                start: w.start.clone(),
                end: w.end.clone(),
            })
            .collect(),
    }
}

fn employee_data(e: &AttendanceEmployee) -> EmployeeData {
    EmployeeData {
        employee_no: e.employee_no.clone(),
        name: e.name.clone(),
        user_id: e.user_id.map(|id| id.to_hex()),
        shift: e.shift.as_ref().map(shift_data),
        alternates: e.alternates.iter().map(shift_data).collect(),
        active: e.active,
        start_date: e.start_date.clone(),
    }
}

fn parse_hm(value: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(value.trim(), "%H:%M").ok()
}

/// Validated (days, start, end) of one window.
fn validate_window(
    start: &str,
    end: &str,
    days: Vec<u8>,
) -> Result<(Vec<u8>, String, String), &'static str> {
    let (Some(start), Some(end)) = (parse_hm(start), parse_hm(end)) else {
        return Err("start and end must be HH:MM");
    };
    if end <= start {
        return Err("end must be after start (overnight shifts are not supported)");
    }
    let mut days = days;
    days.sort_unstable();
    days.dedup();
    if days.is_empty() || days.iter().any(|d| !(1..=7).contains(d)) {
        return Err("days must be 1 (Monday) to 7 (Sunday)");
    }
    Ok((
        days,
        start.format("%H:%M").to_string(),
        end.format("%H:%M").to_string(),
    ))
}

fn validate_shift(s: ShiftData) -> Result<AttendanceShift, &'static str> {
    let (days, start, end) = validate_window(&s.start, &s.end, s.days)?;
    if !(0..=240).contains(&s.tolerance_min) {
        return Err("tolerance_min must be 0-240");
    }
    let mut seen = days.clone();
    let mut other = Vec::with_capacity(s.other.len());
    for w in s.other {
        let (days, start, end) = validate_window(&w.start, &w.end, w.days)?;
        if days.iter().any(|d| seen.contains(d)) {
            return Err("a day can only be in one schedule");
        }
        seen.extend(&days);
        other.push(ShiftWindow { days, start, end });
    }
    Ok(AttendanceShift {
        start,
        end,
        days,
        tolerance_min: s.tolerance_min,
        other,
    })
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct EmployeePayload {
    pub employee_no: String,
    pub name: String,
    pub user_id: Option<String>,
    pub shift: Option<ShiftData>,
    /// Other shifts they may work instead; needs `shift`.
    #[serde(default)]
    pub alternates: Vec<ShiftData>,
    #[serde(default = "yes")]
    pub active: bool,
    /// First day they work here, YYYY-MM-DD. Omitted = keep it (new employees: today);
    /// "" = none (every day counts).
    pub start_date: Option<String>,
}

fn yes() -> bool {
    true
}

#[utoipa::path(
    get,
    path = "/api/admin/attendance/employees",
    tag = "operations",
    responses(
        (status = 200, description = "Employees registered in the time clock"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_employees(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    match list_attendance_employees(&state, &company_id).await {
        Ok(items) => Json(items.iter().map(employee_data).collect::<Vec<_>>()).into_response(),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/admin/attendance/employees",
    tag = "operations",
    request_body = EmployeePayload,
    responses(
        (status = 200, description = "Employee created or replaced (by employee_no)"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_employee_save(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(p): Json<EmployeePayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let employee_no = p.employee_no.trim();
    if !valid_code(employee_no, 32) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "employee_no must be 1-32 letters or digits",
        );
    }
    let name = p.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return json_error(StatusCode::BAD_REQUEST, "name must be 1-120 characters");
    }
    let user_id = match p
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(v) => match ObjectId::parse_str(v) {
            Ok(id) => Some(id),
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid user_id"),
        },
        None => None,
    };
    let shift = match p.shift.map(validate_shift).transpose() {
        Ok(s) => s,
        Err(msg) => return json_error(StatusCode::BAD_REQUEST, msg),
    };
    if shift.is_none() && !p.alternates.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "alternates need a main shift");
    }
    if p.alternates.len() > 4 {
        return json_error(StatusCode::BAD_REQUEST, "at most 4 alternate shifts");
    }
    let alternates = match p
        .alternates
        .into_iter()
        .map(validate_shift)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(a) => a,
        Err(msg) => return json_error(StatusCode::BAD_REQUEST, msg),
    };
    let start_date = match p.start_date.as_deref().map(str::trim) {
        Some("") => Some(String::new()),
        Some(v) => match NaiveDate::parse_from_str(v, "%Y-%m-%d") {
            Ok(d) => Some(d.format("%Y-%m-%d").to_string()),
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "start_date must be YYYY-MM-DD"),
        },
        None => None,
    };
    let today = shop_date(DateTime::now()).format("%Y-%m-%d").to_string();
    match upsert_attendance_employee(
        &state,
        &company_id,
        employee_no,
        name,
        user_id,
        shift,
        alternates,
        p.active,
        start_date.as_deref(),
        &today,
    )
    .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/admin/attendance/employees/{employee_no}/delete",
    tag = "operations",
    params(("employee_no" = String, Path, description = "Employee number in the terminal")),
    responses(
        (status = 200, description = "Employee removed (their checks stay)"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only"),
        (status = 404, description = "No such employee")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_employee_delete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(employee_no): Path<String>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    match delete_attendance_employee(&state, &company_id, employee_no.trim()).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "no such employee"),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

// ---------- manual checks ----------

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ManualCheckPayload {
    pub employee_no: String,
    /// YYYY-MM-DD, shop time.
    pub date: String,
    /// "HH:MM", shop time.
    pub time: String,
    pub note: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/admin/attendance/manual",
    tag = "operations",
    request_body = ManualCheckPayload,
    responses(
        (status = 200, description = "Manual check added"),
        (status = 400, description = "Invalid input or that check already exists"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_manual_add(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(p): Json<ManualCheckPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let employee_no = p.employee_no.trim();
    if !valid_code(employee_no, 32) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "employee_no must be 1-32 letters or digits",
        );
    }
    let (Ok(date), Some(time)) = (
        NaiveDate::parse_from_str(p.date.trim(), "%Y-%m-%d"),
        parse_hm(&p.time),
    ) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "date must be YYYY-MM-DD and time HH:MM",
        );
    };
    let at = DateTime::from_millis(
        shop_midnight(date).timestamp_millis()
            + i64::from(time.hour() * 60 + time.minute()) * 60_000,
    );
    let note: Option<String> = p
        .note
        .as_deref()
        .map(|n| n.trim().chars().take(200).collect::<String>())
        .filter(|n| !n.is_empty());
    let u = session_user.user();
    let author = u
        .display_name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| u.username.clone());
    match insert_manual_attendance_event(&state, &company_id, employee_no, at, note, &author).await
    {
        Ok(id) => Json(serde_json::json!({ "id": id.to_hex() })).into_response(),
        Err(err) if err.to_string().contains("E11000") => {
            json_error(StatusCode::BAD_REQUEST, "that check already exists")
        }
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/admin/attendance/manual/{id}/delete",
    tag = "operations",
    params(("id" = String, Path, description = "Manual check id")),
    responses(
        (status = 200, description = "Manual check removed"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only"),
        (status = 404, description = "No such manual check (terminal checks can't be removed)")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_manual_delete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let Ok(id) = ObjectId::parse_str(id.trim()) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid id");
    };
    match delete_manual_attendance_event(&state, &company_id, id).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "no such manual check"),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

// ---------- corrections ----------

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct CorrectionPayload {
    pub employee_no: String,
    /// YYYY-MM-DD, shop date.
    pub date: String,
    /// "HH:MM"; empty/omitted = keep the one from the checks.
    pub entry: Option<String>,
    pub exit: Option<String>,
    pub note: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/admin/attendance/correction",
    tag = "operations",
    request_body = CorrectionPayload,
    responses(
        (status = 200, description = "Day corrected; with neither entry nor exit, the correction is removed"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_correction_save(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(p): Json<CorrectionPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let employee_no = p.employee_no.trim();
    if !valid_code(employee_no, 32) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "employee_no must be 1-32 letters or digits",
        );
    }
    let Ok(date) = NaiveDate::parse_from_str(p.date.trim(), "%Y-%m-%d") else {
        return json_error(StatusCode::BAD_REQUEST, "date must be YYYY-MM-DD");
    };
    let date = date.format("%Y-%m-%d").to_string();
    let time = |v: &Option<String>| -> Result<Option<NaiveTime>, ()> {
        match v.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some(v) => parse_hm(v).map(Some).ok_or(()),
            None => Ok(None),
        }
    };
    let (Ok(entry), Ok(exit)) = (time(&p.entry), time(&p.exit)) else {
        return json_error(StatusCode::BAD_REQUEST, "entry and exit must be HH:MM");
    };
    if let (Some(a), Some(b)) = (entry, exit) {
        if b <= a {
            return json_error(StatusCode::BAD_REQUEST, "exit must be after entry");
        }
    }
    if entry.is_none() && exit.is_none() {
        return match delete_attendance_correction(&state, &company_id, employee_no, &date).await {
            Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
            Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
        };
    }
    let fmt = |t: Option<NaiveTime>| t.map(|t| t.format("%H:%M").to_string());
    let (entry, exit) = (fmt(entry), fmt(exit));
    let note: Option<String> = p
        .note
        .as_deref()
        .map(|n| n.trim().chars().take(200).collect::<String>())
        .filter(|n| !n.is_empty());
    let u = session_user.user();
    let author = u
        .display_name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| u.username.clone());
    match upsert_attendance_correction(
        &state,
        &company_id,
        employee_no,
        &date,
        entry.as_deref(),
        exit.as_deref(),
        note.as_deref(),
        &author,
    )
    .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

// ---------- report ----------

#[derive(Debug, Serialize, PartialEq)]
pub struct DayData {
    /// YYYY-MM-DD, shop time.
    pub date: String,
    /// "HH:MM" of every check that day (double presses merged).
    pub checks: Vec<String>,
    pub entry: Option<String>,
    pub exit: Option<String>,
    pub worked_min: i64,
    /// Minutes after the shift start, only when past the tolerance.
    pub late_min: i64,
    /// "ok", "retardo", "falta", "incompleto" (one check only), "descanso" (not a work day),
    /// "extra" (checks on a day off), "pendiente" (the shift has not ended yet),
    /// "sin_horario" (no shift: only the checks), "antes_alta" (before their start_date).
    pub status: String,
    /// "HH:MM–HH:MM" the day was measured against (with alternates, the one closest to the entry).
    pub window: Option<String>,
    /// True when that window is not from the main shift.
    pub alternate: bool,
    /// Checks typed by an admin that day.
    pub manual: Vec<ManualCheckData>,
    /// An admin's correction of the entry/exit; `entry`/`exit` above already use it.
    pub correction: Option<CorrectionData>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct CorrectionData {
    pub entry: Option<String>,
    pub exit: Option<String>,
    pub note: Option<String>,
    pub author: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ManualCheckData {
    pub id: String,
    pub time: String,
    pub note: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Totals {
    pub worked_min: i64,
    pub late_min: i64,
    pub late_days: i64,
    pub absences: i64,
    pub incomplete: i64,
}

#[derive(Debug, Serialize)]
pub struct EmployeeReport {
    pub employee_no: String,
    pub name: String,
    pub shift: Option<ShiftData>,
    pub alternates: Vec<ShiftData>,
    pub days: Vec<DayData>,
    pub totals: Totals,
}

#[derive(Debug, Serialize)]
pub struct UnknownChecks {
    pub employee_no: String,
    pub checks: usize,
}

#[derive(Debug, Serialize)]
pub struct AttendanceReport {
    pub from: String,
    pub to: String,
    pub employees: Vec<EmployeeReport>,
    /// Checks from employee numbers that are not registered here.
    pub unknown: Vec<UnknownChecks>,
}

fn shop_ms(at: DateTime) -> i64 {
    at.timestamp_millis() + SHOP_UTC_OFFSET_MS
}

pub(crate) fn shop_date(at: DateTime) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(shop_ms(at))
        .map(|d| d.date_naive())
        .unwrap_or_default()
}

/// Minutes since shop midnight.
fn shop_minute(at: DateTime) -> i64 {
    shop_ms(at).rem_euclid(86_400_000) / 60_000
}

/// UTC instant of shop midnight starting `date`.
pub(crate) fn shop_midnight(date: NaiveDate) -> DateTime {
    let ms = date.and_time(NaiveTime::MIN).and_utc().timestamp_millis() - SHOP_UTC_OFFSET_MS;
    DateTime::from_millis(ms)
}

fn hm(minute: i64) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

/// Minutes since midnight of an "HH:MM" already validated.
fn minute_of(value: &str) -> i64 {
    parse_hm(value).map_or(0, |t| i64::from(t.hour() * 60 + t.minute()))
}

/// One employee's day from their checks (sorted by time). `shifts` = main shift first, then
/// the alternates; empty = no fixed schedule.
fn day_data(
    date: NaiveDate,
    events: &[&AttendanceEvent],
    shifts: &[&AttendanceShift],
    correction: Option<&AttendanceCorrection>,
    now: DateTime,
) -> DayData {
    let manual: Vec<ManualCheckData> = events
        .iter()
        .filter(|e| e.device == MANUAL_DEVICE)
        .map(|e| ManualCheckData {
            id: e.id.map(|id| id.to_hex()).unwrap_or_default(),
            time: hm(shop_minute(e.at)),
            note: e.note.clone(),
            author: e.author.clone(),
        })
        .collect();
    let mut checks: Vec<DateTime> = Vec::new();
    for s in events.iter().map(|e| e.at) {
        if checks
            .last()
            .is_none_or(|last| s.timestamp_millis() - last.timestamp_millis() >= DOUBLE_CHECK_MS)
        {
            checks.push(s);
        }
    }
    let minutes: Vec<i64> = checks.iter().map(|&c| shop_minute(c)).collect();
    let fixed_entry = correction.and_then(|c| c.entry.as_deref()).map(minute_of);
    let fixed_exit = correction.and_then(|c| c.exit.as_deref()).map(minute_of);
    let entry = fixed_entry.or(minutes.first().copied());
    let exit = match (fixed_exit, fixed_entry) {
        (Some(x), _) => Some(x),
        // A corrected entry: the exit is the last check after it.
        (None, Some(e)) => minutes
            .last()
            .copied()
            .filter(|&m| m > e + DOUBLE_CHECK_MS / 60_000),
        (None, None) if minutes.len() >= 2 => minutes.last().copied(),
        (None, None) => None,
    };
    let worked_min = match (entry, exit) {
        (Some(a), Some(b)) if b > a => b - a,
        _ => 0,
    };
    let has_checks = !checks.is_empty() || entry.is_some();
    let weekday = date.weekday().number_from_monday() as u8;
    // (shift, start, end, is_alternate) of every shift that works this weekday
    let candidates: Vec<(&AttendanceShift, &str, &str, bool)> = shifts
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.window(weekday).map(|(a, b)| (*s, a, b, i > 0)))
        .collect();
    // With an entry, the shift whose start is closest to it; without one, the first (main).
    let chosen = match entry {
        Some(e) => candidates
            .iter()
            .min_by_key(|(_, start, _, _)| (e - minute_of(start)).abs())
            .copied(),
        None => candidates.first().copied(),
    };
    let mut late_min = 0;
    let status = match (shifts.is_empty(), chosen) {
        (true, _) => "sin_horario",
        (false, None) => {
            if !has_checks {
                "descanso"
            } else {
                "extra"
            }
        }
        (false, Some((s, win_start, win_end, _))) => {
            let start = minute_of(win_start);
            let end_at = shop_midnight(date).timestamp_millis() + minute_of(win_end) * 60_000;
            match entry {
                None if now.timestamp_millis() < end_at => "pendiente",
                None => "falta",
                Some(e) => {
                    if e > start + i64::from(s.tolerance_min) {
                        late_min = e - start;
                    }
                    if exit.is_none() && now.timestamp_millis() >= end_at {
                        "incompleto"
                    } else if late_min > 0 {
                        "retardo"
                    } else if exit.is_none() {
                        "pendiente"
                    } else {
                        "ok"
                    }
                }
            }
        }
    };
    DayData {
        date: date.format("%Y-%m-%d").to_string(),
        checks: minutes.iter().map(|&m| hm(m)).collect(),
        entry: entry.map(hm),
        exit: exit.map(hm),
        worked_min,
        late_min,
        status: status.to_string(),
        window: chosen.map(|(_, a, b, _)| format!("{a}–{b}")),
        alternate: chosen.is_some_and(|c| c.3),
        manual,
        correction: correction.map(|c| CorrectionData {
            entry: c.entry.clone(),
            exit: c.exit.clone(),
            note: c.note.clone(),
            author: c.author.clone(),
        }),
    }
}

/// The report for `from..=to` (shop dates). Pure: everything it needs comes in.
pub fn build_report(
    employees: &[AttendanceEmployee],
    events: &[AttendanceEvent],
    corrections: &[AttendanceCorrection],
    from: NaiveDate,
    to: NaiveDate,
    now: DateTime,
) -> AttendanceReport {
    let fixes: BTreeMap<(&str, &str), &AttendanceCorrection> = corrections
        .iter()
        .map(|c| ((c.employee_no.as_str(), c.date.as_str()), c))
        .collect();
    let mut by_employee: BTreeMap<&str, BTreeMap<NaiveDate, Vec<&AttendanceEvent>>> =
        BTreeMap::new();
    for e in events {
        let date = shop_date(e.at);
        if date < from || date > to {
            continue;
        }
        by_employee
            .entry(e.employee_no.as_str())
            .or_default()
            .entry(date)
            .or_default()
            .push(e);
    }
    let dates: Vec<NaiveDate> = from.iter_days().take_while(|d| *d <= to).collect();
    let mut reports = Vec::new();
    for emp in employees.iter().filter(|e| e.active) {
        let mine = by_employee
            .remove(emp.employee_no.as_str())
            .unwrap_or_default();
        let mut totals = Totals::default();
        let shifts: Vec<&AttendanceShift> = emp.shift.iter().chain(emp.alternates.iter()).collect();
        let start = emp
            .start_date
            .as_deref()
            .and_then(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").ok());
        let days: Vec<DayData> = dates
            .iter()
            .map(|&d| {
                let mut day_events = mine.get(&d).cloned().unwrap_or_default();
                day_events.sort_by_key(|e| e.at);
                let key = d.format("%Y-%m-%d").to_string();
                let fix = fixes.get(&(emp.employee_no.as_str(), key.as_str())).copied();
                let mut day = day_data(d, &day_events, &shifts, fix, now);
                // Before they started here, a day without checks is nothing, not an absence.
                if start.is_some_and(|s| d < s) && day.entry.is_none() {
                    day.status = "antes_alta".to_string();
                }
                totals.worked_min += day.worked_min;
                totals.late_min += day.late_min;
                match day.status.as_str() {
                    "retardo" => totals.late_days += 1,
                    "falta" => totals.absences += 1,
                    "incompleto" => totals.incomplete += 1,
                    _ => {}
                }
                day
            })
            .collect();
        reports.push(EmployeeReport {
            employee_no: emp.employee_no.clone(),
            name: emp.name.clone(),
            shift: emp.shift.as_ref().map(shift_data),
            alternates: emp.alternates.iter().map(shift_data).collect(),
            days,
            totals,
        });
    }
    // inactive employees' checks are not "unknown"
    for emp in employees.iter().filter(|e| !e.active) {
        by_employee.remove(emp.employee_no.as_str());
    }
    let unknown = by_employee
        .into_iter()
        .map(|(no, days)| UnknownChecks {
            employee_no: no.to_string(),
            checks: days.values().map(Vec::len).sum(),
        })
        .collect();
    AttendanceReport {
        from: from.format("%Y-%m-%d").to_string(),
        to: to.format("%Y-%m-%d").to_string(),
        employees: reports,
        unknown,
    }
}

#[derive(Debug, Deserialize)]
pub struct ReportQuery {
    pub from: Option<String>,
    pub to: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/admin/attendance/report",
    tag = "operations",
    params(
        ("from" = Option<String>, Query, description = "YYYY-MM-DD (default: Monday of this shop week)"),
        ("to" = Option<String>, Query, description = "YYYY-MM-DD inclusive (default: from + 6 days)")
    ),
    responses(
        (status = 200, description = "Entry, exit, lateness and hours per employee and day"),
        (status = 400, description = "Invalid dates"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_attendance_report(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(q): Query<ReportQuery>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    let now = DateTime::now();
    let parse = |v: &str| NaiveDate::parse_from_str(v.trim(), "%Y-%m-%d").ok();
    let from = match q.from.as_deref().filter(|v| !v.is_empty()) {
        Some(v) => match parse(v) {
            Some(d) => d,
            None => return json_error(StatusCode::BAD_REQUEST, "from must be YYYY-MM-DD"),
        },
        None => {
            let today = shop_date(now);
            today - Duration::days(i64::from(today.weekday().num_days_from_monday()))
        }
    };
    let to = match q.to.as_deref().filter(|v| !v.is_empty()) {
        Some(v) => match parse(v) {
            Some(d) => d,
            None => return json_error(StatusCode::BAD_REQUEST, "to must be YYYY-MM-DD"),
        },
        None => from + Duration::days(6),
    };
    if to < from || (to - from).num_days() >= MAX_REPORT_DAYS {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("to must be after from, at most {MAX_REPORT_DAYS} days"),
        );
    }
    let range_end = shop_midnight(to + Duration::days(1));
    let (from_s, to_s) = (
        from.format("%Y-%m-%d").to_string(),
        to.format("%Y-%m-%d").to_string(),
    );
    let (employees, events, corrections) = match tokio::try_join!(
        list_attendance_employees(&state, &company_id),
        list_attendance_events(&state, &company_id, shop_midnight(from), range_end),
        list_attendance_corrections(&state, &company_id, &from_s, &to_s),
    ) {
        Ok(v) => v,
        Err(err) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    };
    Json(build_report(&employees, &events, &corrections, from, to, now)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime {
        DateTime::parse_rfc3339_str(s).unwrap()
    }

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn employee(no: &str, shift: Option<AttendanceShift>) -> AttendanceEmployee {
        AttendanceEmployee {
            id: None,
            company_id: ObjectId::new(),
            employee_no: no.to_string(),
            name: format!("Empleado {no}"),
            user_id: None,
            shift,
            alternates: vec![],
            active: true,
            start_date: None,
            updated_at: DateTime::now(),
        }
    }

    #[test]
    fn days_before_the_start_date_are_not_absences() {
        let mut emp = employee("0006", Some(manana()));
        emp.start_date = Some("2026-11-09".into());
        let events = vec![check("0006", "2026-11-09T14:01:00Z")];
        let r = build_report(
            &[emp],
            &events,
            &[],
            d("2026-11-06"),
            d("2026-11-09"),
            t("2026-11-10T06:00:00Z"),
        );
        let days = &r.employees[0].days;
        assert_eq!(days[0].status, "antes_alta"); // Fri
        assert_eq!(days[1].status, "antes_alta"); // Sat
        assert_eq!(days[3].entry.as_deref(), Some("07:01")); // Mon, counted
        assert_eq!(r.employees[0].totals.absences, 0);
    }

    fn fix(no: &str, date: &str, entry: Option<&str>, exit: Option<&str>) -> AttendanceCorrection {
        AttendanceCorrection {
            id: None,
            company_id: ObjectId::new(),
            employee_no: no.into(),
            date: date.into(),
            entry: entry.map(Into::into),
            exit: exit.map(Into::into),
            note: Some("llegó a las 7, todavía sin huella".into()),
            author: "Daniel".into(),
            updated_at: DateTime::now(),
        }
    }

    #[test]
    fn corrected_entry_and_exit() {
        let emp = employee("0006", Some(manana()));
        // Mon: one check at 11:01 (her fingerprint test); Tue: no checks at all.
        let events = vec![check("0006", "2026-11-09T18:01:00Z")];
        let now = t("2026-11-11T06:00:00Z");
        let r = build_report(&[emp.clone()], &events, &[], d("2026-11-09"), d("2026-11-10"), now);
        assert_eq!(r.employees[0].days[0].status, "incompleto"); // one late check, no exit
        assert_eq!(r.employees[0].days[1].status, "falta");

        let fixes = vec![
            // entry only: the 11:01 check becomes the exit
            fix("0006", "2026-11-09", Some("07:00"), None),
            // forgot to check at all: both typed in
            fix("0006", "2026-11-10", Some("07:05"), Some("15:00")),
        ];
        let r = build_report(&[emp], &events, &fixes, d("2026-11-09"), d("2026-11-10"), now);
        let mon = &r.employees[0].days[0];
        assert_eq!(
            (mon.entry.as_deref(), mon.exit.as_deref(), mon.status.as_str(), mon.worked_min),
            (Some("07:00"), Some("11:01"), "ok", 241)
        );
        assert_eq!(mon.checks, vec!["11:01"]); // the real check stays visible
        assert_eq!(mon.correction.as_ref().map(|c| c.author.as_str()), Some("Daniel"));
        let tue = &r.employees[0].days[1];
        assert_eq!((tue.status.as_str(), tue.worked_min), ("ok", 475));
        assert_eq!(r.employees[0].totals.absences, 0);
        assert_eq!(r.employees[0].totals.late_days, 0);
    }

    fn tarde() -> AttendanceShift {
        AttendanceShift {
            start: "14:00".into(),
            end: "22:00".into(),
            days: vec![1, 2, 3, 4, 5],
            tolerance_min: 10,
            other: vec![ShiftWindow {
                days: vec![6],
                start: "12:00".into(),
                end: "17:00".into(),
            }],
        }
    }

    fn check(no: &str, at: &str) -> AttendanceEvent {
        AttendanceEvent {
            id: None,
            company_id: ObjectId::new(),
            device: "GL5045172".into(),
            serial_no: 1,
            employee_no: no.into(),
            at: t(at),
            method: "huella".into(),
            created_at: DateTime::now(),
            note: None,
            author: None,
        }
    }

    fn manana() -> AttendanceShift {
        AttendanceShift {
            start: "07:00".into(),
            end: "15:00".into(),
            days: vec![1, 2, 3, 4, 5],
            tolerance_min: 10,
            other: vec![ShiftWindow {
                days: vec![6],
                start: "07:00".into(),
                end: "12:00".into(),
            }],
        }
    }

    #[test]
    fn manual_serial_is_per_employee() {
        let at = t("2026-11-07T07:00:00-07:00");
        let a = crate::state::manual_serial("0004", at);
        assert_eq!(a, crate::state::manual_serial("0004", at));
        assert_ne!(a, crate::state::manual_serial("0005", at));
        assert!(a >= 0);
    }

    #[test]
    fn flexible_shift_and_manual_checks() {
        let mut jose = employee("0004", Some(tarde()));
        jose.alternates = vec![manana()];
        let manual = |at: &str| {
            let mut e = check("0004", at);
            e.id = Some(ObjectId::new());
            e.device = MANUAL_DEVICE.into();
            e.method = "manual".into();
            e.note = Some("vino 7-12, sin huella".into());
            e
        };
        let events = vec![
            // Mon 9: came in the morning, 15 min late for the morning shift
            check("0004", "2026-11-09T07:15:00-07:00"),
            check("0004", "2026-11-09T15:00:00-07:00"),
            // Tue 10: normal afternoon, on time
            check("0004", "2026-11-10T13:58:00-07:00"),
            check("0004", "2026-11-10T22:00:00-07:00"),
            // Sat 14: morning, typed by the admin
            manual("2026-11-14T07:00:00-07:00"),
            manual("2026-11-14T12:00:00-07:00"),
        ];
        let now = t("2026-11-16T09:00:00-07:00");
        let r = build_report(&[jose], &events, &[], d("2026-11-09"), d("2026-11-15"), now);
        let days = &r.employees[0].days;
        let view = |i: usize| {
            (
                days[i].status.as_str(),
                days[i].window.as_deref(),
                days[i].alternate,
                days[i].late_min,
            )
        };
        assert_eq!(view(0), ("retardo", Some("07:00–15:00"), true, 15));
        assert_eq!(view(1), ("ok", Some("14:00–22:00"), false, 0));
        // no checks: measured against the main shift
        assert_eq!(view(2), ("falta", Some("14:00–22:00"), false, 0));
        assert_eq!(view(5), ("ok", Some("07:00–12:00"), true, 0));
        assert_eq!(days[5].worked_min, 300);
        assert_eq!(days[5].manual.len(), 2);
        assert_eq!(days[5].manual[0].time, "07:00");
        assert_eq!(
            days[5].manual[0].note.as_deref(),
            Some("vino 7-12, sin huella")
        );
        assert_eq!(view(6), ("descanso", None, false, 0));
    }

    #[test]
    fn shop_time_is_utc_minus_seven() {
        // 2026-11-10 04:30 UTC is still Nov 9, 21:30 in Hermosillo.
        assert_eq!(shop_date(t("2026-11-10T04:30:00Z")), d("2026-11-09"));
        assert_eq!(shop_minute(t("2026-11-10T04:30:00Z")), 21 * 60 + 30);
        assert_eq!(shop_midnight(d("2026-11-09")), t("2026-11-09T07:00:00Z"));
    }

    #[test]
    fn weekly_report_for_the_afternoon_shift() {
        let emps = vec![employee("0004", Some(tarde())), employee("0002", None)];
        let events = vec![
            // Mon 9: on time (within tolerance), double press at the exit
            check("0004", "2026-11-09T14:08:00-07:00"),
            check("0004", "2026-11-09T22:01:00-07:00"),
            check("0004", "2026-11-09T22:02:00-07:00"),
            // Tue 10: 25 min late
            check("0004", "2026-11-10T14:25:00-07:00"),
            check("0004", "2026-11-10T22:00:00-07:00"),
            // Wed 11: absent. Thu 12: only the entry.
            check("0004", "2026-11-12T13:55:00-07:00"),
            // Sat 14: Saturday window 12:00-17:00, 20 min late
            check("0004", "2026-11-14T12:20:00-07:00"),
            check("0004", "2026-11-14T17:00:00-07:00"),
            // Sun 15: came on a day off
            check("0004", "2026-11-15T10:00:00-07:00"),
            check("0004", "2026-11-15T11:00:00-07:00"),
            // no shift: only checks
            check("0002", "2026-11-09T08:00:00-07:00"),
            // not registered
            check("0099", "2026-11-09T08:00:00-07:00"),
        ];
        // Now = Friday 13 at 15:00: Friday's shift has not ended.
        let now = t("2026-11-13T15:00:00-07:00");
        let r = build_report(&emps, &events, &[], d("2026-11-09"), d("2026-11-15"), now);
        let jose = &r.employees[0];
        let status: Vec<&str> = jose.days.iter().map(|x| x.status.as_str()).collect();
        assert_eq!(
            status,
            [
                "ok",
                "retardo",
                "falta",
                "incompleto",
                "pendiente",
                "retardo",
                "extra"
            ]
        );
        let mon = &jose.days[0];
        assert_eq!(
            (
                mon.entry.as_deref(),
                mon.exit.as_deref(),
                mon.checks.len(),
                mon.worked_min,
                mon.late_min
            ),
            (Some("14:08"), Some("22:01"), 2, 473, 0)
        );
        assert_eq!((jose.days[1].late_min, jose.days[1].worked_min), (25, 455));
        assert_eq!((jose.days[5].late_min, jose.days[5].worked_min), (20, 280));
        assert_eq!(jose.days[6].worked_min, 60);
        assert_eq!(
            jose.totals,
            Totals {
                worked_min: 473 + 455 + 280 + 60,
                late_min: 25 + 20,
                late_days: 2,
                absences: 1,
                incomplete: 1
            }
        );
        let daniel = &r.employees[1];
        assert_eq!(daniel.days[0].status, "sin_horario");
        assert_eq!(daniel.days[0].entry.as_deref(), Some("08:00"));
        assert_eq!(daniel.totals.absences, 0);
        assert_eq!(r.unknown.len(), 1);
        assert_eq!(
            (r.unknown[0].employee_no.as_str(), r.unknown[0].checks),
            ("0099", 1)
        );
    }

    #[test]
    fn shift_validation() {
        let ok = validate_shift(ShiftData {
            start: "14:00".into(),
            end: "22:00".into(),
            days: vec![5, 1, 1],
            tolerance_min: 10,
            other: vec![ShiftWindowData {
                days: vec![6],
                start: "7:00".into(),
                end: "12:00".into(),
            }],
        })
        .unwrap();
        assert_eq!(ok.days, vec![1, 5]);
        assert_eq!(ok.window(6), Some(("07:00", "12:00")));
        assert_eq!(ok.window(1), Some(("14:00", "22:00")));
        assert_eq!(ok.window(7), None);
        // the same day in two schedules
        assert!(
            validate_shift(ShiftData {
                start: "14:00".into(),
                end: "22:00".into(),
                days: vec![1, 6],
                tolerance_min: 0,
                other: vec![ShiftWindowData {
                    days: vec![6],
                    start: "12:00".into(),
                    end: "17:00".into(),
                }],
            })
            .is_err()
        );
        assert!(
            validate_shift(ShiftData {
                start: "22:00".into(),
                end: "06:00".into(),
                days: vec![1],
                tolerance_min: 0,
                other: vec![],
            })
            .is_err()
        );
        assert!(
            validate_shift(ShiftData {
                start: "8".into(),
                end: "17:00".into(),
                days: vec![1],
                tolerance_min: 0,
                other: vec![],
            })
            .is_err()
        );
        assert!(
            validate_shift(ShiftData {
                start: "08:00".into(),
                end: "17:00".into(),
                days: vec![8],
                tolerance_min: 0,
                other: vec![],
            })
            .is_err()
        );
        assert_eq!(method_of(Some("Huella")), "huella");
        assert_eq!(method_of(Some("x")), "otro");
        assert!(valid_code("GL5045172", 60) && !valid_code("a b", 60));
    }
}
