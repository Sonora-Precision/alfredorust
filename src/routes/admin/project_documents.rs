//! Project documents (PDF): the customer's purchase order, our quote, others (Daniel,
//! 2026-11-09). Admin only, to list, open, upload and delete: they carry prices.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use super::finance::helpers::require_active_company;
use super::part_files::pdf_inline;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::ProjectDocument,
    session::SessionUser,
    state::{
        AppState, delete_project_document, get_project_by_id_for_company, get_project_document,
        list_project_documents, read_project_document, save_project_document,
    },
};

#[derive(Serialize)]
pub struct ProjectDocumentData {
    pub id: String,
    pub kind: String,
    pub filename: String,
    pub size_bytes: i64,
    pub uploaded_at: String,
    /// Where the SPA opens it.
    pub url: String,
}

fn document_data(d: ProjectDocument) -> Option<ProjectDocumentData> {
    let id = d.id?.to_hex();
    Some(ProjectDocumentData {
        url: format!("/api/admin/project_documents/{id}"),
        id,
        kind: d.kind,
        filename: d.original_filename,
        size_bytes: d.size_bytes,
        uploaded_at: iso(d.uploaded_at),
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
    match list_project_documents(&state, &company_id, &project_id).await {
        Ok(docs) => Json(docs.into_iter().filter_map(document_data).collect::<Vec<_>>()).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load documents"),
    }
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

/// The PDF itself, shown in the browser (inline).
pub async fn api_project_document_download(
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
    let Ok(Some(doc)) = get_project_document(&state, &company_id, &id).await else {
        return json_error(StatusCode::NOT_FOUND, "document not found");
    };
    match read_project_document(&doc).await {
        Ok(bytes) => pdf_inline(bytes, &doc.original_filename),
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
