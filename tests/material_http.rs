#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// add-part-material: the material of each part, an invoice read as bars, the match against
/// what each part needs and the assignment (the F86241 comparison of 2026-11-03).
#[tokio::test]
async fn material_receipt_matches_and_assigns_bars() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "mat-a.miapp.local";

    let company = create_company(&state, "Mat A", "mat-a", "MXN", true, None).await.unwrap();
    let other = create_company(&state, "Mat B", "mat-b", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "mat-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "mat-jose@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProjects, UserPermission::TakeWorkOrders],
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
    let p288 = part("CG-15288-A", 1).await;
    let p289 = part("CG-15289-A", 2).await;
    let p296 = part("CG-15296-A", 3).await;

    // Material of each part: admin only.
    let material = |t: f64, w: f64, l: f64| {
        serde_json::json!({
            "material": "Aluminio 6061", "shape": "Solera",
            "thickness": t, "width": w, "length": l, "ordered": true,
        })
    };
    let (status, _) = post(
        format!("/api/admin/project_concepts/{}/material", p288.to_hex()),
        jose.clone(),
        material(0.125, 1.75, 5.0),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for (id, m) in [
        (p288, material(0.125, 1.75, 5.0)),
        (p289, material(0.1875, 1.5, 5.0)),
        (p296, material(1.0, 1.5, 1.5)),
    ] {
        let (status, body) = post(format!("/api/admin/project_concepts/{}/material", id.to_hex()), admin.clone(), m).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
    }
    let (status, _) = post(
        format!("/api/admin/project_concepts/{}/material", p296.to_hex()),
        admin.clone(),
        serde_json::json!({ "material": "Aluminio 6061", "thickness": -1 }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let concepts = |tok: String| {
        let get = get.clone();
        async move {
            let (status, body) = get(format!("/api/admin/projects/{}/concepts", project.to_hex()), tok).await;
            assert_eq!(status, StatusCode::OK, "body: {body}");
            json(&body)
        }
    };
    let list = concepts(jose.clone()).await;
    let c288 = list.as_array().unwrap().iter().find(|c| c["name"] == "CG-15288-A").unwrap().clone();
    assert_eq!(c288["material"]["shape"], "solera");
    assert_eq!(c288["material_status"], "pedido");

    // A CFDI of another company is never read.
    state
        .cfdis
        .insert_one(mongodb::bson::doc! { "uuid": "AAAA-OTHER", "company_id": other.to_hex(), "conceptos": [] })
        .await
        .unwrap();
    let (status, _) = post(
        "/api/production/material_receipts".into(),
        admin.clone(),
        serde_json::json!({ "cfdi_uuid": "aaaa-other" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The HG Aceros invoice, captured: lines read as bars, no prices kept.
    let lines = [
        "ALUMINIO SOLERA DE 1/8\" X 2\" X 144\" ( 1 pz )",
        "ALUMINIO SOLERA DE 1/8\" X 2\" X 36\" ( 1 pz )",
        "Aluminio solera 6061 de 1\" x 1 1/2\" x 65 ( 1 pz )",
        "Aluminio solera 6061 de 3/8\" x 2\" x 144\" ( 1 pz )",
    ];
    let (status, _) = post(
        "/api/production/material_receipts".into(),
        jose.clone(),
        serde_json::json!({ "supplier": "HG Aceros", "lines": [{ "description": lines[0] }] }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = post(
        "/api/production/material_receipts".into(),
        admin.clone(),
        serde_json::json!({
            "supplier": "HG Aceros y Metales de Hermosillo",
            "folio": "F86241",
            "lines": lines.iter().map(|d| serde_json::json!({ "description": d, "quantity": 1.6, "unit": "KGM" })).collect::<Vec<_>>(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let receipt = json(&body)["id"].as_str().unwrap().to_string();

    let (status, body) = get(format!("/api/production/material_receipts/{receipt}"), jose.clone()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(!body.contains("250") && !body.contains("valor"), "prices leaked: {body}");
    let r = json(&body);
    let line = |n: usize| r["lines"][n].clone();
    assert_eq!(line(0)["thickness"], 0.125);
    assert_eq!(line(0)["width"], 2.0);
    assert_eq!(line(0)["length"], 144.0);
    // The 1/8 x 2 bar suits CG-15288-A (wider) but never the thicker CG-15289-A.
    let s0 = line(0)["suggestions"].as_array().unwrap().clone();
    assert_eq!(s0.len(), 1, "{s0:?}");
    assert_eq!(s0[0]["part"], "CG-15288-A");
    assert_eq!(s0[0]["fit"], "larger");
    assert_eq!(s0[0]["pieces"], 28);
    assert!(s0[0]["note"].as_str().unwrap().contains("ancho 2\" en vez de 1.75\""));
    // The 1 x 1 1/2 x 65 bar is exact for CG-15296-A: 41 pieces.
    let s2 = line(2)["suggestions"].as_array().unwrap().clone();
    let exact = s2.iter().find(|s| s["part"] == "CG-15296-A").unwrap();
    assert_eq!((exact["fit"].as_str(), exact["pieces"].as_i64()), (Some("exact"), Some(41)));

    // Assign both 1/8 x 2 bars to CG-15288-A: 28 + 7 = 35 pieces for 30.
    for n in [1, 2] {
        let (status, body) = post(
            format!("/api/production/material_receipts/{receipt}/lines/{n}/assign"),
            admin.clone(),
            serde_json::json!({ "concept_ids": [p288.to_hex()] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
    }
    let (status, _) = post(
        format!("/api/production/material_receipts/{receipt}/lines/3/assign"),
        jose.clone(),
        serde_json::json!({ "concept_ids": [p296.to_hex()] }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, body) = get(format!("/api/production/material_receipts/{receipt}"), admin.clone()).await;
    let r = json(&body);
    let cover = r["parts"].as_array().unwrap();
    assert_eq!(cover.len(), 1, "{body}");
    assert_eq!(cover[0]["part"], "CG-15288-A");
    assert_eq!((cover[0]["needed"].as_f64(), cover[0]["available"].as_i64()), (Some(30.0), Some(35)));
    assert_eq!(r["lines"][0]["assigned"][0]["part"], "CG-15288-A");
    // Each bar counts the other one: 28 + 7 (bar 2) and 7 + 28 (bar 1).
    let other_bars = &r["lines"][0]["suggestions"][0]["other_bars"];
    assert_eq!(other_bars, &serde_json::json!([{ "line": 2, "pieces": 7, "assigned": true }]), "{body}");
    assert_eq!(r["lines"][1]["suggestions"][0]["other_bars"][0]["pieces"], 28);

    let list = concepts(jose.clone()).await;
    let status_of = |name: &str| list.as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()["material_status"].clone();
    assert_eq!(status_of("CG-15288-A"), "recibido");
    assert_eq!(status_of("CG-15296-A"), "pedido");

    // Cut list: CG-15288-A cuts 28 from the 144" bar and 2 from the 36" one; CG-15296-A has
    // no bar assigned yet.
    let (status, body) = get("/api/production/cut_list".into(), jose.clone()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let cuts = json(&body);
    let item = |name: &str| cuts.as_array().unwrap().iter().find(|c| c["part"] == name).unwrap().clone();
    let c288 = item("CG-15288-A");
    let bars: Vec<(i64, f64)> =
        c288["bars"].as_array().unwrap().iter().map(|b| (b["cuts"].as_i64().unwrap(), b["leftover"].as_f64().unwrap())).collect();
    assert_eq!(bars, [(28, 2.25), (2, 25.875)], "{body}");
    assert_eq!((c288["planned"].as_i64(), c288["status"].as_str()), (Some(30), Some("recibido")));
    assert_eq!(c288["material"]["length"], 5.0);
    let c296 = item("CG-15296-A");
    assert_eq!((c296["planned"].as_i64(), c296["status"].as_str()), (Some(0), Some("pedido")));

    // "Corte terminado" marks "Material habilitado"; it must exist in the catalog.
    let done = format!("/api/production/cut_list/{}/done", p288.to_hex());
    let (status, _) = post(done.clone(), jose.clone(), serde_json::json!({ "done": true })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no Material habilitado step yet");
    let (status, body) = post(
        "/api/admin/process_operations".into(),
        admin.clone(),
        serde_json::json!({ "name": "Material habilitado", "position": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let (status, body) = post(done.clone(), jose.clone(), serde_json::json!({ "done": true })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get("/api/production/cut_list".into(), jose.clone()).await;
    let c288 = json(&body).as_array().unwrap().iter().find(|c| c["part"] == "CG-15288-A").unwrap().clone();
    assert_eq!((c288["cut_done"].as_bool(), c288["status"].as_str()), (Some(true), Some("cortado")));

    // Another company does not see the receipt.
    let out_id = create_user(&state, "mat-out@example.com", "SECRET", &[(other.clone(), UserRole::Admin)]).await.unwrap();
    let out = session(out_id).await;
    let (status, _) =
        get_with_cookie(build_app(shared.clone()), "mat-b.miapp.local", &format!("/api/production/material_receipts/{receipt}"), &out).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    common::teardown(Some(ctx)).await;
}
