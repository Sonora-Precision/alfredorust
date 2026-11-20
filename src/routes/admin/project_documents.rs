//! Project documents (PDF): the customer's purchase order, our quote, others (Daniel,
//! 2026-11-09). Admin only, to list, open, upload and delete: they carry prices.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;

use super::finance::helpers::require_active_company;
use super::part_files::pdf_inline;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{ProjectDocument, Quote, UserPermission},
    session::SessionUser,
    state::{
        AppState, delete_project_document, image_extension, is_visual_kind, folio, get_project_by_id_for_company, get_project_document,
        list_company_project_documents, list_project_documents, list_project_quotes, list_quotes, read_project_document,
        save_project_document,
    },
};

#[derive(Serialize)]
pub struct ProjectDocumentData {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub filename: String,
    pub size_bytes: i64,
    pub uploaded_at: String,
    /// Where the SPA opens it.
    pub url: String,
    /// Set when the entry is the quote the project was made from rather than an uploaded file:
    /// it opens the quote document (which prints its PDF) and cannot be removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_id: Option<String>,
}

fn document_data(d: ProjectDocument) -> Option<ProjectDocumentData> {
    let id = d.id?.to_hex();
    Some(ProjectDocumentData {
        url: format!("/api/admin/project_documents/{id}"),
        id,
        project_id: d.project_id.to_hex(),
        kind: d.kind,
        filename: d.original_filename,
        size_bytes: d.size_bytes,
        uploaded_at: iso(d.uploaded_at),
        quote_id: None,
    })
}

/// The quote a project was made from shows with its documents by itself (Daniel, 2026-11-18:
/// "al convertir una cotizacion a proyecto ya debería de jalar en automatico la cotizacion en
/// pdf"). Every revision of the folio points to the project; the converted one is the revision
/// whose lines carry the parts, else the newest generated one.
fn converted_quote<'a>(quotes: impl Iterator<Item = &'a Quote> + Clone) -> Option<&'a Quote> {
    quotes
        .clone()
        .filter(|q| !q.draft)
        .find(|q| q.lines.iter().any(|l| l.concept_id.is_some()))
        .or_else(|| quotes.filter(|q| !q.draft).max_by_key(|q| (q.revision, q.created_at)))
}

fn quote_entry(q: &Quote) -> Option<ProjectDocumentData> {
    let id = q.id?.to_hex();
    Some(ProjectDocumentData {
        url: format!("/cotizaciones/{id}"),
        project_id: q.project_id?.to_hex(),
        kind: "cotizacion".into(),
        filename: format!("Cotización {}", folio(&q.folio_base, q.revision)),
        size_bytes: 0,
        uploaded_at: iso(q.created_at),
        quote_id: Some(id.clone()),
        id,
    })
}

/// Documents of a project, newest first.
pub async fn api_project_documents(
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
    let (docs, quotes) =
        match (list_project_documents(&state, &company_id, &project_id).await, list_project_quotes(&state, &company_id, &project_id).await) {
            (Ok(d), Ok(q)) => (d, q),
            _ => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load documents"),
        };
    let mut out: Vec<_> = docs.into_iter().filter_map(document_data).collect();
    add_quote_entry(&mut out, converted_quote(quotes.iter()));
    Json(out).into_response()
}

/// Adds the project's quote unless a quote PDF was already uploaded by hand.
fn add_quote_entry(docs: &mut Vec<ProjectDocumentData>, quote: Option<&Quote>) {
    if docs.iter().any(|d| d.kind == "cotizacion") {
        return;
    }
    if let Some(entry) = quote.and_then(quote_entry) {
        docs.push(entry);
    }
}

/// Every document of the company, so the projects list shows each project's PO and quote.
pub async fn api_company_project_documents(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let (docs, quotes) = match (list_company_project_documents(&state, &company_id).await, list_quotes(&state, &company_id).await) {
        (Ok(d), Ok(q)) => (d, q),
        _ => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load documents"),
    };
    let mut by_project: std::collections::BTreeMap<_, Vec<ProjectDocumentData>> = std::collections::BTreeMap::new();
    for d in docs {
        let project = d.project_id;
        if let Some(data) = document_data(d) {
            by_project.entry(project).or_default().push(data);
        }
    }
    let mut quoted: std::collections::BTreeMap<_, Vec<&Quote>> = std::collections::BTreeMap::new();
    for q in &quotes {
        if let Some(p) = q.project_id {
            quoted.entry(p).or_default().push(q);
        }
    }
    for (project, qs) in quoted {
        add_quote_entry(by_project.entry(project).or_default(), converted_quote(qs.into_iter()));
    }
    Json(by_project.into_values().flatten().collect::<Vec<_>>()).into_response()
}

/// Uploads a PDF to the project (multipart fields `file` and `kind`).
pub async fn api_project_document_upload(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    mut multipart: Multipart,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Ok(Some(project)) = get_project_by_id_for_company(&state, &project_id, &company_id).await else {
        return json_error(StatusCode::NOT_FOUND, "project not found");
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
                let filename = field.file_name().unwrap_or("documento.pdf").to_string();
                match field.bytes().await {
                    Ok(bytes) => upload = Some((filename, bytes)),
                    Err(_) => {
                        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "el archivo excede el tamaño máximo (40 MB)");
                    }
                }
            }
            _ => {}
        }
    }
    let Some((filename, bytes)) = upload else {
        return json_error(StatusCode::BAD_REQUEST, "falta el archivo");
    };
    match save_project_document(&state, &project, &kind, &filename, &bytes, *session_user.user_id()).await {
        Ok(doc) => match document_data(doc) {
            Some(data) => (StatusCode::CREATED, Json(data)).into_response(),
            None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "document missing id"),
        },
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// A preview image, served as itself.
fn image_inline(bytes: Vec<u8>, ext: &str) -> Response {
    let content_type = if ext == "png" { "image/png" } else { "image/jpeg" };
    let mut resp = bytes.into_response();
    let headers = resp.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    resp
}

/// The file itself, shown in the browser (inline): the PDF, or the preview image.
pub async fn api_project_document_download(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    // The assembly preview and drawing carry no prices: whoever sees projects opens them.
    if !session_user.is_admin() && !session_user.has_permission(UserPermission::ViewProjects) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Ok(Some(doc)) = get_project_document(&state, &company_id, &id).await else {
        return json_error(StatusCode::NOT_FOUND, "document not found");
    };
    if !session_user.is_admin() && !is_visual_kind(&doc.kind) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match read_project_document(&doc).await {
        Ok(bytes) => match image_extension(&bytes) {
            Some(ext) => image_inline(bytes, ext),
            None => pdf_inline(bytes, &doc.original_filename),
        },
        Err(_) => json_error(StatusCode::NOT_FOUND, "document file missing"),
    }
}

/// Removes a document from the project (soft delete).
pub async fn api_project_document_delete(
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
    match delete_project_document(&state, &company_id, &id).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "document not found"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not delete document"),
    }
}
