#[path = "common/mod.rs"]
mod common;

use common::harness::*;
use serde_json::{Value, json};

async fn request_with_bearer(
    app: Router,
    method: &str,
    host: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, String) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", host)
        .header("authorization", format!("Bearer {token}"));
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let request = builder
        .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

#[tokio::test]
async fn personal_token_is_shown_once_authenticates_and_can_be_revoked() {
    let ctx = match common::setup_state().await {
        Some(ctx) => ctx,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let user = list_users(&state).await.unwrap().remove(0);
    let host = format!("{}.miapp.local", user.company_slug);
    let session = create_session(&state, &user.username).await.unwrap();

    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        &host,
        "/api/account/tokens",
        &session,
        json!({ "name": "Prueba CLI", "expires_in_days": 30 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let created: Value = serde_json::from_str(&body).unwrap();
    let plaintext = created["token"].as_str().unwrap();
    let id = created["id"].as_str().unwrap();
    assert!(plaintext.starts_with("spat_"));

    let stored = state.api_tokens.find_one(doc! {}).await.unwrap().unwrap();
    assert_ne!(stored.secret_hash, plaintext);
    assert!(!stored.secret_hash.contains(plaintext));

    let (status, body) = request_with_bearer(
        build_app(shared.clone()),
        "GET",
        &host,
        "/api/me",
        plaintext,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["username"],
        user.username
    );

    let (status, body) = get_with_cookie(
        build_app(shared.clone()),
        &host,
        "/api/account/tokens",
        &session,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let listed: Value = serde_json::from_str(&body).unwrap();
    assert!(
        listed[0].get("token").is_none(),
        "plaintext leaked in token list"
    );

    let (status, _) = request_with_bearer(
        build_app(shared.clone()),
        "POST",
        &host,
        "/api/account/tokens",
        plaintext,
        Some(json!({ "name": "No permitido", "expires_in_days": 30 })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    state
        .api_tokens
        .update_one(
            doc! { "_id": &stored.id },
            doc! { "$set": { "expires_at": DateTime::from_millis(0) } },
        )
        .await
        .unwrap();
    let (status, _) = request_with_bearer(
        build_app(shared.clone()),
        "GET",
        &host,
        "/api/me",
        plaintext,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    state
        .api_tokens
        .update_one(
            doc! { "_id": &stored.id },
            doc! { "$set": { "expires_at": stored.expires_at } },
        )
        .await
        .unwrap();

    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        &host,
        &format!("/api/account/tokens/{id}/revoke"),
        &session,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, _) =
        request_with_bearer(build_app(shared), "GET", &host, "/api/me", plaintext, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    common::teardown(Some(ctx)).await;
}
