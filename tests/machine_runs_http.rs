#[path = "common/mod.rs"]
mod common;

use common::harness::*;

fn run(id: &str, part: Option<&str>, minutes: f64, cycles: i32) -> serde_json::Value {
    serde_json::json!({
        "external_id": id,
        "machine": "VF-3",
        "program": "O0010.NC",
        "part_number": part,
        "header_date": "14-08-26 11:43",
        "started_at": "2026-10-20T08:00:00Z",
        "ended_at": "2026-10-20T16:00:00Z",
        "minutes": minutes,
        "cutting_minutes": minutes / 2.0,
        "cycles": cycles,
    })
}

#[tokio::test]
async fn machine_runs_ingest_upsert_and_project_time() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company = create_company(
        &state,
        "Machine Runs A",
        "machine-runs-a",
        "MXN",
        true,
        None,
    )
    .await
    .unwrap();
    let other = create_company(
        &state,
        "Machine Runs B",
        "machine-runs-b",
        "MXN",
        true,
        None,
    )
    .await
    .unwrap();
    let admin_id = create_user(
        &state,
        "machine-runs-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let staff_id = create_user_with_permissions(
        &state,
        "machine-runs-staff@example.com",
        "SECRET",
        &[(
            company.clone(),
            UserRole::Staff,
            vec![UserPermission::ViewProjects],
        )],
    )
    .await
    .unwrap();
    let other_admin_id = create_user(
        &state,
        "machine-runs-other@example.com",
        "SECRET",
        &[(other.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let staff = get_user_by_id(&state, &staff_id).await.unwrap().unwrap();
    let other_admin = get_user_by_id(&state, &other_admin_id)
        .await
        .unwrap()
        .unwrap();
    let admin_token = create_session(&state, &admin.username).await.unwrap();
    let staff_token = create_session(&state, &staff.username).await.unwrap();
    let other_token = create_session(&state, &other_admin.username).await.unwrap();
    let host = "machine-runs-a.miapp.local";
    let other_host = "machine-runs-b.miapp.local";

    let status_id = create_concept_status(
        &state,
        &company,
        "En proceso",
        1,
        None,
        true,
        false,
        false,
        true,
    )
    .await
    .unwrap();
    let mk_project = |title: &'static str| {
        let state = state.clone();
        let company = company.clone();
        async move {
            create_project(
                &state,
                &company,
                title,
                None,
                None,
                None,
                ProjectPriority::Medium,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        }
    };
    let p1 = mk_project("ZBL149 Braba").await;
    let p2 = mk_project("TY2157 Otro").await;
    let mk_concept = |project: bson::oid::ObjectId, name: &'static str, pieces: f64| {
        let state = state.clone();
        let company = company.clone();
        let status_id = status_id.clone();
        async move {
            create_project_concept(
                &state,
                &company,
                &project,
                Some(status_id),
                name,
                pieces,
                None,
                None,
                Some(2.0),
                None,
                None,
                1,
            )
            .await
            .unwrap()
        }
    };
    let c1 = mk_concept(p1, "ZBL149-CST-Y261007-1", 4.0).await;
    // the same part in two active projects: 6 pieces for A, 2 for B
    let pin_a = mk_concept(p1, "PIN-10", 6.0).await;
    let pin_b = mk_concept(p2, "PIN-10", 2.0).await;

    // staff can read but not write
    let app = build_app(shared.clone());
    let (status, _) = post_json_with_cookie(
        app,
        host,
        "/api/admin/machine_runs/ingest",
        &staff_token,
        serde_json::json!({ "source": "taller-vision", "runs": [run("vf3:1", Some("PIN-10"), 10.0, 1)] }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // invalid: cutting time longer than the run
    let mut bad = run("vf3:bad", None, 10.0, 1);
    bad["cutting_minutes"] = serde_json::json!(30.0);
    let app = build_app(shared.clone());
    let (status, _) = post_json_with_cookie(
        app,
        host,
        "/api/admin/machine_runs/ingest",
        &admin_token,
        serde_json::json!({ "source": "taller-vision", "runs": [bad] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let payload = serde_json::json!({ "source": "taller-vision", "runs": [
        run("vf3:1", Some(" zbl149-cst-y261007-1"), 30.0, 3),
        run("vf3:2", Some("PIN-10"), 480.0, 8),                 // 8 h, 8 pieces: split 6/2 by pieces ordered
        run("vf3:4", None, 5.0, 1),                             // old header without part number
        run("vf3:5", Some("NO-EXISTE-9"), 7.0, 1),
    ]});
    let app = build_app(shared.clone());
    let (status, body) = post_json_with_cookie(
        app,
        host,
        "/api/admin/machine_runs/ingest",
        &admin_token,
        payload.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let res: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(res["inserted"], 4);

    // resending is an upsert, not a duplicate; a changed run is updated
    let mut again = payload.clone();
    again["runs"][0]["minutes"] = serde_json::json!(40.0);
    let app = build_app(shared.clone());
    let (status, body) = post_json_with_cookie(
        app,
        host,
        "/api/admin/machine_runs/ingest",
        &admin_token,
        again,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let res: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        (res["inserted"].as_i64(), res["updated"].as_i64()),
        (Some(0), Some(1))
    );

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(
        app,
        host,
        &format!("/api/admin/projects/{}/machine_time", p1.to_hex()),
        &staff_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let t: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(t["minutes"], 400.0);
    assert_eq!(t["cycles"], 9.0);
    let part = t["concepts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["concept_id"] == c1.to_hex())
        .unwrap();
    assert_eq!(part["minutes"], 40.0);
    assert_eq!(part["cutting_minutes"], 15.0);
    assert_eq!(part["machines"], serde_json::json!(["VF-3"]));
    assert_eq!(part["estimated_hours"], 2.0);
    assert_eq!(part["shared_minutes"], 0.0);
    let pin = t["concepts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["concept_id"] == pin_a.to_hex())
        .unwrap();
    assert_eq!(
        (
            pin["minutes"].as_f64(),
            pin["shared_minutes"].as_f64(),
            pin["cycles"].as_f64()
        ),
        (Some(360.0), Some(360.0), Some(6.0))
    );

    let app = build_app(shared.clone());
    let (_, body) = get_with_cookie(
        app,
        host,
        &format!("/api/admin/projects/{}/machine_time", p2.to_hex()),
        &admin_token,
    )
    .await;
    let t: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(t["minutes"], 120.0);
    assert!(
        t["concepts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["concept_id"] == pin_b.to_hex()
                && c["minutes"] == 120.0
                && c["cycles"] == 2.0)
    );

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(
        app,
        host,
        "/api/admin/machine_runs?status=matched",
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let runs: serde_json::Value = serde_json::from_str(&body).unwrap();
    let split = runs
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["external_id"] == "vf3:2")
        .unwrap();
    assert_eq!(split["match"]["shares"].as_array().unwrap().len(), 2);

    let app = build_app(shared.clone());
    let (_, body) = get_with_cookie(app, host, "/api/admin/machine_runs", &admin_token).await;
    let runs: serde_json::Value = serde_json::from_str(&body).unwrap();
    let statuses: Vec<&str> = runs
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["match"]["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses.iter().filter(|s| **s == "matched").count(), 2);
    assert!(statuses.contains(&"no_part") && statuses.contains(&"not_found"));

    // another company sees nothing and cannot read this project
    let app = build_app(shared.clone());
    let (_, body) = get_with_cookie(app, other_host, "/api/admin/machine_runs", &other_token).await;
    assert_eq!(body, "[]");
    let app = build_app(shared);
    let (status, _) = get_with_cookie(
        app,
        other_host,
        &format!("/api/admin/projects/{}/machine_time", p1.to_hex()),
        &other_token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn shop_reports_are_for_admins_of_the_company() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let a = create_company(&state, "Shop A", "shop-a", "MXN", true, None)
        .await
        .unwrap();
    let b = create_company(&state, "Shop B", "shop-b", "MXN", true, None)
        .await
        .unwrap();
    let mk = |name: &'static str, co, role| {
        let state = state.clone();
        async move {
            let id = create_user(&state, name, "SECRET", &[(co, role)])
                .await
                .unwrap();
            let u = get_user_by_id(&state, &id).await.unwrap().unwrap();
            create_session(&state, &u.username).await.unwrap()
        }
    };
    let admin = mk("shop-admin@example.com", a.clone(), UserRole::Admin).await;
    let staff = mk("shop-staff@example.com", a.clone(), UserRole::Staff).await;
    let other = mk("shop-other@example.com", b.clone(), UserRole::Admin).await;
    let (host, other_host) = ("shop-a.miapp.local", "shop-b.miapp.local");
    let body = |minutes: i64| {
        serde_json::json!({ "source": "taller-vision", "day": "2026-11-03", "summary": "Jornada",
            "kpis": { "gente_min": minutes }, "report": { "zonas": [], "corridas": [{ "minutes": minutes }] } })
    };
    let path = "/api/admin/shop_reports/ingest";

    let (s, _) =
        post_json_with_cookie(build_app(shared.clone()), host, path, &staff, body(1)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let mut bad = body(1);
    bad["day"] = serde_json::json!("03/11/2026");
    let (s, _) = post_json_with_cookie(build_app(shared.clone()), host, path, &admin, bad).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // re-sending a day replaces it
    for m in [10, 25] {
        let (s, b) =
            post_json_with_cookie(build_app(shared.clone()), host, path, &admin, body(m)).await;
        assert_eq!(s, StatusCode::OK, "{b}");
    }
    let (s, b) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/shop_reports",
        &admin,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let list: serde_json::Value = serde_json::from_str(&b).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["kpis"]["gente_min"], 25);
    assert!(list[0].get("report").is_none());
    let (s, b) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/shop_reports/2026-11-03",
        &admin,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let day: serde_json::Value = serde_json::from_str(&b).unwrap();
    assert_eq!(day["report"]["corridas"][0]["minutes"], 25);

    // not for staff, and another company sees nothing
    let (s, _) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/shop_reports/2026-11-03",
        &staff,
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, b) = get_with_cookie(
        build_app(shared.clone()),
        other_host,
        "/api/admin/shop_reports",
        &other,
    )
    .await;
    assert_eq!((s, b.as_str()), (StatusCode::OK, "[]"));
    let (s, _) = get_with_cookie(
        build_app(shared),
        other_host,
        "/api/admin/shop_reports/2026-11-03",
        &other,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn inferred_runs_count_apart_on_the_part() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let co = create_company(&state, "Inferred", "inferred", "MXN", true, None)
        .await
        .unwrap();
    let id = create_user(
        &state,
        "inferred@example.com",
        "SECRET",
        &[(co.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let u = get_user_by_id(&state, &id).await.unwrap().unwrap();
    let token = create_session(&state, &u.username).await.unwrap();
    let host = "inferred.miapp.local";
    let st = create_concept_status(&state, &co, "En proceso", 1, None, true, false, false, true)
        .await
        .unwrap();
    let p = create_project(
        &state,
        &co,
        "CG Proyecto",
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
    create_project_concept(
        &state,
        &co,
        &p,
        Some(st),
        "CG-15675",
        2.0,
        None,
        None,
        None,
        None,
        None,
        1,
    )
    .await
    .unwrap();
    let mut est = run("1:est:1", Some("CG-15675"), 90.0, 0);
    est["cutting_minutes"] = serde_json::json!(0.0);
    est["inferred"] = serde_json::json!(true);
    est["program_loaded_at"] = serde_json::json!("2026-10-15T08:00:00Z");
    let payload = serde_json::json!({ "source": "taller-vision", "runs": [run("1:2", Some("CG-15675"), 30.0, 1), est] });
    let (s, b) = post_json_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/machine_runs/ingest",
        &token,
        payload,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let (_, b) = get_with_cookie(
        build_app(shared),
        host,
        &format!("/api/admin/projects/{}/machine_time", p.to_hex()),
        &token,
    )
    .await;
    let t: serde_json::Value = serde_json::from_str(&b).unwrap();
    assert_eq!(t["concepts"][0]["minutes"], 120.0);
    assert_eq!(t["concepts"][0]["inferred_minutes"], 90.0);
    common::teardown(Some(ctx)).await;
}
