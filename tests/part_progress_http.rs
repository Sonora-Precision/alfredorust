#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

#[tokio::test]
async fn part_progress_tracks_finished_pieces_and_process_steps() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company = create_company(&state, "Progress A", "progress-a", "MXN", true, None)
        .await
        .unwrap();
    let other = create_company(&state, "Progress B", "progress-b", "MXN", true, None)
        .await
        .unwrap();
    let admin_id = create_user(
        &state,
        "progress-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let other_admin_id = create_user(
        &state,
        "progress-other-admin@example.com",
        "SECRET",
        &[(other.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let staff_id = create_user_with_permissions(
        &state,
        "progress-staff@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![UserPermission::ViewProjects])],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let other_admin = get_user_by_id(&state, &other_admin_id).await.unwrap().unwrap();
    let staff = get_user_by_id(&state, &staff_id).await.unwrap().unwrap();
    let admin_token = create_session(&state, &admin.username).await.unwrap();
    let other_token = create_session(&state, &other_admin.username).await.unwrap();
    let staff_token = create_session(&state, &staff.username).await.unwrap();
    let host = "progress-a.miapp.local";
    let other_host = "progress-b.miapp.local";

    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true)
        .await
        .unwrap();
    let project_id = create_project(
        &state,
        &company,
        "Pallets",
        None,
        None,
        None,
        ProjectPriority::Medium,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let concept_id = create_project_concept(
        &state,
        &company,
        &project_id,
        None,
        "CG-15287-B",
        60.0,
        Some("pza".into()),
        None,
        None,
        None,
        None,
        1,
    )
    .await
    .unwrap()
    .to_hex();

    // Catalog: admin creates, staff with view_projects reads, staff cannot write.
    let mut op_ids = Vec::new();
    for (position, name) in [(2, "Programa"), (1, "Material"), (3, "Setup 1")] {
        let (status, body) = post_json_with_cookie(
            build_app(shared.clone()),
            host,
            "/api/admin/process_operations",
            &admin_token,
            serde_json::json!({ "name": name, "position": position }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body: {body}");
        op_ids.push(json(&body)["id"].as_str().unwrap().to_string());
    }
    let (programa, material, setup1) = (op_ids[0].clone(), op_ids[1].clone(), op_ids[2].clone());

    let (status, body) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/process_operations",
        &staff_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let names: Vec<String> = json(&body)
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Material", "Programa", "Setup 1"]);

    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/process_operations",
        &staff_token,
        serde_json::json!({ "name": "Rebabeado" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let progress = format!("/api/admin/project_concepts/{concept_id}/progress");

    // Finished pieces out of range are rejected and nothing is written.
    for bad in [61.0, -1.0] {
        let (status, body) = post_json_with_cookie(
            build_app(shared.clone()),
            host,
            &progress,
            &admin_token,
            serde_json::json!({ "completed_quantity": bad }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
    }

    // A piece only counts once every step is done or N/A.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &admin_token,
        serde_json::json!({ "completed_quantity": 15 }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    assert!(body.contains("Programa"), "names the pending steps: {body}");

    // Steps: done and not applicable are stored with who and when.
    for (op, st) in [(&material, "done"), (&setup1, "not_applicable")] {
        let (status, body) = post_json_with_cookie(
            build_app(shared.clone()),
            host,
            &progress,
            &admin_token,
            serde_json::json!({ "operation_id": op, "state": st }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
    }

    // The last pending step can be closed in the same request that records pieces.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &admin_token,
        serde_json::json!({ "completed_quantity": 15, "operation_id": programa, "state": "done" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(json(&body)["completed_quantity"], 15.0);

    // Reopening a step does not block corrections downwards.
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &admin_token,
        serde_json::json!({ "operation_id": programa, "state": "pending" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &admin_token,
        serde_json::json!({ "completed_quantity": 16 }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "more pieces with a pending step: {body}");
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &admin_token,
        serde_json::json!({ "operation_id": programa, "state": "done" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &admin_token,
        serde_json::json!({ "operation_id": material, "state": "maybe" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");

    // An operation of another company is rejected.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        other_host,
        "/api/admin/process_operations",
        &other_token,
        serde_json::json!({ "name": "Ajena" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let foreign_op = json(&body)["id"].as_str().unwrap().to_string();
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &admin_token,
        serde_json::json!({ "operation_id": foreign_op, "state": "done" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Another company cannot touch the part; staff cannot write yet.
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        other_host,
        &progress,
        &other_token,
        serde_json::json!({ "completed_quantity": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &staff_token,
        serde_json::json!({ "completed_quantity": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Renaming the catalog keeps the recorded name; the part lists only marked steps.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/process_operations/{material}/update"),
        &admin_token,
        serde_json::json!({ "name": "Material comprado", "position": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    let (status, body) = get_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/projects/{}/concepts", project_id.to_hex()),
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let concept = &json(&body)[0];
    assert_eq!(concept["completed_quantity"], 15.0);
    let steps = concept["process_steps"].as_array().unwrap();
    assert_eq!(steps.len(), 3, "{steps:?}");
    let material_step = steps.iter().find(|s| s["operation_id"] == material.as_str()).unwrap();
    assert_eq!(material_step["name"], "Material");
    assert_eq!(material_step["state"], "done");
    assert_eq!(material_step["updated_by"], admin.username.as_str());
    assert!(material_step["updated_at"].is_string());
    assert!(steps.iter().any(|s| s["operation_id"] == setup1.as_str() && s["state"] == "not_applicable"));
    assert!(steps.iter().any(|s| s["operation_id"] == programa.as_str() && s["state"] == "done"));

    // The full edit cannot drop the quantity below finished pieces and keeps progress.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/project_concepts/{concept_id}/update"),
        &admin_token,
        serde_json::json!({ "name": "CG-15287-B", "quantity": 10.0, "position": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/project_concepts/{concept_id}/update"),
        &admin_token,
        serde_json::json!({ "name": "CG-15287-B", "quantity": 40.0, "position": 1, "notes": "ajuste" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/projects/{}/concepts", project_id.to_hex()),
        &admin_token,
    )
    .await;
    let concept = &json(&body)[0];
    assert_eq!(concept["quantity"], 40.0);
    assert_eq!(concept["completed_quantity"], 15.0);
    assert_eq!(concept["process_steps"].as_array().unwrap().len(), 3);

    // Deleting an operation only removes the column; the recorded step stays.
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/process_operations/{setup1}/delete"),
        &admin_token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        other_host,
        &format!("/api/admin/process_operations/{programa}/delete"),
        &other_token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, body) = get_with_cookie(
        build_app(shared),
        host,
        &format!("/api/admin/projects/{}/concepts", project_id.to_hex()),
        &admin_token,
    )
    .await;
    assert_eq!(json(&body)[0]["process_steps"].as_array().unwrap().len(), 3);

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn concurrent_step_marks_on_one_part_are_all_kept() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company = create_company(&state, "Progress C", "progress-c", "MXN", true, None)
        .await
        .unwrap();
    let admin_id = create_user(
        &state,
        "progress-c-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let token = create_session(&state, &admin.username).await.unwrap();
    let host = "progress-c.miapp.local";
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true)
        .await
        .unwrap();
    let project_id = create_project(
        &state, &company, "P", None, None, None, ProjectPriority::Medium, None, None, None,
    )
    .await
    .unwrap();
    let concept_id = create_project_concept(
        &state, &company, &project_id, None, "PIN-10", 4.0, None, None, None, None, None, 1,
    )
    .await
    .unwrap()
    .to_hex();

    let mut op_ids = Vec::new();
    for i in 0..9 {
        let (status, body) = post_json_with_cookie(
            build_app(shared.clone()),
            host,
            "/api/admin/process_operations",
            &token,
            serde_json::json!({ "name": format!("Paso {i}"), "position": i }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body: {body}");
        op_ids.push(json(&body)["id"].as_str().unwrap().to_string());
    }

    let path = format!("/api/admin/project_concepts/{concept_id}/progress");
    let results = futures::future::join_all(op_ids.iter().map(|op| {
        post_json_with_cookie(
            build_app(shared.clone()),
            host,
            &path,
            &token,
            serde_json::json!({ "operation_id": op, "state": "done" }),
        )
    }))
    .await;
    for (status, body) in results {
        assert_eq!(status, StatusCode::OK, "body: {body}");
    }

    let (_, body) = get_with_cookie(
        build_app(shared),
        host,
        &format!("/api/admin/projects/{}/concepts", project_id.to_hex()),
        &token,
    )
    .await;
    let steps = json(&body)[0]["process_steps"].as_array().unwrap().clone();
    assert_eq!(steps.len(), 9, "{steps:?}");
    assert!(steps.iter().all(|s| s["state"] == "done"));

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn programmer_ticks_steps_and_pieces_without_seeing_money() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "ticks-a.miapp.local";

    let company = create_company(&state, "Ticks A", "ticks-a", "MXN", true, None)
        .await
        .unwrap();
    let admin_id = create_user(
        &state,
        "ticks-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "ticks-jose@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProjects, UserPermission::TakeWorkOrders],
        )],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let jose = get_user_by_id(&state, &jose_id).await.unwrap().unwrap();
    let admin_token = create_session(&state, &admin.username).await.unwrap();
    let jose_token = create_session(&state, &jose.username).await.unwrap();

    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true)
        .await
        .unwrap();
    let project_id = create_project(
        &state, &company, "Pallets", None, None, None, ProjectPriority::Medium, Some(9000.0), None,
        None,
    )
    .await
    .unwrap();
    let concept_id = create_project_concept(
        &state,
        &company,
        &project_id,
        None,
        "CG-15253-A",
        40.0,
        None,
        Some("Fixture pallet Vulcan — PU cotización $455".into()),
        None,
        Some(4500.0),
        None,
        1,
    )
    .await
    .unwrap();
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/project_concepts/{}/update", concept_id.to_hex()),
        &admin_token,
        serde_json::json!({
            "name": "CG-15253-A", "quantity": 40.0, "unit_price": 455.0, "position": 1,
            "description": "Fixture pallet Vulcan — PU cotización $455", "estimated_cost": 4500.0
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/process_operations",
        &admin_token,
        serde_json::json!({ "name": "Setup 1", "position": 1, "queue": "setup" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let setup1 = json(&body)["id"].as_str().unwrap().to_string();

    let progress = format!("/api/admin/project_concepts/{}/progress", concept_id.to_hex());

    // Not his part yet: he cannot tick it.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &jose_token,
        serde_json::json!({ "completed_quantity": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {body}");

    // He takes it on the board; now it is his.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/production/work_orders/{}/take", concept_id.to_hex()),
        &jose_token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "take: {body}");
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &jose_token,
        serde_json::json!({ "completed_quantity": 12, "operation_id": setup1, "state": "done" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let part = json(&body);
    assert_eq!(part["completed_quantity"], 12.0);
    assert_eq!(part["description"], "Fixture pallet Vulcan");
    assert!(part["unit_price"].is_null() && part["estimated_cost"].is_null());
    for leak in ["455", "4500", "9000", "cotiz"] {
        assert!(!body.contains(leak), "{leak} leaked: {body}");
    }
    let step = part["process_steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["operation_id"] == setup1.as_str())
        .unwrap();
    assert_eq!(step["state"], "done");
    assert_eq!(step["updated_by"], "ticks-jose@example.com");

    // Corrected down a bit later.
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &progress,
        &jose_token,
        serde_json::json!({ "completed_quantity": 10 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Every tick is in the log with who did it; pieces keep the price of that moment.
    let mut cursor = state
        .work_order_events
        .find(doc! { "concept_id": concept_id, "kind": "pieces_recorded" })
        .sort(doc! { "at": 1 })
        .await
        .unwrap();
    let mut deltas = Vec::new();
    while cursor.advance().await.unwrap() {
        let e = cursor.deserialize_current().unwrap();
        assert_eq!(e.actor_user_id, jose_id);
        assert_eq!(e.unit_price, Some(455.0));
        deltas.push(e.pieces_delta.unwrap());
    }
    assert_eq!(deltas, [12.0, -2.0]);
    let done = state
        .work_order_events
        .find_one(doc! { "concept_id": concept_id, "kind": "step_done" })
        .await
        .unwrap()
        .expect("step_done");
    assert_eq!(done.subject_user_id, Some(jose_id));

    common::teardown(Some(ctx)).await;
}
