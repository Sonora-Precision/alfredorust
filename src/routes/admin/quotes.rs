//! Quotes JSON API (openspec add-quote-document): company data for quotes, quote values per
//! client, quotes of a project with their revisions, and "sent". Admin only: it is money.

use std::collections::HashMap;
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
    models::{
        ClientPerson, ClientQuoteDefaults, PartMaterial, PartQuote, Project, ProjectPriority, ProjectStatus, Quote, QuoteItem,
        QuoteSettings,
    },
    session::SessionUser,
    state::{
        AppState, create_project, create_project_concept, folio, folio_project, get_client_quote_defaults,
        get_initial_concept_status, get_project_by_id_for_company, get_quote, get_quote_settings, insert_quote,
        last_revision, link_folio_to_project, list_client_quote_defaults, list_material_prices, list_project_concepts,
        list_project_quotes, list_quotes, mark_quote_sent, next_folio_base, quote_totals, save_client_quote_defaults,
        save_quote_settings, set_concept_unit_price, set_part_material, set_part_quote, suggest_line,
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
//
// A quote is made before the project exists (Daniel, 2026-11-06): the client asks, Daniel
// quotes, and once the client approves (or sends the PO) the quote becomes the project with
// its parts and prices. Quotes made from a project (the old way) still work.

#[derive(Debug, Deserialize, Default)]
pub struct QuoteLinePayload {
    pub quantity: f64,
    pub description: String,
    pub unit_price: f64,
    #[serde(default)]
    pub concept_id: Option<String>,
    #[serde(default)]
    pub material: Option<PartMaterial>,
    #[serde(default)]
    pub weight_kg: Option<f64>,
    #[serde(default)]
    pub multiplier: Option<f64>,
}

#[derive(Debug, Deserialize, Default)]
pub struct QuoteCreatePayload {
    /// Client; defaults to the project's contact (or the revised quote's).
    #[serde(default)]
    pub contact_id: Option<String>,
    #[serde(default)]
    pub attention: Option<String>,
    #[serde(default)]
    pub attention_initials: Option<String>,
    /// Folio base written by hand ("261103-01"); else the next of the day.
    #[serde(default)]
    pub folio_base: Option<String>,
    /// A new revision of this quote: same folio base, next revision.
    #[serde(default)]
    pub revision_of: Option<String>,
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
    /// Lines written by hand; else (from a project) the parts with a quoted price.
    #[serde(default)]
    pub lines: Option<Vec<QuoteLinePayload>>,
}

#[derive(Serialize)]
pub struct QuoteData {
    pub id: String,
    /// The project the quote became (or was made from); None while it is not approved.
    pub project_id: Option<String>,
    pub project_title: Option<String>,
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
    let project_title = match q.project_id {
        Some(p) => get_project_by_id_for_company(state, &p, &q.company_id).await.ok().flatten().map(|p| p.title),
        None => None,
    };
    Some(QuoteData {
        id: q.id?.to_hex(),
        project_id: q.project_id.map(|p| p.to_hex()),
        project_title,
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

fn created(d: Option<QuoteData>) -> Response {
    match d {
        Some(d) => (StatusCode::CREATED, Json(d)).into_response(),
        None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "quote missing id"),
    }
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
            material: c.material,
            weight_kg: c.quote.as_ref().and_then(|q| q.weight_kg),
            multiplier: c.quote.as_ref().and_then(|q| q.multiplier),
        })
        .collect())
}

fn positive(v: Option<f64>) -> Result<Option<f64>, Response> {
    match v {
        Some(x) if !x.is_finite() || x <= 0.0 => Err(json_error(StatusCode::BAD_REQUEST, "peso y multiplicador deben ser mayores a 0")),
        other => Ok(other),
    }
}

