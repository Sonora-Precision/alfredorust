//! Part drawings (PDF) JSON API. Everyone who sees projects can list and open them; only
//! the admin uploads or deletes (Daniel, 2026-11-03).

use std::sync::Arc;

use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use mongodb::bson::oid::ObjectId;
use serde::Serialize;

use super::finance::helpers::require_active_company;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{PartFile, UserPermission},
    session::{EMBEDDABLE_CSP, SessionUser},
    state::{
        AppState, delete_part_file, get_part_file, get_project_concept_by_id_for_company,
        list_part_files, read_part_file, save_part_drawing,
    },
};

#[derive(Serialize)]
pub struct PartFileData {
    pub id: String,
    pub concept_id: String,
    pub kind: String,
    pub filename: String,
    pub size_bytes: i64,
    pub uploaded_at: String,
    /// Where the SPA opens it.
    pub url: String,
}

fn part_file_data(f: PartFile) -> Option<PartFileData> {
    let id = f.id?.to_hex();
    Some(PartFileData {
        url: format!("/api/admin/part_files/{id}"),
        id,
        concept_id: f.concept_id.to_hex(),
        kind: f.kind,
        filename: f.original_filename,
        size_bytes: f.size_bytes,
        uploaded_at: iso(f.uploaded_at),
    })
}

fn can_view(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::ViewProjects)
}

/// Drawings of every part of a project, newest first.
pub async fn api_project_part_files(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let project_id = match parse_oid(&project_id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let concept_ids: Vec<ObjectId> = match state
        .project_concepts
        .distinct("_id", mongodb::bson::doc! { "company_id": company_id, "project_id": project_id })
        .await
    {
        Ok(ids) => ids.into_iter().filter_map(|b| b.as_object_id()).collect(),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load parts"),
    };
    match list_part_files(&state, &company_id, &concept_ids).await {
        Ok(files) => Json(files.into_iter().filter_map(part_file_data).collect::<Vec<_>>()).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load drawings"),
    }
}

/// Uploads the PDF drawing of a part (multipart field `file`). Admin only.
pub async fn api_part_drawing_upload(
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
    let Ok(Some(concept)) = get_project_concept_by_id_for_company(&state, &id, &company_id).await else {
        return json_error(StatusCode::NOT_FOUND, "concept not found");
    };
    let mut upload = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().unwrap_or("plano.pdf").to_string();
        match field.bytes().await {
            Ok(bytes) => upload = Some((filename, bytes)),
            Err(_) => return json_error(StatusCode::PAYLOAD_TOO_LARGE, "el plano excede el tamaño máximo (40 MB)"),
        }
        break;
    }
    let Some((filename, bytes)) = upload else {
        return json_error(StatusCode::BAD_REQUEST, "falta el archivo del plano");
    };
    match save_part_drawing(&state, &concept, &filename, &bytes, *session_user.user_id()).await {
        Ok(file) => match part_file_data(file) {
            Some(data) => (StatusCode::CREATED, Json(data)).into_response(),
            None => json_error(StatusCode::INTERNAL_SERVER_ERROR, "file missing id"),
        },
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// The PDF itself, shown in the browser (inline).
pub async fn api_part_file_download(
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
    let Ok(Some(file)) = get_part_file(&state, &company_id, &id).await else {
        return json_error(StatusCode::NOT_FOUND, "drawing not found");
    };
    let bytes = match read_part_file(&file).await {
        Ok(b) => b,
        Err(_) => return json_error(StatusCode::NOT_FOUND, "drawing file missing"),
    };
    // ASCII fallback plus the UTF-8 name, so "Ñ" or accents survive.
    let ascii: String = file
        .original_filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || ".-_ ".contains(c) { c } else { '_' })
        .collect();
    let encoded: String = file
        .original_filename
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b".-_".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let disposition = format!("inline; filename=\"{ascii}\"; filename*=UTF-8''{encoded}");
    let mut resp = bytes.into_response();
    let headers = resp.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // The board shows it in a hover preview (same-origin iframe).
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(EMBEDDABLE_CSP));
    resp
}

/// Removes a drawing from the part (soft delete). Admin only.
pub async fn api_part_file_delete(
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
    match delete_part_file(&state, &company_id, &id).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "drawing not found"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not delete drawing"),
    }
}
