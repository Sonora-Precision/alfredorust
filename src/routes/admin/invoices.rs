//! Invoice register JSON API (cuentas por cobrar). Daniel, 2026-11-19: every invoice we
//! issue with its payments (REP) and files, the share still owed (100% = nothing paid,
//! 0% = settled), and the totals to know what is billed, paid and left to collect.
//!
//! Admin only: it is money.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    invoices::local_ms,
    models::{Invoice, InvoiceStatus},
    session::SessionUser,
    state::{
        AppState, ManualPayment, UploadedFile, add_invoice_file, add_manual_payment, delete_manual_payment,
        get_company_by_id, get_invoice, get_project_by_id_for_company, import_files, list_invoices, list_sat_configs,
        read_invoice_file, replace_invoice,
    },
};

const DAY_MS: i64 = 86_400_000;

#[derive(Serialize)]
pub struct InvoiceRow {
    pub id: String,
    pub uuid: String,
    pub serie: String,
    pub folio: String,
    pub issued_at: String,
    pub due_on: Option<String>,
    pub customer_name: String,
    pub customer_rfc: String,
    pub currency: String,
    pub subtotal: f64,
    pub tax: f64,
    pub withholding: f64,
    /// What the customer owes: subtotal + VAT − withholdings.
    pub total: f64,
    pub paid: f64,
    pub balance: f64,
    /// Share still owed: 100 = nothing paid, 0 = settled.
    pub pending_pct: f64,
    /// "pendiente", "parcial", "pagada", "cancelada" or "sustituida".
    pub state: &'static str,
    /// "PPD" or "PUE".
    pub payment_method: String,
    /// Days since it was issued, while something is owed.
    pub days_open: i64,
    /// Past its due date with a balance (only when a due date is set).
    pub overdue: bool,
    pub payments_count: usize,
    pub files_count: usize,
    /// Money received that has no REP yet (PPD): ask the accountant for it.
    pub missing_rep: bool,
    pub purchase_order: Option<String>,
    pub project_id: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize)]
pub struct PaymentData {
    pub id: String,
    pub paid_on: String,
    pub amount: f64,
    pub currency: String,
    pub exchange_rate: f64,
    /// Off the invoice, in the invoice currency.
    pub applied: f64,
    /// "rep", "nota_credito" or "manual".
    pub source: String,
    pub cfdi_uuid: Option<String>,
    pub installment: Option<i32>,
    /// Balance the REP states; compare with ours.
    pub balance_after: Option<f64>,
    pub note: Option<String>,
}

#[derive(Serialize)]
pub struct FileData {
    pub id: String,
    pub kind: String,
    pub filename: String,
    pub size_bytes: i64,
    pub uploaded_at: String,
    pub cfdi_uuid: Option<String>,
    pub url: String,
}

#[derive(Serialize)]
pub struct LineData {
    pub description: String,
    pub quantity: f64,
    pub unit_value: f64,
    pub amount: f64,
}

#[derive(Serialize)]
pub struct InvoiceDetail {
    #[serde(flatten)]
    pub row: InvoiceRow,
    pub lines: Vec<LineData>,
    pub payments: Vec<PaymentData>,
    pub files: Vec<FileData>,
    pub replaced_by: Option<String>,
}

fn state_of(inv: &Invoice) -> &'static str {
    match inv.status {
        InvoiceStatus::Cancelled => "cancelada",
        InvoiceStatus::Replaced => "sustituida",
        InvoiceStatus::Active => {
            if inv.balance() <= 0.0 {
                "pagada"
            } else if inv.settled() > 0.0 {
                "parcial"
            } else {
                "pendiente"
            }
        }
    }
}

