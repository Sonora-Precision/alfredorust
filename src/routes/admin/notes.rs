//! Shop-floor notes and the suggestion box (Daniel, 2026-11-06):
//! - closing a project moves it out of the active list ("Terminados");
//! - comments on a part number: scrap (how many and why), notes to learn from (shown again
//!   when the same part number comes back in another project) and plain comments;
//! - suggestions any user leaves to improve the system, answered by the admin.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;

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
    models::{PartComment, ProjectStatus, Suggestion, UserPermission},
    session::SessionUser,
    state::{AppState, get_project_by_id_for_company, get_project_concept_by_id_for_company, list_project_concepts},
};

fn author_name(user: &SessionUser) -> String {
    let u = user.user();
    u.display_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| u.username.clone())
}

fn clean(text: &str, max: usize) -> Option<String> {
    let t: String = text.trim().chars().take(max).collect();
    (!t.is_empty()).then_some(t)
}

/// Part number without spaces or symbols, upper case ("CG-15286-C" == "cg 15286 c").
pub fn part_key(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_uppercase()
}

// --- closing a project -------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ProjectClosePayload {
    pub closed: bool,
}

/// "Terminar proyecto": delivered and out of the active list; "Reabrir" puts it back in
/// production. Admin only.
pub async fn api_project_close(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<ProjectClosePayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let now = DateTime::from_system_time(SystemTime::now());
    let (status, completed_at) =
        if payload.closed { (ProjectStatus::Entregado, Some(now)) } else { (ProjectStatus::Produccion, None) };
    match state
        .projects
        .update_one(
            doc! { "_id": id, "company_id": company_id },
            doc! { "$set": { "status": status.as_str(), "completed_at": completed_at, "updated_at": now } },
        )
        .await
    {
        Ok(r) if r.matched_count == 0 => json_error(StatusCode::NOT_FOUND, "project not found"),
        Ok(_) => Json(serde_json::json!({
            "ok": true,
            "status": status.as_str(),
            "status_label": status.label(),
            "completed_at": completed_at.map(iso),
        }))
        .into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not update the project"),
    }
}

// --- comments on part numbers ----------------------------------------------------------

const KINDS: [&str; 3] = ["comentario", "scrap", "nota"];

#[derive(Serialize)]
pub struct PartCommentData {
    pub id: String,
    pub concept_id: String,
    pub part: String,
    pub kind: String,
    pub text: String,
    pub quantity: Option<f64>,
    pub author: String,
    pub author_id: String,
    pub created_at: String,
    /// A note left on the same part number in another project.
    pub other_project: Option<String>,
}

fn comment_data(c: PartComment, other_project: Option<String>) -> Option<PartCommentData> {
    Some(PartCommentData {
        id: c.id?.to_hex(),
        concept_id: c.concept_id.to_hex(),
        part: c.part,
        kind: c.kind,
        text: c.text,
        quantity: c.quantity,
        author: c.author,
        author_id: c.author_id.to_hex(),
        created_at: iso(c.created_at),
        other_project,
    })
}

/// Comments of every part of a project, newest first, plus the notes ("nota") left on the
/// same part numbers in other projects, so what was learned comes back with the part.
pub async fn api_project_part_comments(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !session_user.has_permission(UserPermission::ViewProjects) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Ok(concepts) = list_project_concepts(&state, &company_id, &id).await else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the parts");
    };
    // Each part number of this project → its part in it, for notes from other projects.
    let by_key: HashMap<String, ObjectId> =
        concepts.iter().filter_map(|c| Some((part_key(&c.name), c.id?))).collect();
    let keys: Vec<&String> = by_key.keys().collect();
    let found: Vec<PartComment> = match state
        .part_comments
        .find(doc! {
            "company_id": company_id,
            "$or": [
                { "project_id": id },
                { "kind": "nota", "part_key": { "$in": keys } },
            ],
        })
        .sort(doc! { "created_at": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect().await.unwrap_or_default(),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the comments"),
    };
    let mut titles: HashMap<ObjectId, String> = HashMap::new();
    let mut out = Vec::new();
    for mut c in found {
        let other = if c.project_id == id {
            None
        } else {
            if !titles.contains_key(&c.project_id) {
                let t = get_project_by_id_for_company(&state, &c.project_id, &company_id)
                    .await
                    .ok()
                    .flatten()
                    .map(|p| p.title)
                    .unwrap_or_else(|| "otro proyecto".into());
                titles.insert(c.project_id, t);
            }
            // Shown on this project's part with the same number.
            if let Some(here) = by_key.get(&c.part_key) {
                c.concept_id = *here;
            }
            titles.get(&c.project_id).cloned()
        };
        if let Some(d) = comment_data(c, other) {
            out.push(d);
        }
    }
    Json(out).into_response()
}

#[derive(Deserialize)]
pub struct PartCommentPayload {
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub quantity: Option<f64>,
}

