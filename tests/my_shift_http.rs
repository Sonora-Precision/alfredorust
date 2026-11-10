#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

fn parts(v: &serde_json::Value, list: &str) -> Vec<String> {
    v[list].as_array().unwrap().iter().map(|p| p["part"].as_str().unwrap().to_string()).collect()
}

/// "Mi turno": a programmer sees their parts and what others did to them since their last
/// look, never their own actions and never money.
#[tokio::test]
async fn my_shift_shows_my_parts_and_what_changed() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let company = create_company(&state, "Turno A", "turno-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "turno-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let programmer = |name: &'static str| {
        let state = state.clone();
        let company = company.clone();
        async move {
            create_user_with_permissions(
                &state,
                name,
                "SECRET",
                &[(
                    company,
                    UserRole::Staff,
                    vec![UserPermission::ViewProductionBoard, UserPermission::TakeWorkOrders],
                )],
            )
            .await
            .unwrap()
        }
    };
    let jose_id = programmer("turno-jose@example.com").await;
    let carlos_id = programmer("turno-carlos@example.com").await;
    let viewer_id = create_user_with_permissions(
        &state,
        "turno-viewer@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![UserPermission::ViewProjects])],
    )
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
    let carlos = token(carlos_id).await;
    let viewer = token(viewer_id).await;
    let host = "turno-a.miapp.local";
    let url = "/api/production/my_shift";
    let get = |tok: String, path: String| {
        let shared = shared.clone();
        async move { get_with_cookie(build_app(shared), host, &path, &tok).await }
    };
    let act = |order: String, action: &'static str, tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move {
            post_json_with_cookie(
                build_app(shared),
                host,
                &format!("/api/production/work_orders/{order}/{action}"),
                &tok,
                body,
            )
            .await
        }
    };

    let mut material_id = String::new();
    for (position, name, queue) in [
        (1, "Material", serde_json::Value::Null),
        (2, "Programa", serde_json::json!("programming")),
        (3, "Setup 1", serde_json::json!("setup")),
    ] {
        let (status, body) = post_json_with_cookie(
            build_app(shared.clone()),
            host,
            "/api/admin/process_operations",
            &admin,
            serde_json::json!({ "name": name, "position": position, "queue": queue }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body: {body}");
        if name == "Material" {
            material_id = json(&body)["id"].as_str().expect("operation id").to_string();
        }
    }
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project = create_project(
        &state, &company, "Pallets", None, None, None, ProjectPriority::Medium, Some(9000.0), None, None,
    )
    .await
    .unwrap();
    let part = |name: &'static str| {
        let state = state.clone();
        let company = company.clone();
        async move {
            create_project_concept(
                &state, &company, &project, None, name, 10.0, Some("pza".into()),
                Some("PU cotización $585".into()), None, Some(4500.0), None, 1,
            )
            .await
            .unwrap()
            .to_hex()
        }
    };
    let a = part("PART-A").await;
    let b = part("PART-B").await;

    // Only people of the board.
    let (status, _) = get(viewer.clone(), url.into()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // First look: nothing yet.
    let (status, body) = get(jose.clone(), url.into()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let v = json(&body);
    assert_eq!(v["first_visit"], true);
    assert!(v["now"].as_array().unwrap().is_empty() && v["changes"].as_array().unwrap().is_empty(), "{body}");

    // The admin gives him A: it is new and at his step.
    let (status, _) = act(a.clone(), "assign", admin.clone(), serde_json::json!({ "user_id": jose_id.to_hex() })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get(jose.clone(), url.into()).await;
    let v = json(&body);
    assert_eq!(v["first_visit"], false);
    assert_eq!(parts(&v, "now"), ["PART-A"]);
    assert_eq!(v["now"][0]["new"], true);
    assert_eq!(v["now"][0]["step"], "Programa");
    assert_eq!(v["changes"][0]["kind"], "assigned");
    assert_eq!(v["changes"][0]["subject"]["id"], jose_id.to_hex());
    assert!(!body.contains("585") && !body.contains("4500") && !body.contains("9000"), "money leaked: {body}");

    // He finishes the program himself (not news to him); the part moves on to Setup 1.
    let (status, body) = act(a.clone(), "complete", jose.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    // The admin gives Setup 1 to Carlos, and B to Jose, then moves B to Carlos.
    act(a.clone(), "assign", admin.clone(), serde_json::json!({ "user_id": carlos_id.to_hex() })).await;
    act(b.clone(), "assign", admin.clone(), serde_json::json!({ "user_id": jose_id.to_hex() })).await;
    act(b.clone(), "assign", admin.clone(), serde_json::json!({ "user_id": carlos_id.to_hex() })).await;

    let (_, body) = get(jose.clone(), url.into()).await;
    let v = json(&body);
    assert!(parts(&v, "now").is_empty(), "{body}");
    assert_eq!(parts(&v, "elsewhere"), ["PART-A"]);
    assert_eq!(v["elsewhere"][0]["step"], "Setup 1");
    assert_eq!(v["elsewhere"][0]["step_assignee"]["id"], carlos_id.to_hex());
    // Program done but Material still pending: not ready to run yet. In programming the
    // flag does not apply.
    assert_eq!(v["elsewhere"][0]["ready"], false, "{body}");
    let (_, board) = get(admin.clone(), "/api/production/board?queue=setup".into()).await;
    let board = json(&board);
    assert_eq!(board[0]["part"], "PART-A");
    assert_eq!(board[0]["ready"], false);
    let (_, board) = get(admin.clone(), "/api/production/board".into()).await;
    assert!(json(&board)[0]["ready"].is_null(), "programming queue has no ready flag");
    // Material arrives: now it can run.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/project_concepts/{a}/progress"),
        &admin,
        serde_json::json!({ "operation_id": material_id, "state": "done" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, board) = get(admin.clone(), "/api/production/board?queue=setup".into()).await;
    assert_eq!(json(&board)[0]["ready"], true);
    let kinds: Vec<(String, String)> = v["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["part"].as_str().unwrap().to_string(), c["kind"].as_str().unwrap().to_string()))
        .collect();
    // Newest first; his own "step done" is not there.
    assert_eq!(
        kinds,
        [
            ("PART-B".to_string(), "assigned".to_string()),
            ("PART-B".to_string(), "assigned".to_string()),
            ("PART-A".to_string(), "assigned".to_string()),
            ("PART-A".to_string(), "assigned".to_string()),
        ],
        "{body}"
    );
    assert_eq!(v["changes"][0]["previous"]["id"], jose_id.to_hex());
    assert_eq!(v["changes"][0]["subject"]["id"], carlos_id.to_hex());

    // Carlos has both at his step.
    let (_, body) = get(carlos.clone(), url.into()).await;
    let mut now = parts(&json(&body), "now");
    now.sort();
    assert_eq!(now, ["PART-A", "PART-B"]);

    // The admin looks at Jose's turn without spending his look; others cannot.
    let (status, body) = get(admin.clone(), format!("{url}?user_id={}", jose_id.to_hex())).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(parts(&json(&body), "elsewhere"), ["PART-A"]);
    let (status, _) = get(jose.clone(), format!("{url}?user_id={}", carlos_id.to_hex())).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Next morning: only what happened since his last look.
    let visits = state.my_shift_visits.clone();
    let three_hours_ago = mongodb::bson::DateTime::from_millis(mongodb::bson::DateTime::now().timestamp_millis() - 3 * 3_600_000);
    let five_hours_ago = mongodb::bson::DateTime::from_millis(mongodb::bson::DateTime::now().timestamp_millis() - 5 * 3_600_000);
    visits
        .update_one(
            mongodb::bson::doc! { "user_id": jose_id },
            mongodb::bson::doc! { "$set": { "last_at": three_hours_ago } },
        )
        .await
        .unwrap();
    state
        .work_order_events
        .update_many(mongodb::bson::doc! { "company_id": company }, mongodb::bson::doc! { "$set": { "at": five_hours_ago } })
        .await
        .unwrap();
    let (_, body) = get(jose.clone(), url.into()).await;
    let v = json(&body);
    assert!(v["changes"].as_array().unwrap().is_empty(), "{body}");
    assert_eq!(parts(&v, "elsewhere"), ["PART-A"]);

    common::teardown(Some(ctx)).await;
}