fn row_of(inv: &Invoice, now_ms: i64) -> Option<InvoiceRow> {
    let balance = inv.balance();
    let open = inv.status == InvoiceStatus::Active && balance > 0.0;
    Some(InvoiceRow {
        id: inv.id?.to_hex(),
        uuid: inv.uuid.clone(),
        serie: inv.serie.clone(),
        folio: inv.folio.clone(),
        issued_at: iso(inv.issued_at),
        due_on: inv.due_on.map(iso),
        customer_name: inv.customer_name.clone(),
        customer_rfc: inv.customer_rfc.clone(),
        currency: inv.currency.clone(),
        subtotal: inv.subtotal,
        tax: inv.tax,
        withholding: inv.withholding,
        total: inv.total,
        paid: inv.settled(),
        balance,
        pending_pct: inv.pending_pct(),
        state: state_of(inv),
        payment_method: inv.payment_method.clone(),
        days_open: if open { ((now_ms - inv.issued_at.timestamp_millis()) / DAY_MS).max(0) } else { 0 },
        overdue: open && inv.due_on.is_some_and(|d| d.timestamp_millis() + DAY_MS < now_ms),
        payments_count: inv.payments.len(),
        files_count: inv.files.len(),
        missing_rep: inv.status == InvoiceStatus::Active
            && inv.payment_method == "PPD"
            && inv.payments.iter().any(|p| p.source == "manual"),
        purchase_order: inv.purchase_order.clone(),
        project_id: inv.project_id.map(|p| p.to_hex()),
        notes: inv.notes.clone(),
    })
}

fn detail_of(inv: &Invoice) -> Option<InvoiceDetail> {
    let row = row_of(inv, DateTime::now().timestamp_millis())?;
    let id = inv.id?.to_hex();
    let mut payments: Vec<_> = inv
        .payments
        .iter()
        .map(|p| PaymentData {
            id: p.id.to_hex(),
            paid_on: iso(p.paid_on),
            amount: p.amount,
            currency: p.currency.clone(),
            exchange_rate: p.exchange_rate,
            applied: p.applied,
            source: p.source.clone(),
            cfdi_uuid: p.cfdi_uuid.clone(),
            installment: p.installment,
            balance_after: p.balance_after,
            note: p.note.clone(),
        })
        .collect();
    payments.sort_by(|a, b| a.paid_on.cmp(&b.paid_on));
    Some(InvoiceDetail {
        row,
        lines: inv
            .lines
            .iter()
            .map(|l| LineData {
                description: l.description.clone(),
                quantity: l.quantity,
                unit_value: l.unit_value,
                amount: l.amount,
            })
            .collect(),
        payments,
        files: inv
            .files
            .iter()
            .map(|f| FileData {
                id: f.id.to_hex(),
                kind: f.kind.clone(),
                filename: f.filename.clone(),
                size_bytes: f.size_bytes,
                uploaded_at: iso(f.uploaded_at),
                cfdi_uuid: f.cfdi_uuid.clone(),
                url: format!("/api/admin/invoices/{id}/files/{}", f.id.to_hex()),
            })
            .collect(),
        replaced_by: inv.replaced_by.clone(),
    })
}

fn detail_response(inv: &Invoice) -> Response {
    match detail_of(inv) {
        Some(d) => Json(d).into_response(),
        None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "invoice missing id"),
    }
}

#[derive(Deserialize)]
pub struct InvoiceQuery {
    /// Text in the customer, folio, UUID or purchase order.
    pub q: Option<String>,
    /// "pendiente", "parcial", "pagada", "cancelada", "sustituida" or "abiertas" (pending + partial).
    pub state: Option<String>,
    pub currency: Option<String>,
    /// Issued from / until (YYYY-MM-DD).
    pub from: Option<String>,
    pub to: Option<String>,
}

fn day_start_ms(s: &str) -> Option<i64> {
    local_ms(&format!("{}T00:00:00", s.trim())).ok()
}

pub async fn api_invoices(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(q): Query<InvoiceQuery>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let Ok(invoices) = list_invoices(&state, &company_id).await else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list invoices");
    };
    let now_ms = DateTime::now().timestamp_millis();
    let text = q.q.as_deref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    let from = q.from.as_deref().and_then(day_start_ms);
    let to = q.to.as_deref().and_then(day_start_ms).map(|t| t + DAY_MS);
    let items: Vec<InvoiceRow> = invoices
        .iter()
        .filter(|i| {
            let t = i.issued_at.timestamp_millis();
            from.is_none_or(|f| t >= f)
                && to.is_none_or(|e| t < e)
                && q.currency.as_deref().is_none_or(|c| c.is_empty() || i.currency == c)
                && text.as_ref().is_none_or(|s| {
                    i.customer_name.to_lowercase().contains(s)
                        || i.folio.to_lowercase().contains(s)
                        || i.uuid.contains(s)
                        || i.purchase_order.as_deref().is_some_and(|p| p.to_lowercase().contains(s))
                })
        })
        .filter_map(|i| row_of(i, now_ms))
        .filter(|r| match q.state.as_deref() {
            None | Some("") | Some("todas") => true,
            Some("abiertas") => r.state == "pendiente" || r.state == "parcial",
            Some(s) => r.state == s,
        })
        .collect();
    Json(serde_json::json!({ "total": items.len(), "items": items })).into_response()
}

