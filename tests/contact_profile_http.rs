#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// Daniel, 2026-11-13: suppliers can be just an alias or a full card, and the maquila ones
/// are marked with what they do.
#[tokio::test]
async fn supplier_card_alias_or_full() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let company = create_company(&state, "Prov A", "prov-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "prov-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let user = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let admin = create_session(&state, &user.username).await.unwrap();
    let host = "prov-a.miapp.local";
    let post = |path: String, body: serde_json::Value| {
        let shared = shared.clone();
        let admin = admin.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &admin, body).await }
    };
    let get = |path: String| {
        let shared = shared.clone();
        let admin = admin.clone();
        async move { get_with_cookie(build_app(shared), host, &path, &admin).await }
    };

    // Just an alias, marked as maquila.
    let (status, body) = post(
        "/api/admin/contacts".into(),
        serde_json::json!({
            "name": "Maquison",
            "contact_type": "supplier",
            "profile": { "alias": " Maquison ", "outsourcing": true, "processes": ["Torno", " torno ", "Fresa CNC", ""] }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let id = json(&body)["id"].as_str().unwrap().to_string();

    let (_, body) = get("/api/admin/contacts".into()).await;
    let rows = json(&body);
    let row = rows.as_array().unwrap().iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(row["alias"], "Maquison");
    assert_eq!(row["outsourcing"], true);
    assert_eq!(row["processes"], serde_json::json!(["Torno", "Fresa CNC"]));
    assert_eq!(row["missing"], serde_json::json!(["rfc", "address", "contact"]));

    // Filled in later; an update without a card leaves it alone.
    let (status, body) = post(
        format!("/api/admin/contacts/{id}/update"),
        serde_json::json!({
            "name": "MAQUINADOS DE SONORA",
            "contact_type": "supplier",
            "rfc": "mso010101aaa",
            "phone": "662 000 0000",
            "profile": {
                "alias": "Maquison", "outsourcing": true, "processes": ["Torno"],
                "address": "Calle 1 #2", "city": "Hermosillo", "state": "Sonora", "postal_code": "83000",
                "contact_person": "Ing. Pérez", "clabe": "0121 8000 1234 5678 90", "credit_days": 30
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, body) = post(
        format!("/api/admin/contacts/{id}/update"),
        serde_json::json!({ "name": "MAQUINADOS DE SONORA", "contact_type": "supplier", "rfc": "MSO010101AAA", "phone": "662 000 0000" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    let (_, body) = get(format!("/api/admin/contacts/{id}")).await;
    let detail = json(&body);
    assert_eq!(detail["name"], "MAQUINADOS DE SONORA");
    assert_eq!(detail["rfc"], "MSO010101AAA");
    assert_eq!(detail["profile"]["city"], "Hermosillo");
    assert_eq!(detail["profile"]["clabe"], "012180001234567890");
    assert_eq!(detail["profile"]["credit_days"], 30);
    assert_eq!(detail["profile"]["processes"], serde_json::json!(["Torno"]));

    let (_, body) = get("/api/admin/contacts".into()).await;
    let rows = json(&body);
    let row = rows.as_array().unwrap().iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(row["missing"], serde_json::json!([]), "{body}");

    // A customer never shows supplier gaps.
    let (status, _) = post(
        "/api/admin/contacts".into(),
        serde_json::json!({ "name": "Cliente X", "contact_type": "customer" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, body) = get("/api/admin/contacts".into()).await;
    let rows = json(&body);
    let customer = rows.as_array().unwrap().iter().find(|r| r["name"] == "Cliente X").unwrap();
    assert_eq!(customer["missing"], serde_json::json!([]));
    assert_eq!(customer["outsourcing"], false);

    common::teardown(Some(ctx)).await;
}
