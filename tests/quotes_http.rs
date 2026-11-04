#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// add-quote-document: quote from the project with the template's folio, client values,
/// totals, revisions and "sent". Admin only.
#[tokio::test]
async fn quote_document_from_project() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "quotes-a.miapp.local";

    let company = create_company(&state, "Quotes A", "quotes-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "quotes-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "quotes-jose@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![UserPermission::ViewProjects, UserPermission::TakeWorkOrders])],
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

    // Company data and the Brabatech client (5 days, 50 %, Angel Cedillo).
    let (status, body) = post(
        "/api/admin/quote_settings".into(),
        admin.clone(),
        serde_json::json!({
            "company_name": "SONORA PRECISION", "address1": "BLVD CIMARRON No.403 COL. AGUALURCA",
            "address2": "HERMOSILLO, SON., MEX CP: 83297", "phone": "662 195 82 24",
            "email": "daniel@sonoraprecision.com", "web": "www.sonoraprecision.com",
            "iva_rate": 0.16, "retention_rate": 0.0125,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let braba = create_contact(&state, &company, "Brabatech", ContactType::Customer, None, None, None, None).await.unwrap();
    let (status, body) = post(
        format!("/api/admin/contacts/{}/quote_defaults", braba.to_hex()),
        admin.clone(),
        serde_json::json!({
            "abbreviation": "BRABA", "currency": "MXN", "language": "es", "iva": true, "retention": true,
            "validity_days": 5, "advance_pct": 50,
            "people": [{ "name": "Angel Cedillo", "initials": "AC" }],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project = create_project(
        &state, &company, "ZBL136", Some(braba), None, None, ProjectPriority::Medium, None, None, None,
    )
    .await
    .unwrap();
    let mut parts = Vec::new();
    for (i, (name, price)) in [("ZBL136-PLT-A260129-2", 1250.0), ("ZBL136-BLCK-A260129", 3850.0), ("SIN-PRECIO", 0.0)].into_iter().enumerate() {
        let id = create_project_concept(&state, &company, &project, None, name, 3.0, None, None, None, None, None, i as i32 + 1)
            .await
            .unwrap();
        if price > 0.0 {
            alfredodev::state::set_concept_unit_price(&state, &id, &company, Some(price)).await.unwrap();
        }
        parts.push(id);
    }
    // The project goes to Análisis before quoting.
    state
        .projects
        .update_one(mongodb::bson::doc! { "_id": project }, mongodb::bson::doc! { "$set": { "status": "analisis" } })
        .await
        .unwrap();

    // Programmers never see quotes.
    let quotes_path = format!("/api/admin/projects/{}/quotes", project.to_hex());
    let (status, _) = get(quotes_path.clone(), jose.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // First quote: folio of the day, the two priced parts, Brabatech's 5 days.
    let (status, body) = post(
        quotes_path.clone(),
        admin.clone(),
        serde_json::json!({ "attention": "Angel Cedillo", "attention_initials": "AC", "delivery_time": 20 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let q = json(&body);
    let day = alfredodev::state::folio_day(DateTime::now());
    assert_eq!(q["folio"], format!("{day}-01-00"));
    assert_eq!(q["lines"].as_array().unwrap().len(), 2);
    assert_eq!(q["lines"][1]["description"], "ZBL136-BLCK-A260129");
    assert_eq!((q["validity_days"].as_i64(), q["advance_pct"].as_f64()), (Some(5), Some(50.0)));
    assert_eq!(q["client_name"], "Brabatech");
    assert_eq!(q["client_abbreviation"], "BRABA");
    // 3 × 1,250 + 3 × 3,850 = 15,300 → IVA 2,448, ret 191.25 → 17,556.75.
    assert_eq!((q["subtotal"].as_f64(), q["iva_amount"].as_f64(), q["retention_amount"].as_f64(), q["net"].as_f64()),
        (Some(15_300.0), Some(2_448.0), Some(191.25), Some(17_556.75)));
    let id = q["id"].as_str().unwrap().to_string();

    // The document carries the company data.
    let (status, body) = get(format!("/api/admin/quotes/{id}"), admin.clone()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(json(&body)["company"]["company_name"], "SONORA PRECISION");

    // A second quote the same day takes the next number.
    let (_, body) = post(quotes_path.clone(), admin.clone(), serde_json::json!({})).await;
    assert_eq!(json(&body)["folio"], format!("{day}-02-00"));

    // Revision: same base, next revision, current prices; the first stays as it was.
    alfredodev::state::set_concept_unit_price(&state, &parts[0], &company, Some(1300.0)).await.unwrap();
    let (status, body) = post(format!("/api/admin/quotes/{id}/revise"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let rev = json(&body);
    assert_eq!(rev["folio"], format!("{day}-01-01"));
    assert_eq!(rev["lines"][0]["unit_price"], 1300.0);
    let (_, body) = get(format!("/api/admin/quotes/{id}"), admin.clone()).await;
    assert_eq!(json(&body)["lines"][0]["unit_price"], 1250.0);

    // Sent: the project moves from Análisis to Cotizado.
    let (status, _) = post(format!("/api/admin/quotes/{id}/sent"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let p = state.projects.find_one(mongodb::bson::doc! { "_id": project }).await.unwrap().unwrap();
    assert_eq!(p.status.as_str(), "cotizado");

    // Nothing to quote: a project without priced parts.
    let empty = create_project(&state, &company, "Vacío", None, None, None, ProjectPriority::Low, None, None, None).await.unwrap();
    let (status, body) = post(format!("/api/admin/projects/{}/quotes", empty.to_hex()), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");

    common::teardown(Some(ctx)).await;
}
