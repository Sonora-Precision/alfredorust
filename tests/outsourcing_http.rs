#[path = "common/mod.rs"]
mod common;

use alfredodev::state::get_project_concept_by_id_for_company;
use common::harness::*;
use mongodb::bson::oid::ObjectId;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

/// Daniel, 2026-11-13: parts go to maquila whole or for some steps, may be split among
/// suppliers, leave the board while the suppliers have them, and programmers see that a
/// part is "En maquila" but not who has it nor what we pay.
#[tokio::test]
async fn outsourced_parts_leave_the_board_until_they_come_back() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let company = create_company(&state, "Maq A", "maq-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "maq-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let carlos_id = create_user_with_permissions(
        &state,
        "maq-carlos@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProjects, UserPermission::ViewProductionBoard, UserPermission::TakeWorkOrders],
        )],
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
    let carlos = token(carlos_id).await;
    let host = "maq-a.miapp.local";
    let post = |path: String, tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &tok, body).await }
    };
    let get = |path: String, tok: String| {
        let shared = shared.clone();
        async move { get_with_cookie(build_app(shared), host, &path, &tok).await }
    };

    let mut ops = std::collections::HashMap::new();
    for (position, name, queue) in [
        (1, "Material", serde_json::Value::Null),
        (2, "Programa", serde_json::json!("programming")),
        (3, "Setup 1", serde_json::json!("setup")),
        (4, "Tratamiento térmico", serde_json::Value::Null),
    ] {
        let (status, body) = post(
            "/api/admin/process_operations".into(),
            admin.clone(),
            serde_json::json!({ "name": name, "position": position, "queue": queue }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body: {body}");
        ops.insert(name, json(&body)["id"].as_str().unwrap().to_string());
    }
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project =
        create_project(&state, &company, "Bases", None, None, None, ProjectPriority::Medium, None, None, None)
            .await
            .unwrap();
    let new_part = |name: &'static str, position: i32| {
        let state = state.clone();
        let company = company.clone();
        let project = project.clone();
        async move {
            create_project_concept(&state, &company, &project, None, name, 10.0, None, None, None, None, None, position)
                .await
                .unwrap()
        }
    };
    let whole = new_part("BASE-1", 1).await;
    let split = new_part("BASE-2", 2).await;

    let supplier = |alias: &'static str| {
        let post = post.clone();
        let admin = admin.clone();
        async move {
            let (status, body) = post(
                "/api/admin/contacts".into(),
                admin,
                serde_json::json!({ "name": alias, "contact_type": "supplier", "profile": { "alias": alias, "outsourcing": true } }),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "body: {body}");
            json(&body)["id"].as_str().unwrap().to_string()
        }
    };
    let zz = supplier("ZZ Desarrollos").await;
    let ripasa = supplier("Ripasa").await;

    // Programs done: both parts wait on Setup 1.
    for part in [whole, split] {
        let (status, body) = post(
            format!("/api/admin/project_concepts/{}/progress", part.to_hex()),
            admin.clone(),
            serde_json::json!({ "operation_id": ops["Programa"], "state": "done" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
    }
    let on_board = |name: &'static str| {
        let get = get.clone();
        let admin = admin.clone();
        async move {
            let (_, body) = get("/api/production/board?queue=setup".into(), admin).await;
            body.contains(name)
        }
    };
    assert!(on_board("BASE-1").await);
    assert!(on_board("BASE-2").await);

    // Programmers cannot send parts out.
    let (status, _) = post(
        "/api/admin/outsourcing".into(),
        carlos.clone(),
        serde_json::json!({ "concept_id": whole.to_hex(), "supplier_id": zz, "quantity": 10.0 }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // BASE-1 goes whole to ZZ: off the board.
    let (status, body) = post(
        "/api/admin/outsourcing".into(),
        admin.clone(),
        serde_json::json!({
            "concept_id": whole.to_hex(), "supplier_id": zz, "quantity": 10.0, "unit_cost": 450.0,
            "due_date": "2026-11-20", "status": "sent", "notes": "Pagar $4,500 al recibir"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let job = json(&body)["id"].as_str().unwrap().to_string();
    assert!(!on_board("BASE-1").await);

    // The admin sees who and how much; Carlos only that it is out, no price.
    let list = format!("/api/admin/outsourcing?project_id={}", project.to_hex());
    let (_, body) = get(list.clone(), admin.clone()).await;
    let rows = json(&body);
    assert_eq!(rows[0]["supplier_name"], "ZZ Desarrollos", "{body}");
    assert_eq!(rows[0]["unit_cost"], 450.0);
    assert_eq!(rows[0]["status"], "sent");
    let (status, body) = get(list.clone(), carlos.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = json(&body);
    assert_eq!(rows[0]["supplier_id"], serde_json::Value::Null, "{body}");
    assert_eq!(rows[0]["supplier_name"], serde_json::Value::Null);
    assert_eq!(rows[0]["unit_cost"], serde_json::Value::Null);
    assert!(!body.contains("4,500"), "{body}");

    // ZZ hands the 10 back: every step done and the pieces wait for quality.
    let (status, body) = post(
        format!("/api/admin/outsourcing/{job}/update"),
        admin.clone(),
        serde_json::json!({ "supplier_id": zz, "quantity": 10.0, "unit_cost": 450.0, "due_date": "2026-11-20", "received_quantity": 10.0 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let c = get_project_concept_by_id_for_company(&state, &whole, &company).await.unwrap().unwrap();
    assert_eq!(c.completed_quantity, 10.0);
    for name in ["Material", "Setup 1", "Tratamiento térmico"] {
        let id = ObjectId::parse_str(&ops[name]).unwrap();
        let step = c.process_steps.iter().find(|s| s.operation_id == id).unwrap();
        assert_eq!(step.state, alfredodev::models::StepState::Done, "{name}");
    }
    let (_, body) = get(list.clone(), admin.clone()).await;
    assert_eq!(json(&body)[0]["status"], "received");

    // BASE-2: Setup 1 split, 6 to ZZ: the other 4 are still ours, it stays on the board.
    let (status, body) = post(
        "/api/admin/outsourcing".into(),
        admin.clone(),
        serde_json::json!({ "concept_id": split.to_hex(), "supplier_id": zz, "quantity": 6.0, "operation_ids": [ops["Setup 1"]], "status": "sent" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    assert!(on_board("BASE-2").await);
    // The other 4 to Ripasa: now all of Setup 1 is out.
    let (status, body) = post(
        "/api/admin/outsourcing".into(),
        admin.clone(),
        serde_json::json!({ "concept_id": split.to_hex(), "supplier_id": ripasa, "quantity": 4.0, "operation_ids": [ops["Setup 1"]] }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let ripasa_job = json(&body)["id"].as_str().unwrap().to_string();
    assert!(!on_board("BASE-2").await);
    // Ripasa's share is cancelled: back on the board.
    let (status, body) = post(
        format!("/api/admin/outsourcing/{ripasa_job}/update"),
        admin.clone(),
        serde_json::json!({ "supplier_id": ripasa, "quantity": 4.0, "operation_ids": [ops["Setup 1"]], "status": "cancelled" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(on_board("BASE-2").await);
    let (status, _) = post(format!("/api/admin/outsourcing/{ripasa_job}/delete"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);

    // A customer is not a supplier.
    let (status, body) = post(
        "/api/admin/contacts".into(),
        admin.clone(),
        serde_json::json!({ "name": "Cliente", "contact_type": "customer" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let customer = json(&body)["id"].as_str().unwrap().to_string();
    let (status, _) = post(
        "/api/admin/outsourcing".into(),
        admin.clone(),
        serde_json::json!({ "concept_id": split.to_hex(), "supplier_id": customer, "quantity": 1.0 }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    common::teardown(Some(ctx)).await;
}