fn clean_material(m: Option<PartMaterial>) -> Option<PartMaterial> {
    let mut m = m?;
    m.material = text(m.material, 60);
    m.shape = text(m.shape, 30);
    m.bar_to_order = text(m.bar_to_order, 80);
    m.notes = text(m.notes, 300);
    let dim = |v: Option<f64>| v.filter(|x| x.is_finite() && *x > 0.0);
    m.thickness = dim(m.thickness);
    m.width = dim(m.width);
    m.length = dim(m.length);
    (m != PartMaterial::default()).then_some(m)
}

fn lines_from_payload(lines: Vec<QuoteLinePayload>) -> Result<Vec<QuoteItem>, Response> {
    let mut out = Vec::new();
    for (i, l) in lines.into_iter().take(200).enumerate() {
        if !l.quantity.is_finite() || l.quantity <= 0.0 || !l.unit_price.is_finite() || l.unit_price < 0.0 {
            return Err(json_error(StatusCode::BAD_REQUEST, "cada partida necesita cantidad mayor a 0 y precio"));
        }
        let description: String = l.description.trim().chars().take(300).collect();
        if description.is_empty() {
            return Err(json_error(StatusCode::BAD_REQUEST, "cada partida necesita su número de parte o descripción"));
        }
        out.push(QuoteItem {
            item: i as i32 + 1,
            quantity: l.quantity,
            description,
            unit_price: l.unit_price,
            concept_id: l.concept_id.as_deref().and_then(|c| ObjectId::parse_str(c).ok()),
            material: clean_material(l.material),
            weight_kg: positive(l.weight_kg)?,
            multiplier: positive(l.multiplier)?,
        });
    }
    Ok(out)
}

/// One quote from the form: client values as defaults, the folio of the day (or the next
/// revision of `revision_of`), and the lines given or (from a project) its priced parts.
async fn build_quote(
    state: &AppState,
    session_user: &SessionUser,
    company_id: ObjectId,
    project: Option<&Project>,
    p: QuoteCreatePayload,
) -> Result<Quote, Response> {
    let previous = match p.revision_of.as_deref().filter(|r| !r.is_empty()) {
        Some(r) => {
            let r = parse_oid(r)?;
            match get_quote(state, &company_id, &r).await {
                Ok(Some(q)) => Some(q),
                Ok(None) => return Err(json_error(StatusCode::NOT_FOUND, "quote not found")),
                Err(_) => return Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the quote")),
            }
        }
        None => None,
    };
    let contact_id = match p.contact_id.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => Some(parse_oid(c)?),
        None => project.and_then(|p| p.contact_id).or(previous.as_ref().and_then(|q| q.contact_id)),
    };
    let contact = match contact_id {
        Some(c) => state.contacts.find_one(doc! { "_id": c, "company_id": company_id }).await.ok().flatten(),
        None => None,
    };
    if contact_id.is_some() && contact.is_none() {
        return Err(json_error(StatusCode::BAD_REQUEST, "client not found"));
    }
    if project.is_none() && contact.is_none() {
        return Err(json_error(StatusCode::BAD_REQUEST, "escoge el cliente"));
    }
    let defaults = match contact_id {
        Some(c) => get_client_quote_defaults(state, &company_id, &c).await.ok().flatten(),
        None => None,
    };
    let settings = get_quote_settings(state, &company_id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the settings"))?;
    let now = DateTime::now();
    let currency = p.currency.or_else(|| defaults.as_ref().map(|d| d.currency.clone())).unwrap_or_else(|| "MXN".into());
    let language = p.language.or_else(|| defaults.as_ref().map(|d| d.language.clone())).unwrap_or_else(|| "es".into());
    let validity_days = p.validity_days.or(defaults.as_ref().map(|d| d.validity_days)).unwrap_or(15);
    let advance_pct = p.advance_pct.or(defaults.as_ref().map(|d| d.advance_pct)).unwrap_or(50.0);
    valid_terms(&currency, &language, advance_pct, validity_days)?;
    let delivery_unit = p.delivery_unit.unwrap_or_else(|| "dias".into());
    if !matches!(delivery_unit.as_str(), "dias" | "semanas") {
        return Err(json_error(StatusCode::BAD_REQUEST, "entrega en dias o semanas"));
    }
    let discount = p.discount.unwrap_or(0.0);
    if !discount.is_finite() || discount < 0.0 {
        return Err(json_error(StatusCode::BAD_REQUEST, "el descuento no puede ser negativo"));
    }
    let project_id = project.and_then(|p| p.id).or(previous.as_ref().and_then(|q| q.project_id));
    let lines = match (p.lines, project_id) {
        (Some(lines), _) => lines_from_payload(lines)?,
        (None, Some(pid)) => lines_from_parts(state, &company_id, &pid)
            .await
            .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the parts"))?,
        (None, None) => Vec::new(),
    };
    if lines.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            if project.is_some() { "ninguna parte tiene precio cotizado" } else { "agrega al menos una partida" },
        ));
    }
    let (folio_base, revision) = match &previous {
        Some(q) => {
            let last = last_revision(state, &company_id, &q.folio_base)
                .await
                .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not number the revision"))?;
            (q.folio_base.clone(), last + 1)
        }
        None => match text(p.folio_base, 20) {
            Some(b) => (b, 0),
            None => (
                next_folio_base(state, &company_id, now)
                    .await
                    .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not number the quote"))?,
                0,
            ),
        },
    };
    let client_name = contact
        .map(|c| c.name)
        .or_else(|| previous.as_ref().map(|q| q.client_name.clone()))
        .or_else(|| project.map(|p| p.title.clone()))
        .unwrap_or_default();
    Ok(Quote {
        id: None,
        company_id,
        project_id,
        contact_id,
        client_name,
        attention: text(p.attention, 80),
        attention_initials: text(p.attention_initials, 6),
        folio_base,
        revision,
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
    })
}

