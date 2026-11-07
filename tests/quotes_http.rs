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

    // A revision with other lines keeps the folio base. Its material is the full one from the
    // editor (part size, saw cut, bar to order) and it reaches the part as it is.
    let alu_full = serde_json::json!({
        "material": "Aluminio 6061", "shape": "solera", "thickness": 0.5, "width": 2.0, "length": 3.0,
        "part_thickness": 0.45, "part_width": 1.9, "part_length": 2.9, "saw_kerf": 0.125,
        "bar_to_order": "1/2\" × 2\" × 31.25\"",
    });
    let (status, body) = post(
        "/api/admin/quotes".into(),
        admin.clone(),
        serde_json::json!({
            "revision_of": sq_id,
            "lines": [
                { "quantity": 10, "description": "PA-R261019-1B", "unit_price": 430, "material": alu_full, "multiplier": 4.0 },
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
    let m = parts[0].material.as_ref().unwrap();
    assert_eq!(m.material.as_deref(), Some("Aluminio 6061"));
    assert_eq!((m.part_thickness, m.part_length, m.saw_kerf), (Some(0.45), Some(2.9), Some(0.125)));
    assert_eq!(m.bar_to_order.as_deref(), Some("1/2\" × 2\" × 31.25\""));
    assert!(!m.ordered, "a quoted part still has its material to order");
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

    // --- What each part was quoted / sold for ------------------------------------------
    let (status, body) = post(
        "/api/admin/quotes/references".into(),
        admin.clone(),
        serde_json::json!({ "names": ["pa-r261019-1b", "ZBL136-PLT-A260129-2", "NUEVA"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let refs = json(&body);
    // Newest first; the parts made from the quote are not told twice.
    assert_eq!(refs[0].as_array().unwrap().len(), 2, "{refs}");
    assert_eq!((refs[0][0]["unit_price"].as_f64(), refs[0][0]["kind"].as_str()), (Some(430.0), Some("aprobada")));
    assert_eq!(refs[0][0]["client_name"], "Brabatech");
    assert_eq!(refs[1][0]["unit_price"], 1300.0);
    assert!(refs[2].as_array().unwrap().is_empty());
    // A part priced in a project without a quote counts as sold.
    let loose = create_project_concept(&state, &company, &empty, None, "SUELTA-1", 4.0, None, None, None, None, None, 1).await.unwrap();
    alfredodev::state::set_concept_unit_price(&state, &loose, &company, Some(275.0)).await.unwrap();
    let (_, body) = post("/api/admin/quotes/references".into(), admin.clone(), serde_json::json!({ "names": ["suelta 1"] })).await;
    assert_eq!((json(&body)[0][0]["kind"].as_str(), json(&body)[0][0]["unit_price"].as_f64()), (Some("vendida"), Some(275.0)));
    let (_, body) = get("/api/admin/quotes/part_names".into(), admin.clone()).await;
    assert!(json(&body).as_array().unwrap().iter().any(|n| n == "PA-R261019-1B"), "{body}");
    let (status, _) = post("/api/admin/quotes/references".into(), jose.clone(), serde_json::json!({ "names": ["x"] })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // --- Material prices from invoices (Daniel, 2026-11-06) -----------------------------
    // Billed by kg: 288 / 2.4 kg = 120; billed by piece: kilos from the bar (Ø2.5 × 16 × 2).
    let (status, body) = post(
        "/api/production/material_receipts".into(),
        admin.clone(),
        serde_json::json!({
            "supplier": "HG Aceros y Metales de Hermosillo", "folio": "F90001",
            "lines": [
                { "description": "Aluminio solera 6061 de 1/4\" x 1 1/2\" x 144\" ( 1 pz )", "quantity": 2.4, "unit": "KGM", "amount": 288.0 },
                { "description": "Redondo 1045 de 2 1/2\" x 16\"", "quantity": 2, "unit": "H87", "amount": 808.26 },
                { "description": "Flete", "quantity": 1, "unit": "E48", "amount": 300.0 },
            ],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let receipt = json(&body)["id"].as_str().unwrap().to_string();
    let prices = |body: &str| -> std::collections::HashMap<String, serde_json::Value> {
        json(body).as_array().unwrap().iter().map(|p| (p["material"].as_str().unwrap().to_string(), p.clone())).collect()
    };
    let (_, body) = get("/api/admin/material_prices".into(), admin.clone()).await;
    let p = prices(&body);
    // The invoice is newer than the price written by hand, so it replaces it.
    assert_eq!((p["Aluminio 6061"]["price_per_kg"].as_f64(), p["Aluminio 6061"]["source"].as_str()), (Some(120.0), Some("factura")));
    assert!(p["Aluminio 6061"]["note"].as_str().unwrap().contains("F90001"));
    assert_eq!(p["1045"]["price_per_kg"], 40.0);
    assert_eq!(p["1045"]["history"][0]["kg_source"], "calculado");
    // The quote finds it as "Acero 1045".
    let (_, body) = post(
        "/api/admin/quotes/suggest".into(),
        admin.clone(),
        serde_json::json!({ "lines": [{ "material": { "material": "Acero 1045", "shape": "redondo", "thickness": 2.5, "length": 16.0 } }] }),
    )
    .await;
    assert_eq!(json(&body)[0]["price_per_kg"], 40.0);

    // An older invoice loaded later goes to the history, not over the current price.
    let (status, _) = post(
        "/api/production/material_receipts".into(),
        admin.clone(),
        serde_json::json!({
            "supplier": "HG", "folio": "F80000", "received_at": "2026-01-15T12:00:00-07:00",
            "lines": [{ "description": "Aluminio solera 6061 de 1/4\" x 1 1/2\" x 144\" ( 1 pz )", "quantity": 2.4, "unit": "KGM", "amount": 216.0 }],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, body) = get("/api/admin/material_prices".into(), admin.clone()).await;
    let p = prices(&body);
    assert_eq!(p["Aluminio 6061"]["price_per_kg"], 120.0);
    let history: Vec<f64> = p["Aluminio 6061"]["history"].as_array().unwrap().iter().map(|h| h["price_per_kg"].as_f64().unwrap()).collect();
    assert_eq!(history, vec![120.0, 90.0]);

    // Programmers see the receipt, never its prices.
    let (status, body) = get(format!("/api/production/material_receipts/{receipt}"), jose.clone()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(!body.contains("price_per_kg") && !body.contains("808"), "{body}");
    let (_, body) = get(format!("/api/production/material_receipts/{receipt}"), admin.clone()).await;
    assert_eq!(json(&body)["lines"][1]["price"]["price_per_kg"], 40.0);
    let (status, _) = post(format!("/api/production/material_receipts/{receipt}/prices"), jose.clone(), serde_json::json!({ "lines": [] })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Amounts captured later (a PDF): replace that receipt's prices.
    let (status, body) = post(
        format!("/api/production/material_receipts/{receipt}/prices"),
        admin.clone(),
        serde_json::json!({ "lines": [{ "line": 1, "amount": 300.0 }, { "line": 2, "amount": null }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(json(&body)["priced"], 1);
    let (_, body) = get("/api/admin/material_prices".into(), admin.clone()).await;
    assert_eq!(prices(&body)["Aluminio 6061"]["price_per_kg"], 125.0);

    common::teardown(Some(ctx)).await;
}
