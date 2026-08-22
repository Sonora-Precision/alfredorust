use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Write},
    path::PathBuf,
    sync::Arc,
};

use anyhow::Context;
use askama::Template;
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use futures::stream::TryStreamExt;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[allow(unused_imports)]
use crate::filters;
use crate::{
    models::{ContactType, FlowType, TransactionType},
    session::SessionUser,
    state::{
        AppState, CfdiTransactionSync, CfdiTransactionSyncOutcome,
        create_or_update_planned_entry_from_cfdi, get_company_by_id, get_or_create_category,
        get_or_create_contact_by_rfc, get_or_create_sat_account, list_sat_configs,
        sync_transaction_from_cfdi,
    },
};

const PER_PAGE: u64 = 50;
const API_LIMIT: i64 = 5000;
const MAX_CFDI_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Template)]
#[template(path = "admin/cfdis/index.html")]
struct CfdisIndexTemplate {
    cfdis: Vec<CfdiRow>,
    page: u64,
    total_pages: u64,
    total: u64,
}

struct CfdiRow {
    uuid: String,
    tipo: String,
    emisor_rfc: String,
    emisor_nombre: String,
    receptor_rfc: String,
    receptor_nombre: String,
    total: String,
    moneda: String,
    fecha: String,
}

#[derive(Deserialize)]
pub struct PageQuery {
    #[serde(default = "default_page")]
    page: u64,
}

fn default_page() -> u64 {
    1
}

fn str_field(doc: &bson::Document, key: &str) -> String {
    doc.get_str(key).unwrap_or("").to_string()
}

fn nested_str(doc: &bson::Document, nested: &str, key: &str) -> String {
    doc.get_document(nested)
        .ok()
        .and_then(|d| d.get_str(key).ok())
        .unwrap_or("")
        .to_string()
}

pub async fn cfdis_index(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(q): Query<PageQuery>,
) -> Result<Html<String>, StatusCode> {
    if !session_user.is_admin() {
        return Err(StatusCode::FORBIDDEN);
    }
    let active_company = session_user.active_company_id();
    let filter = bson::doc! { "company_id": active_company.to_hex() };

    let total = state
        .cfdis
        .count_documents(filter.clone())
        .await
        .unwrap_or(0);

    let total_pages = (total + PER_PAGE - 1) / PER_PAGE;
    let page = q.page.max(1).min(total_pages.max(1));
    let skip = (page - 1) * PER_PAGE;

    let opts = mongodb::options::FindOptions::builder()
        .sort(bson::doc! { "comprobante.fecha": -1 })
        .skip(skip)
        .limit(PER_PAGE as i64)
        .build();

    let mut cursor = state
        .cfdis
        .find(filter)
        .with_options(opts)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut rows = Vec::new();
    while let Some(doc) = cursor
        .try_next()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let comp = doc.get_document("comprobante").ok();
        rows.push(CfdiRow {
            uuid: str_field(&doc, "uuid"),
            tipo: comp
                .map(|c| str_field(c, "tipoDeComprobante"))
                .unwrap_or_default(),
            emisor_rfc: nested_str(&doc, "emisor", "rfc"),
            emisor_nombre: nested_str(&doc, "emisor", "nombre"),
            receptor_rfc: nested_str(&doc, "receptor", "rfc"),
            receptor_nombre: nested_str(&doc, "receptor", "nombre"),
            total: comp.map(|c| str_field(c, "total")).unwrap_or_default(),
            moneda: comp.map(|c| str_field(c, "moneda")).unwrap_or_default(),
            fecha: comp.map(|c| str_field(c, "fecha")).unwrap_or_default(),
        });
    }

    CfdisIndexTemplate {
        cfdis: rows,
        page,
        total_pages,
        total,
    }
    .render()
    .map(Html)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// ── JSON API for the React dashboard ──────────────────────────────────────

#[derive(Serialize)]
pub struct CfdiApiItem {
    pub uuid: String,
    pub folio: String,
    pub tipo: String,
    pub fecha: String,
    pub subtotal: f64,
    pub iva: f64,
    pub total: f64,
    pub moneda: String,
    pub forma_pago: String,
    pub metodo_pago: String,
    pub emisor_rfc: String,
    pub emisor_nombre: String,
    pub receptor_rfc: String,
    pub receptor_nombre: String,
    pub concepto: String,
    /// "vigente" | "cancelado" — SAT status, defaults to "vigente" until a
    /// status check proves otherwise (see the check-status endpoint).
    pub estatus: String,
    /// true if the company is the emisor (issued = income), false if receptor (received = expense)
    pub es_emitido: bool,
    pub has_transaction: bool,
}