async fn insert_and_respond(state: &AppState, quote: Quote) -> Response {
    match insert_quote(state, quote).await {
        Ok(q) => created(quote_data(state, q).await),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the quote"),
    }
}

async fn quotes_json(state: &AppState, list: Vec<Quote>) -> Response {
    let mut out = Vec::new();
    for q in list {
        if let Some(d) = quote_data(state, q).await {
            out.push(d);
        }
    }
    Json(out).into_response()
}

/// Every quote, newest first, with the project each one became.
pub async fn api_quotes_index(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    let company_id = admin_company!(session_user);
    match list_quotes(&state, &company_id).await {
        Ok(list) => quotes_json(&state, list).await,
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list quotes"),
    }
}

/// A new quote for a client, before there is a project.
pub async fn api_quote_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(p): Json<QuoteCreatePayload>,
) -> Response {
    let company_id = admin_company!(session_user);
    match build_quote(&state, &session_user, company_id, None, p).await {
        Ok(q) => insert_and_respond(&state, q).await,
        Err(resp) => resp,
    }
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
        Ok(list) => quotes_json(&state, list).await,
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
    let Ok(Some(project)) = get_project_by_id_for_company(&state, &project_id, &company_id).await else {
        return json_error(StatusCode::NOT_FOUND, "project not found");
    };
    match build_quote(&state, &session_user, company_id, Some(&project), p).await {
        Ok(q) => insert_and_respond(&state, q).await,
        Err(resp) => resp,
    }
}