pub async fn api_invoice(
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
    match get_invoice(&state, &company_id, &id).await {
        Ok(Some(inv)) => detail_response(&inv),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "invoice not found"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load invoice"),
    }
}

// ── Summary ───────────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
struct CurrencyTotals {
    currency: String,
    /// Billed (cancelled and replaced invoices left out).
    billed: f64,
    paid: f64,
    balance: f64,
    invoices: usize,
    open_invoices: usize,
}

#[derive(Serialize, Default)]
struct MonthTotals {
    /// "2026-11"
    month: String,
    currency: String,
    billed: f64,
    collected: f64,
    invoices: usize,
}

#[derive(Serialize, Default)]
struct AgingBucket {
    bucket: &'static str,
    currency: String,
    balance: f64,
    invoices: usize,
}

#[derive(Serialize, Default)]
struct CustomerTotals {
    customer_name: String,
    currency: String,
    billed: f64,
    paid: f64,
    balance: f64,
    open_invoices: usize,
}

fn month_of(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms - 7 * 3_600_000)
        .map(|d| d.format("%Y-%m").to_string())
        .unwrap_or_default()
}

fn bucket_of(days: i64) -> &'static str {
    match days {
        ..=30 => "0-30",
        31..=60 => "31-60",
        61..=90 => "61-90",
        _ => "90+",
    }
}

/// Billed, collected and owed: by currency, by month, by age and by customer.
pub async fn api_invoices_summary(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let Ok(invoices) = list_invoices(&state, &company_id).await else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list invoices");
    };
    let now_ms = DateTime::now().timestamp_millis();
    let mut totals: BTreeMap<String, CurrencyTotals> = BTreeMap::new();
    let mut months: BTreeMap<(String, String), MonthTotals> = BTreeMap::new();
    let mut aging: BTreeMap<(String, &'static str), AgingBucket> = BTreeMap::new();
    let mut customers: BTreeMap<(String, String), CustomerTotals> = BTreeMap::new();

    for inv in invoices.iter().filter(|i| i.status == InvoiceStatus::Active) {
        let balance = inv.balance();
        let paid = inv.total - balance;
        let t = totals.entry(inv.currency.clone()).or_insert_with(|| CurrencyTotals {
            currency: inv.currency.clone(),
            ..Default::default()
        });
        t.billed += inv.total;
        t.paid += paid;
        t.balance += balance;
        t.invoices += 1;
        if balance > 0.0 {
            t.open_invoices += 1;
        }
        let m = months
            .entry((month_of(inv.issued_at.timestamp_millis()), inv.currency.clone()))
            .or_default();
        m.month = month_of(inv.issued_at.timestamp_millis());
        m.currency = inv.currency.clone();
        m.billed += inv.total;
        m.invoices += 1;
        for p in &inv.payments {
            let month = month_of(p.paid_on.timestamp_millis());
            let m = months.entry((month.clone(), inv.currency.clone())).or_default();
            m.month = month;
            m.currency = inv.currency.clone();
            m.collected += p.applied;
        }
        if balance > 0.0 {
            // Age from the due date when there is one, else from the issue date.
            let from = inv.due_on.unwrap_or(inv.issued_at).timestamp_millis();
            let bucket = bucket_of(((now_ms - from) / DAY_MS).max(0));
            let a = aging.entry((inv.currency.clone(), bucket)).or_insert_with(|| AgingBucket {
                bucket,
                currency: inv.currency.clone(),
                ..Default::default()
            });
            a.balance += balance;
            a.invoices += 1;
        }
        let c = customers
            .entry((inv.customer_name.clone(), inv.currency.clone()))
            .or_insert_with(|| CustomerTotals {
                customer_name: inv.customer_name.clone(),
                currency: inv.currency.clone(),
                ..Default::default()
            });
        c.billed += inv.total;
        c.paid += paid;
        c.balance += balance;
        if balance > 0.0 {
            c.open_invoices += 1;
        }
    }
    let round = |v: f64| (v * 100.0).round() / 100.0;
    let mut customers: Vec<_> = customers.into_values().collect();
    customers.sort_by(|a, b| b.balance.total_cmp(&a.balance));
    let months: Vec<_> = months
        .into_values()
        .map(|mut m| {
            m.billed = round(m.billed);
            m.collected = round(m.collected);
            m
        })
        .collect();
    Json(serde_json::json!({
        "totals": totals.into_values().map(|mut t| { t.billed = round(t.billed); t.paid = round(t.paid); t.balance = round(t.balance); t }).collect::<Vec<_>>(),
        "by_month": months,
        "aging": aging.into_values().map(|mut a| { a.balance = round(a.balance); a }).collect::<Vec<_>>(),
        "by_customer": customers.into_iter().map(|mut c| { c.billed = round(c.billed); c.paid = round(c.paid); c.balance = round(c.balance); c }).collect::<Vec<_>>(),
        // Invoices with money received and no REP yet.
        "missing_rep": invoices.iter().filter(|i| i.status == InvoiceStatus::Active && i.payment_method == "PPD" && i.payments.iter().any(|p| p.source == "manual")).count(),
    }))
    .into_response()
}

