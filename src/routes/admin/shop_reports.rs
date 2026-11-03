//! Daily shop-floor reports pushed by the monitor (taller-vision), for admins only: they say
//! who was at which machine and when. Numbers only, never images.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::finance::helpers::require_admin_active;
use super::project_backend::{iso, json_error};
use crate::{
    models::ShopDailyReport,
    session::SessionUser,
    state::{AppState, get_shop_report, list_shop_reports, upsert_shop_report},
};

const MAX_REPORT_BYTES: usize = 1_500_000;
const MAX_LISTED: i64 = 400;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ShopReportPayload {
    pub source: String,
    /// YYYY-MM-DD, shop time.
    pub day: String,
    pub summary: Option<String>,
    #[schema(value_type = Object)]
    pub kpis: Value,
    #[schema(value_type = Object)]
    pub report: Value,
}

fn valid_day(day: &str) -> bool {
    day.len() == 10 && chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok()
}

#[utoipa::path(
    post,
    path = "/api/admin/shop_reports/ingest",
    tag = "operations",
    request_body = ShopReportPayload,
    responses(
        (status = 200, description = "Report stored, replacing that day's"),
        (status = 400, description = "Invalid input"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_shop_reports_ingest(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ShopReportPayload>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    if !valid_day(&payload.day) {
        return json_error(StatusCode::BAD_REQUEST, "day must be YYYY-MM-DD");
    }
    let source = payload.source.trim();
    if source.is_empty() || source.chars().count() > 60 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "source must be between 1 and 60 characters",
        );
    }
    let report_json = payload.report.to_string();
    if report_json.len() > MAX_REPORT_BYTES {
        return json_error(StatusCode::BAD_REQUEST, "report too large");
    }
    let report = ShopDailyReport {
        id: None,
        company_id,
        day: payload.day,
        source: source.to_string(),
        summary: payload.summary,
        kpis_json: payload.kpis.to_string(),
        report_json,
        updated_at: None,
    };
    match upsert_shop_report(&state, report).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not store report"),
    }
}

#[derive(Serialize)]
pub struct ShopReportListItem {
    pub day: String,
    pub summary: Option<String>,
    pub kpis: Value,
    pub updated_at: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/admin/shop_reports",
    tag = "operations",
    responses(
        (status = 200, description = "Days with a report, newest first, without the report body"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only")
    ),
    security(("session" = []))
)]
pub async fn api_shop_reports_index(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    match list_shop_reports(&state, &company_id, MAX_LISTED).await {
        Ok(items) => Json(
            items
                .into_iter()
                .map(|r| ShopReportListItem {
                    day: r.day,
                    summary: r.summary,
                    kpis: serde_json::from_str(&r.kpis_json).unwrap_or(Value::Null),
                    updated_at: r.updated_at.map(iso),
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list reports"),
    }
}

#[utoipa::path(
    get,
    path = "/api/admin/shop_reports/{day}",
    tag = "operations",
    params(("day" = String, Path, description = "YYYY-MM-DD")),
    responses(
        (status = 200, description = "The complete report of that day"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Admin only"),
        (status = 404, description = "No report that day")
    ),
    security(("session" = []))
)]
pub async fn api_shop_report_detail(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(day): Path<String>,
) -> Response {
    let company_id = match require_admin_active(&session_user) {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };
    match get_shop_report(&state, &company_id, &day).await {
        Ok(Some(r)) => Json(serde_json::json!({
            "day": r.day,
            "summary": r.summary,
            "kpis": serde_json::from_str::<Value>(&r.kpis_json).unwrap_or(Value::Null),
            "report": serde_json::from_str::<Value>(&r.report_json).unwrap_or(Value::Null),
            "updated_at": r.updated_at.map(iso),
        }))
        .into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "no report that day"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load report"),
    }
}