#[derive(Debug, Deserialize)]
pub struct SuggestLinePayload {
    #[serde(default)]
    pub material: Option<PartMaterial>,
    #[serde(default)]
    pub weight_kg: Option<f64>,
    #[serde(default)]
    pub multiplier: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct SuggestPayload {
    pub lines: Vec<SuggestLinePayload>,
}

#[derive(Serialize)]
pub struct SuggestedLine {
    pub weight_kg: Option<f64>,
    pub weight_source: Option<&'static str>,
    pub price_per_kg: Option<f64>,
    pub material_cost: Option<f64>,
    pub multiplier: f64,
    pub suggested_unit_price: Option<f64>,
    pub missing: Vec<&'static str>,
}

/// Daniel's method for lines without a part: blank weight × $/kg × multiplier.
pub async fn api_quote_suggest(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(p): Json<SuggestPayload>,
) -> Response {
    let company_id = admin_company!(session_user);
    let Ok(prices) = list_material_prices(&state, &company_id).await else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the prices");
    };
    let out: Vec<SuggestedLine> = p
        .lines
        .into_iter()
        .take(200)
        .map(|l| {
            let material = clean_material(l.material);
            let quote = PartQuote {
                weight_kg: l.weight_kg.filter(|w| w.is_finite() && *w > 0.0),
                multiplier: l.multiplier.filter(|m| m.is_finite() && *m > 0.0),
            };
            let s = suggest_line(material.as_ref(), &quote, &prices);
            SuggestedLine {
                weight_kg: s.weight_kg,
                weight_source: s.weight_source,
                price_per_kg: s.price_per_kg,
                material_cost: s.material_cost,
                multiplier: s.multiplier,
                suggested_unit_price: s.suggested_unit_price,
                missing: s.missing,
            }
        })
        .collect();
    Json(out).into_response()
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

/// "Nueva revisión": same folio base, next revision, same terms. Lines that came from a
/// project's parts take the parts' current prices; any other lines stay as they were.
pub async fn api_quote_revise(session_user: SessionUser, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let (company_id, q) = match load_quote(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let revision = match last_revision(&state, &company_id, &q.folio_base).await {
        Ok(r) => r + 1,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not number the revision"),
    };
    let parts = match q.project_id {
        Some(pid) => lines_from_parts(&state, &company_id, &pid).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let lines: Vec<QuoteItem> = if q.lines.iter().all(|l| l.concept_id.is_some()) && !parts.is_empty() {
        parts
    } else {
        q.lines.clone()
    };
    let now = DateTime::now();
    let next = Quote { id: None, revision, date: now, lines, sent_at: None, created_by: *session_user.user_id(), created_at: now, ..q };
    insert_and_respond(&state, next).await
}

/// "Marcar como enviada": records the date and, for a quote that has a project still in
/// Pedidos or Análisis, moves it to Cotizado.
pub async fn api_quote_sent(session_user: SessionUser, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let (company_id, q) = match load_quote(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if mark_quote_sent(&state, &company_id, &q.id.unwrap_or_default()).await.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not mark the quote");
    }
    if let Some(project_id) = q.project_id {
        let early = [ProjectStatus::Pedidos.as_str(), ProjectStatus::Analisis.as_str()];
        let _ = state
            .projects
            .update_one(
                doc! { "_id": project_id, "company_id": company_id, "status": { "$in": early.to_vec() } },
                doc! { "$set": { "status": ProjectStatus::Cotizado.as_str(), "updated_at": DateTime::now() } },
            )
            .await;
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize, Default)]
pub struct QuoteToProjectPayload {
    /// Project name; defaults to "<client abbreviation> <folio>".
    #[serde(default)]
    pub title: Option<String>,
}

/// "Convertir en proyecto": the approved quote becomes a project in Pedidos, one part per
/// line with its quantity, price, material, weight and multiplier. Every revision of the
/// folio then points to that project; a folio becomes a project only once.
pub async fn api_quote_to_project(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    payload: Option<Json<QuoteToProjectPayload>>,
) -> Response {
    let (company_id, q) = match load_quote(&session_user, &state, &id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let p = payload.map(|Json(p)| p).unwrap_or_default();
    match folio_project(&state, &company_id, &q.folio_base).await {
        Ok(Some(existing)) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "esta cotización ya es un proyecto", "project_id": existing.to_hex() })),
            )
                .into_response();
        }
        Ok(None) => {}
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not check the quote"),
    }
    if q.lines.iter().any(|l| l.description.trim().is_empty() || l.quantity <= 0.0) {
        return json_error(StatusCode::BAD_REQUEST, "cada partida necesita número de parte y cantidad");
    }
    // Parts start in the company's first status; without one nothing is created.
    match get_initial_concept_status(&state, &company_id).await {
        Ok(Some(_)) => {}
        _ => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "no hay estado inicial de partes configurado"),
    }
    let code = folio(&q.folio_base, q.revision);
    let abbreviation = match q.contact_id {
        Some(c) => get_client_quote_defaults(&state, &company_id, &c).await.ok().flatten().and_then(|d| d.abbreviation),
        None => None,
    };
    let title = text(p.title, 120)
        .unwrap_or_else(|| format!("{} {code}", abbreviation.unwrap_or_else(|| q.client_name.clone())));
    let t = quote_totals(&q);
    let project_id = match create_project(
        &state,
        &company_id,
        &title,
        q.contact_id,
        None,
        Some(format!("Cotización {code}")),
        ProjectPriority::default(),
        Some(t.subtotal - t.discount),
        None,
        None,
    )
    .await
    {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not create the project"),
    };
    let mut lines = q.lines.clone();
    for (i, line) in lines.iter_mut().enumerate() {
        let concept_id = match create_project_concept(
            &state, &company_id, &project_id, None, &line.description, line.quantity, None, None, None, None, None, i as i32 + 1,
        )
        .await
        {
            Ok(id) => id,
            Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not create the parts"),
        };
        let price = (line.unit_price > 0.0).then_some(line.unit_price);
        let quote = PartQuote { weight_kg: line.weight_kg, multiplier: line.multiplier };
        let saved = async {
            if price.is_some() {
                set_concept_unit_price(&state, &concept_id, &company_id, price).await?;
            }
            if line.material.is_some() {
                set_part_material(&state, &company_id, &concept_id, line.material.as_ref()).await?;
            }
            if quote != PartQuote::default() {
                set_part_quote(&state, &company_id, &concept_id, &quote).await?;
            }
            anyhow::Ok(())
        }
        .await;
        if saved.is_err() {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the parts");
        }
        line.concept_id = Some(concept_id);
    }
    let linked = async {
        state
            .quotes
            .update_one(doc! { "_id": q.id, "company_id": company_id }, doc! { "$set": { "lines": mongodb::bson::to_bson(&lines)? } })
            .await?;
        link_folio_to_project(&state, &company_id, &q.folio_base, &project_id).await
    }
    .await;
    if linked.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not link the quote");
    }
    (StatusCode::CREATED, Json(serde_json::json!({ "project_id": project_id.to_hex(), "title": title }))).into_response()
}

