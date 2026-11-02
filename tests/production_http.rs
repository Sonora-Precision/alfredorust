#[path = "common/mod.rs"]
mod common;

use alfredodev::models::WorkQueue;
use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

fn folios(body: &str) -> Vec<String> {
    json(body)
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["folio"].as_str().unwrap().to_string())
        .collect()
}

fn id_of(body: &str, folio: &str) -> String {
    json(body)
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["folio"] == folio)
        .unwrap_or_else(|| panic!("{folio} not in {body}"))["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn production_board_queues_sequence_and_assignment() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company = create_company(&state, "Board A", "board-a", "MXN", true, None)
        .await
        .unwrap();
    let admin_id = create_user(
        &state,
        "board-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin)],
    )
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
                    vec![
                        UserPermission::ViewProjects,
                        UserPermission::ViewProductionBoard,
                        UserPermission::TakeWorkOrders,
                    ],
                )],
            )
            .await
            .unwrap()
        }
    };
    let jose_id = programmer("board-jose@example.com").await;
    let carlos_id = programmer("board-carlos@example.com").await;
    let viewer_id = create_user_with_permissions(
        &state,
        "board-viewer@example.com",
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
    let host = "board-a.miapp.local";
    let board = "/api/production/board?queue=programming";

    // Catalog: Material has no queue, so a part's first board step is Programa.
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
    }

    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true)
        .await
        .unwrap();
    let normal = create_project(
        &state, &company, "Normal", None, None, None, ProjectPriority::Medium, None, None, None,
    )
    .await
    .unwrap();
    let urgent = create_project(
        &state, &company, "Urgente", None, None, None, ProjectPriority::Urgent, Some(9000.0), None,
        None,
    )
    .await
    .unwrap();
    let part = |project, name: &'static str| {
        let state = state.clone();
        let company = company.clone();
        async move {
            create_project_concept(
                &state,
                &company,
                &project,
                None,
                name,
                10.0,
                Some("pza".into()),
                Some("PU cotización $585".into()),
                None,
                Some(4500.0),
                None,
                1,
            )
            .await
            .unwrap()
        }
    };
    let a = part(normal, "PART-A").await; // OT-0001
    part(normal, "PART-B").await; // OT-0002
    part(urgent, "PART-C").await; // OT-0003
    // A part from before the board: gets its folio on the first read.
    let legacy = part(normal, "PART-LEGACY").await;
    state
        .project_concepts
        .update_one(
            mongodb::bson::doc! { "_id": legacy },
            mongodb::bson::doc! { "$unset": { "work_order_number": "" } },
        )
        .await
        .unwrap();

    // Without the board permission nobody gets in.
    let (status, _) = get_with_cookie(build_app(shared.clone()), host, board, &viewer).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Urgent project first, then folio order; the legacy part got the next folio.
    let (status, body) = get_with_cookie(build_app(shared.clone()), host, board, &jose).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(folios(&body), ["OT-0003", "OT-0001", "OT-0002", "OT-0005"]);
    let first = &json(&body)[0];
    assert_eq!(first["operation"], "Programa");
    assert_eq!(first["priority"], "urgent");
    assert!(first["assignee"].is_null());
    for leak in ["4500", "9000", "585", "cotizaci"] {
        assert!(!body.contains(leak), "board leaked {leak}: {body}");
    }
    let (ot1, ot2, ot3, ot5) = (
        id_of(&body, "OT-0001"),
        id_of(&body, "OT-0002"),
        id_of(&body, "OT-0003"),
        id_of(&body, "OT-0005"),
    );
    assert_eq!(ot1, a.to_hex());

    // Any free order can be taken for yourself; two programmers racing for one: one wins.
    let none = || serde_json::json!({});
    let ((s1, _), (s2, _)) = tokio::join!(
        act(&shared, &ot3, "take", &jose, none()),
        act(&shared, &ot3, "take", &carlos, none())
    );
    let mut statuses = [s1, s2];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let jose_won = s1 == StatusCode::OK;
    let (winner, loser) = if jose_won { (&jose, &carlos) } else { (&carlos, &jose) };

    // The loser picks one further down, out of sequence; taking a held order is a conflict.
    let (status, body) = act(&shared, &ot1, "take", loser, none()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (status, _) = act(&shared, &ot1, "take", winner, none()).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // The winner groups a similar part out of sequence, with a reason; it lands right
    // after the order it was grouped with.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/production/work_orders/{ot5}/take"),
        winner,
        serde_json::json!({ "related_to": ot3, "reason": "mismas herramientas" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, board, &admin).await;
    assert_eq!(folios(&body), ["OT-0003", "OT-0005", "OT-0001", "OT-0002"]);

    // Programmers cannot assign to others; the admin can.
    let to = |id: mongodb::bson::oid::ObjectId| serde_json::json!({ "user_id": id.to_hex() });
    let (status, _) = act(&shared, &ot2, "assign", &jose, to(carlos_id)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = act(&shared, &ot2, "assign", &admin, to(viewer_id)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "viewer cannot hold orders");
    let (status, body) = act(&shared, &ot2, "assign", &admin, to(carlos_id)).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    // "Mis asignaciones" and the load per person.
    let (_, body) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/production/board?queue=programming&mine=true",
        &carlos,
    )
    .await;
    let carlos_orders = folios(&body);
    assert!(carlos_orders.contains(&"OT-0002".to_string()), "{body}");
    let (status, body) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/production/members",
        &jose,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let members = json(&body);
    let carlos_row = members
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["username"] == "board-carlos@example.com")
        .unwrap();
    assert_eq!(
        carlos_row["assigned"].as_array().unwrap().len(),
        carlos_orders.len()
    );
    assert!(!body.contains("board-viewer"), "viewer is not a board member");

    // The admin moves OT-0002 to the top.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/production/work_orders/{ot2}/sequence"),
        &admin,
        serde_json::json!({ "before_id": ot3 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, board, &admin).await;
    assert_eq!(folios(&body)[0], "OT-0002");
    assert_eq!(json(&body)[0]["pinned"], true);

    // Only the holder (or a manager) marks the step done; it then moves to the setup queue
    // and the StepDone event credits the holder.
    let (status, _) = act(&shared, &ot2, "complete", &jose, none()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "OT-0002 is Carlos's");
    let (status, body) = act(&shared, &ot2, "complete", &carlos, none()).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, board, &admin).await;
    assert!(!folios(&body).contains(&"OT-0002".to_string()));
    let (_, body) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/production/board?queue=setup",
        &admin,
    )
    .await;
    assert_eq!(folios(&body), ["OT-0002"]);
    assert_eq!(json(&body)[0]["operation"], "Setup 1");
    let done = state
        .work_order_events
        .find_one(mongodb::bson::doc! { "concept_id": parse_oid_or_panic(&ot2), "kind": "step_done" })
        .await
        .unwrap()
        .expect("step_done event");
    assert_eq!(done.subject_user_id, Some(carlos_id));
    assert_eq!(done.queue, Some(WorkQueue::Programming));

    // Releasing: only your own.
    let (status, _) = act(&shared, &ot3, "release", loser, none()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = act(&shared, &ot3, "release", winner, none()).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get_with_cookie(build_app(shared.clone()), host, board, &admin).await;
    let ot3_row = json(&body)
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["folio"] == "OT-0003")
        .cloned()
        .unwrap();
    assert!(ot3_row["assignee"].is_null());

    common::teardown(Some(ctx)).await;
}

fn parse_oid_or_panic(id: &str) -> mongodb::bson::oid::ObjectId {
    mongodb::bson::oid::ObjectId::parse_str(id).unwrap()
}

async fn act(
    shared: &Arc<AppState>,
    order: &str,
    action: &str,
    token: &str,
    body: serde_json::Value,
) -> (StatusCode, String) {
    post_json_with_cookie(
        build_app(shared.clone()),
        "board-a.miapp.local",
        &format!("/api/production/work_orders/{order}/{action}"),
        token,
        body,
    )
    .await
}
