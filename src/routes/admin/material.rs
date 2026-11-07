//! Part material and material receipts JSON API (openspec add-part-material). Recording
//! material and receiving invoices is for whoever manages the board; everyone who sees
//! parts sees it. Receipts never hold prices: the amount of each invoice line goes to the
//! material's price history (admin only), and only the admin sees it back.

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

use super::finance::helpers::require_active_company;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{MaterialReceipt, PartMaterial, ProjectConcept, ReceiptLine, UserPermission},
    session::SessionUser,
    state::{
        AppState, assign_receipt_line, cut_plan, fit_bar, material_status, get_material_receipt,
        get_project_concept_by_id_for_company,
        insert_material_receipt, list_material_receipts, receipt_pieces_by_part, receipt_price_points, read_line,
        record_receipt_prices, set_part_material,
    },
};

fn can_manage(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::ManageProductionBoard)
}

fn can_view(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::ViewProjects) || user.has_permission(UserPermission::ViewProductionBoard)
}

fn clean_text(v: Option<String>, max: usize) -> Option<String> {
    v.map(|s| s.trim().chars().take(max).collect::<String>()).filter(|s| !s.is_empty())
}

fn clean_dim(v: Option<f64>) -> Result<Option<f64>, Response> {
    match v {
        Some(d) if !d.is_finite() || d <= 0.0 || d > 1000.0 => Err(json_error(
            StatusCode::BAD_REQUEST,
            "las medidas van en pulgadas, mayores a 0",
        )),
        other => Ok(other),
    }
}