// --- what a part was quoted and sold for ---------------------------------------------
//
// Daniel, 2026-11-06: "que el sistema sea capaz de recordar los nombres de las partidas por si
// en futuras ocasiones nos piden la misma partida que nos recuerde en cuánto se vendió".

/// "zbl136-plt a260129" and "ZBL136-PLT-A260129" are one part: no spaces, no case.
fn part_key(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_uppercase()
}

#[derive(Serialize, Clone)]
pub struct PartReferenceData {
    /// "vendida" (a project's part), "aprobada" (a quote that became a project) or "cotizada".
    pub kind: &'static str,
    pub description: String,
    pub unit_price: f64,
    pub quantity: f64,
    pub currency: String,
    pub client_name: Option<String>,
    pub folio: Option<String>,
    pub quote_id: Option<String>,
    pub project_id: Option<String>,
    pub project_title: Option<String>,
    pub date: String,
    #[serde(skip)]
    at: DateTime,
}

/// Every price a part has had, newest first, by part key.
async fn part_references(state: &AppState, company_id: &ObjectId) -> anyhow::Result<HashMap<String, Vec<PartReferenceData>>> {
    use futures::stream::TryStreamExt;
    let quotes = list_quotes(state, company_id).await?;
    let projects: HashMap<ObjectId, (String, Option<ObjectId>)> = state
        .projects
        .find(doc! { "company_id": company_id })
        .await?
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .filter_map(|p| Some((p.id?, (p.title, p.contact_id))))
        .collect();
    let contacts: HashMap<ObjectId, String> = state
        .contacts
        .find(doc! { "company_id": company_id })
        .await?
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .filter_map(|c| Some((c.id?, c.name)))
        .collect();
    let mut out: HashMap<String, Vec<PartReferenceData>> = HashMap::new();
    // Parts that came from a quote line are told once, as the approved quote.
    let mut from_quotes = std::collections::HashSet::new();
    for q in &quotes {
        for l in &q.lines {
            if l.unit_price <= 0.0 {
                continue;
            }
            if let Some(c) = l.concept_id {
                from_quotes.insert(c);
            }
            out.entry(part_key(&l.description)).or_default().push(PartReferenceData {
                kind: if q.project_id.is_some() { "aprobada" } else { "cotizada" },
                description: l.description.clone(),
                unit_price: l.unit_price,
                quantity: l.quantity,
                currency: q.currency.clone(),
                client_name: Some(q.client_name.clone()),
                folio: Some(folio(&q.folio_base, q.revision)),
                quote_id: q.id.map(|i| i.to_hex()),
                project_id: q.project_id.map(|p| p.to_hex()),
                project_title: q.project_id.and_then(|p| projects.get(&p)).map(|p| p.0.clone()),
                date: iso(q.date),
                at: q.date,
            });
        }
    }
    let sold: Vec<crate::models::ProjectConcept> = state
        .project_concepts
        .find(doc! { "company_id": company_id, "unit_price": { "$gt": 0.0 } })
        .await?
        .try_collect()
        .await?;
    for c in sold {
        if c.id.is_some_and(|id| from_quotes.contains(&id)) {
            continue;
        }
        let project = projects.get(&c.project_id);
        let at = c.created_at.unwrap_or(DateTime::from_millis(0));
        out.entry(part_key(&c.name)).or_default().push(PartReferenceData {
            kind: "vendida",
            description: c.name.clone(),
            unit_price: c.unit_price.unwrap_or(0.0),
            quantity: c.quantity,
            currency: "MXN".into(),
            client_name: project.and_then(|p| p.1).and_then(|id| contacts.get(&id)).cloned(),
            folio: c.work_order_number.map(|n| format!("OT-{n:04}")),
            quote_id: None,
            project_id: Some(c.project_id.to_hex()),
            project_title: project.map(|p| p.0.clone()),
            date: iso(at),
            at,
        });
    }
    for refs in out.values_mut() {
        refs.sort_by(|a, b| b.at.cmp(&a.at));
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct ReferencesPayload {
    pub names: Vec<String>,
}

/// For each name, the last prices of that part (up to 5): sold, approved or quoted.
pub async fn api_quote_references(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(p): Json<ReferencesPayload>,
) -> Response {
    let company_id = admin_company!(session_user);
    match part_references(&state, &company_id).await {
        Ok(all) => Json(
            p.names
                .iter()
                .take(200)
                .map(|n| all.get(&part_key(n)).map(|r| r.iter().take(5).cloned().collect()).unwrap_or_default())
                .collect::<Vec<Vec<PartReferenceData>>>(),
        )
        .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the references"),
    }
}

/// Every part name that has had a price, to suggest while typing a line.
pub async fn api_quote_part_names(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    let company_id = admin_company!(session_user);
    match part_references(&state, &company_id).await {
        Ok(all) => {
            let mut names: Vec<(DateTime, String)> =
                all.values().filter_map(|r| r.first().map(|x| (x.at, x.description.clone()))).collect();
            names.sort_by(|a, b| b.0.cmp(&a.0));
            Json(names.into_iter().map(|(_, n)| n).take(3000).collect::<Vec<_>>()).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not list the parts"),
    }
}
