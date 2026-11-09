#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// The admin attaches the PDF drawing to a part; programmers open it but cannot upload or
/// delete; other companies never see it.
#[tokio::test]
async fn part_drawings_upload_open_and_delete() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    // A store folder of our own so tests never touch the dev tree.
    let store = std::env::temp_dir().join(format!("part_files_test_{}", std::process::id()));
    // SAFETY: set once before any request in this test binary.
    unsafe { std::env::set_var("PART_FILE_STORE_DIR", &store) };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company = create_company(&state, "Files A", "files-a", "MXN", true, None).await.unwrap();
    let other = create_company(&state, "Files B", "files-b", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "files-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "files-jose@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProjects, UserPermission::TakeWorkOrders],
        )],
    )
    .await
    .unwrap();
    let outsider_id = create_user(&state, "files-outsider@example.com", "SECRET", &[(other.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let token = |id| {
        let state = state.clone();
        async move {
            let user = get_user_by_id(&state, &id).await.unwrap().unwrap();
            create_session(&state, &user.username).await.unwrap()
        }
    };
    let admin = token(admin_id).await;
    let jose = token(jose_id).await;
    let outsider = token(outsider_id).await;
    let host = "files-a.miapp.local";

    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project = create_project(
        &state, &company, "Pallets", None, None, None, ProjectPriority::Medium, None, None, None,
    )
    .await
    .unwrap();
    let concept = create_project_concept(
        &state, &company, &project, None, "CG-15253-A", 40.0, Some("pza".into()), None, None, None, None, 1,
    )
    .await
    .unwrap();
    let upload = format!("/api/admin/project_concepts/{}/drawing", concept.to_hex());
    let pdf: &[u8] = b"%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n";

    // Only PDFs, only the admin.
    let (status, _) = post_multipart_with_cookie(
        build_app(shared.clone()), host, &upload, &jose, &[("file", Some("CG-15253-A.pdf"), pdf)],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = post_multipart_with_cookie(
        build_app(shared.clone()), host, &upload, &admin, &[("file", Some("foto.png"), b"\x89PNG....")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let (status, body) = post_multipart_with_cookie(
        build_app(shared.clone()), host, &upload, &admin, &[("file", Some("CG-15253-A Rev B.pdf"), pdf)],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let file = json(&body);
    assert_eq!(file["filename"], "CG-15253-A Rev B.pdf");
    let url = file["url"].as_str().unwrap().to_string();

    // The programmer lists and opens it.
    let list = format!("/api/admin/projects/{}/part_files", project.to_hex());
    let (status, body) = get_with_cookie(build_app(shared.clone()), host, &list, &jose).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let files = json(&body);
    assert_eq!(files[0]["concept_id"], concept.to_hex());
    let (status, body) = get_with_cookie(build_app(shared.clone()), host, &url, &jose).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.starts_with("%PDF-"), "{body}");

    // The PDF keeps a CSP that lets the app's own pages frame it (hover preview).
    let app = build_app(shared.clone()).layer(middleware::from_fn(alfredodev::session::security_headers));
    let req = Request::builder()
        .uri(&url)
        .header("host", host)
        .header("cookie", format!("{SESSION_COOKIE_NAME}={jose}"))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let csp = res.headers()["content-security-policy"].to_str().unwrap().to_string();
    assert!(csp.contains("frame-ancestors 'self'"), "{csp}");

    // Quality (no view_projects) sees every drawing of the company and opens it.
    let bere_id = create_user_with_permissions(
        &state,
        "files-bere@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![UserPermission::ReleaseParts])],
    )
    .await
    .unwrap();
    let bere = token(bere_id).await;
    let (status, body) =
        get_with_cookie(build_app(shared.clone()), host, "/api/production/part_drawings", &bere).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let all = json(&body);
    assert_eq!(all.as_array().unwrap().len(), 1, "{body}");
    assert_eq!(all[0]["concept_id"], concept.to_hex());
    let (status, _) = get_with_cookie(build_app(shared.clone()), host, &url, &bere).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) =
        get_with_cookie(build_app(shared.clone()), "files-b.miapp.local", "/api/production/part_drawings", &outsider)
            .await;
    assert_eq!(json(&body).as_array().unwrap().len(), 0, "{body}");

    // Another company cannot open it.
    let (status, _) = get_with_cookie(build_app(shared.clone()), "files-b.miapp.local", &url, &outsider).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Only the admin deletes; then it is gone from the list.
    let delete = format!("{url}/delete");
    let (status, _) =
        post_json_with_cookie(build_app(shared.clone()), host, &delete, &jose, serde_json::json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) =
        post_json_with_cookie(build_app(shared.clone()), host, &delete, &admin, serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, &list, &jose).await;
    assert_eq!(json(&body).as_array().unwrap().len(), 0, "{body}");

    // Project documents (purchase order, quote): admin only, PDFs only, per company.
    let docs = format!("/api/admin/projects/{}/documents", project.to_hex());
    let (status, _) = post_multipart_with_cookie(
        build_app(shared.clone()), host, &docs, &jose,
        &[("kind", None, &b"orden_compra"[..]), ("file", Some("PO-C261109-1 Cople.pdf"), pdf)],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = post_multipart_with_cookie(
        build_app(shared.clone()), host, &docs, &admin,
        &[("kind", None, &b"factura"[..]), ("file", Some("x.pdf"), pdf)],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let (status, body) = post_multipart_with_cookie(
        build_app(shared.clone()), host, &docs, &admin,
        &[("kind", None, &b"orden_compra"[..]), ("file", Some("PO-C261109-1 Cople.pdf"), pdf)],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let po = json(&body);
    assert_eq!(po["kind"], "orden_compra");
    assert_eq!(po["filename"], "PO-C261109-1 Cople.pdf");
    let po_url = po["url"].as_str().unwrap().to_string();
    let (status, body) = get_with_cookie(build_app(shared.clone()), host, &docs, &admin).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(json(&body).as_array().unwrap().len(), 1, "{body}");
    let (status, body) = get_with_cookie(build_app(shared.clone()), host, &po_url, &admin).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.starts_with("%PDF-"), "{body}");
    // The programmer sees neither the list nor the file (prices).
    let (status, _) = get_with_cookie(build_app(shared.clone()), host, &docs, &jose).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = get_with_cookie(build_app(shared.clone()), host, &po_url, &jose).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Another company's admin cannot open it.
    let (status, _) = get_with_cookie(build_app(shared.clone()), "files-b.miapp.local", &po_url, &outsider).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()), host, &format!("{po_url}/delete"), &admin, serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, &docs, &admin).await;
    assert_eq!(json(&body).as_array().unwrap().len(), 0, "{body}");

    let _ = std::fs::remove_dir_all(&store);
    common::teardown(Some(ctx)).await;
}
