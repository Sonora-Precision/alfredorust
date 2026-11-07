#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// Daniel, 2026-11-06: close a project into "Terminados", hold a step up with a note,
/// comments / scrap / notes on part numbers (notes come back with the part number in another
/// project) and the suggestion box.
#[tokio::test]
async fn close_block_comments_and_suggestions() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "notes-a.miapp.local";

    let company = create_company(&state, "Notes A", "notes-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "notes-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "notes-jose@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![UserPermission::ViewProjects, UserPermission::TakeWorkOrders])],
    )
    .await
    .unwrap();
    let ana_id = create_user_with_permissions(
        &state,
        "notes-ana@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![UserPermission::ViewProjects])],
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
    let ana = session(ana_id).await;
    let post = |path: String, tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &tok, body).await }
    };
    let get = |path: String, tok: String| {
        let shared = shared.clone();
        async move { get_with_cookie(build_app(shared), host, &path, &tok).await }
    };

    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let pallets = create_project(&state, &company, "Pallets", None, None, None, ProjectPriority::Medium, None, None, None)
        .await
        .unwrap();
    let older = create_project(&state, &company, "Pallets 2025", None, None, None, ProjectPriority::Medium, None, None, None)
        .await
        .unwrap();
    let part = create_project_concept(&state, &company, &pallets, None, "CG-15286-C", 30.0, None, None, None, None, None, 1)
        .await
        .unwrap();
    let old_part = create_project_concept(&state, &company, &older, None, "cg 15286 c", 10.0, None, None, None, None, None, 1)
        .await
        .unwrap();

    // 1. Closing a project: admin only; it is delivered with a date, and reopening undoes it.
    let close = format!("/api/admin/projects/{}/close", older.to_hex());
    let (status, _) = post(close.clone(), jose.clone(), serde_json::json!({ "closed": true })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = post(close.clone(), admin.clone(), serde_json::json!({ "closed": true })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get("/api/admin/projects".into(), admin.clone()).await;
    let list = json(&body);
    let p = list.as_array().unwrap().iter().find(|p| p["title"] == "Pallets 2025").unwrap().clone();
    assert_eq!(p["status"], "entregado");
    assert!(p["completed_at"].is_string(), "{p}");
    let (status, _) = post(close.clone(), admin.clone(), serde_json::json!({ "closed": false })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get("/api/admin/projects".into(), admin.clone()).await;
    let p = json(&body).as_array().unwrap().iter().find(|p| p["title"] == "Pallets 2025").unwrap().clone();
    assert!(p["completed_at"].is_null(), "{p}");
    let (status, _) = post(close, admin.clone(), serde_json::json!({ "closed": true })).await;
    assert_eq!(status, StatusCode::OK);

    // 2. A step held up by a missing tool: orange, with what is missing; it needs the note.
    let (status, body) = post(
        "/api/admin/process_operations".into(),
        admin.clone(),
        serde_json::json!({ "name": "Machueleado / Rimado", "position": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let op = json(&body)["id"].as_str().unwrap().to_string();
    let progress = format!("/api/admin/project_concepts/{}/progress", part.to_hex());
    let (status, body) =
        post(progress.clone(), admin.clone(), serde_json::json!({ "operation_id": op, "state": "blocked" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "needs the note: {body}");
    let (status, body) = post(
        progress.clone(),
        admin.clone(),
        serde_json::json!({ "operation_id": op, "state": "blocked", "note": "falta machuelo 1/4-20" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let step = json(&body)["process_steps"][0].clone();
    assert_eq!((step["state"].as_str(), step["note"].as_str()), (Some("blocked"), Some("falta machuelo 1/4-20")));
    // Blocked is not done: pieces cannot be finished yet.
    let (status, _) = post(progress.clone(), admin.clone(), serde_json::json!({ "completed_quantity": 5 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Done once the tool came: the note goes away.
    let (status, body) = post(progress, admin.clone(), serde_json::json!({ "operation_id": op, "state": "done" })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(json(&body)["process_steps"][0]["note"].is_null(), "{body}");

    // 3â€“4. Comments: scrap needs how many; a note on the old project comes back with the part.
    let comments = |id: mongodb::bson::oid::ObjectId| format!("/api/admin/project_concepts/{}/comments", id.to_hex());
    let (status, _) =
        post(comments(part), jose.clone(), serde_json::json!({ "kind": "scrap", "text": "se moviÃ³ la pieza" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = post(
        comments(part),
        jose.clone(),
        serde_json::json!({ "kind": "scrap", "text": "se moviÃ³ la pieza en el tornillo", "quantity": 3 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let scrap_id = json(&body)["id"].as_str().unwrap().to_string();
    let (status, _) = post(
        comments(old_part),
        admin.clone(),
        serde_json::json!({ "kind": "nota", "text": "sujetar con mordazas suaves, el G10 se astilla" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = post(comments(part), jose.clone(), serde_json::json!({ "kind": "queja", "text": "x" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = get(format!("/api/admin/projects/{}/part_comments", pallets.to_hex()), ana.clone()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let list = json(&body);
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 2, "{body}");
    let note = list.iter().find(|c| c["kind"] == "nota").unwrap();
    assert_eq!(note["other_project"], "Pallets 2025");
    assert_eq!(note["concept_id"], part.to_hex(), "shown on this project's part");
    let scrap = list.iter().find(|c| c["kind"] == "scrap").unwrap();
    assert_eq!((scrap["quantity"].as_f64(), scrap["author"].as_str()), (Some(3.0), Some("notes-jose@example.com")));
    // Only its author (or the admin) deletes it.
    let del = format!("/api/admin/part_comments/{scrap_id}/delete");
    let (status, _) = post(del.clone(), ana.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post(del, jose.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);

    // 5. Suggestions: everyone leaves them and sees their own; the admin sees all and answers.
    let (status, _) = post("/api/suggestions".into(), ana.clone(), serde_json::json!({ "text": "  " })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) =
        post("/api/suggestions".into(), ana.clone(), serde_json::json!({ "text": "ver el plano en el celular" })).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let sid = json(&body)["id"].as_str().unwrap().to_string();
    let (status, _) =
        post("/api/suggestions".into(), jose.clone(), serde_json::json!({ "text": "avisar cuando llegue material" })).await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, body) = get("/api/suggestions".into(), ana.clone()).await;
    assert_eq!(json(&body).as_array().unwrap().len(), 1, "{body}");
    let (_, body) = get("/api/suggestions".into(), admin.clone()).await;
    assert_eq!(json(&body).as_array().unwrap().len(), 2, "{body}");
    let (status, _) = post(format!("/api/suggestions/{sid}"), ana.clone(), serde_json::json!({ "status": "hecha" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post(
        format!("/api/suggestions/{sid}"),
        admin.clone(),
        serde_json::json!({ "status": "hecha", "reply": "Listo, ya se ve" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get("/api/suggestions".into(), ana.clone()).await;
    let mine = json(&body)[0].clone();
    assert_eq!((mine["status"].as_str(), mine["reply"].as_str(), mine["mine"].as_bool()), (Some("hecha"), Some("Listo, ya se ve"), Some(true)));
}