// ── Import ────────────────────────────────────────────────────────────────

async fn company_rfcs(state: &AppState, session_user: &SessionUser) -> Result<Vec<String>, Response> {
    let company_id = require_active_company(session_user);
    list_sat_configs(state, &company_id)
        .await
        .map(|c| c.into_iter().map(|c| c.rfc).collect())
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not read the SAT configuration"))
}

/// Loads XML, PDF or ZIP files (multipart field `files`): invoices, REPs, credit notes and
/// the PDFs named after their UUID. Safe to repeat; the order of the files does not matter.
pub async fn api_invoices_import(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let rfcs = match company_rfcs(&state, &session_user).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    if rfcs.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "configura primero el RFC de la empresa (SAT)");
    }
    let mut files: Vec<UploadedFile> = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.file_name().unwrap_or("archivo").to_string();
        match field.bytes().await {
            Ok(bytes) => files.push((name, bytes.to_vec())),
            Err(_) => return json_error(StatusCode::PAYLOAD_TOO_LARGE, "un archivo excede el tamaño máximo"),
        }
    }
    if files.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "no se recibió ningún archivo");
    }
    match import_files(&state, &company_id, &rfcs, files).await {
        Ok(report) => Json(report).into_response(),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// Loads the invoices, REPs and credit notes the SAT download already archived, so the
/// register follows the automatic sync without uploading anything.
pub async fn api_invoices_sync_sat(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    use futures::stream::TryStreamExt;
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let rfcs = match company_rfcs(&state, &session_user).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Ok(Some(company)) = get_company_by_id(&state, &company_id).await else {
        return json_error(StatusCode::NOT_FOUND, "company not found");
    };
    let root = std::path::PathBuf::from(
        std::env::var("CFDI_STORE_DIR").unwrap_or_else(|_| "data/cfdi_store".to_string()),
    );
    let Ok(cursor) = state
        .cfdis
        .find(doc! {
            "company_id": company_id.to_hex(),
            "comprobante.tipoDeComprobante": { "$in": ["I", "P", "E"] },
        })
        .await
    else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not read the CFDIs");
    };
    let Ok(docs) = cursor.try_collect::<Vec<_>>().await else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not read the CFDIs");
    };
    let mut files: Vec<UploadedFile> = Vec::new();
    let mut missing = 0usize;
    for d in &docs {
        let emisor = d.get_document("emisor").ok().and_then(|e| e.get_str("rfc").ok()).unwrap_or("");
        if !rfcs.iter().any(|r| r.eq_ignore_ascii_case(emisor)) {
            continue;
        }
        let uuid = d.get_str("uuid").unwrap_or("").to_string();
        let found = super::cfdis::cfdi_archive_candidates(&root, &company.slug, &rfcs, d)
            .into_iter()
            .find(|p| p.is_file());
        match found.and_then(|p| std::fs::read(p).ok()) {
            Some(bytes) => files.push((format!("{uuid}.xml"), bytes)),
            None => missing += 1,
        }
    }
    // The SAT download only holds what is in force. An invoice of ours that falls inside the
    // dates it covers and is not among its CFDIs was probably cancelled or replaced.
    let covered = {
        let dates: Vec<String> = docs
            .iter()
            .filter_map(|d| d.get_document("comprobante").ok().and_then(|c| c.get_str("fecha").ok()).map(str::to_string))
            .collect();
        dates.iter().min().cloned().zip(dates.iter().max().cloned())
    };
    let in_sat: std::collections::HashSet<String> =
        docs.iter().filter_map(|d| d.get_str("uuid").ok()).map(str::to_lowercase).collect();
    match import_files(&state, &company_id, &rfcs, files).await {
        Ok(mut report) => {
            if missing > 0 {
                report.warnings.push(format!("{missing} CFDI no tienen su XML archivado en el servidor"));
            }
            if let (Some((from, to)), Ok(invoices)) = (covered, list_invoices(&state, &company_id).await) {
                let (from, to) = (local_ms(&from).unwrap_or(i64::MAX), local_ms(&to).unwrap_or(i64::MIN));
                for inv in invoices.iter().filter(|i| i.status == InvoiceStatus::Active) {
                    let at = inv.issued_at.timestamp_millis();
                    if at >= from && at <= to && !in_sat.contains(&inv.uuid) {
                        report.warnings.push(format!(
                            "Factura {} de {} ({:.2} {}): no aparece vigente en la descarga del SAT; ¿cancelada o sustituida?",
                            if inv.serie.is_empty() { inv.folio.clone() } else { format!("{} {}", inv.serie, inv.folio) },
                            inv.customer_name,
                            inv.total,
                            inv.currency
                        ));
                    }
                }
            }
            Json(report).into_response()
        }
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

// ── Edits ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PaymentBody {
    /// YYYY-MM-DD
    pub paid_on: String,
    pub amount: f64,
    pub currency: Option<String>,
    pub exchange_rate: Option<f64>,
    pub note: Option<String>,
}

