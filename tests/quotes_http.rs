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

    // --- Quote before the project (Daniel, 2026-11-06) ---------------------------------
    // Programmers never see the quotes page.
    let (status, _) = get("/api/admin/quotes".into(), jose.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post("/api/admin/quotes".into(), jose.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Suggested price from the blank: 0.5 × 2 × 3 in of aluminum = 0.1327 kg × $100 × 3.5 → 47.
    alfredodev::state::set_material_price(&state, company, "Aluminio 6061", Some(100.0), None, admin_id).await.unwrap();
    let alu = serde_json::json!({ "material": "Aluminio 6061", "shape": "placa", "thickness": 0.5, "width": 2.0, "length": 3.0 });
    let (status, body) = post("/api/admin/quotes/suggest".into(), admin.clone(), serde_json::json!({ "lines": [{ "material": alu }, {}] })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let s = json(&body);
    assert_eq!(s[0]["suggested_unit_price"], 47.0);
    assert_eq!(s[1]["missing"][0], "material");

    // Needs a client and at least one line.
    let (status, _) = post("/api/admin/quotes".into(), admin.clone(), serde_json::json!({ "lines": [{ "quantity": 1, "description": "X", "unit_price": 1 }] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = post("/api/admin/quotes".into(), admin.clone(), serde_json::json!({ "contact_id": braba.to_hex() })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, body) = post(
        "/api/admin/quotes".into(),
        admin.clone(),
        serde_json::json!({
            "contact_id": braba.to_hex(), "attention": "Angel Cedillo",
            "lines": [
                { "quantity": 10, "description": "PA-R261019-1B", "unit_price": 450, "material": alu, "multiplier": 4.0 },
                { "quantity": 2, "description": "PA-R261019-2", "unit_price": 1200 },
            ],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let sq = json(&body);
    assert!(sq["project_id"].is_null());
    assert_eq!(sq["folio"], format!("{day}-03-00"));
    assert_eq!(sq["subtotal"], 6_900.0);
    let sq_id = sq["id"].as_str().unwrap().to_string();

    // A revision with other lines keeps the folio base.
    let (status, body) = post(
        "/api/admin/quotes".into(),
        admin.clone(),
        serde_json::json!({
            "revision_of": sq_id,
            "lines": [
                { "quantity": 10, "description": "PA-R261019-1B", "unit_price": 430, "material": alu, "multiplier": 4.0 },
                { "quantity": 2, "description": "PA-R261019-2", "unit_price": 1200 },
            ],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let rev = json(&body);
    assert_eq!(rev["folio"], format!("{day}-03-01"));
    assert_eq!(rev["client_name"], "Brabatech");
    let rev_id = rev["id"].as_str().unwrap().to_string();

    // Sent without a project: just the date.
    let (status, _) = post(format!("/api/admin/quotes/{rev_id}/sent"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);

    // Every quote is listed; the new ones have no project yet.
    let (_, body) = get("/api/admin/quotes".into(), admin.clone()).await;
    let all = json(&body);
    assert_eq!(all.as_array().unwrap().len(), 5);
    assert!(all[0]["project_id"].is_null());

    // Approved: the revision becomes a project in Pedidos with its parts and prices.
    let (status, body) = post(format!("/api/admin/quotes/{rev_id}/project"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let made = json(&body);
    assert_eq!(made["title"], format!("BRABA {day}-03-01"));
    let pid = mongodb::bson::oid::ObjectId::parse_str(made["project_id"].as_str().unwrap()).unwrap();
    let p = state.projects.find_one(mongodb::bson::doc! { "_id": pid }).await.unwrap().unwrap();
    assert_eq!((p.status.as_str(), p.contact_id), ("pedidos", Some(braba)));
    assert_eq!(p.total_budget, Some(6_700.0));
    let mut parts = alfredodev::state::list_project_concepts(&state, &company, &pid).await.unwrap();
    parts.sort_by_key(|c| c.position);
    assert_eq!(parts.len(), 2);
    assert_eq!((parts[0].name.as_str(), parts[0].quantity, parts[0].unit_price), ("PA-R261019-1B", 10.0, Some(430.0)));
    assert_eq!(parts[0].material.as_ref().and_then(|m| m.material.as_deref()), Some("Aluminio 6061"));
    assert_eq!(parts[0].quote.as_ref().and_then(|q| q.multiplier), Some(4.0));
    assert!(parts[0].work_order_number.is_some());
    assert_eq!((parts[1].unit_price, parts[1].material.is_none()), (Some(1200.0), true));

    // Both revisions now point to the project; a folio becomes a project only once.
    let (_, body) = get(format!("/api/admin/quotes/{sq_id}"), admin.clone()).await;
    let first = json(&body);
    assert_eq!(first["project_id"], pid.to_hex());
    assert_eq!(first["project_title"], format!("BRABA {day}-03-01"));
    let (status, body) = post(format!("/api/admin/quotes/{sq_id}/project"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {body}");
    assert_eq!(json(&body)["project_id"], pid.to_hex());
    let (_, body) = get(format!("/api/admin/quotes/{rev_id}"), admin.clone()).await;
    assert!(!json(&body)["lines"][0]["concept_id"].is_null());

    common::teardown(Some(ctx)).await;
}
