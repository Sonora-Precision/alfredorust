//! Quotes JSON API (openspec add-quote-document): company data for quotes, quote values per
//! client, quotes of a project with their revisions, and "sent". Admin only: it is money.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{ClientPerson, ClientQuoteDefaults, ProjectStatus, Quote, QuoteItem, QuoteSettings},
    session::SessionUser,
    state::{
        AppState, folio, get_client_quote_defaults, get_quote, get_quote_settings, insert_quote, last_revision,
        list_client_quote_defaults, list_project_concepts, list_project_quotes, mark_quote_sent, next_folio_base,
        quote_totals, save_client_quote_defaults, save_quote_settings,
    },
};

fn text(v: Option<String>, max: usize) -> Option<String> {
    v.map(|s| s.trim().chars().take(max).collect::<String>()).filter(|s| !s.is_empty())
}

macro_rules! admin_company {
    ($user:expr) => {{
        if !$user.is_admin() {
            return StatusCode::FORBIDDEN.into_response();
        }
        require_active_company(&$user)
    }};
}

// --- company data ------------------------------------------------------------------

pub async fn api_quote_settings_show(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    let company_id = admin_company!(session_user);
    match get_quote_settings(&state, &company_id).await {
        Ok(s) => Json(s).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the settings"),
    }
}

pub async fn api_quote_settings_save(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(mut payload): Json<QuoteSettings>,
) -> Response {
    let company_id = admin_company!(session_user);
    if !(0.0..1.0).contains(&payload.iva_rate) || !(0.0..1.0).contains(&payload.retention_rate) {
        return json_error(StatusCode::BAD_REQUEST, "las tasas van como fracción: 0.16 y 0.0125");
    }
    if payload.logo_data_url.as_ref().is_some_and(|l| !l.starts_with("data:image/") || l.len() > 400_000) {
        return json_error(StatusCode::BAD_REQUEST, "el logo debe ser una imagen de menos de 300 KB");
    }
    payload.company_id = company_id;
    match save_quote_settings(&state, payload).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the settings"),
    }
}

// --- client values -----------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ClientDefaultsPayload {
    #[serde(default)]
    pub abbreviation: Option<String>,
    pub currency: String,
    pub language: String,
    pub iva: bool,
    pub retention: bool,
    pub validity_days: i32,
    pub advance_pct: f64,
    #[serde(default)]
    pub people: Vec<ClientPerson>,
}

fn valid_terms(currency: &str, language: &str, advance: f64, validity: i32) -> Result<(), Response> {
    if !matches!(currency, "MXN" | "USD") || !matches!(language, "es" | "en") {
        return Err(json_error(StatusCode::BAD_REQUEST, "moneda MXN o USD; idioma es o en"));
    }
    if !(0.0..=100.0).contains(&advance) || !(0..=365).contains(&validity) {
        return Err(json_error(StatusCode::BAD_REQUEST, "anticipo de 0 a 100 % y validez de 0 a 365 días"));
    }
    Ok(())
}

pub async fn api_client_quote_defaults_index(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    let company_id = admin_company!(session_user);
    match list_client_quote_defaults(&state, &company_id).await {
        Ok(list) => Json(list.into_iter().map(|d| serde_json::json!({
            "contact_id": d.contact_id.to_hex(),
            "abbreviation": d.abbreviation,
            "currency": d.currency,
            "language": d.language,
            "iva": d.iva,
            "retention": d.retention,
            "validity_days": d.validity_days,
            "advance_pct": d.advance_pct,
            "people": d.people,
        })).collect::<Vec<_>>())
        .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list the clients"),
    }
}

pub async fn api_client_quote_defaults_save(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(contact_id): Path<String>,
    Json(p): Json<ClientDefaultsPayload>,
) -> Response {
    let company_id = admin_company!(session_user);
    let contact_id = match parse_oid(&contact_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if let Err(resp) = valid_terms(&p.currency, &p.language, p.advance_pct, p.validity_days) {
        return resp;
    }
    match state.contacts.find_one(doc! { "_id": contact_id, "company_id": company_id }).await {
        Ok(Some(_)) => {}
        _ => return json_error(StatusCode::NOT_FOUND, "contact not found"),
    }
    let people = p
        .people
        .into_iter()
        .filter_map(|person| {
            Some(ClientPerson {
                name: text(Some(person.name), 80)?,
                initials: text(person.initials, 6),
                email: text(person.email, 120),
            })
        })
        .take(50)
        .collect();
    let defaults = ClientQuoteDefaults {
        id: None,
        company_id,
        contact_id,
        abbreviation: text(p.abbreviation, 20),
        currency: p.currency,
        language: p.language,
        iva: p.iva,
        retention: p.retention,
        validity_days: p.validity_days,
        advance_pct: p.advance_pct,
        people,
    };
    match save_client_quote_defaults(&state, defaults).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the client"),
    }
}

