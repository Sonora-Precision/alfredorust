#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// add-part-quoting: blank kg × $/kg × multiplier, admin only, applied on request.
#[tokio::test]
async fn quote_from_blank_weight_and_apply() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "quote-a.miapp.local";

    let company = create_company(&state, "Quote A", "quote-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "quote-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "quote-jose@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProjects, UserPermission::ViewProductionBoard, UserPermission::TakeWorkOrders],
        )],
    )
    .await
    .unwrap();
    let session = |id| {
        let state = state.clone();
        async move {
            let u = get_user_by_id(&state, &id).await.unwrap().unwrap();
            create_session(&state, &u.username).await.unwrap()
        }
    };
    let admin = session(admin_id).await;
    let jose = session(jose_id).await;
    let post = |path: String, tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &tok, body).await }
    };
    let get = |path: String, tok: String| {
        let shared = shared.clone();
        async move { get_with_cookie(build_app(shared), host, &path, &tok).await }
    };

    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project = create_project(
        &state, &company, "Pallets", None, None, None, ProjectPriority::Medium, None, None, None,
    )
    .await
    .unwrap();
    let part = |name: &'static str, pos: i32| {
        let state = state.clone();
        async move {
            create_project_concept(&state, &company, &project, None, name, 30.0, None, None, None, None, None, pos)
                .await
                .unwrap()
        }
    };
    let p296 = part("CG-15296-A", 1).await;
    let p253 = part("CG-15253-A", 2).await;
    for (id, m) in [
        (p296, serde_json::json!({ "material": "Aluminio 6061", "shape": "solera", "thickness": 1.0, "width": 1.5, "length": 1.5 })),
        (p253, serde_json::json!({ "material": "4140", "shape": "solera", "thickness": 0.5, "width": 1.125, "length": 6.375 })),
    ] {
        let (status, _) = post(format!("/api/admin/project_concepts/{}/material", id.to_hex()), admin.clone(), m).await;
        assert_eq!(status, StatusCode::OK);
    }

    // Prices per kg: admin only.
    let (status, _) = post(
        "/api/admin/material_prices".into(),
        jose.clone(),
        serde_json::json!({ "material": "Aluminio 6061", "price_per_kg": 250 }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = post(
        "/api/admin/material_prices".into(),
        admin.clone(),
        serde_json::json!({ "material": "Aluminio 6061", "price_per_kg": 250, "note": "F86241 HG Aceros" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    // The quote: staff never see it.
    let quote_path = format!("/api/admin/projects/{}/quote", project.to_hex());
    let (status, _) = get(quote_path.clone(), jose.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let quote = || {
        let get = get.clone();
        let (path, tok) = (quote_path.clone(), admin.clone());
        async move {
            let (status, body) = get(path, tok).await;
            assert_eq!(status, StatusCode::OK, "body: {body}");
            json(&body)
        }
    };
    let line = |q: &serde_json::Value, name: &str| q["lines"].as_array().unwrap().iter().find(|l| l["part"] == name).unwrap().clone();
    let q = quote().await;
    let l296 = line(&q, "CG-15296-A");
    assert!((l296["weight_kg"].as_f64().unwrap() - 0.0996).abs() < 1e-3, "{l296}");
    assert_eq!(l296["weight_source"], "tocho");
    assert!((l296["material_cost"].as_f64().unwrap() - 24.89).abs() < 0.01);
    assert_eq!((l296["multiplier"].as_f64(), l296["suggested_unit_price"].as_f64()), (Some(3.5), Some(88.0)));
    let l253 = line(&q, "CG-15253-A");
    assert!(l253["suggested_unit_price"].is_null());
    assert_eq!(l253["missing"][0], "precio por kg del material");
    assert_eq!(q["suggested_total"], 88.0 * 30.0);

    // SolidWorks weight and multiplier 4 on CG-15296-A.
    let (status, _) = post(
        format!("/api/admin/project_concepts/{}/quote", p296.to_hex()),
        jose.clone(),
        serde_json::json!({ "weight_kg": 0.2, "multiplier": 4 }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post(
        format!("/api/admin/project_concepts/{}/quote", p296.to_hex()),
        admin.clone(),
        serde_json::json!({ "weight_kg": 0.2, "multiplier": 4 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let l296 = line(&quote().await, "CG-15296-A");
    assert_eq!((l296["material_cost"].as_f64(), l296["suggested_unit_price"].as_f64()), (Some(50.0), Some(200.0)));
    assert_eq!(l296["weight_source"], "solidworks");

    // Apply only to CG-15296-A; CG-15253-A has no suggestion and keeps no price.
    let (status, body) = post(
        format!("/api/admin/projects/{}/quote/apply", project.to_hex()),
        admin.clone(),
        serde_json::json!({ "concept_ids": [p296.to_hex(), p253.to_hex()] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let r = json(&body);
    assert_eq!((r["applied"].as_i64(), r["skipped"][0].as_str()), (Some(1), Some("CG-15253-A")));
    let q = quote().await;
    assert_eq!(line(&q, "CG-15296-A")["unit_price"], 200.0);
    assert!(line(&q, "CG-15253-A")["unit_price"].is_null());
    assert_eq!(q["quoted_total"], 200.0 * 30.0);

    // Costing from Seguimiento (Daniel, 2026-11-07): the admin types the price per piece.
    let set_price = format!("/api/admin/project_concepts/{}/unit_price", p253.to_hex());
    let (status, _) = post(set_price.clone(), jose.clone(), serde_json::json!({ "unit_price": 585 })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post(set_price.clone(), admin.clone(), serde_json::json!({ "unit_price": -1 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = post(set_price, admin.clone(), serde_json::json!({ "unit_price": 585 })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let q = quote().await;
    assert_eq!(line(&q, "CG-15253-A")["unit_price"], 585.0);

    // Expected material cost (Daniel, 2026-11-07): density and $/kg of the project's materials.
    let rates_path = format!("/api/admin/projects/{}/material_rates", project.to_hex());
    let (status, _) = get(rates_path.clone(), jose.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = get(rates_path, admin.clone()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let rates = json(&body);
    let rate = |m: &str| rates.as_array().unwrap().iter().find(|r| r["material"] == m).unwrap().clone();
    assert_eq!((rate("Aluminio 6061")["density_g_cm3"].as_f64(), rate("Aluminio 6061")["price_per_kg"].as_f64()), (Some(2.7), Some(250.0)));
    assert!(rate("4140")["price_per_kg"].is_null());
    assert_eq!(rate("4140")["density_g_cm3"], 7.85);

    // What the supplier quoted, saved next to the estimate.
    let quotes_path = format!("/api/admin/projects/{}/material_quotes", project.to_hex());
    let quote_body = serde_json::json!({
        "supplier": "HG Aceros", "total": 1800, "estimate_total": 1500,
        "lines": [{ "stock": "Aluminio 6061 solera 1\" × 1.5\" × 49.5\"", "kg": 1.2, "estimate": 300, "quoted": 360 }],
    });
    let (status, _) = post(quotes_path.clone(), jose.clone(), quote_body.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post(quotes_path.clone(), admin.clone(), serde_json::json!({ "supplier": "", "total": 10 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = post(quotes_path.clone(), admin.clone(), serde_json::json!({ "supplier": "HG", "total": 0 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = post(quotes_path.clone(), admin.clone(), quote_body).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, body) = get(quotes_path.clone(), admin.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let list = json(&body);
    assert_eq!((list[0]["supplier"].as_str(), list[0]["total"].as_f64(), list[0]["lines"][0]["quoted"].as_f64()), (Some("HG Aceros"), Some(1800.0), Some(360.0)));
    let qid = list[0]["id"].as_str().unwrap().to_string();
    let (status, _) = get(quotes_path.clone(), jose.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post(format!("/api/admin/material_quotes/{qid}/delete"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get(quotes_path, admin.clone()).await;
    assert_eq!(json(&body).as_array().unwrap().len(), 0);

    common::teardown(Some(ctx)).await;
}
