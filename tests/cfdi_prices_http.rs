#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

fn concepto(desc: &str, cantidad: &str, unidad: &str, importe: &str) -> bson::Document {
    doc! { "descripcion": desc, "cantidad": cantidad, "claveUnidad": unidad, "importe": importe, "valorUnitario": "0" }
}

/// Material prices read from the supplier invoices downloaded from the SAT (Daniel,
/// 2026-11-07): preview first, then saved; only received invoices count; admin only.
#[tokio::test]
async fn prices_from_supplier_invoices() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "cfdip-a.miapp.local";

    let company = create_company(&state, "CfdiP A", "cfdip-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "cfdip-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "cfdip-jose@example.com",
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

    alfredodev::state::create_sat_config(
        &state,
        mongodb::bson::oid::ObjectId::new(),
        company,
        "RIAD90102219A".into(),
        "c.cer".into(),
        "k.key".into(),
        "x".into(),
        None,
    )
    .await
    .unwrap();
    let cfdi = |uuid: &str, fecha: &str, folio: &str, emisor: &str, receptor: &str, conceptos: Vec<bson::Document>| {
        doc! {
            "company_id": company.to_hex(),
            "uuid": uuid,
            "comprobante": { "tipoDeComprobante": "I", "fecha": fecha, "folio": folio, "serie": "" },
            "emisor": { "rfc": emisor, "nombre": "HG ACEROS Y METALES DE HERMOSILLO" },
            "receptor": { "rfc": receptor, "nombre": "DANIEL" },
            "conceptos": conceptos,
        }
    };
    state
        .cfdis
        .insert_many(vec![
            cfdi("u-1", "2026-10-21T10:00:00", "85671", "HAM1611284W5", "RIAD90102219A", vec![
                concepto("Aluminio solera 6061 de 1\" x 2 1/2\" x 74\" 1 pza", "8.85", "KGM", "1858.50"),
                concepto("Barra Acero 4140R de 1 1/4\" x 200\" 1 pza", "33.40", "KGM", "2171.00"),
                concepto("SIERRA CINTA MADA DE 1\" X 130\" paso 4-6 1 pza", "1", "H87", "1300.00"),
            ]),
            // Newer: aluminum at 230.
            cfdi("u-2", "2026-10-28T10:00:00", "85989", "HAM1611284W5", "RIAD90102219A", vec![
                concepto("Aluminio solera 6061 de 1\" x 2\" x 60\" 1 pza", "5.85", "KGM", "1345.50"),
            ]),
            // Our own sale: never a supplier price.
            cfdi("u-3", "2026-11-01T10:00:00", "167", "RIAD90102219A", "BTE131008US3", vec![
                concepto("Placa aluminio 6061 de 1\" x 2\" x 60\" 1 pza", "5.85", "KGM", "9999.00"),
            ]),
        ])
        .await
        .unwrap();

    let (status, _) = post("/api/admin/material_prices/from_cfdis".into(), jose.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Preview: nothing saved yet.
    let (status, body) = post("/api/admin/material_prices/from_cfdis".into(), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let r = json(&body);
    assert_eq!(r["lines"].as_array().unwrap().len(), 3, "{body}");
    let alu = r["materials"].as_array().unwrap().iter().find(|m| m["material"] == "Aluminio 6061").unwrap().clone();
    assert_eq!((alu["price_per_kg"].as_f64(), alu["folio"].as_str()), (Some(230.0), Some("85989")), "newest invoice wins");
    assert_eq!((alu["min"].as_f64(), alu["max"].as_f64(), alu["lines"].as_u64()), (Some(210.0), Some(230.0), Some(2)));
    assert!(r["updated"].is_null());
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, "/api/admin/material_prices", &admin).await;
    assert_eq!(json(&body).as_array().unwrap().len(), 0, "{body}");

    // Saved.
    let (status, body) =
        post("/api/admin/material_prices/from_cfdis".into(), admin.clone(), serde_json::json!({ "apply": true })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(json(&body)["updated"], 2);
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, "/api/admin/material_prices", &admin).await;
    let prices = json(&body);
    let p = |m: &str| prices.as_array().unwrap().iter().find(|p| p["material"] == m).cloned();
    assert_eq!(p("Aluminio 6061").unwrap()["price_per_kg"], 230.0);
    assert_eq!(p("4140 R").unwrap()["price_per_kg"], 65.0);
    assert_eq!(p("Aluminio 6061").unwrap()["history"].as_array().unwrap().len(), 2, "{body}");
    // Reading again replaces the points instead of doubling them.
    let (status, _) =
        post("/api/admin/material_prices/from_cfdis".into(), admin.clone(), serde_json::json!({ "apply": true })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, "/api/admin/material_prices", &admin).await;
    let prices = json(&body);
    let alu = prices.as_array().unwrap().iter().find(|p| p["material"] == "Aluminio 6061").unwrap().clone();
    assert_eq!(alu["history"].as_array().unwrap().len(), 2, "{body}");
}