// --- quotes ------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
pub struct QuoteLinePayload {
    pub quantity: f64,
    pub description: String,
    pub unit_price: f64,
    #[serde(default)]
    pub concept_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct QuoteCreatePayload {
    /// Client; defaults to the project's contact.
    #[serde(default)]
    pub contact_id: Option<String>,
    #[serde(default)]
    pub attention: Option<String>,
    #[serde(default)]
    pub attention_initials: Option<String>,
    /// Folio base written by hand ("261103-01"); else the next of the day.
    #[serde(default)]
    pub folio_base: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub iva: Option<bool>,
    #[serde(default)]
    pub retention: Option<bool>,
    #[serde(default)]
    pub discount: Option<f64>,
    #[serde(default)]
    pub delivery_time: Option<i32>,
    #[serde(default)]
    pub delivery_unit: Option<String>,
    #[serde(default)]
    pub validity_days: Option<i32>,
    #[serde(default)]
    pub advance_pct: Option<f64>,
    #[serde(default)]
    pub notes: Vec<String>,
    /// Lines written by hand; else the parts with a quoted price.
    #[serde(default)]
    pub lines: Option<Vec<QuoteLinePayload>>,
}

#[derive(Serialize)]
pub struct QuoteData {
    pub id: String,
    pub project_id: String,
    pub folio: String,
    pub folio_base: String,
    pub revision: i32,
    pub date: String,
    pub client_name: String,
    pub contact_id: Option<String>,
    pub attention: Option<String>,
    pub attention_initials: Option<String>,
    pub client_abbreviation: Option<String>,
    pub currency: String,
    pub language: String,
    pub iva: bool,
    pub retention: bool,
    pub iva_rate: f64,
    pub retention_rate: f64,
    pub discount: f64,
    pub delivery_time: i32,
    pub delivery_unit: String,
    pub validity_days: i32,
    pub advance_pct: f64,
    pub remaining_pct: f64,
    pub notes: Vec<String>,
    pub lines: Vec<QuoteItem>,
    pub subtotal: f64,
    pub iva_amount: f64,
    pub retention_amount: f64,
    pub net: f64,
    pub sent_at: Option<String>,
    pub created_at: String,
}

async fn quote_data(state: &AppState, q: Quote) -> Option<QuoteData> {
    let t = quote_totals(&q);
    let abbreviation = match q.contact_id {
        Some(c) => get_client_quote_defaults(state, &q.company_id, &c).await.ok().flatten().and_then(|d| d.abbreviation),
        None => None,
    };
    Some(QuoteData {
        id: q.id?.to_hex(),
        project_id: q.project_id.to_hex(),
        folio: folio(&q.folio_base, q.revision),
        folio_base: q.folio_base,
        revision: q.revision,
        date: iso(q.date),
        client_name: q.client_name,
        contact_id: q.contact_id.map(|c| c.to_hex()),
        attention: q.attention,
        attention_initials: q.attention_initials,
        client_abbreviation: abbreviation,
        currency: q.currency,
        language: q.language,
        iva: q.iva,
        retention: q.retention,
        iva_rate: q.iva_rate,
        retention_rate: q.retention_rate,
        discount: q.discount,
        delivery_time: q.delivery_time,
        delivery_unit: q.delivery_unit,
        validity_days: q.validity_days,
        advance_pct: q.advance_pct,
        remaining_pct: t.remaining_pct,
        notes: q.notes,
        lines: q.lines,
        subtotal: t.subtotal,
        iva_amount: t.iva,
        retention_amount: t.retention,
        net: t.net,
        sent_at: q.sent_at.map(iso),
        created_at: iso(q.created_at),
    })
}

/// The parts of the project with a quoted price, in order, as quote lines.
async fn lines_from_parts(state: &AppState, company_id: &ObjectId, project_id: &ObjectId) -> anyhow::Result<Vec<QuoteItem>> {
    let mut parts = list_project_concepts(state, company_id, project_id).await?;
    parts.sort_by_key(|c| c.position);
    Ok(parts
        .into_iter()
        .filter(|c| c.unit_price.is_some_and(|p| p > 0.0))
        .enumerate()
        .map(|(i, c)| QuoteItem {
            item: i as i32 + 1,
            quantity: c.quantity,
            description: c.name,
            unit_price: c.unit_price.unwrap_or(0.0),
            concept_id: c.id,
        })
        .collect())
}

pub async fn api_project_quotes_index(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Response {
    let company_id = admin_company!(session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match list_project_quotes(&state, &company_id, &project_id).await {
        Ok(list) => {
            let mut out = Vec::new();
            for q in list {
                if let Some(d) = quote_data(&state, q).await {
                    out.push(d);
                }
            }
            Json(out).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list quotes"),
    }
}

pub async fn api_project_quote_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(p): Json<QuoteCreatePayload>,
) -> Response {
    let company_id = admin_company!(session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Ok(Some(project)) = state.projects.find_one(doc! { "_id": project_id, "company_id": company_id }).await else {
        return json_error(StatusCode::NOT_FOUND, "project not found");
    };
    let contact_id = match p.contact_id.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => match parse_oid(c) {
            Ok(c) => Some(c),
            Err(resp) => return resp,
        },
        None => project.contact_id,
    };
    let contact = match contact_id {
        Some(c) => state.contacts.find_one(doc! { "_id": c, "company_id": company_id }).await.ok().flatten(),
        None => None,
    };
    if contact_id.is_some() && contact.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "client not found");
    }
    let defaults = match contact_id {
        Some(c) => get_client_quote_defaults(&state, &company_id, &c).await.ok().flatten(),
        None => None,
    };
    let settings = match get_quote_settings(&state, &company_id).await {
        Ok(s) => s,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the settings"),
    };
    let now = DateTime::now();
    let currency = p.currency.or_else(|| defaults.as_ref().map(|d| d.currency.clone())).unwrap_or_else(|| "MXN".into());
    let language = p.language.or_else(|| defaults.as_ref().map(|d| d.language.clone())).unwrap_or_else(|| "es".into());
    let validity_days = p.validity_days.or(defaults.as_ref().map(|d| d.validity_days)).unwrap_or(15);
    let advance_pct = p.advance_pct.or(defaults.as_ref().map(|d| d.advance_pct)).unwrap_or(50.0);
    if let Err(resp) = valid_terms(&currency, &language, advance_pct, validity_days) {
        return resp;
    }
    let delivery_unit = p.delivery_unit.unwrap_or_else(|| "dias".into());
    if !matches!(delivery_unit.as_str(), "dias" | "semanas") {
        return json_error(StatusCode::BAD_REQUEST, "entrega en dias o semanas");
    }
    let discount = p.discount.unwrap_or(0.0);
    if !discount.is_finite() || discount < 0.0 {
        return json_error(StatusCode::BAD_REQUEST, "el descuento no puede ser negativo");
    }
    let lines = match p.lines {
        Some(lines) => {
            let mut out = Vec::new();
            for (i, l) in lines.into_iter().take(200).enumerate() {
                if !l.quantity.is_finite() || l.quantity <= 0.0 || !l.unit_price.is_finite() || l.unit_price < 0.0 {
                    return json_error(StatusCode::BAD_REQUEST, "cada partida necesita cantidad mayor a 0 y precio");
                }
                out.push(QuoteItem {
                    item: i as i32 + 1,
                    quantity: l.quantity,
                    description: l.description.trim().chars().take(300).collect(),
                    unit_price: l.unit_price,
                    concept_id: l.concept_id.as_deref().and_then(|c| ObjectId::parse_str(c).ok()),
                });
            }
            out
        }
        None => match lines_from_parts(&state, &company_id, &project_id).await {
            Ok(l) => l,
            Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the parts"),
        },
    };
    if lines.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "ninguna parte tiene precio cotizado; ponlo en el Cotizador");
    }
    let folio_base = match text(p.folio_base, 20) {
        Some(b) => b,
        None => match next_folio_base(&state, &company_id, now).await {
            Ok(b) => b,
            Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not number the quote"),
        },
    };
    let quote = Quote {
        id: None,
        company_id,
        project_id,
        contact_id,
        client_name: contact.map(|c| c.name).unwrap_or_else(|| project.title.clone()),
        attention: text(p.attention, 80),
        attention_initials: text(p.attention_initials, 6),
        folio_base,
        revision: 0,
        date: now,
        currency,
        language,
        iva: p.iva.or(defaults.as_ref().map(|d| d.iva)).unwrap_or(true),
        retention: p.retention.or(defaults.as_ref().map(|d| d.retention)).unwrap_or(true),
        iva_rate: settings.iva_rate,
        retention_rate: settings.retention_rate,
        discount,
        delivery_time: p.delivery_time.unwrap_or(10).clamp(0, 999),
        delivery_unit,
        validity_days,
        advance_pct,
        notes: p.notes.into_iter().filter_map(|n| text(Some(n), 300)).take(3).collect(),
        lines,
        sent_at: None,
        created_by: *session_user.user_id(),
        created_at: now,
    };
    match insert_quote(&state, quote).await {
        Ok(q) => match quote_data(&state, q).await {
            Some(d) => (StatusCode::CREATED, Json(d)).into_response(),
            None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "quote missing id"),
        },
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the quote"),
    }
}