/// Money received whose REP is not issued yet.
pub async fn api_invoice_payment_add(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PaymentBody>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Ok(paid_on_ms) = local_ms(&format!("{}T12:00:00", body.paid_on.trim())) else {
        return json_error(StatusCode::BAD_REQUEST, "fecha de pago inválida (AAAA-MM-DD)");
    };
    let Ok(Some(inv)) = get_invoice(&state, &company_id, &id).await else {
        return json_error(StatusCode::NOT_FOUND, "invoice not found");
    };
    let payment = ManualPayment {
        paid_on_ms,
        amount: body.amount,
        currency: body.currency.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| inv.currency.clone()),
        exchange_rate: body.exchange_rate,
        note: body.note,
    };
    match add_manual_payment(&state, &company_id, &id, payment).await {
        Ok(inv) => detail_response(&inv),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

pub async fn api_invoice_payment_delete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path((id, payment_id)): Path<(String, String)>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let (id, payment_id) = match (parse_oid(&id), parse_oid(&payment_id)) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(resp), _) | (_, Err(resp)) => return resp,
    };
    match delete_manual_payment(&state, &company_id, &id, &payment_id).await {
        Ok(inv) => detail_response(&inv),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// Fields the admin sets by hand. An empty string clears a text field.
#[derive(Deserialize)]
pub struct InvoiceUpdate {
    pub notes: Option<String>,
    pub purchase_order: Option<String>,
    /// YYYY-MM-DD; empty clears it.
    pub due_on: Option<String>,
    /// Project hex id; empty clears it.
    pub project_id: Option<String>,
    /// "active" or "cancelled" (the SAT status the XML cannot tell).
    pub status: Option<String>,
}

fn clean(s: Option<String>) -> Option<Option<String>> {
    s.map(|v| {
        let v = v.trim().to_string();
        if v.is_empty() { None } else { Some(v) }
    })
}

pub async fn api_invoice_update(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<InvoiceUpdate>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Ok(Some(mut inv)) = get_invoice(&state, &company_id, &id).await else {
        return json_error(StatusCode::NOT_FOUND, "invoice not found");
    };
    if let Some(v) = clean(body.notes) {
        inv.notes = v;
    }
    if let Some(v) = clean(body.purchase_order) {
        inv.purchase_order = v;
    }
    if let Some(v) = clean(body.due_on) {
        inv.due_on = match v {
            None => None,
            Some(d) => match local_ms(&format!("{d}T12:00:00")) {
                Ok(ms) => Some(DateTime::from_millis(ms)),
                Err(_) => return json_error(StatusCode::BAD_REQUEST, "fecha de vencimiento inválida (AAAA-MM-DD)"),
            },
        };
    }
    if let Some(v) = clean(body.project_id) {
        inv.project_id = match v {
            None => None,
            Some(p) => {
                let pid = match parse_oid(&p) {
                    Ok(pid) => pid,
                    Err(resp) => return resp,
                };
                if !matches!(get_project_by_id_for_company(&state, &pid, &company_id).await, Ok(Some(_))) {
                    return json_error(StatusCode::NOT_FOUND, "project not found");
                }
                Some(pid)
            }
        };
    }
    match body.status.as_deref() {
        None | Some("") => {}
        Some("active") if inv.status != InvoiceStatus::Replaced => inv.status = InvoiceStatus::Active,
        Some("cancelled") => inv.status = InvoiceStatus::Cancelled,
        Some(_) => return json_error(StatusCode::BAD_REQUEST, "estatus no válido"),
    }
    inv.updated_at = DateTime::now();
    if replace_invoice(&state, &inv).await.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the invoice");
    }
    detail_response(&inv)
}

