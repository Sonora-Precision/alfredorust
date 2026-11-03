#[path = "common/mod.rs"]
mod common;

use alfredodev::models::MachineRun;
use common::harness::*;

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

fn machine<'a>(plant: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    plant["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == name)
        .unwrap_or_else(|| panic!("{name} not in {plant}"))
}

#[tokio::test]
async fn plant_view_layout_machine_status_and_programmer() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "plant-a.miapp.local";

    let company = create_company(&state, "Plant A", "plant-a", "MXN", true, None)
        .await
        .unwrap();
    let other = create_company(&state, "Plant B", "plant-b", "MXN", true, None)
        .await
        .unwrap();
    let admin_id = create_user(
        &state,
        "plant-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "plant-jose@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![
                UserPermission::ViewProductionBoard,
                UserPermission::TakeWorkOrders,
            ],
        )],
    )
    .await
    .unwrap();
    let viewer_id = create_user_with_permissions(
        &state,
        "plant-viewer@example.com",
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
    let viewer = session(viewer_id).await;

    let vf3 = create_resource(&state, &company, "VF-3", ResourceType::Machinery, true, None)
        .await
        .unwrap();
    let sl15 = create_resource(&state, &company, "Mori SL-15", ResourceType::Machinery, true, None)
        .await
        .unwrap();
    let vf6 = create_resource(&state, &company, "VF-6", ResourceType::Machinery, true, None)
        .await
        .unwrap();
    let foreign = create_resource(&state, &other, "VF-9", ResourceType::Machinery, true, None)
        .await
        .unwrap();

    // The admin names José for the shop floor.
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/users/{}/update", jose_id.to_hex()),
        &admin,
        serde_json::json!({
            "username": "plant-jose@example.com",
            "display_name": "José Márquez",
            "memberships": [{
                "company_id": company.to_hex(),
                "role": "staff",
                "permissions": ["view_production_board", "take_work_orders"]
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    // Layout: admin only, and every machine must belong to the company.
    let layout = |machines: serde_json::Value| {
        serde_json::json!({
            "width": 680, "height": 470,
            "walls": [[224, 20], [430, 154], [277, 390], [15, 390], [18, 173], [132, 162]],
            "rooms": [[[210, 41], [242, 61]]],
            "labels": [{ "text": "Oficina", "x": 282, "y": 104 }],
            "machines": machines,
        })
    };
    let place = |id: mongodb::bson::oid::ObjectId, area: &str| {
        serde_json::json!({ "resource_id": id.to_hex(), "x": 164, "y": 332, "w": 78, "h": 46, "area": area })
    };
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/production/plant_layout",
        &jose,
        layout(serde_json::json!([place(vf3, "Centros de maquinado")])),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/production/plant_layout",
        &admin,
        layout(serde_json::json!([place(foreign, "x")])),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/production/plant_layout",
        &admin,
        layout(serde_json::json!([
            place(vf3, "Centros de maquinado"),
            place(sl15, "Tornos CNC"),
        ])),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    // A part José programmed (he takes it and marks Programa done).
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/process_operations",
        &admin,
        serde_json::json!({ "name": "Programa", "position": 1, "queue": "programming" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true)
        .await
        .unwrap();
    let project = create_project(
        &state, &company, "EST 17-22", None, None, None, ProjectPriority::High, Some(9000.0),
        None, None,
    )
    .await
    .unwrap();
    let part = create_project_concept(
        &state, &company, &project, None, "ZBL149-17", 10.0, None, None, None, Some(4500.0),
        None, 1,
    )
    .await
    .unwrap();
    for action in ["take", "complete"] {
        let (status, body) = post_json_with_cookie(
            build_app(shared.clone()),
            host,
            &format!("/api/production/work_orders/{}/{action}", part.to_hex()),
            &jose,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{action}: {body}");
    }

    // VF-3 runs that part right now (monitor reports it as "VF3"); VF-6 last ran an hour ago.
    let now = DateTime::now().timestamp_millis();
    let run = |machine: &str, part: Option<&str>, ended_ms: i64, id: &str| MachineRun {
        id: None,
        company_id: company,
        source: "taller-vision".into(),
        external_id: id.into(),
        machine: machine.into(),
        program: "O0010.NC".into(),
        part_number: part.map(String::from),
        part_key: part.map(|p| p.to_uppercase()),
        header_date: None,
        started_at: DateTime::from_millis(ended_ms - 1_200_000),
        ended_at: DateTime::from_millis(ended_ms),
        minutes: 20.0,
        cutting_minutes: 18.0,
        cycles: 2,
        inferred: false,
        program_loaded_at: None,
        header_name: None,
        created_at: None,
        updated_at: None,
    };
    state
        .machine_runs
        .insert_many([
            run("VF3", Some("ZBL149-17"), now - 120_000, "a"),
            run("VF-6", None, now - 3_600_000, "b"),
        ])
        .await
        .unwrap();

    // SL-15 has no DNC: the admin marks it in setup; someone without take_work_orders cannot.
    let set_state = |tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move {
            post_json_with_cookie(
                build_app(shared),
                host,
                &format!("/api/production/machines/{}/state", sl15.to_hex()),
                &tok,
                body,
            )
            .await
        }
    };
    let (status, _) = set_state(viewer.clone(), serde_json::json!({ "status": "setup" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = set_state(
        admin.clone(),
        serde_json::json!({ "status": "setup", "note": "Setup 1 de 2" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    // Reading the plant.
    let (status, _) =
        get_with_cookie(build_app(shared.clone()), host, "/api/production/plant", &viewer).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) =
        get_with_cookie(build_app(shared.clone()), host, "/api/production/plant", &jose).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    for leak in ["4500", "9000", "VF-9"] {
        assert!(!body.contains(leak), "plant leaked {leak}: {body}");
    }
    let plant = json(&body);
    assert_eq!(plant["layout"]["machines"].as_array().unwrap().len(), 2);
    assert_eq!(plant["layout"]["labels"][0]["text"], "Oficina");

    let m = machine(&plant, "VF-3");
    assert_eq!(m["status"], "working");
    assert_eq!(m["source"], "dnc");
    assert_eq!(m["order"]["part"], "ZBL149-17");
    assert_eq!(m["order"]["project"], "EST 17-22");
    assert!(m["order"]["folio"].as_str().unwrap().starts_with("OT-"));
    assert_eq!(m["programmer"]["name"], "José Márquez");

    let m = machine(&plant, "Mori SL-15");
    assert_eq!(m["status"], "setup");
    assert_eq!(m["source"], "manual");
    assert_eq!(m["note"], "Setup 1 de 2");

    let m = machine(&plant, "VF-6");
    assert_eq!(m["status"], "stopped");
    assert!(m["order"].is_null());
    assert!(m["since"].is_string());

    // The board also shows the display name.
    let (_, body) =
        get_with_cookie(build_app(shared.clone()), host, "/api/production/members", &admin).await;
    assert!(body.contains("José Márquez"), "{body}");

    let _ = vf6;
    common::teardown(Some(ctx)).await;
}

/// Machine queue (design §9c): several setups of one order on a machine, the same order on
/// two machines, moving in only when asked, and the programmer finishing the job.
#[tokio::test]
async fn machine_queue_setups_two_machines_and_finish() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let host = "queue-a.miapp.local";

    let company = create_company(&state, "Queue A", "queue-a", "MXN", true, None).await.unwrap();
    let other = create_company(&state, "Queue B", "queue-b", "MXN", true, None).await.unwrap();
    let admin_id = create_user(&state, "queue-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let jose_id = create_user_with_permissions(
        &state,
        "queue-jose@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProductionBoard, UserPermission::TakeWorkOrders],
        )],
    )
    .await
    .unwrap();
    let bere_id = create_user_with_permissions(
        &state,
        "queue-bere@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProductionBoard, UserPermission::ReleaseParts],
        )],
    )
    .await
    .unwrap();
    let outsider_id = create_user(&state, "queue-out@example.com", "SECRET", &[(other.clone(), UserRole::Admin)])
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
    let bere = session(bere_id).await;
    let outsider = session(outsider_id).await;

    let vf3 = create_resource(&state, &company, "VF-3", ResourceType::Machinery, true, None).await.unwrap();
    let vf6 = create_resource(&state, &company, "VF-6", ResourceType::Machinery, true, None).await.unwrap();
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project = create_project(
        &state, &company, "Pallets", None, None, None, ProjectPriority::Medium, Some(9000.0), None, None,
    )
    .await
    .unwrap();
    let part = create_project_concept(
        &state, &company, &project, None, "CG-16587", 20.0, None, None, None, Some(4500.0), None, 1,
    )
    .await
    .unwrap();

    let post = |path: String, tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &tok, body).await }
    };
    let plant = || {
        let shared = shared.clone();
        let jose = jose.clone();
        async move {
            let (status, body) = get_with_cookie(build_app(shared), host, "/api/production/plant", &jose).await;
            assert_eq!(status, StatusCode::OK, "body: {body}");
            for leak in ["4500", "9000"] {
                assert!(!body.contains(leak), "plant leaked {leak}: {body}");
            }
            json(&body)
        }
    };
    let queue_of = |m: &serde_json::Value| -> Vec<String> {
        m["queue"].as_array().unwrap().iter().map(|e| e["label"].as_str().unwrap_or("").to_string()).collect()
    };
    // Quality only looks.
    let (status, _) = post(
        format!("/api/production/machines/{}/queue", vf3.to_hex()),
        bere.clone(),
        serde_json::json!({ "concept_id": part.to_hex(), "label": "Setup 1" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // José queues three setups of the same part on VF-3; the admin also queues it on VF-6.
    for label in ["Setup 1", "Setup 2", "Setup 3"] {
        let (status, body) = post(
            format!("/api/production/machines/{}/queue", vf3.to_hex()),
            jose.clone(),
            serde_json::json!({ "concept_id": part.to_hex(), "label": label }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body: {body}");
    }
    let (status, _) = post(
        format!("/api/production/machines/{}/queue", vf6.to_hex()),
        admin.clone(),
        serde_json::json!({ "concept_id": part.to_hex(), "label": "Setup 1" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let p = plant().await;
    assert_eq!(queue_of(machine(&p, "VF-3")), ["Setup 1", "Setup 2", "Setup 3"]);
    assert_eq!(queue_of(machine(&p, "VF-6")), ["Setup 1"]);
    assert_eq!(machine(&p, "VF-3")["queue"][0]["order"]["part"], "CG-16587");
    assert!(machine(&p, "VF-3")["order"].is_null(), "nothing runs until someone moves it in");

    // Reorder: Setup 3 one place up.
    let third = machine(&p, "VF-3")["queue"][2]["id"].as_str().unwrap().to_string();
    let (status, _) =
        post(format!("/api/production/machine_queue/{third}/move"), jose.clone(), serde_json::json!({ "up": true })).await;
    assert_eq!(status, StatusCode::OK);
    let p = plant().await;
    assert_eq!(queue_of(machine(&p, "VF-3")), ["Setup 1", "Setup 3", "Setup 2"]);

    // José picks VF-3 and moves Setup 1 to production; the admin runs the same part on VF-6.
    let first = machine(&p, "VF-3")["queue"][0]["id"].as_str().unwrap().to_string();
    let (status, _) =
        post(format!("/api/production/machine_queue/{first}/start"), jose.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let on_vf6 = machine(&p, "VF-6")["queue"][0]["id"].as_str().unwrap().to_string();
    let (status, _) =
        post(format!("/api/production/machine_queue/{on_vf6}/start"), admin.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);

    let p = plant().await;
    for name in ["VF-3", "VF-6"] {
        let m = machine(&p, name);
        assert_eq!(m["status"], "working", "{name}: {m}");
        assert_eq!(m["order"]["part"], "CG-16587");
        assert_eq!(m["label"], "Setup 1");
    }
    assert_eq!(machine(&p, "VF-3")["running_by"]["id"], jose_id.to_hex());
    assert_eq!(queue_of(machine(&p, "VF-3")), ["Setup 3", "Setup 2"]);
    assert!(machine(&p, "VF-6")["queue"].as_array().unwrap().is_empty());

    // José finishes his job on VF-3: stopped, with a note of what he finished.
    let (status, _) = post(format!("/api/production/machines/{}/finish", vf3.to_hex()), bere.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post(format!("/api/production/machines/{}/finish", vf3.to_hex()), jose.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let p = plant().await;
    let m = machine(&p, "VF-3");
    assert_eq!(m["status"], "stopped");
    assert!(m["order"].is_null());
    let note = m["note"].as_str().unwrap();
    assert!(note.contains("Terminó") && note.contains("CG-16587") && note.contains("Setup 1"), "{note}");
    assert_eq!(machine(&p, "VF-6")["status"], "working", "VF-6 keeps running");

    // Another company never touches it; removing takes it out of the queue.
    let next = m["queue"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = post_json_with_cookie(
        build_app(shared.clone()),
        "queue-b.miapp.local",
        &format!("/api/production/machine_queue/{next}/remove"),
        &outsider,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) =
        post(format!("/api/production/machine_queue/{next}/remove"), jose.clone(), serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let p = plant().await;
    assert_eq!(queue_of(machine(&p, "VF-3")), ["Setup 2"]);

    common::teardown(Some(ctx)).await;
}
