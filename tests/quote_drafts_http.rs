#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// From the client's request (Daniel, 2026-11-07): a draft with part numbers, quantities and
/// each drawing, no prices yet; it is filled in place, generated, and when approved the
/// drawings go to the parts of the project.
#[tokio::test]
async fn quote_draft_with_drawings_becomes_a_project() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let store = std::env::temp_dir().join(format!("quote_files_test_{}", std::process::id()));
    // SAFETY: set once before any request in this test binary.
    unsafe { std::env::set_var("PART_FILE_STORE_DIR", &store) };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "drafts-a.miapp.local";

    let company = create_company(&state, "Drafts A", "drafts-a", "MXN", true, None).await.unwrap();
    let other = create_company(&state, "Drafts B", "drafts-b", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "drafts-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let outsider_id = create_user(&state, "drafts-out@example.com", "SECRET", &[(other.clone(), UserRole::Admin)])
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
    let outsider = session(outsider_id).await;
    let post = |path: String, body: serde_json::Value| {
        let shared = shared.clone();
        let admin = admin.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &admin, body).await }
    };
    let client = create_contact(&state, &company, "Brabatech", ContactType::Customer, None, None, None, None).await.unwrap();
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();

    // The drawing of each part, uploaded before there is a project. Only PDFs.
    let pdf: &[u8] = b"%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n";
    let (status, _) =
        post_multipart_with_cookie(build_app(shared.clone()), host, "/api/admin/quote_files", &admin, &[("file", Some("x.png"), b"\x89PNG")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) =
        post_multipart_with_cookie(build_app(shared.clone()), host, "/api/admin/quote_files", &admin, &[("file", Some("PA-1001 Rev A.pdf"), pdf)]).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let drawing = json(&body);
    let drawing_id = drawing["id"].as_str().unwrap().to_string();
    let (status, bytes) = get_with_cookie(build_app(shared.clone()), host, drawing["url"].as_str().unwrap(), &admin).await;
    assert_eq!((status, bytes.starts_with("%PDF")), (StatusCode::OK, true));
    // Another company never sees it.
    let (status, _) =
        get_with_cookie(build_app(shared.clone()), "drafts-b.miapp.local", drawing["url"].as_str().unwrap(), &outsider).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A generated quote needs every price; a draft does not.
    let lines = serde_json::json!([
        { "quantity": 20, "description": "PA-1001", "drawing_id": drawing_id },
        { "quantity": 4, "description": "PA-1002" },
    ]);
    let (status, _) = post("/api/admin/quotes".into(), serde_json::json!({ "contact_id": client.to_hex(), "lines": lines })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) =
        post("/api/admin/quotes".into(), serde_json::json!({ "contact_id": client.to_hex(), "lines": lines, "draft": true })).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let q = json(&body);
    assert_eq!(q["draft"], true);
    assert_eq!(q["lines"][0]["drawing_name"], "PA-1001 Rev A.pdf");
    let id = q["id"].as_str().unwrap().to_string();
    let folio = q["folio"].as_str().unwrap().to_string();

    // A draft is not sent, revised or turned into a project.
    for action in ["sent", "revise", "project"] {
        let (status, body) = post(format!("/api/admin/quotes/{id}/{action}"), serde_json::json!({})).await;
        assert_eq!(status, StatusCode::CONFLICT, "{action}: {body}");
    }
    // Someone else's drawing is refused.
    let (status, _) = post(
        format!("/api/admin/quotes/{id}/update"),
        serde_json::json!({ "contact_id": client.to_hex(), "draft": true,
            "lines": [{ "quantity": 1, "description": "X", "drawing_id": mongodb::bson::oid::ObjectId::new().to_hex() }] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Measures and the first price go in; it stays a draft with the same folio.
    let alu = serde_json::json!({ "material": "Aluminio 6061", "shape": "solera", "thickness": 1.0, "width": 2.0, "length": 2.5,
        "part_thickness": 0.748, "part_width": 1.969, "part_length": 2.362, "saw_kerf": 0.125 });
    let (status, body) = post(
        format!("/api/admin/quotes/{id}/update"),
        serde_json::json!({ "contact_id": client.to_hex(), "draft": true, "lines": [
            { "quantity": 20, "description": "PA-1001", "drawing_id": drawing_id, "material": alu, "unit_price": 350 },
            { "quantity": 4, "description": "PA-1002" },
        ] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let q = json(&body);
    assert_eq!((q["id"].as_str(), q["folio"].as_str(), q["draft"].as_bool()), (Some(id.as_str()), Some(folio.as_str()), Some(true)));
    assert_eq!(q["lines"][0]["material"]["part_length"], 2.362);

    // Generated with every price: no longer a draft, and no longer edited in place.
    let (status, body) = post(
        format!("/api/admin/quotes/{id}/update"),
        serde_json::json!({ "contact_id": client.to_hex(), "lines": [
            { "quantity": 20, "description": "PA-1001", "drawing_id": drawing_id, "material": alu, "unit_price": 350 },
            { "quantity": 4, "description": "PA-1002", "unit_price": 900 },
        ] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let q = json(&body);
    assert_eq!((q["draft"].as_bool(), q["subtotal"].as_f64()), (Some(false), Some(10_600.0)));
    let (status, _) = post(format!("/api/admin/quotes/{id}/update"), serde_json::json!({ "contact_id": client.to_hex(), "draft": true, "lines": lines })).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Approved: the drawing is now the part's drawing.
    let (status, body) = post(format!("/api/admin/quotes/{id}/project"), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let pid = mongodb::bson::oid::ObjectId::parse_str(json(&body)["project_id"].as_str().unwrap()).unwrap();
    let mut parts = alfredodev::state::list_project_concepts(&state, &company, &pid).await.unwrap();
    parts.sort_by_key(|c| c.position);
    let files = alfredodev::state::list_part_files(&state, &company, &[parts[0].id.unwrap(), parts[1].id.unwrap()]).await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!((files[0].concept_id, files[0].original_filename.as_str()), (parts[0].id.unwrap(), "PA-1001 Rev A.pdf"));
    assert_eq!(parts[0].material.as_ref().and_then(|m| m.part_length), Some(2.362));
}
