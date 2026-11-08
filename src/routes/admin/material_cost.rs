//! What a project's material should cost (Daniel, 2026-11-07): once every part has its stock,
//! the request (bars by total length, plates cut to size, whole sheets) × density × price per
//! kg gives the expected amount. Saving what the supplier quoted next to it shows whether the
//! material was costed well. Admin only: it is money.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::SystemTime;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{MaterialQuote, MaterialQuoteLine},
    session::SessionUser,
    state::{AppState, density_g_cm3, get_project_by_id_for_company, list_material_prices, list_project_concepts, price_for},
};

#[derive(Serialize)]
pub struct MaterialRateData {
    /// The material as the part has it.
    pub material: String,
    pub density_g_cm3: Option<f64>,
    pub price_per_kg: Option<f64>,
    /// The price list entry it was read from ("4140 T" for a plain "4140").
    pub priced_as: Option<String>,
    pub as_of: Option<String>,
}

/// Density and price per kg of every material the project's parts use.
pub async fn api_project_material_rates(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Ok((concepts, prices)) = tokio::try_join!(
        list_project_concepts(&state, &company_id, &project_id),
        list_material_prices(&state, &company_id),
    ) else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the materials");
    };
    let names: BTreeSet<String> = concepts
        .iter()
        .filter_map(|c| c.material.as_ref()?.material.clone())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    let rates: Vec<MaterialRateData> = names
        .into_iter()
        .map(|m| {
            let p = price_for(&prices, &m);
            MaterialRateData {
                density_g_cm3: density_g_cm3(&m),
                price_per_kg: p.map(|p| p.price_per_kg),
                priced_as: p.map(|p| p.material.clone()),
                as_of: p.map(|p| iso(p.as_of.unwrap_or(p.updated_at))),
                material: m,
            }
        })
        .collect();
    Json(rates).into_response()
}

#[derive(Serialize)]
pub struct MaterialQuoteData {
    pub id: String,
    pub supplier: String,
    pub total: f64,
    pub estimate_total: f64,
    pub lines: Vec<MaterialQuoteLine>,
    pub note: Option<String>,
    pub created_by: String,
    pub created_at: String,
}

fn quote_data(q: MaterialQuote) -> Option<MaterialQuoteData> {
    Some(MaterialQuoteData {
        id: q.id?.to_hex(),
        supplier: q.supplier,
        total: q.total,
        estimate_total: q.estimate_total,
        lines: q.lines,
        note: q.note,
        created_by: q.created_by,
        created_at: iso(q.created_at),
    })
}

/// The supplier quotes saved for a project, newest first.
pub async fn api_project_material_quotes(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let filter = doc! { "company_id": company_id, "project_id": project_id };
    match state.material_quotes.find(filter).sort(doc! { "created_at": -1 }).await {
        Ok(cursor) => {
            let list: Vec<MaterialQuote> = cursor.try_collect().await.unwrap_or_default();
            Json(list.into_iter().filter_map(quote_data).collect::<Vec<_>>()).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the quotes"),
    }
}

#[derive(Deserialize)]
pub struct MaterialQuotePayload {
    pub supplier: String,
    pub total: f64,
    #[serde(default)]
    pub estimate_total: f64,
    #[serde(default)]
    pub lines: Vec<MaterialQuoteLine>,
    #[serde(default)]
    pub note: Option<String>,
}

fn money_ok(v: f64) -> bool {
    v.is_finite() && (0.0..1e9).contains(&v)
}

pub async fn api_project_material_quote_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<MaterialQuotePayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match get_project_by_id_for_company(&state, &project_id, &company_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "project not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the project"),
    }
    let supplier: String = payload.supplier.trim().chars().take(120).collect();
    if supplier.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "escribe el proveedor");
    }
    if !money_ok(payload.total) || payload.total == 0.0 || !money_ok(payload.estimate_total) {
        return json_error(StatusCode::BAD_REQUEST, "el monto va en pesos, mayor a cero");
    }
    if payload.lines.len() > 200 {
        return json_error(StatusCode::BAD_REQUEST, "demasiados renglones");
    }
    let opt_ok = |v: Option<f64>| v.is_none_or(money_ok);
    if payload.lines.iter().any(|l| !opt_ok(l.kg) || !opt_ok(l.estimate) || !opt_ok(l.quoted)) {
        return json_error(StatusCode::BAD_REQUEST, "revisa los montos de los renglones");
    }
    let lines = payload
        .lines
        .into_iter()
        .map(|l| MaterialQuoteLine { stock: l.stock.trim().chars().take(200).collect(), ..l })
        .collect();
    let u = session_user.user();
    let q = MaterialQuote {
        id: None,
        company_id,
        project_id,
        supplier,
        total: payload.total,
        estimate_total: payload.estimate_total,
        lines,
        note: payload.note.map(|n| n.trim().chars().take(500).collect::<String>()).filter(|n| !n.is_empty()),
        created_by: u.display_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| u.username.clone()),
        created_at: DateTime::from_system_time(SystemTime::now()),
    };
    match state.material_quotes.insert_one(&q).await {
        Ok(r) => Json(serde_json::json!({ "ok": true, "id": r.inserted_id.as_object_id().map(|i| i.to_hex()) })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the quote"),
    }
}

pub async fn api_material_quote_delete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match state.material_quotes.delete_one(doc! { "_id": id, "company_id": company_id }).await {
        Ok(r) if r.deleted_count == 0 => json_error(StatusCode::NOT_FOUND, "quote not found"),
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not delete the quote"),
    }
}
