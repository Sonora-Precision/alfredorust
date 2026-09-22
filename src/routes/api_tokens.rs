use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mongodb::bson::oid::ObjectId;
use serde::{Deserialize, Serialize};

use crate::{
    session::SessionUser,
    state::{AppState, create_api_token, list_api_tokens, revoke_api_token},
};

#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiTokenRow {
    id: String,
    name: String,
    token_prefix: String,
    created_at: String,
    expires_at: String,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateApiTokenPayload {
    name: String,
    expires_in_days: u32,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct CreatedApiToken {
    id: String,
    name: String,
    token: String,
    token_prefix: String,
    expires_at: String,
}

#[utoipa::path(
    get,
    path = "/api/account/tokens",
    tag = "auth",
    responses((status = 200, body = [ApiTokenRow]), (status = 401)),
    security(("session" = []), ("bearerToken" = []))
)]
pub async fn api_tokens_index(
    session: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ApiTokenRow>>, StatusCode> {
    let tokens = list_api_tokens(&state, session.user_id())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        tokens
            .into_iter()
            .map(|token| ApiTokenRow {
                id: token.id.expect("persisted token has id").to_hex(),
                name: token.name,
                token_prefix: token.token_prefix,
                created_at: token.created_at.to_chrono().to_rfc3339(),
                expires_at: token.expires_at.to_chrono().to_rfc3339(),
                last_used_at: token.last_used_at.map(|date| date.to_chrono().to_rfc3339()),
                revoked_at: token.revoked_at.map(|date| date.to_chrono().to_rfc3339()),
            })
            .collect(),
    ))
}

#[utoipa::path(
    post,
    path = "/api/account/tokens",
    tag = "auth",
    request_body = CreateApiTokenPayload,
    responses((status = 201, body = CreatedApiToken), (status = 400), (status = 401), (status = 403)),
    security(("session" = []))
)]
pub async fn api_tokens_create(
    session: SessionUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateApiTokenPayload>,
) -> Response {
    // A token cannot mint another token. Creation requires an interactive
    // browser session that already passed TOTP authentication.
    if !session.is_browser_session() {
        return StatusCode::FORBIDDEN.into_response();
    }
    match create_api_token(
        &state,
        session.user_id(),
        &payload.name,
        payload.expires_in_days,
    )
    .await
    {
        Ok((record, token)) => (
            StatusCode::CREATED,
            Json(CreatedApiToken {
                id: record.id.expect("persisted token has id").to_hex(),
                name: record.name,
                token,
                token_prefix: record.token_prefix,
                expires_at: record.expires_at.to_chrono().to_rfc3339(),
            }),
        )
            .into_response(),
        Err(err) if err.to_string().contains("must be") => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": err.to_string() })),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/account/tokens/{id}/revoke",
    tag = "auth",
    params(("id" = String, Path)),
    responses((status = 200), (status = 400), (status = 401), (status = 403), (status = 404)),
    security(("session" = []))
)]
pub async fn api_tokens_revoke(
    session: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !session.is_browser_session() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(id) = ObjectId::parse_str(&id) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match revoke_api_token(&state, session.user_id(), &id).await {
        Ok(true) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
