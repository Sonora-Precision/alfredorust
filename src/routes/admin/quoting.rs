//! Part quoting JSON API (openspec add-part-quoting): price per kg of each material, the
//! quote of a project (blank kg × $/kg × multiplier) and applying the suggested prices.
//! Admin only: it is money.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::PartQuote,
    session::SessionUser,
    state::{
        AppState, get_project_concept_by_id_for_company, list_material_prices, list_project_concepts, quote_line,
        set_concept_unit_price, set_material_price, set_part_quote,
    },
};

#[derive(Serialize)]
pub struct MaterialPriceData {
    pub material: String,
    pub price_per_kg: f64,
    pub source: String,
    pub note: Option<String>,
    pub updated_at: String,
}

pub async fn api_material_prices_index(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    match list_material_prices(&state, &company_id).await {
        Ok(list) => Json(
            list.into_iter()
                .map(|p| MaterialPriceData {
                    material: p.material,
                    price_per_kg: p.price_per_kg,
                    source: p.source,
                    note: p.note,
                    updated_at: iso(p.updated_at),
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list prices"),
    }
}

#[derive(Debug, Deserialize)]
pub struct MaterialPricePayload {
    pub material: String,
    /// null removes the price.
    pub price_per_kg: Option<f64>,
    #[serde(default)]
    pub note: Option<String>,
}

pub async fn api_material_price_set(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<MaterialPricePayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let material: String = payload.material.trim().chars().take(60).collect();
    if material.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "falta el material");
    }
    if payload.price_per_kg.is_some_and(|p| !p.is_finite() || p <= 0.0) {
        return json_error(StatusCode::BAD_REQUEST, "el precio por kg debe ser mayor a 0");
    }
    let note = payload.note.map(|n| n.trim().chars().take(120).collect::<String>()).filter(|n| !n.is_empty());
    match set_material_price(&state, company_id, &material, payload.price_per_kg, note, *session_user.user_id()).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the price"),
    }
}

#[derive(Serialize)]
pub struct QuoteLineData {
    pub concept_id: String,
    pub folio: String,
    pub part: String,
    pub quantity: f64,
    pub material: Option<String>,
    pub shape: Option<String>,
    pub thickness: Option<f64>,
    pub width: Option<f64>,
    pub length: Option<f64>,
    pub weight_kg: Option<f64>,
    pub weight_source: Option<&'static str>,
    /// What the admin entered (SolidWorks weight, multiplier), to edit.
    pub entered_weight_kg: Option<f64>,
    pub entered_multiplier: Option<f64>,
    pub price_per_kg: Option<f64>,
    pub material_cost: Option<f64>,
    pub multiplier: f64,
    pub suggested_unit_price: Option<f64>,
    pub unit_price: Option<f64>,
    pub missing: Vec<&'static str>,
}

#[derive(Serialize)]
pub struct ProjectQuoteData {
    pub lines: Vec<QuoteLineData>,
    /// Σ material cost × quantity (lines with a cost).
    pub material_total: f64,
    /// Σ suggested × quantity (lines with a suggestion).
    pub suggested_total: f64,
    /// Σ quoted unit price × quantity (lines with a price).
    pub quoted_total: f64,
}

/// The quote of a project, part by part.
pub async fn api_project_quote(
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
    let (concepts, prices) = match tokio::try_join!(
        list_project_concepts(&state, &company_id, &project_id),
        list_material_prices(&state, &company_id),
    ) {
        Ok(v) => v,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the quote"),
    };
    let lines: Vec<QuoteLineData> = concepts
        .iter()
        .filter_map(|c| {
            let q = quote_line(c, &prices);
            let m = c.material.clone().unwrap_or_default();
            Some(QuoteLineData {
                concept_id: c.id?.to_hex(),
                folio: c.work_order_number.map(|n| format!("OT-{n:04}")).unwrap_or_else(|| "OT-?".into()),
                part: c.name.clone(),
                quantity: c.quantity,
                material: m.material,
                shape: m.shape,
                thickness: m.thickness,
                width: m.width,
                length: m.length,
                weight_kg: q.weight_kg,
                weight_source: q.weight_source,
                entered_weight_kg: c.quote.as_ref().and_then(|q| q.weight_kg),
                entered_multiplier: c.quote.as_ref().and_then(|q| q.multiplier),
                price_per_kg: q.price_per_kg,
                material_cost: q.material_cost,
                multiplier: q.multiplier,
                suggested_unit_price: q.suggested_unit_price,
                unit_price: c.unit_price,
                missing: q.missing,
            })
        })
        .collect();
    let sum = |f: &dyn Fn(&QuoteLineData) -> Option<f64>| lines.iter().filter_map(|l| f(l).map(|v| v * l.quantity)).sum();
    Json(ProjectQuoteData {
        material_total: sum(&|l| l.material_cost),
        suggested_total: sum(&|l| l.suggested_unit_price),
        quoted_total: sum(&|l| l.unit_price),
        lines,
    })
    .into_response()
}

/// The SolidWorks weight and multiplier of one part (null clears each).
pub async fn api_part_quote_set(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<PartQuote>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let bad = |v: Option<f64>, max: f64| v.is_some_and(|v| !v.is_finite() || v <= 0.0 || v > max);
    if bad(payload.weight_kg, 10_000.0) || bad(payload.multiplier, 100.0) {
        return json_error(StatusCode::BAD_REQUEST, "el peso y el multiplicador deben ser mayores a 0");
    }
    match set_part_quote(&state, &company_id, &id, &payload).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "part not found"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the quote"),
    }
}

#[derive(Debug, Deserialize)]
pub struct ApplyPayload {
    pub concept_ids: Vec<String>,
}

/// "Usar precio sugerido": copies the suggested unit price into the quoted price of the
/// chosen parts. Parts without a suggestion are skipped and reported.
pub async fn api_project_quote_apply(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(payload): Json<ApplyPayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let prices = match list_material_prices(&state, &company_id).await {
        Ok(p) => p,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load prices"),
    };
    let (mut applied, mut skipped) = (0, Vec::new());
    for raw in payload.concept_ids.iter().take(500) {
        let id = match parse_oid(raw) {
            Ok(id) => id,
            Err(resp) => return resp,
        };
        let concept = match get_project_concept_by_id_for_company(&state, &id, &company_id).await {
            Ok(Some(c)) if c.project_id == project_id => c,
            _ => return json_error(StatusCode::BAD_REQUEST, "part not in this project"),
        };
        match quote_line(&concept, &prices).suggested_unit_price {
            Some(price) => {
                if set_concept_unit_price(&state, &id, &company_id, Some(price)).await.is_err() {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the price");
                }
                applied += 1;
            }
            None => skipped.push(concept.name),
        }
    }
    Json(serde_json::json!({ "applied": applied, "skipped": skipped })).into_response()
}