/// Replaces the material of a part; a `null` body clears it.
pub async fn api_part_material_set(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<Option<PartMaterial>>,
) -> Response {
    if !(can_manage(&session_user) || session_user.has_permission(UserPermission::TakeWorkOrders)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let material = match payload {
        Some(m) => {
            let (thickness, width, length) = match (clean_dim(m.thickness), clean_dim(m.width), clean_dim(m.length)) {
                (Ok(t), Ok(w), Ok(l)) => (t, w, l),
                (Err(r), _, _) | (_, Err(r), _) | (_, _, Err(r)) => return r,
            };
            let (part_thickness, part_width, part_length) =
                match (clean_dim(m.part_thickness), clean_dim(m.part_width), clean_dim(m.part_length)) {
                    (Ok(t), Ok(w), Ok(l)) => (t, w, l),
                    (Err(r), _, _) | (_, Err(r), _) | (_, _, Err(r)) => return r,
                };
            Some(PartMaterial {
                material: clean_text(m.material, 60),
                shape: clean_text(m.shape, 30).map(|s| s.to_lowercase()),
                thickness,
                width,
                length,
                part_thickness,
                part_width,
                part_length,
                bar_to_order: clean_text(m.bar_to_order, 120),
                customer_supplied: m.customer_supplied,
                ordered: m.ordered,
                notes: clean_text(m.notes, 500),
            })
        }
        None => None,
    };
    match set_part_material(&state, &company_id, &id, material.as_ref()).await {
        Ok(true) => Json(serde_json::json!({ "ok": true, "material": material })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "concept not found"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the material"),
    }
}

#[derive(Debug, Deserialize)]
pub struct ReceiptLinePayload {
    pub description: String,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    /// Line amount before tax; only the admin's is kept (it is money).
    #[serde(default)]
    pub amount: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptCreatePayload {
    /// Take supplier, folio, date and lines from this CFDI of the company.
    #[serde(default)]
    pub cfdi_uuid: Option<String>,
    #[serde(default)]
    pub supplier: Option<String>,
    #[serde(default)]
    pub folio: Option<String>,
    /// RFC 3339; defaults to now (or the CFDI date).
    #[serde(default)]
    pub received_at: Option<String>,
    #[serde(default)]
    pub lines: Vec<ReceiptLinePayload>,
}

/// Creates a receipt from a stored CFDI or from captured lines.
pub async fn api_material_receipt_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReceiptCreatePayload>,
) -> Response {
    if !can_manage(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let mut supplier = clean_text(payload.supplier, 120);
    let mut folio = clean_text(payload.folio, 40);
    let mut received_at = payload
        .received_at
        .as_deref()
        .and_then(|s| DateTime::parse_rfc3339_str(s).ok());
    let admin = session_user.is_admin();
    let mut raw: Vec<(String, f64, String, Option<f64>)> = payload
        .lines
        .into_iter()
        .map(|l| (l.description, l.quantity.unwrap_or(1.0), l.unit.unwrap_or_default(), l.amount.filter(|_| admin)))
        .collect();

    let cfdi_uuid = clean_text(payload.cfdi_uuid, 40);
    if let Some(uuid) = &cfdi_uuid {
        let found = state
            .cfdis
            .find_one(doc! {
                "company_id": company_id.to_hex(),
                "uuid": { "$in": [uuid.to_uppercase(), uuid.to_lowercase()] },
            })
            .await;
        let Ok(Some(cfdi)) = found else {
            return json_error(StatusCode::NOT_FOUND, "CFDI not found");
        };
        let text = |d: Option<&mongodb::bson::Document>, k: &str| {
            d.and_then(|d| d.get_str(k).ok()).map(str::to_string).filter(|s| !s.is_empty())
        };
        supplier = supplier.or_else(|| text(cfdi.get_document("emisor").ok(), "nombre"));
        folio = folio.or_else(|| text(cfdi.get_document("comprobante").ok(), "folio"));
        if received_at.is_none() {
            received_at = text(cfdi.get_document("comprobante").ok(), "fecha")
                .and_then(|f| DateTime::parse_rfc3339_str(format!("{f}-07:00")).ok());
        }
        if raw.is_empty() {
            raw = cfdi
                .get_array("conceptos")
                .map(|a| {
                    a.iter()
                        .filter_map(|c| c.as_document())
                        .map(|c| {
                            let num = |k: &str| c.get_str(k).ok().and_then(|q| q.parse::<f64>().ok());
                            let quantity = num("cantidad").unwrap_or(1.0);
                            // The SAT's own amount, before tax and less its discount.
                            let amount = num("importe")
                                .or_else(|| num("valorUnitario").map(|p| p * quantity))
                                .map(|a| a - num("descuento").unwrap_or(0.0));
                            (
                                c.get_str("descripcion").unwrap_or("").to_string(),
                                quantity,
                                c.get_str("claveUnidad").unwrap_or("").to_string(),
                                amount,
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
        }
    }
    let Some(supplier) = supplier else {
        return json_error(StatusCode::BAD_REQUEST, "falta el proveedor");
    };
    let kept: Vec<_> = raw.into_iter().filter(|(d, _, _, _)| !d.trim().is_empty()).take(200).collect();
    let amounts: Vec<(i32, f64)> = kept
        .iter()
        .enumerate()
        .filter_map(|(i, (_, _, _, a))| Some((i as i32 + 1, (*a)?)))
        .collect();
    let lines: Vec<ReceiptLine> = kept
        .into_iter()
        .enumerate()
        .map(|(i, (d, q, u, _))| read_line(i as i32 + 1, &d, q, &u))
        .collect();
    if lines.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "la recepción no tiene renglones");
    }
    let receipt = MaterialReceipt {
        id: None,
        company_id,
        supplier,
        folio,
        cfdi_uuid,
        received_at: received_at.unwrap_or_else(DateTime::now),
        lines,
        created_by: *session_user.user_id(),
        created_at: DateTime::now(),
    };
    let receipt = match insert_material_receipt(&state, receipt).await {
        Ok(r) => r,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the receipt"),
    };
    // Each invoice keeps the material prices current (a failure never loses the receipt).
    if !amounts.is_empty() {
        let _ = record_receipt_prices(&state, &receipt, &amounts, *session_user.user_id()).await;
    }
    (StatusCode::CREATED, Json(serde_json::json!({ "id": receipt.id.map(|i| i.to_hex()) }))).into_response()
}

#[derive(Debug, Deserialize)]
pub struct ReceiptPriceLine {
    pub line: i32,
    /// Line amount before tax; null or missing: no price for that line.
    #[serde(default)]
    pub amount: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptPricesPayload {
    pub lines: Vec<ReceiptPriceLine>,
}

/// The amounts of an invoice captured by hand (a PDF, or one loaded before prices were
/// kept): replaces that receipt's prices and updates the materials. Admin only.
pub async fn api_material_receipt_prices(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(p): Json<ReceiptPricesPayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let receipt = match get_material_receipt(&state, &company_id, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "receipt not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the receipt"),
    };
    let mut amounts = Vec::new();
    for l in p.lines.into_iter().take(200) {
        match l.amount {
            Some(a) if !a.is_finite() || a < 0.0 => return json_error(StatusCode::BAD_REQUEST, "el importe no puede ser negativo"),
            Some(a) if a > 0.0 => amounts.push((l.line, a)),
            _ => {}
        }
    }
    match record_receipt_prices(&state, &receipt, &amounts, *session_user.user_id()).await {
        Ok(points) => Json(serde_json::json!({
            "priced": points.len(),
            "lines": points.iter().map(|p| serde_json::json!({
                "line": p.line, "material": p.material, "kg": p.kg, "price_per_kg": p.price_per_kg, "kg_source": p.kg_source,
            })).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the prices"),
    }
}

#[derive(Serialize)]
pub struct ReceiptSummaryData {
    pub id: String,
    pub supplier: String,
    pub folio: Option<String>,
    pub cfdi_uuid: Option<String>,
    pub received_at: String,
    pub lines: usize,
    pub assigned_lines: usize,
}

pub async fn api_material_receipts_index(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    match list_material_receipts(&state, &company_id).await {
        Ok(list) => Json(
            list.into_iter()
                .filter_map(|r| {
                    Some(ReceiptSummaryData {
                        id: r.id?.to_hex(),
                        assigned_lines: r.lines.iter().filter(|l| !l.concept_ids.is_empty()).count(),
                        lines: r.lines.len(),
                        supplier: r.supplier,
                        folio: r.folio,
                        cfdi_uuid: r.cfdi_uuid,
                        received_at: iso(r.received_at),
                    })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list receipts"),
    }
}

#[derive(Serialize, Clone)]
pub struct PartRefData {
    pub concept_id: String,
    pub folio: String,
    pub part: String,
    pub project_id: String,
}

#[derive(Serialize)]
pub struct SuggestionData {
    #[serde(flatten)]
    pub part: PartRefData,
    /// "exact" or "larger".
    pub fit: &'static str,
    pub note: Option<String>,
    pub pieces: i64,
    pub needed: f64,
    /// Other bars of this receipt that suit the same part (assigned or not), so a part that
    /// needs two bars reads "28 + 7 = 35 de 30" instead of "28 de 30" and "7 de 30".
    pub other_bars: Vec<OtherBarData>,
}

#[derive(Serialize)]
pub struct OtherBarData {
    pub line: i32,
    pub pieces: i64,
    pub assigned: bool,
}

#[derive(Serialize)]
pub struct ReceiptLineData {
    pub line: i32,
    pub description: String,
    pub quantity: f64,
    pub unit: String,
    pub material: Option<String>,
    pub shape: Option<String>,
    pub thickness: Option<f64>,
    pub width: Option<f64>,
    pub length: Option<f64>,
    pub pieces: f64,
    pub assigned: Vec<PartRefData>,
    pub suggestions: Vec<SuggestionData>,
    /// Admin only: the line amount, its kilos and $/kg.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<LinePriceData>,
}

#[derive(Serialize)]
pub struct LinePriceData {
    pub amount: f64,
    pub kg: f64,
    pub price_per_kg: f64,
    pub kg_source: String,
}

#[derive(Serialize)]
pub struct PartCoverageData {
    #[serde(flatten)]
    pub part: PartRefData,
    pub needed: f64,
    pub available: i64,
}

#[derive(Serialize)]
pub struct ReceiptDetailData {
    pub id: String,
    pub supplier: String,
    pub folio: Option<String>,
    pub cfdi_uuid: Option<String>,
    pub received_at: String,
    pub lines: Vec<ReceiptLineData>,
    /// Every part with a bar of this receipt assigned: pieces needed vs pieces it yields.
    pub parts: Vec<PartCoverageData>,
}

fn part_ref(c: &ProjectConcept) -> Option<PartRefData> {
    Some(PartRefData {
        concept_id: c.id?.to_hex(),
        folio: c.work_order_number.map(|n| format!("OT-{n:04}")).unwrap_or_else(|| "OT-?".into()),
        part: c.name.clone(),
        project_id: c.project_id.to_hex(),
    })
}

/// Pieces still to make: ordered minus good pieces already produced.
fn needed(c: &ProjectConcept) -> f64 {
    (c.quantity - (c.completed_quantity - c.rejected_quantity).max(0.0)).max(0.0)
}

/// Parts of open projects with a material recorded, plus the ones the receipt names.
async fn candidate_parts(
    state: &AppState,
    company_id: &ObjectId,
    receipt: &MaterialReceipt,
) -> HashMap<ObjectId, ProjectConcept> {
    let assigned: Vec<ObjectId> = receipt.lines.iter().flat_map(|l| l.concept_ids.clone()).collect();
    let closed: Vec<ObjectId> = match state
        .projects
        .find(doc! { "company_id": company_id, "completed_at": { "$ne": null } })
        .await
    {
        Ok(c) => c.try_collect::<Vec<_>>().await.unwrap_or_default().into_iter().filter_map(|p| p.id).collect(),
        Err(_) => Vec::new(),
    };
    let filter = doc! {
        "company_id": company_id,
        "$or": [
            { "material.length": { "$exists": true }, "project_id": { "$nin": &closed } },
            { "_id": { "$in": &assigned } },
        ],
    };
    match state.project_concepts.find(filter).await {
        Ok(c) => c
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|c| c.id.map(|id| (id, c)))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

/// The receipt with each line read, the parts it suits and what each assigned part gets.
pub async fn api_material_receipt_show(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let receipt = match get_material_receipt(&state, &company_id, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "receipt not found"),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the receipt"),
    };
    let parts = candidate_parts(&state, &company_id, &receipt).await;
    let mut prices: HashMap<i32, LinePriceData> = if session_user.is_admin() {
        receipt_price_points(&state, &company_id, &id)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.line, LinePriceData { amount: p.amount, kg: p.kg, price_per_kg: p.price_per_kg, kg_source: p.kg_source }))
            .collect()
    } else {
        HashMap::new()
    };
    let mut ordered: Vec<&ProjectConcept> = parts.values().collect();
    ordered.sort_by_key(|c| c.work_order_number.unwrap_or(i64::MAX));

    // Which bars suit which part, once, so each suggestion can count the others.
    let fits: Vec<Vec<(ObjectId, crate::state::BarFit)>> = receipt
        .lines
        .iter()
        .map(|l| {
            ordered
                .iter()
                .filter_map(|c| Some((c.id?, fit_bar(c.material.as_ref()?, l)?)))
                .collect()
        })
        .collect();
    let lines = receipt
        .lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let mut suggestions: Vec<SuggestionData> = fits[i]
                .iter()
                .filter_map(|(cid, fit)| {
                    let c = parts.get(cid)?;
                    let other_bars = receipt
                        .lines
                        .iter()
                        .enumerate()
                        .filter(|(j, _)| *j != i)
                        .filter_map(|(j, other)| {
                            let (_, f) = fits[j].iter().find(|(o, _)| o == cid)?;
                            let assigned = other.concept_ids.contains(cid);
                            // A bar already given to another part is not on offer.
                            (assigned || other.concept_ids.is_empty()).then_some(OtherBarData {
                                line: other.line,
                                pieces: f.pieces,
                                assigned,
                            })
                        })
                        .collect();
                    Some(SuggestionData {
                        part: part_ref(c)?,
                        fit: fit.fit,
                        note: fit.note.clone(),
                        pieces: fit.pieces,
                        needed: needed(c),
                        other_bars,
                    })
                })
                .collect();
            // Exact fits first, then the least excess material.
            suggestions.sort_by_key(|s| (s.fit != "exact", s.note.as_ref().map(|n| n.len()).unwrap_or(0)));
            ReceiptLineData {
                line: l.line,
                description: l.description.clone(),
                quantity: l.quantity,
                unit: l.unit.clone(),
                material: l.material.clone(),
                shape: l.shape.clone(),
                thickness: l.thickness,
                width: l.width,
                length: l.length,
                pieces: l.pieces,
                assigned: l.concept_ids.iter().filter_map(|c| parts.get(c).and_then(part_ref)).collect(),
                suggestions,
                price: prices.remove(&l.line),
            }
        })
        .collect();
    let available = receipt_pieces_by_part(&receipt, &parts);
    let mut coverage: Vec<PartCoverageData> = available
        .iter()
        .filter_map(|(c, pieces)| {
            let concept = parts.get(c)?;
            Some(PartCoverageData { part: part_ref(concept)?, needed: needed(concept), available: *pieces })
        })
        .collect();
    coverage.sort_by(|a, b| a.part.folio.cmp(&b.part.folio));

    Json(ReceiptDetailData {
        id: id.to_hex(),
        supplier: receipt.supplier,
        folio: receipt.folio,
        cfdi_uuid: receipt.cfdi_uuid,
        received_at: iso(receipt.received_at),
        lines,
        parts: coverage,
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct AssignPayload {
    pub concept_ids: Vec<String>,
}

/// Which parts a received bar goes to (replaces the previous choice; empty clears it).
pub async fn api_material_receipt_assign(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path((id, line)): Path<(String, i32)>,
    Json(payload): Json<AssignPayload>,
) -> Response {
    if !(can_manage(&session_user) || session_user.has_permission(UserPermission::TakeWorkOrders)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let mut concept_ids = Vec::new();
    for c in payload.concept_ids.iter().take(50) {
        let c = match parse_oid(c) {
            Ok(c) => c,
            Err(resp) => return resp,
        };
        match get_project_concept_by_id_for_company(&state, &c, &company_id).await {
            Ok(Some(_)) => {}
            _ => return json_error(StatusCode::BAD_REQUEST, "part not found"),
        }
        if !concept_ids.contains(&c) {
            concept_ids.push(c);
        }
    }
    match assign_receipt_line(&state, &company_id, &id, line, &concept_ids).await {
        Ok(true) => {
            // The material is in the shop: tick "Material" on each part (Daniel, 2026-11-03).
            let username = session_user.user().username.clone();
            for c in &concept_ids {
                let _ = crate::state::mark_step_by_name(
                    &state,
                    &company_id,
                    c,
                    crate::state::STEP_MATERIAL,
                    crate::models::StepState::Done,
                    &username,
                )
                .await;
            }
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Ok(false) => json_error(StatusCode::NOT_FOUND, "receipt line not found"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not assign the bar"),
    }
}

#[derive(Serialize)]
pub struct BarCutsData {
    pub receipt_id: String,
    pub folio: Option<String>,
    pub line: i32,
    pub thickness: Option<f64>,
    pub width: Option<f64>,
    pub length: f64,
    pub cuts: i64,
    pub leftover: f64,
    pub note: Option<String>,
}

#[derive(Serialize)]
pub struct CutListItemData {
    #[serde(flatten)]
    pub part: PartRefData,
    pub project: String,
    pub material: PartMaterial,
    pub status: Option<&'static str>,
    /// "Material habilitado" is ✔.
    pub cut_done: bool,
    pub needed: f64,
    /// Blanks planned from the assigned bars (may fall short of `needed`).
    pub planned: i64,
    pub bars: Vec<BarCutsData>,
    /// Place in the Sierra cinta queue (1 = next), when it was sent to cut.
    pub saw_position: Option<usize>,
}

/// The band saw of the company: the active machine whose name says "sierra".
pub(crate) const NOT_IN_SHOP: &str =
    "el material todavía no está en el taller: asígnale una barra recibida o marca el paso Material";

/// Only what is already in the shop goes to the saw (Daniel, 2026-11-06): a received bar
/// assigned or the "Material" step ✔, also for material the customer supplies.
pub(crate) async fn material_in_shop(state: &AppState, company_id: &ObjectId, concept: &ProjectConcept) -> bool {
    let Some(id) = concept.id else { return false };
    let received = crate::state::parts_with_received_material(state, company_id, &[id])
        .await
        .map(|s| s.contains(&id))
        .unwrap_or(false);
    let mut in_shop = concept.clone();
    if let Some(m) = in_shop.material.as_mut() {
        m.customer_supplied = false;
    }
    matches!(material_status(&in_shop, received), Some("recibido" | "cortado"))
}

pub(crate) async fn find_saw(state: &AppState, company_id: &ObjectId) -> Option<ObjectId> {
    crate::state::list_resources(state, company_id)
        .await
        .ok()?
        .into_iter()
        .filter(|r| r.is_active && r.resource_type == crate::models::ResourceType::Machinery)
        .find(|r| crate::state::machine_key(&r.name).contains("SIERRA"))
        .and_then(|r| r.id)
}

/// Order of each part in the saw queue (first entry wins).
async fn saw_positions(state: &AppState, company_id: &ObjectId, saw: Option<ObjectId>) -> HashMap<ObjectId, usize> {
    let Some(saw) = saw else { return HashMap::new() };
    let queue = crate::state::list_machine_queues(state, company_id)
        .await
        .ok()
        .and_then(|mut q| q.remove(&saw))
        .unwrap_or_default();
    let mut out = HashMap::new();
    for (i, e) in queue.iter().enumerate() {
        out.entry(e.concept_id).or_insert(i + 1);
    }
    out
}

/// "Pasar a corte": puts the part in the Sierra cinta queue with the label "Corte 30 pz @
/// 5\"" (Daniel, 2026-11-03). Programmers and whoever manages the board.
pub async fn api_cut_queue(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !(session_user.has_permission(UserPermission::TakeWorkOrders) || can_manage(&session_user)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let concept = match get_project_concept_by_id_for_company(&state, &id, &company_id).await {
        Ok(Some(c)) => c,
        _ => return json_error(StatusCode::NOT_FOUND, "part not found"),
    };
    let Some(length) = concept.material.as_ref().and_then(|m| m.length) else {
        return json_error(StatusCode::BAD_REQUEST, "captura primero el material y el largo de corte de la parte");
    };
    if !material_in_shop(&state, &company_id, &concept).await {
        return json_error(StatusCode::BAD_REQUEST, NOT_IN_SHOP);
    }
    let Some(saw) = find_saw(&state, &company_id).await else {
        return json_error(StatusCode::BAD_REQUEST, "no hay una máquina \"Sierra\" dada de alta");
    };
    if saw_positions(&state, &company_id, Some(saw)).await.contains_key(&id) {
        return json_error(StatusCode::CONFLICT, "ya está en la fila de la sierra");
    }
    let inches = format!("{length:.4}");
    let inches = inches.trim_end_matches('0').trim_end_matches('.');
    let label = format!("Corte {} pz @ {inches}\"", needed(&concept));
    match crate::state::add_machine_queue_entry(&state, company_id, saw, id, Some(label), *session_user.user_id()).await {
        Ok(e) => (StatusCode::CREATED, Json(serde_json::json!({ "id": e.id.map(|i| i.to_hex()), "rank": e.rank })))
            .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not queue the cut"),
    }
}

/// The saw's cut list (add-part-material §3): every part of an open project with a cut
/// length, which assigned bars to cut and how many blanks from each, with its status. For
/// the shop floor: no prices.
/// Everything the cut list is computed from: titles of open projects, their parts with a cut
/// length and the cuts each gets from its assigned bars. Shared by the cut list and the plant
/// view so both say the same.
pub(crate) struct CutPlanData {
    pub projects: HashMap<ObjectId, String>,
    pub parts: HashMap<ObjectId, ProjectConcept>,
    pub plan: HashMap<ObjectId, Vec<crate::state::BarCuts>>,
}

pub(crate) async fn load_cut_plan(state: &AppState, company_id: &ObjectId) -> anyhow::Result<CutPlanData> {
    let projects: HashMap<ObjectId, String> = state
        .projects
        .find(doc! { "company_id": company_id, "completed_at": null })
        .await?
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .filter_map(|p| Some((p.id?, p.title)))
        .collect();
    let project_ids: Vec<ObjectId> = projects.keys().copied().collect();
    let parts: HashMap<ObjectId, ProjectConcept> = state
        .project_concepts
        .find(doc! {
            "company_id": company_id,
            "project_id": { "$in": &project_ids },
            "material.length": { "$exists": true },
        })
        .await?
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .filter_map(|c| Some((c.id?, c)))
        .collect();
    let mut receipts = list_material_receipts(state, company_id).await?;
    // Oldest delivery first, so earlier bars are used before newer ones.
    receipts.reverse();
    let plan = cut_plan(&receipts, &parts, needed);
    Ok(CutPlanData { projects, parts, plan })
}

pub async fn api_cut_list(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let Ok(CutPlanData { projects, parts, mut plan }) = load_cut_plan(&state, &company_id).await else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the cut list");
    };
    let saw = saw_positions(&state, &company_id, find_saw(&state, &company_id).await).await;

    let mut items: Vec<CutListItemData> = parts
        .values()
        .filter_map(|c| {
            let id = c.id?;
            let bars = plan.remove(&id).unwrap_or_default();
            let cut_done = c.process_steps.iter().any(|s| {
                s.name.trim().eq_ignore_ascii_case("material habilitado")
                    && s.state == crate::models::StepState::Done
            });
            Some(CutListItemData {
                part: part_ref(c)?,
                project: projects.get(&c.project_id).cloned().unwrap_or_default(),
                material: c.material.clone()?,
                status: material_status(c, !bars.is_empty()),
                cut_done,
                needed: needed(c),
                saw_position: saw.get(&id).copied(),
                planned: bars.iter().map(|b| b.cuts).sum(),
                bars: bars
                    .into_iter()
                    .map(|b| BarCutsData {
                        receipt_id: b.receipt_id.to_hex(),
                        folio: b.folio,
                        line: b.line,
                        thickness: b.thickness,
                        width: b.width,
                        length: b.length,
                        cuts: b.cuts,
                        leftover: b.leftover,
                        note: b.note,
                    })
                    .collect(),
            })
        })
        .collect();
    // By material, so the saw cuts all the aluminum in a row, then by OT.
    items.sort_by(|a, b| {
        (a.material.material.as_deref().unwrap_or("~"), &a.part.folio)
            .cmp(&(b.material.material.as_deref().unwrap_or("~"), &b.part.folio))
    });
    Json(items).into_response()
}

#[derive(Debug, Deserialize)]
pub struct CutDonePayload {
    pub done: bool,
}

/// "Corte terminado": marks (or unmarks) the part's "Material habilitado" step. Programmers
/// and whoever manages the board, like the machines.
pub async fn api_cut_done(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<CutDonePayload>,
) -> Response {
    if !(session_user.has_permission(UserPermission::TakeWorkOrders) || can_manage(&session_user)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match get_project_concept_by_id_for_company(&state, &id, &company_id).await {
        Ok(Some(_)) => {}
        _ => return json_error(StatusCode::NOT_FOUND, "part not found"),
    }
    let step_state = if payload.done { crate::models::StepState::Done } else { crate::models::StepState::Pending };
    let username = session_user.user().username.clone();
    match crate::state::mark_step_by_name(&state, &company_id, &id, crate::state::STEP_CUT, step_state, &username).await {
        Ok(true) => {
            // A finished cut leaves the saw queue.
            if payload.done {
                if let Some(saw) = find_saw(&state, &company_id).await {
                    let _ = crate::state::remove_part_from_machine_queue(&state, &company_id, &saw, &id).await;
                }
            }
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Ok(false) => json_error(StatusCode::BAD_REQUEST, "falta el paso \"Material habilitado\" en el catálogo de proceso"),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// When the saw finishes a job ("Terminar trabajo" on the Sierra cinta), that part's cut is
/// done: tick "Material habilitado" (Daniel, 2026-11-03). Other machines are untouched.
pub async fn saw_job_finished(
    state: &AppState,
    company_id: &ObjectId,
    resource_id: &ObjectId,
    concept_id: &ObjectId,
    username: &str,
) {
    if find_saw(state, company_id).await.as_ref() != Some(resource_id) {
        return;
    }
    let _ = crate::state::mark_step_by_name(
        state,
        company_id,
        concept_id,
        crate::state::STEP_CUT,
        crate::models::StepState::Done,
        username,
    )
    .await;
    let _ = crate::state::remove_part_from_machine_queue(state, company_id, resource_id, concept_id).await;
}