/// Leaves a comment on a part: whoever sees projects (programmers included).
pub async fn api_part_comment_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<PartCommentPayload>,
) -> Response {
    if !session_user.has_permission(UserPermission::ViewProjects) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if !KINDS.contains(&payload.kind.as_str()) {
        return json_error(StatusCode::BAD_REQUEST, "el tipo va comentario, scrap o nota");
    }
    let Some(text) = clean(&payload.text, 1000) else {
        return json_error(StatusCode::BAD_REQUEST, "escribe el comentario");
    };
    let quantity = match (payload.kind.as_str(), payload.quantity) {
        ("scrap", Some(q)) if q.is_finite() && q > 0.0 && q <= 1_000_000.0 => Some(q),
        ("scrap", _) => return json_error(StatusCode::BAD_REQUEST, "pon cuántas piezas fueron scrap"),
        _ => None,
    };
    let concept = match get_project_concept_by_id_for_company(&state, &id, &company_id).await {
        Ok(Some(c)) => c,
        _ => return json_error(StatusCode::NOT_FOUND, "part not found"),
    };
    let comment = PartComment {
        id: None,
        company_id,
        project_id: concept.project_id,
        concept_id: id,
        part_key: part_key(&concept.name),
        part: concept.name.clone(),
        kind: payload.kind,
        text,
        quantity,
        author_id: *session_user.user_id(),
        author: author_name(&session_user),
        created_at: DateTime::from_system_time(SystemTime::now()),
    };
    match state.part_comments.insert_one(&comment).await {
        Ok(r) => {
            let saved = PartComment { id: r.inserted_id.as_object_id(), ..comment };
            (StatusCode::CREATED, Json(comment_data(saved, None))).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the comment"),
    }
}

/// Deletes a comment: its author or the admin.
pub async fn api_part_comment_delete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let mut filter = doc! { "_id": id, "company_id": company_id };
    if !session_user.is_admin() {
        filter.insert("author_id", *session_user.user_id());
    }
    match state.part_comments.delete_one(filter).await {
        Ok(r) if r.deleted_count == 0 => json_error(StatusCode::NOT_FOUND, "comentario no encontrado o no es tuyo"),
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not delete the comment"),
    }
}

// --- suggestions -------------------------------------------------------------------------

const SUGGESTION_STATUSES: [&str; 4] = ["nueva", "en_revision", "hecha", "descartada"];

#[derive(Serialize)]
pub struct SuggestionData {
    pub id: String,
    pub author: String,
    pub mine: bool,
    pub text: String,
    pub status: String,
    pub reply: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

fn suggestion_data(s: Suggestion, me: &ObjectId) -> Option<SuggestionData> {
    Some(SuggestionData {
        id: s.id?.to_hex(),
        author: s.author,
        mine: &s.user_id == me,
        text: s.text,
        status: s.status,
        reply: s.reply,
        created_at: iso(s.created_at),
        updated_at: s.updated_at.map(iso),
    })
}

/// The admin sees every suggestion; everyone else, their own.
pub async fn api_suggestions_index(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    let company_id = require_active_company(&session_user);
    let me = *session_user.user_id();
    let mut filter = doc! { "company_id": company_id };
    if !session_user.is_admin() {
        filter.insert("user_id", me);
    }
    match state.suggestions.find(filter).sort(doc! { "created_at": -1 }).await {
        Ok(cursor) => {
            let list: Vec<Suggestion> = cursor.try_collect().await.unwrap_or_default();
            Json(list.into_iter().filter_map(|s| suggestion_data(s, &me)).collect::<Vec<_>>()).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the suggestions"),
    }
}

#[derive(Deserialize)]
pub struct SuggestionPayload {
    pub text: String,
}

pub async fn api_suggestion_create(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SuggestionPayload>,
) -> Response {
    let Some(text) = clean(&payload.text, 2000) else {
        return json_error(StatusCode::BAD_REQUEST, "escribe tu sugerencia");
    };
    let s = Suggestion {
        id: None,
        company_id: require_active_company(&session_user),
        user_id: *session_user.user_id(),
        author: author_name(&session_user),
        text,
        status: "nueva".into(),
        reply: None,
        created_at: DateTime::from_system_time(SystemTime::now()),
        updated_at: None,
    };
    match state.suggestions.insert_one(&s).await {
        Ok(r) => {
            let me = *session_user.user_id();
            let saved = Suggestion { id: r.inserted_id.as_object_id(), ..s };
            (StatusCode::CREATED, Json(suggestion_data(saved, &me))).into_response()
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the suggestion"),
    }
}

#[derive(Deserialize)]
pub struct SuggestionUpdatePayload {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub reply: Option<String>,
}

/// The admin marks where a suggestion stands and answers it.
pub async fn api_suggestion_update(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<SuggestionUpdatePayload>,
) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let mut set = doc! { "updated_at": DateTime::from_system_time(SystemTime::now()) };
    if let Some(st) = payload.status {
        if !SUGGESTION_STATUSES.contains(&st.as_str()) {
            return json_error(StatusCode::BAD_REQUEST, "estado inválido");
        }
        set.insert("status", st);
    }
    if let Some(r) = payload.reply {
        set.insert("reply", clean(&r, 2000));
    }
    match state.suggestions.update_one(doc! { "_id": id, "company_id": company_id }, doc! { "$set": set }).await {
        Ok(r) if r.matched_count == 0 => json_error(StatusCode::NOT_FOUND, "suggestion not found"),
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not update the suggestion"),
    }
}
