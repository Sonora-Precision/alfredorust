//! Part material and material receipts JSON API (openspec add-part-material). Recording
//! material and receiving invoices is for whoever manages the board; everyone who sees
//! parts sees it. Never stores or returns prices.

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
        AppState, PartProgressUpdate, assign_receipt_line, cut_plan, fit_bar, list_process_operations, material_status,
        update_part_progress, get_material_receipt, get_project_concept_by_id_for_company,
        insert_material_receipt, list_material_receipts, receipt_pieces_by_part, read_line, set_part_material,
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
    if !can_manage(&session_user) {
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
            Some(PartMaterial {
                material: clean_text(m.material, 60),
                shape: clean_text(m.shape, 30).map(|s| s.to_lowercase()),
                thickness,
                width,
                length,
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
    let mut raw: Vec<(String, f64, String)> = payload
        .lines
        .into_iter()
        .map(|l| (l.description, l.quantity.unwrap_or(1.0), l.unit.unwrap_or_default()))
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
                            (
                                c.get_str("descripcion").unwrap_or("").to_string(),
                                c.get_str("cantidad").ok().and_then(|q| q.parse().ok()).unwrap_or(1.0),
                                c.get_str("claveUnidad").unwrap_or("").to_string(),
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
    let lines: Vec<ReceiptLine> = raw
        .into_iter()
        .filter(|(d, _, _)| !d.trim().is_empty())
        .take(200)
        .enumerate()
        .map(|(i, (d, q, u))| read_line(i as i32 + 1, &d, q, &u))
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
    match insert_material_receipt(&state, receipt).await {
        Ok(r) => (StatusCode::CREATED, Json(serde_json::json!({ "id": r.id.map(|i| i.to_hex()) }))).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the receipt"),
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
    if !can_manage(&session_user) {
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
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
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
}

/// The saw's cut list (add-part-material §3): every part of an open project with a cut
/// length, which assigned bars to cut and how many blanks from each, with its status. For
/// the shop floor: no prices.
pub async fn api_cut_list(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let projects: HashMap<ObjectId, String> = match state
        .projects
        .find(doc! { "company_id": company_id, "completed_at": null })
        .await
    {
        Ok(c) => c
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| Some((p.id?, p.title)))
            .collect(),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load projects"),
    };
    let project_ids: Vec<ObjectId> = projects.keys().copied().collect();
    let parts: HashMap<ObjectId, ProjectConcept> = match state
        .project_concepts
        .find(doc! {
            "company_id": company_id,
            "project_id": { "$in": &project_ids },
            "material.length": { "$exists": true },
        })
        .await
    {
        Ok(c) => c
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|c| Some((c.id?, c)))
            .collect(),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load parts"),
    };
    let mut receipts = list_material_receipts(&state, &company_id).await.unwrap_or_default();
    // Oldest delivery first, so earlier bars are used before newer ones.
    receipts.reverse();
    let mut plan = cut_plan(&receipts, &parts, needed);

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
    let operation = match list_process_operations(&state, &company_id, true).await {
        Ok(ops) => ops
            .into_iter()
            .find(|op| op.name.trim().eq_ignore_ascii_case("material habilitado"))
            .and_then(|op| op.id),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the process"),
    };
    let Some(operation_id) = operation else {
        return json_error(StatusCode::BAD_REQUEST, "falta el paso \"Material habilitado\" en el catálogo de proceso");
    };
    let update = PartProgressUpdate {
        completed_quantity: None,
        step: Some((
            operation_id,
            if payload.done { crate::models::StepState::Done } else { crate::models::StepState::Pending },
        )),
    };
    let username = session_user.user().username.clone();
    match update_part_progress(&state, &id, &company_id, update, &username).await {
        Ok(Some(_)) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "part not found"),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}