async fn load_quote(session_user: &SessionUser, state: &AppState, id: &str) -> Result<(ObjectId, Quote), Response> {
    if !session_user.is_admin() {
        return Err(StatusCode::FORBIDDEN.into_response());
    }
    let company_id = require_active_company(session_user);
    let id = parse_oid(id)?;
    match get_quote(state, &company_id, &id).await {
        Ok(Some(q)) => Ok((company_id, q)),
        Ok(None) => Err(json_error(StatusCode::NOT_FOUND, "quote not found")),
        Err(_) => Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the quote")),
    }
}

#[derive(Serialize)]
pub struct QuoteDocumentData {
    #[serde(flatten)]
    pub quote: QuoteData,
    pub company: QuoteSettings,
}

/// One quote with its totals and the company data, to print.
pub async fn api_quote_show(session_user: SessionUser, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let (company_id, q) = match load_quote(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Ok(company) = get_quote_settings(&state, &company_id).await else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the settings");
    };
    match quote_data(&state, q).await {
        Some(quote) => Json(QuoteDocumentData { quote, company }).into_response(),
        None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "quote missing id"),
    }
}

/// "Nueva revisión": same folio base, next revision, same terms, current part prices.
pub async fn api_quote_revise(session_user: SessionUser, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let (company_id, q) = match load_quote(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let revision = match last_revision(&state, &company_id, &q.folio_base).await {
        Ok(r) => r + 1,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not number the revision"),
    };
    // Lines that came from parts take the part's current price; hand-written ones stay.
    let parts = lines_from_parts(&state, &company_id, &q.project_id).await.unwrap_or_default();
    let lines: Vec<QuoteItem> = if q.lines.iter().all(|l| l.concept_id.is_some()) && !parts.is_empty() {
        parts
    } else {
        q.lines.clone()
    };
    let now = DateTime::now();
    let next = Quote { id: None, revision, date: now, lines, sent_at: None, created_by: *session_user.user_id(), created_at: now, ..q };
    match insert_quote(&state, next).await {
        Ok(q) => match quote_data(&state, q).await {
            Some(d) => (StatusCode::CREATED, Json(d)).into_response(),
            None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "quote missing id"),
        },
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the revision"),
    }
}

/// "Marcar como enviada": records the date and moves the project to Cotizado if it was still
/// in Pedidos or Análisis.
pub async fn api_quote_sent(session_user: SessionUser, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let (company_id, q) = match load_quote(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if mark_quote_sent(&state, &company_id, &q.id.unwrap_or_default()).await.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not mark the quote");
    }
    let early = [ProjectStatus::Pedidos.as_str(), ProjectStatus::Analisis.as_str()];
    let _ = state
        .projects
        .update_one(
            doc! { "_id": q.project_id, "company_id": company_id, "status": { "$in": early.to_vec() } },
            doc! { "$set": { "status": ProjectStatus::Cotizado.as_str(), "updated_at": DateTime::now() } },
        )
        .await;
    Json(serde_json::json!({ "ok": true })).into_response()
}
