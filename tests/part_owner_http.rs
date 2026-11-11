#[path = "common/mod.rs"]
mod common;

use common::harness::*;
use alfredodev::state::get_project_concept_by_id_for_company;
use mongodb::bson::oid::ObjectId;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

fn pieces_of(weekly: &serde_json::Value, id: &ObjectId) -> f64 {
    weekly["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id.to_hex())
        .map(|p| p["pieces"].as_f64().unwrap())
        .unwrap_or(0.0)
}

/// Daniel, 2026-11-10: whoever programs a part is not necessarily who makes it. The first
/// person on a step past programming becomes responsible and gets the part's pieces; the
/// admin can change it; with nobody responsible the programmer keeps them.
#[tokio::test]
async fn responsible_gets_the_pieces_not_the_programmer() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let company = create_company(&state, "Dueño A", "dueno-a", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "dueno-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
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
                &[(company, UserRole::Staff, vec![UserPermission::ViewProductionBoard, UserPermission::TakeWorkOrders])],
            )
            .await
            .unwrap()
        }
    };
    let jesus_id = programmer("dueno-jesus@example.com").await;
    let carlos_id = programmer("dueno-carlos@example.com").await;
    let jose_id = programmer("dueno-jose@example.com").await;
    let token = |id| {
        let state = state.clone();
        async move {
            let user = get_user_by_id(&state, &id).await.unwrap().unwrap();
            create_session(&state, &user.username).await.unwrap()
        }
    };
    let admin = token(admin_id).await;
    let jesus = token(jesus_id).await;
    let carlos = token(carlos_id).await;
    let jose = token(jose_id).await;
    let host = "dueno-a.miapp.local";
    let post = |path: String, tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &tok, body).await }
    };
    let get = |path: &'static str, tok: String| {
        let shared = shared.clone();
        async move { get_with_cookie(build_app(shared), host, path, &tok).await }
    };

    let mut material_id = String::new();
    for (position, name, queue) in [
        (1, "Material", serde_json::Value::Null),
        (2, "Programa", serde_json::json!("programming")),
        (3, "Setup 1", serde_json::json!("setup")),
    ] {
        let (status, body) = post(
            "/api/admin/process_operations".into(),
            admin.clone(),
            serde_json::json!({ "name": name, "position": position, "queue": queue }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body: {body}");
        if name == "Material" {
            material_id = json(&body)["id"].as_str().unwrap().to_string();
        }
    }
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project =
        create_project(&state, &company, "Pallets", None, None, None, ProjectPriority::Medium, None, None, None)
            .await
            .unwrap();
    let part = create_project_concept(&state, &company, &project, None, "CG-1", 10.0, None, None, None, None, None, 1)
        .await
        .unwrap()
        .to_hex();
    let order = |action: &str| format!("/api/production/work_orders/{part}/{action}");

    // Jesús programs it: taking Programa does not make him responsible.
    let (status, body) = post(order("take"), jesus.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, body) = post(order("complete"), jesus.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let concept = get_project_concept_by_id_for_company(&state, &ObjectId::parse_str(&part).unwrap(), &company)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(concept.owner_user_id, None);

    // Carlos takes Setup 1: he becomes responsible.
    let (status, body) = post(order("take"), carlos.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let concept = get_project_concept_by_id_for_company(&state, &ObjectId::parse_str(&part).unwrap(), &company)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(concept.owner_user_id, Some(carlos_id));

    // Material in, setup done, 4 pieces made and released: they are Carlos's, not Jesús's.
    let (status, body) = post(
        format!("/api/admin/project_concepts/{part}/progress"),
        admin.clone(),
        serde_json::json!({ "operation_id": material_id, "state": "done" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, body) = post(order("complete"), carlos.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, body) = post(
        format!("/api/admin/project_concepts/{part}/progress"),
        admin.clone(),
        serde_json::json!({ "completed_quantity": 4.0 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, body) = post(order("quality"), admin.clone(), serde_json::json!({ "released": 4.0 })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get("/api/production/weekly_pieces", admin.clone()).await;
    let weekly = json(&body);
    assert_eq!(pieces_of(&weekly, &carlos_id), 4.0, "{body}");
    assert_eq!(pieces_of(&weekly, &jesus_id), 0.0, "{body}");

    // And Carlos sees it in Mi turno (still open: 4 of 10 made).
    let (_, body) = get("/api/production/my_shift", carlos.clone()).await;
    assert!(body.contains("CG-1"), "{body}");

    // The admin moves it to José; a programmer cannot hand it to someone else.
    let owner = format!("/api/admin/project_concepts/{part}/owner");
    let (status, _) = post(owner.clone(), carlos.clone(), serde_json::json!({ "user_id": jose_id.to_hex() })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, body) = post(owner.clone(), admin.clone(), serde_json::json!({ "user_id": jose_id.to_hex() })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get("/api/production/weekly_pieces", admin.clone()).await;
    assert_eq!(pieces_of(&json(&body), &jose_id), 4.0, "{body}");

    // Clearing it gives the pieces back to the programmer.
    let (status, _) = post(owner, admin.clone(), serde_json::json!({ "user_id": null })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get("/api/production/weekly_pieces", admin.clone()).await;
    assert_eq!(pieces_of(&json(&body), &jesus_id), 4.0, "{body}");

    // A second part: Jesús takes its program; Carlos takes the part from Seguimiento and
    // gets its setup, while the program stays Jesús's.
    let part2 = create_project_concept(&state, &company, &project, None, "CG-2", 5.0, None, None, None, None, None, 2)
        .await
        .unwrap();
    let (status, body) = post(
        format!("/api/production/work_orders/{}/take", part2.to_hex()),
        jesus.clone(),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let owner2 = format!("/api/admin/project_concepts/{}/owner", part2.to_hex());
    let (status, body) = post(owner2.clone(), carlos.clone(), serde_json::json!({ "user_id": carlos_id.to_hex() })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let c2 = get_project_concept_by_id_for_company(&state, &part2, &company).await.unwrap().unwrap();
    assert_eq!(c2.owner_user_id, Some(carlos_id));
    let holder = |c: &alfredodev::models::ProjectConcept, step: &str| {
        c.process_steps.iter().find(|s| s.name == step).and_then(|s| s.assignee_user_id)
    };
    assert_eq!(holder(&c2, "Programa"), Some(jesus_id));
    assert_eq!(holder(&c2, "Setup 1"), Some(carlos_id));
    // José cannot take it while Carlos is responsible.
    let (status, _) = post(owner2.clone(), jose.clone(), serde_json::json!({ "user_id": jose_id.to_hex() })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Carlos lets go: the setup is free again, the program untouched.
    let (status, body) = post(owner2, carlos.clone(), serde_json::json!({ "user_id": null })).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let c2 = get_project_concept_by_id_for_company(&state, &part2, &company).await.unwrap().unwrap();
    assert_eq!(c2.owner_user_id, None);
    assert_eq!(holder(&c2, "Setup 1"), None);
    assert_eq!(holder(&c2, "Programa"), Some(jesus_id));

    common::teardown(Some(ctx)).await;
}