// ── Files ─────────────────────────────────────────────────────────────────

/// Adds a PDF or XML to an invoice (multipart fields `kind` and `file`).
pub async fn api_invoice_file_add(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let mut kind = "otro".to_string();
    let mut upload = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        match field.name() {
            Some("kind") => {
                if let Ok(v) = field.text().await {
                    kind = v.trim().to_string();
                }
            }
            Some("file") => {
                let filename = field.file_name().unwrap_or("archivo").to_string();
                match field.bytes().await {
                    Ok(bytes) => upload = Some((filename, bytes)),
                    Err(_) => return json_error(StatusCode::PAYLOAD_TOO_LARGE, "el archivo excede el tamaño máximo (40 MB)"),
                }
            }
            _ => {}
        }
    }
    let Some((filename, bytes)) = upload else {
        return json_error(StatusCode::BAD_REQUEST, "falta el archivo");
    };
    match add_invoice_file(&state, &company_id, &id, &kind, &filename, &bytes).await {
        Ok(inv) => detail_response(&inv),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// The file itself: PDFs open in the browser, XML downloads.
pub async fn api_invoice_file_download(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path((id, file_id)): Path<(String, String)>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let (id, file_id): (ObjectId, ObjectId) = match (parse_oid(&id), parse_oid(&file_id)) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(resp), _) | (_, Err(resp)) => return resp,
    };
    let Ok(Some(inv)) = get_invoice(&state, &company_id, &id).await else {
        return json_error(StatusCode::NOT_FOUND, "invoice not found");
    };
    let Some(file) = inv.files.iter().find(|f| f.id == file_id) else {
        return json_error(StatusCode::NOT_FOUND, "file not found");
    };
    let Ok(bytes) = read_invoice_file(file).await else {
        return json_error(StatusCode::NOT_FOUND, "file missing on disk");
    };
    let pdf = file.kind.ends_with("_pdf") || file.kind == "otro";
    let safe: String = file
        .filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, if pdf { "application/pdf" } else { "application/xml" }.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("{}; filename=\"{safe}\"", if pdf { "inline" } else { "attachment" }),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        Body::from(bytes),
    )
        .into_response()
}