#[derive(Serialize)]
pub struct CfdiDataResponse {
    pub company_rfcs: Vec<String>,
    pub items: Vec<CfdiApiItem>,
}

#[derive(Deserialize, ToSchema)]
pub struct BulkCfdiTransactionsRequest {
    pub uuids: Vec<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct CfdiZipRequest {
    pub uuids: Vec<String>,
}

#[derive(Serialize, ToSchema)]
pub struct BulkCfdiTransactionError {
    pub uuid: String,
    pub error: String,
}

#[derive(Serialize, ToSchema)]
pub struct BulkCfdiTransactionsResponse {
    pub requested: usize,
    pub created: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub errors: Vec<BulkCfdiTransactionError>,
}

#[derive(Serialize)]
pub struct CfdiConceptData {
    pub descripcion: String,
    pub cantidad: String,
    pub valor_unitario: String,
    pub importe: String,
}

#[derive(Serialize)]
pub struct CfdiDetailResponse {
    pub uuid: String,
    pub company_id: String,
    pub folio: String,
    pub serie: String,
    pub tipo: String,
    pub fecha: String,
    pub subtotal: f64,
    pub iva: f64,
    pub total: f64,
    pub moneda: String,
    pub forma_pago: String,
    pub metodo_pago: String,
    pub uso_cfdi: String,
    pub emisor_rfc: String,
    pub emisor_nombre: String,
    pub receptor_rfc: String,
    pub receptor_nombre: String,
    pub conceptos: Vec<CfdiConceptData>,
    /// "vigente" | "cancelado" — see [`CfdiApiItem::estatus`].
    pub estatus: String,
    pub es_emitido: bool,
}

/// Read the stored SAT status of a CFDI doc, defaulting to "vigente" (a freshly
/// downloaded/uploaded CFDI is presumed vigente until a status check says else).
fn cfdi_estatus(doc: &bson::Document) -> String {
    match doc.get_str("estatus") {
        Ok(s) if !s.trim().is_empty() => s.to_string(),
        _ => "vigente".to_string(),
    }
}

fn parse_f64(s: &str) -> f64 {
    s.trim().parse().unwrap_or(0.0)
}

fn sanitize_archive_segment(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .collect()
}

enum BulkSyncOutcome {
    Created,
    Updated,
    Unchanged,
    Skipped,
}

async fn sync_cfdi_document(
    state: &AppState,
    company_id: &bson::oid::ObjectId,
    company_rfcs: &HashSet<String>,
    doc: &bson::Document,
) -> anyhow::Result<BulkSyncOutcome> {
    if cfdi_estatus(doc).eq_ignore_ascii_case("cancelado") {
        return Ok(BulkSyncOutcome::Skipped);
    }
    let uuid = str_field(doc, "uuid");
    let comp = doc
        .get_document("comprobante")
        .context("CFDI is missing comprobante data")?;
    let tipo = str_field(comp, "tipoDeComprobante");
    if tipo != "I" && tipo != "E" {
        return Ok(BulkSyncOutcome::Skipped);
    }
    let amount = parse_f64(comp.get_str("total").unwrap_or("0"));
    if amount <= 0.0 {
        return Ok(BulkSyncOutcome::Skipped);
    }
    let date = chrono::NaiveDateTime::parse_from_str(
        comp.get_str("fecha").unwrap_or(""),
        "%Y-%m-%dT%H:%M:%S",
    )
    .with_context(|| format!("CFDI {uuid} has an invalid date"))?;
    let date = bson::DateTime::from_chrono(
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(date, chrono::Utc),
    );
    let emisor_rfc = nested_str(doc, "emisor", "rfc");
    let receptor_rfc = nested_str(doc, "receptor", "rfc");
    if company_rfcs.is_empty() {
        anyhow::bail!("company has no SAT RFC configured");
    }
    let es_emitido = company_rfcs.contains(&emisor_rfc.to_uppercase());
    if !es_emitido && !company_rfcs.contains(&receptor_rfc.to_uppercase()) {
        anyhow::bail!("CFDI parties do not match the active company RFC");
    }
    let is_income = (tipo == "I" && es_emitido) || (tipo == "E" && !es_emitido);
    let (flow_type, transaction_type, category_name) = if is_income {
        (
            FlowType::Income,
            TransactionType::Income,
            "CFDIs Importados (Ingresos)",
        )
    } else {
        (
            FlowType::Expense,
            TransactionType::Expense,
            "CFDIs Importados (Egresos)",
        )
    };
    let (contact_rfc, contact_name, contact_type) = if es_emitido {
        (
            receptor_rfc,
            nested_str(doc, "receptor", "nombre"),
            ContactType::Customer,
        )
    } else {
        (
            emisor_rfc,
            nested_str(doc, "emisor", "nombre"),
            ContactType::Supplier,
        )
    };
    let contact_id = if contact_rfc.is_empty() {
        None
    } else {
        Some(
            get_or_create_contact_by_rfc(
                state,
                company_id,
                &contact_rfc,
                &contact_name,
                contact_type,
            )
            .await?,
        )
    };
    let category_id =
        get_or_create_category(state, company_id, category_name, flow_type.clone()).await?;
    let account_id = get_or_create_sat_account(state, company_id).await?;
    let description = format!("{contact_name} — {uuid}");
    let currency = Some(str_field(comp, "moneda")).filter(|value| !value.is_empty());
    let folio = Some(str_field(comp, "folio")).filter(|value| !value.is_empty());
    let (planned_entry_id, _) = create_or_update_planned_entry_from_cfdi(
        state,
        company_id,
        date,
        &description,
        flow_type,
        &category_id,
        &account_id,
        contact_id,
        amount,
        &uuid,
        currency.clone(),
        folio.clone(),
        None,
    )
    .await?;
    let outcome = sync_transaction_from_cfdi(
        state,
        company_id,
        CfdiTransactionSync {
            date,
            description,
            transaction_type,
            category_id,
            account_id,
            amount,
            planned_entry_id,
            contact_id,
            cfdi_uuid: uuid,
            currency,
            cfdi_folio: folio,
        },
    )
    .await?;
    Ok(match outcome {
        CfdiTransactionSyncOutcome::Created => BulkSyncOutcome::Created,
        CfdiTransactionSyncOutcome::Updated => BulkSyncOutcome::Updated,
        CfdiTransactionSyncOutcome::Unchanged => BulkSyncOutcome::Unchanged,
    })
}

#[utoipa::path(
    post,
    path = "/api/admin/cfdis/transactions/bulk",
    tag = "cfdi",
    request_body = BulkCfdiTransactionsRequest,
    responses(
        (status = 200, description = "Bulk CFDI transaction synchronization", body = BulkCfdiTransactionsResponse),
        (status = 400, description = "Invalid UUID selection"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden")
    ),
    security(("session" = []))
)]
pub async fn cfdi_transactions_bulk_api(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(request): Json<BulkCfdiTransactionsRequest>,
) -> Result<Json<BulkCfdiTransactionsResponse>, StatusCode> {
    if !session_user.is_admin() {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut seen = HashSet::new();
    let uuids: Vec<String> = request
        .uuids
        .into_iter()
        .map(|uuid| uuid.trim().to_string())
        .filter(|uuid| !uuid.is_empty() && seen.insert(uuid.clone()))
        .collect();
    if uuids.is_empty() || uuids.len() > API_LIMIT as usize {
        return Err(StatusCode::BAD_REQUEST);
    }

    let company_id = session_user.active_company_id();
    let _sync_guard = state.cfdi_transaction_sync_lock.lock().await;
    let company_hex = company_id.to_hex();
    let company_rfcs: HashSet<String> = list_sat_configs(&state, &company_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .map(|config| config.rfc.to_uppercase())
        .collect();
    let mut cursor = state
        .cfdis
        .find(bson::doc! {
            "company_id": &company_hex,
            "uuid": { "$in": bson::to_bson(&uuids).map_err(|_| StatusCode::BAD_REQUEST)? },
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut documents = HashMap::new();
    while let Some(doc) = cursor
        .try_next()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        documents.insert(str_field(&doc, "uuid"), doc);
    }

    let mut response = BulkCfdiTransactionsResponse {
        requested: uuids.len(),
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        errors: Vec::new(),
    };
    for uuid in uuids {
        let Some(doc) = documents.get(&uuid) else {
            response.errors.push(BulkCfdiTransactionError {
                uuid,
                error: "CFDI is not available for the active company".to_string(),
            });
            continue;
        };
        match sync_cfdi_document(&state, &company_id, &company_rfcs, doc).await {
            Ok(BulkSyncOutcome::Created) => response.created += 1,
            Ok(BulkSyncOutcome::Updated) => response.updated += 1,
            Ok(BulkSyncOutcome::Unchanged) => response.unchanged += 1,
            Ok(BulkSyncOutcome::Skipped) => response.skipped += 1,
            Err(error) => {
                eprintln!("[cfdi] bulk transaction sync failed uuid={uuid}: {error:#}");
                response.errors.push(BulkCfdiTransactionError {
                    uuid,
                    error: "CFDI transaction synchronization failed".to_string(),
                });
            }
        }
    }
    Ok(Json(response))
}

fn cfdi_archive_candidates(
    root: &std::path::Path,
    slug: &str,
    company_rfcs: &[String],
    doc: &bson::Document,
) -> Vec<PathBuf> {
    let uuid = sanitize_archive_segment(&str_field(doc, "uuid"));
    let year = doc
        .get_document("comprobante")
        .ok()
        .and_then(|comp| comp.get_str("fecha").ok())
        .and_then(|date| date.get(..4))
        .map(sanitize_archive_segment)
        .unwrap_or_else(|| "unknown".to_string());
    let mut rfcs = company_rfcs.to_vec();
    let emisor_rfc = nested_str(doc, "emisor", "rfc");
    if !emisor_rfc.is_empty() && !rfcs.iter().any(|rfc| rfc == &emisor_rfc) {
        rfcs.push(emisor_rfc);
    }
    let receptor_rfc = nested_str(doc, "receptor", "rfc");
    if !receptor_rfc.is_empty() && !rfcs.iter().any(|rfc| rfc == &receptor_rfc) {
        rfcs.push(receptor_rfc);
    }
    let mut candidates = Vec::new();
    for rfc in rfcs {
        for direction in ["emitido", "recibido"] {
            candidates.push(
                root.join(sanitize_archive_segment(slug))
                    .join(sanitize_archive_segment(&rfc))
                    .join(direction)
                    .join(&year)
                    .join(format!("{uuid}.xml")),
            );
        }
    }
    candidates
}

#[utoipa::path(
    post,
    path = "/api/admin/cfdis/archive",
    tag = "cfdi",
    request_body = CfdiZipRequest,
    responses(
        (status = 200, description = "ZIP with selected CFDI XML files", content_type = "application/zip"),
        (status = 400, description = "Invalid UUID selection"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "A selected CFDI is unavailable"),
        (status = 409, description = "A selected CFDI has no archived XML"),
        (status = 413, description = "Selected archive exceeds the size limit")
    ),
    security(("session" = []))
)]
pub async fn cfdi_archive_api(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(request): Json<CfdiZipRequest>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let _archive_guard = state.cfdi_archive_lock.lock().await;
    let mut seen = HashSet::new();
    let uuids: Vec<String> = request
        .uuids
        .into_iter()
        .map(|uuid| uuid.trim().to_string())
        .filter(|uuid| !uuid.is_empty() && seen.insert(uuid.clone()))
        .collect();
    if uuids.is_empty() || uuids.len() > API_LIMIT as usize {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Select between 1 and 5000 CFDIs" })),
        )
            .into_response();
    }
    let company_id = session_user.active_company_id();
    let company_hex = company_id.to_hex();
    let mut cursor = match state
        .cfdis
        .find(bson::doc! {
            "company_id": &company_hex,
            "uuid": { "$in": bson::to_bson(&uuids).unwrap_or_default() },
        })
        .await
    {
        Ok(cursor) => cursor,
        Err(error) => {
            eprintln!("[cfdi] archive query failed: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let mut documents = HashMap::new();
    loop {
        match cursor.try_next().await {
            Ok(Some(doc)) => {
                documents.insert(str_field(&doc, "uuid"), doc);
            }
            Ok(None) => break,
            Err(error) => {
                eprintln!("[cfdi] archive cursor failed: {error}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    }
    if documents.len() != uuids.len() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "One or more CFDIs are unavailable" })),
        )
            .into_response();
    }
    let company = match get_company_by_id(&state, &company_id).await {
        Ok(Some(company)) => company,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            eprintln!("[cfdi] archive company lookup failed: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let company_rfcs: Vec<String> = match list_sat_configs(&state, &company_id).await {
        Ok(configs) => configs.into_iter().map(|config| config.rfc).collect(),
        Err(error) => {
            eprintln!("[cfdi] archive SAT config lookup failed: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let root = PathBuf::from(
        std::env::var("CFDI_STORE_DIR").unwrap_or_else(|_| "data/cfdi_store".to_string()),
    );
    let mut files = Vec::with_capacity(uuids.len());
    let mut total_bytes = 0_u64;
    for uuid in &uuids {
        let doc = &documents[uuid];
        let Some(path) = cfdi_archive_candidates(&root, &company.slug, &company_rfcs, doc)
            .into_iter()
            .find(|path| path.is_file())
        else {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "One or more selected CFDIs have no archived XML" })),
            )
                .into_response();
        };
        let file_bytes = match path.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                eprintln!(
                    "[cfdi] archive metadata failed for {}: {error}",
                    path.display()
                );
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        total_bytes = total_bytes.saturating_add(file_bytes);
        if total_bytes > MAX_CFDI_ARCHIVE_BYTES {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({ "error": "Selected CFDI archive exceeds 128 MB" })),
            )
                .into_response();
        }
        files.push((uuid.clone(), path));
    }
    let zip = match tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (uuid, path) in files {
            let xml = std::fs::read(&path)
                .with_context(|| format!("failed to read archived CFDI {}", path.display()))?;
            let safe_uuid = sanitize_archive_segment(&uuid);
            anyhow::ensure!(
                !safe_uuid.is_empty(),
                "CFDI UUID has no safe filename characters"
            );
            writer.start_file(format!("{safe_uuid}.xml"), options)?;
            writer.write_all(&xml)?;
        }
        Ok(writer.finish()?.into_inner())
    })
    .await
    {
        Ok(Ok(zip)) => zip,
        Ok(Err(error)) => {
            eprintln!("[cfdi] archive ZIP creation failed: {error:#}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Err(error) => {
            eprintln!("[cfdi] archive task failed: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/zip"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=cfdis-seleccionados.zip",
            ),
        ],
        Body::from(zip),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/api/admin/cfdis/data",
    tag = "cfdi",
    responses(
        (status = 200, description = "CFDI list for the dashboard"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden")
    ),
    security(("session" = []))
)]
pub async fn cfdis_data_api(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<CfdiDataResponse>, StatusCode> {
    if !session_user.is_admin() {
        return Err(StatusCode::FORBIDDEN);
    }
    let active_company = session_user.active_company_id();

    // Get known RFCs for this company from SAT configs
    let sat_configs = list_sat_configs(&state, &active_company)
        .await
        .unwrap_or_default();
    let company_rfcs: HashSet<String> = sat_configs
        .into_iter()
        .map(|c| c.rfc.to_uppercase())
        .collect();
    let company_rfcs_vec: Vec<String> = company_rfcs.iter().cloned().collect();
    let transaction_docs: Vec<bson::Document> = state
        .transactions
        .clone_with_type::<bson::Document>()
        .find(bson::doc! {
            "company_id": &active_company,
            "cfdi_uuid": { "$type": "string" },
        })
        .projection(bson::doc! { "cfdi_uuid": 1 })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .try_collect()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let transaction_uuids: HashSet<String> = transaction_docs
        .into_iter()
        .filter_map(|doc| doc.get_str("cfdi_uuid").ok().map(str::to_string))
        .collect();

    let filter = bson::doc! { "company_id": active_company.to_hex() };
    let opts = mongodb::options::FindOptions::builder()
        .sort(bson::doc! { "comprobante.fecha": -1 })
        .limit(API_LIMIT)
        .build();

    let mut cursor = state
        .cfdis
        .find(filter)
        .with_options(opts)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut items: Vec<CfdiApiItem> = Vec::new();

    while let Some(doc) = cursor
        .try_next()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let (folio, tipo, fecha, subtotal, iva, total, moneda, forma_pago, metodo_pago, concepto) =
            if let Ok(comp) = doc.get_document("comprobante") {
                let folio = str_field(comp, "folio");
                let tipo = str_field(comp, "tipoDeComprobante");
                let fecha = str_field(comp, "fecha");
                let subtotal = parse_f64(comp.get_str("subTotal").unwrap_or("0"));
                let total = parse_f64(comp.get_str("total").unwrap_or("0"));
                let moneda = str_field(comp, "moneda");
                let forma_pago = str_field(comp, "formaPago");
                let metodo_pago = str_field(comp, "metodoPago");

                let iva = doc
                    .get_document("impuestos")
                    .ok()
                    .and_then(|imp| imp.get_str("totalImpuestosTrasladados").ok())
                    .map(parse_f64)
                    .unwrap_or(0.0);

                let concepto = doc
                    .get_array("conceptos")
                    .ok()
                    .and_then(|arr| arr.first())
                    .and_then(|v| v.as_document())
                    .and_then(|d| d.get_str("descripcion").ok())
                    .unwrap_or("")
                    .to_string();

                (
                    folio,
                    tipo,
                    fecha,
                    subtotal,
                    iva,
                    total,
                    moneda,
                    forma_pago,
                    metodo_pago,
                    concepto,
                )
            } else {
                Default::default()
            };

        let emisor_rfc = nested_str(&doc, "emisor", "rfc");
        let emisor_nombre = nested_str(&doc, "emisor", "nombre");
        let receptor_rfc = nested_str(&doc, "receptor", "rfc");
        let receptor_nombre = nested_str(&doc, "receptor", "nombre");

        // Determine direction: company is emisor → issued (income-side), else received (expense-side)
        let es_emitido = if company_rfcs.is_empty() {
            // No SAT config: fall back to tipo heuristic
            tipo == "I" || tipo == "N"
        } else {
            company_rfcs.contains(&emisor_rfc.to_uppercase())
        };

        let uuid = str_field(&doc, "uuid");
        items.push(CfdiApiItem {
            has_transaction: transaction_uuids.contains(&uuid),
            uuid,
            folio,
            tipo,
            fecha,
            subtotal,
            iva,
            total,
            moneda,
            forma_pago,
            metodo_pago,
            emisor_rfc,
            emisor_nombre,
            receptor_rfc,
            receptor_nombre,
            concepto,
            estatus: cfdi_estatus(&doc),
            es_emitido,
        });
    }

    Ok(Json(CfdiDataResponse {
        company_rfcs: company_rfcs_vec,
        items,
    }))
}

#[utoipa::path(
    get,
    path = "/api/admin/cfdis/{uuid}",
    tag = "cfdi",
    params(("uuid" = String, Path, description = "CFDI UUID")),
    responses(
        (status = 200, description = "CFDI detail"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "Not found")
    ),
    security(("session" = []))
)]
pub async fn cfdi_data_api(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<CfdiDetailResponse>, StatusCode> {
    if !session_user.is_admin() {
        return Err(StatusCode::FORBIDDEN);
    }
    let active_company = session_user.active_company_id();
    let sat_configs = list_sat_configs(&state, &active_company)
        .await
        .unwrap_or_default();
    let company_rfcs: HashSet<String> = sat_configs
        .into_iter()
        .map(|c| c.rfc.to_uppercase())
        .collect();

    let doc = state
        .cfdis
        .find_one(bson::doc! {
            "company_id": active_company.to_hex(),
            "uuid": uuid.trim(),
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(cfdi_detail_response(
        &doc,
        active_company.to_hex(),
        &company_rfcs,
    )))
}

fn cfdi_detail_response(
    doc: &bson::Document,
    company_id: String,
    company_rfcs: &HashSet<String>,
) -> CfdiDetailResponse {
    let comp = doc.get_document("comprobante").ok();
    let impuestos = doc.get_document("impuestos").ok();
    let tipo = comp
        .map(|comp| str_field(comp, "tipoDeComprobante"))
        .unwrap_or_default();
    let emisor_rfc = nested_str(doc, "emisor", "rfc");
    let es_emitido = if company_rfcs.is_empty() {
        tipo == "I" || tipo == "N"
    } else {
        company_rfcs.contains(&emisor_rfc.to_uppercase())
    };
    let conceptos = doc
        .get_array("conceptos")
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_document())
        .map(|concepto| CfdiConceptData {
            descripcion: str_field(concepto, "descripcion"),
            cantidad: str_field(concepto, "cantidad"),
            valor_unitario: str_field(concepto, "valorUnitario"),
            importe: str_field(concepto, "importe"),
        })
        .collect();

    CfdiDetailResponse {
        uuid: str_field(doc, "uuid"),
        company_id,
        folio: comp
            .map(|comp| str_field(comp, "folio"))
            .unwrap_or_default(),
        serie: comp
            .map(|comp| str_field(comp, "serie"))
            .unwrap_or_default(),
        tipo,
        fecha: comp
            .map(|comp| str_field(comp, "fecha"))
            .unwrap_or_default(),
        subtotal: comp
            .and_then(|comp| comp.get_str("subTotal").ok())
            .map(parse_f64)
            .unwrap_or(0.0),
        iva: impuestos
            .and_then(|imp| imp.get_str("totalImpuestosTrasladados").ok())
            .map(parse_f64)
            .unwrap_or(0.0),
        total: comp
            .and_then(|comp| comp.get_str("total").ok())
            .map(parse_f64)
            .unwrap_or(0.0),
        moneda: comp
            .map(|comp| str_field(comp, "moneda"))
            .unwrap_or_default(),
        forma_pago: comp
            .map(|comp| str_field(comp, "formaPago"))
            .unwrap_or_default(),
        metodo_pago: comp
            .map(|comp| str_field(comp, "metodoPago"))
            .unwrap_or_default(),
        uso_cfdi: nested_str(doc, "receptor", "usoCFDI"),
        emisor_rfc,
        emisor_nombre: nested_str(doc, "emisor", "nombre"),
        receptor_rfc: nested_str(doc, "receptor", "rfc"),
        receptor_nombre: nested_str(doc, "receptor", "nombre"),
        conceptos,
        estatus: cfdi_estatus(doc),
        es_emitido,
    }
}

#[derive(Serialize)]
pub struct CfdiEstatusResponse {
    /// "vigente" | "cancelado" | "no_encontrado"
    pub estatus: String,
    pub es_cancelable: Option<String>,
    pub estatus_cancelacion: Option<String>,
    pub codigo: Option<String>,
}

/// Live SAT status check for one CFDI (`POST /api/admin/cfdis/{uuid}/check-status`).
/// Queries the public ConsultaCFDIService with the CFDI's RFCs + total + UUID,
/// and persists a definitive `vigente`/`cancelado` result back onto the document
/// (a `no_encontrado` is returned but not stored, so it can't clobber a known
/// state with noise).
#[utoipa::path(
    post,
    path = "/api/admin/cfdis/{uuid}/check-status",
    tag = "cfdi",
    params(("uuid" = String, Path, description = "CFDI UUID")),
    responses(
        (status = 200, description = "SAT status"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "Not found"),
        (status = 502, description = "SAT service unavailable")
    ),
    security(("session" = []))
)]
pub async fn cfdi_check_status_api(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<CfdiEstatusResponse>, StatusCode> {
    if !session_user.is_admin() {
        return Err(StatusCode::FORBIDDEN);
    }
    let active_company = session_user.active_company_id();

    let doc = state
        .cfdis
        .find_one(bson::doc! {
            "company_id": active_company.to_hex(),
            "uuid": uuid.trim(),
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let emisor_rfc = nested_str(&doc, "emisor", "rfc");
    let receptor_rfc = nested_str(&doc, "receptor", "rfc");
    let total = doc
        .get_document("comprobante")
        .ok()
        .and_then(|c| c.get_str("total").ok())
        .unwrap_or("")
        .to_string();
    let uuid_val = str_field(&doc, "uuid");

    let result =
        crate::sat_consulta::consulta_estatus(&emisor_rfc, &receptor_rfc, &total, &uuid_val)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if result.estado == "vigente" || result.estado == "cancelado" {
        let _ = state
            .cfdis
            .update_one(
                bson::doc! { "company_id": active_company.to_hex(), "uuid": &uuid_val },
                bson::doc! { "$set": { "estatus": &result.estado } },
            )
            .await;
    }

    Ok(Json(CfdiEstatusResponse {
        estatus: result.estado,
        es_cancelable: result.es_cancelable,
        estatus_cancelacion: result.estatus_cancelacion,
        codigo: result.codigo,
    }))
}
