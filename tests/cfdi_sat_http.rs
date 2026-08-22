#[path = "common/mod.rs"]
mod common;

use common::harness::*;
use std::io::Read;

fn bulk_cfdi_document(
    company_id: &bson::oid::ObjectId,
    uuid: &str,
    company_rfc: &str,
    tipo: &str,
    total: &str,
) -> bson::Document {
    doc! {
        "company_id": company_id.to_hex(),
        "uuid": uuid,
        "comprobante": {
            "folio": uuid,
            "tipoDeComprobante": tipo,
            "fecha": "2026-03-15T10:30:00",
            "subTotal": total,
            "total": total,
            "moneda": "MXN",
        },
        "emisor": { "rfc": company_rfc, "nombre": "Bulk Company" },
        "receptor": { "rfc": "XAXX010101000", "nombre": "Bulk Customer" },
    }
}

#[tokio::test]
async fn bulk_cfdi_transactions_are_idempotent_and_tenant_scoped() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let company_a = create_company(&state, "Bulk A", "bulk-a", "MXN", true, None)
        .await
        .unwrap();
    let company_b = create_company(&state, "Bulk B", "bulk-b", "MXN", true, None)
        .await
        .unwrap();
    create_sat_config(
        &state,
        bson::oid::ObjectId::new(),
        company_a,
        "AAA010101AAA".into(),
        "a.cer".into(),
        "a.key".into(),
        "secret".into(),
        None,
    )
    .await
    .unwrap();
    create_sat_config(
        &state,
        bson::oid::ObjectId::new(),
        company_b,
        "BBB010101BBB".into(),
        "b.cer".into(),
        "b.key".into(),
        "secret".into(),
        None,
    )
    .await
    .unwrap();
    let admin_id = create_user(
        &state,
        "bulk-admin@example.com",
        "SECRET",
        &[(company_a, UserRole::Admin)],
    )
    .await
    .unwrap();
    let staff_id = create_user(
        &state,
        "bulk-staff@example.com",
        "SECRET",
        &[(company_a, UserRole::Staff)],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let staff = get_user_by_id(&state, &staff_id).await.unwrap().unwrap();
    let admin_token = create_session(&state, &admin.username).await.unwrap();
    let staff_token = create_session(&state, &staff.username).await.unwrap();
    let invoice_uuid = "aaaaaaaa-1111-2222-3333-444444444444";
    let credit_uuid = "bbbbbbbb-1111-2222-3333-444444444444";
    let foreign_uuid = "cccccccc-1111-2222-3333-444444444444";
    let received_credit_uuid = "dddddddd-1111-2222-3333-444444444444";
    let cancelled_uuid = "eeeeeeee-1111-2222-3333-444444444444";
    let mut received_credit = bulk_cfdi_document(
        &company_a,
        received_credit_uuid,
        "VENDOR010101AAA",
        "E",
        "10.00",
    );
    received_credit.insert(
        "receptor",
        doc! { "rfc": "AAA010101AAA", "nombre": "Bulk Company" },
    );
    let mut cancelled =
        bulk_cfdi_document(&company_a, cancelled_uuid, "AAA010101AAA", "I", "80.00");
    cancelled.insert("estatus", "cancelado");
    state
        .cfdis
        .insert_many([
            bulk_cfdi_document(&company_a, invoice_uuid, "AAA010101AAA", "I", "116.00"),
            bulk_cfdi_document(&company_a, credit_uuid, "AAA010101AAA", "E", "25.00"),
            received_credit,
            cancelled,
            bulk_cfdi_document(&company_b, foreign_uuid, "BBB010101BBB", "I", "500.00"),
        ])
        .await
        .unwrap();

    let archive_root = std::path::PathBuf::from("data/cfdi_store/bulk-a");
    let _ = std::fs::remove_dir_all(&archive_root);
    let archive_dir = archive_root
        .join("AAA010101AAA")
        .join("emitido")
        .join("2026");
    std::fs::create_dir_all(&archive_dir).unwrap();
    std::fs::write(
        archive_dir.join(format!("{invoice_uuid}.xml")),
        b"<cfdi>invoice</cfdi>",
    )
    .unwrap();
    std::fs::write(
        archive_dir.join(format!("{credit_uuid}.xml")),
        b"<cfdi>credit</cfdi>",
    )
    .unwrap();
    let (archive_status, archive_headers, archive_body) = post_json_with_cookie_bytes(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/archive",
        &admin_token,
        serde_json::json!({ "uuids": [invoice_uuid, credit_uuid] }),
    )
    .await;
    assert_eq!(archive_status, StatusCode::OK);
    assert_eq!(
        archive_headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/zip")
    );
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(archive_body)).unwrap();
    assert_eq!(archive.len(), 2);
    let mut invoice_xml = String::new();
    archive
        .by_name(&format!("{invoice_uuid}.xml"))
        .unwrap()
        .read_to_string(&mut invoice_xml)
        .unwrap();
    assert_eq!(invoice_xml, "<cfdi>invoice</cfdi>");

    let (foreign_status, _, _) = post_json_with_cookie_bytes(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/archive",
        &admin_token,
        serde_json::json!({ "uuids": [foreign_uuid] }),
    )
    .await;
    assert_eq!(foreign_status, StatusCode::NOT_FOUND);
    let (missing_status, _, _) = post_json_with_cookie_bytes(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/archive",
        &admin_token,
        serde_json::json!({ "uuids": [received_credit_uuid] }),
    )
    .await;
    assert_eq!(missing_status, StatusCode::CONFLICT);

    let payload = serde_json::json!({
        "uuids": [invoice_uuid, credit_uuid, received_credit_uuid, cancelled_uuid, foreign_uuid]
    });
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/transactions/bulk",
        &admin_token,
        payload,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let result: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(result["created"], 3);
    assert_eq!(result["skipped"], 1);
    assert_eq!(result["errors"].as_array().unwrap().len(), 1);
    let invoice = state
        .transactions
        .find_one(doc! { "company_id": company_a, "cfdi_uuid": invoice_uuid })
        .await
        .unwrap()
        .unwrap();
    let credit = state
        .transactions
        .find_one(doc! { "company_id": company_a, "cfdi_uuid": credit_uuid })
        .await
        .unwrap()
        .unwrap();
    let received_credit = state
        .transactions
        .find_one(doc! { "company_id": company_a, "cfdi_uuid": received_credit_uuid })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(invoice.transaction_type, TransactionType::Income);
    assert_eq!(credit.transaction_type, TransactionType::Expense);
    assert_eq!(received_credit.transaction_type, TransactionType::Income);

    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/transactions/bulk",
        &admin_token,
        serde_json::json!({ "uuids": [invoice_uuid, credit_uuid, received_credit_uuid, invoice_uuid] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let replay: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(replay["requested"], 3);
    assert_eq!(replay["unchanged"], 3);

    state
        .cfdis
        .update_one(
            doc! { "company_id": company_a.to_hex(), "uuid": invoice_uuid },
            doc! { "$set": { "comprobante.total": "150.00", "comprobante.subTotal": "150.00" } },
        )
        .await
        .unwrap();
    let (status, body) = post_json_with_cookie(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/transactions/bulk",
        &admin_token,
        serde_json::json!({ "uuids": [invoice_uuid] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let updated: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(updated["updated"], 1);
    let invoice = state
        .transactions
        .find_one(doc! { "company_id": company_a, "cfdi_uuid": invoice_uuid })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(invoice.amount, 150.0);
    assert_eq!(
        state
            .transactions
            .count_documents(doc! { "company_id": company_a })
            .await
            .unwrap(),
        3
    );

    let concurrent_uuid = "ffffffff-1111-2222-3333-444444444444";
    state
        .cfdis
        .insert_one(bulk_cfdi_document(
            &company_a,
            concurrent_uuid,
            "AAA010101AAA",
            "I",
            "75.00",
        ))
        .await
        .unwrap();
    let first = post_json_with_cookie(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/transactions/bulk",
        &admin_token,
        serde_json::json!({ "uuids": [concurrent_uuid] }),
    );
    let second = post_json_with_cookie(
        build_app(shared.clone()),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/transactions/bulk",
        &admin_token,
        serde_json::json!({ "uuids": [concurrent_uuid] }),
    );
    let ((first_status, first_body), (second_status, second_body)) = tokio::join!(first, second);
    assert_eq!(first_status, StatusCode::OK, "{first_body}");
    assert_eq!(second_status, StatusCode::OK, "{second_body}");
    let first_result: serde_json::Value = serde_json::from_str(&first_body).unwrap();
    let second_result: serde_json::Value = serde_json::from_str(&second_body).unwrap();
    assert_eq!(
        first_result["created"].as_u64().unwrap() + second_result["created"].as_u64().unwrap(),
        1
    );
    assert_eq!(
        state
            .transactions
            .count_documents(doc! { "company_id": company_a, "cfdi_uuid": concurrent_uuid })
            .await
            .unwrap(),
        1
    );

    let (status, _) = post_json_with_cookie(
        build_app(shared),
        "bulk-a.miapp.local",
        "/api/admin/cfdis/transactions/bulk",
        &staff_token,
        serde_json::json!({ "uuids": [invoice_uuid] }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let _ = std::fs::remove_dir_all(archive_root);
    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn cfdi_json_endpoints_scope_to_active_tenant() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company_a = create_company(&state, "CFDI JSON A", "cfdi-json-a", "MXN", true, None)
        .await
        .unwrap();
    let company_b = create_company(&state, "CFDI JSON B", "cfdi-json-b", "MXN", true, None)
        .await
        .unwrap();
    let user_id = create_user(
        &state,
        "cfdi-json-admin@example.com",
        "SECRET",
        &[
            (company_a.clone(), UserRole::Admin),
            (company_b.clone(), UserRole::Admin),
        ],
    )
    .await
    .unwrap();
    let user = get_user_by_id(&state, &user_id).await.unwrap().unwrap();
    let token = create_session(&state, &user.username).await.unwrap();
    let host_a = "cfdi-json-a.miapp.local";
    let uuid_a = "11111111-1111-1111-1111-111111111111";
    let uuid_b = "22222222-2222-2222-2222-222222222222";

    state
        .cfdis
        .insert_one(doc! {
            "company_id": company_a.to_hex(),
            "uuid": uuid_a,
            "comprobante": {
                "serie": "A",
                "folio": "100",
                "tipoDeComprobante": "I",
                "fecha": "2026-01-01T00:00:00",
                "subTotal": "100.00",
                "total": "116.00",
                "moneda": "MXN",
                "formaPago": "03",
                "metodoPago": "PUE",
            },
            "emisor": { "rfc": "AAA010101AAA", "nombre": "CFDI Emisor A" },
            "receptor": { "rfc": "XAXX010101000", "nombre": "CFDI Receptor A" },
            "impuestos": { "totalImpuestosTrasladados": "16.00" },
            "conceptos": [{
                "descripcion": "CFDI concepto A",
                "cantidad": "1",
                "valorUnitario": "100.00",
                "importe": "100.00",
            }],
        })
        .await
        .unwrap();
    state
        .cfdis
        .insert_one(doc! {
            "company_id": company_b.to_hex(),
            "uuid": uuid_b,
            "comprobante": {
                "serie": "B",
                "folio": "200",
                "tipoDeComprobante": "I",
                "fecha": "2026-01-02T00:00:00",
                "subTotal": "200.00",
                "total": "232.00",
                "moneda": "MXN",
                "formaPago": "03",
                "metodoPago": "PUE",
            },
            "emisor": { "rfc": "BBB010101BBB", "nombre": "CFDI Emisor B" },
            "receptor": { "rfc": "XAXX010101000", "nombre": "CFDI Receptor B" },
            "impuestos": { "totalImpuestosTrasladados": "32.00" },
            "conceptos": [{
                "descripcion": "CFDI concepto B",
                "cantidad": "1",
                "valorUnitario": "200.00",
                "importe": "200.00",
            }],
        })
        .await
        .unwrap();

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(app, host_a, "/api/admin/cfdis/data", &token).await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_str::<serde_json::Value>(&body).expect("response must be JSON");
    assert!(body.contains(uuid_a));
    assert!(body.contains("CFDI concepto A"));
    assert!(!body.contains(uuid_b));
    assert!(!body.contains("CFDI concepto B"));

    let app = build_app(shared.clone());
    let (status, body) =
        get_with_cookie(app, host_a, &format!("/api/admin/cfdis/{uuid_a}"), &token).await;
    assert_eq!(status, StatusCode::OK);
    let detail: serde_json::Value = serde_json::from_str(&body).expect("detail must be JSON");
    assert_eq!(detail["uuid"], uuid_a);
    assert_eq!(detail["folio"], "100");
    assert_eq!(detail["conceptos"][0]["descripcion"], "CFDI concepto A");

    let app = build_app(shared.clone());
    let (status, _body) =
        get_with_cookie(app, host_a, &format!("/api/admin/cfdis/{uuid_b}"), &token).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let staff_id = create_user(
        &state,
        "cfdi-json-staff@example.com",
        "SECRET",
        &[(company_a.clone(), UserRole::Staff)],
    )
    .await
    .unwrap();
    let staff = get_user_by_id(&state, &staff_id).await.unwrap().unwrap();
    let staff_token = create_session(&state, &staff.username).await.unwrap();
    let app = build_app(shared);
    let (status, _body) = get_with_cookie(app, host_a, "/api/admin/cfdis/data", &staff_token).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn cfdi_job_endpoints_scope_to_company_and_admin() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company_a = create_company(&state, "CFDI Jobs A", "cfdi-jobs-a", "MXN", true, None)
        .await
        .unwrap();
    let company_b = create_company(&state, "CFDI Jobs B", "cfdi-jobs-b", "MXN", true, None)
        .await
        .unwrap();
    let admin_id = create_user(
        &state,
        "cfdi-jobs-admin@example.com",
        "SECRET",
        &[
            (company_a.clone(), UserRole::Admin),
            (company_b.clone(), UserRole::Admin),
        ],
    )
    .await
    .unwrap();
    let staff_id = create_user(
        &state,
        "cfdi-jobs-staff@example.com",
        "SECRET",
        &[(company_a.clone(), UserRole::Staff)],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let staff = get_user_by_id(&state, &staff_id).await.unwrap().unwrap();
    let admin_token = create_session(&state, &admin.username).await.unwrap();
    let staff_token = create_session(&state, &staff.username).await.unwrap();
    let host_a = "cfdi-jobs-a.miapp.local";

    insert_cfdi_job(
        &state,
        &CfdiJob {
            job_id: "job-a".into(),
            company_id: company_a.to_hex(),
            label: "2026-01".into(),
            chunk_start: "2026-01-01".into(),
            started_at: "2026-01-15".into(),
            status: CfdiJobStatus::Queued,
            source: "manual".into(),
            created_at: DateTime::now(),
        },
    )
    .await
    .unwrap();
    insert_cfdi_job(
        &state,
        &CfdiJob {
            job_id: "job-b".into(),
            company_id: company_b.to_hex(),
            label: "2026-02".into(),
            chunk_start: "2026-02-01".into(),
            started_at: "2026-02-15".into(),
            status: CfdiJobStatus::Running,
            source: "manual".into(),
            created_at: DateTime::now(),
        },
    )
    .await
    .unwrap();

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(
        app,
        host_a,
        &format!("/admin/companies/{}/cfdi/jobs", company_a.to_hex()),
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("job-a"));
    assert!(!body.contains("job-b"));

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(
        app,
        host_a,
        &format!("/admin/companies/{}/cfdi/jobs/job-a", company_a.to_hex()),
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let job: serde_json::Value = serde_json::from_str(&body).expect("job must be JSON");
    assert_eq!(job["job_id"], "job-a");

    // job-b belongs to company_b. Fetching it through company_a's URL now returns
    // 404 (not 403): jobs are queried scoped by company_id, so another company's
    // job simply doesn't exist in this scope — which also avoids leaking its
    // existence across tenants. The spec only requires the request be rejected.
    let app = build_app(shared.clone());
    let (status, _body) = get_with_cookie(
        app,
        host_a,
        &format!("/admin/companies/{}/cfdi/jobs/job-b", company_a.to_hex()),
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let app = build_app(shared);
    let (status, _body) = get_with_cookie(
        app,
        host_a,
        &format!("/admin/companies/{}/cfdi/jobs", company_a.to_hex()),
        &staff_token,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn cfdi_startup_marks_active_jobs_as_interrupted() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();

    let company = create_company(
        &state,
        "CFDI Interrupted Jobs",
        "cfdi-interrupted-jobs",
        "MXN",
        true,
        None,
    )
    .await
    .unwrap();

    insert_cfdi_job(
        &state,
        &CfdiJob {
            job_id: "job-running".into(),
            company_id: company.to_hex(),
            label: "Running".into(),
            chunk_start: "2026-01-01".into(),
            started_at: "2026-01-01".into(),
            status: CfdiJobStatus::Running,
            source: "manual".into(),
            created_at: DateTime::now(),
        },
    )
    .await
    .unwrap();
    insert_cfdi_job(
        &state,
        &CfdiJob {
            job_id: "job-done".into(),
            company_id: company.to_hex(),
            label: "Done".into(),
            chunk_start: "2026-01-02".into(),
            started_at: "2026-01-02".into(),
            status: CfdiJobStatus::Done {
                imported: 1,
                transactions_created: 1,
                transactions_updated: 0,
                transactions_skipped: 0,
                errors: vec![],
            },
            source: "manual".into(),
            created_at: DateTime::now(),
        },
    )
    .await
    .unwrap();

    let changed = fail_interrupted_cfdi_jobs(&state).await.unwrap();
    assert_eq!(changed, 1);

    let jobs = list_cfdi_jobs(&state, &company.to_hex()).await.unwrap();
    let running = jobs
        .iter()
        .find(|job| job.job_id == "job-running")
        .expect("running job exists");
    assert!(matches!(running.status, CfdiJobStatus::Failed { .. }));
    let done = jobs
        .iter()
        .find(|job| job.job_id == "job-done")
        .expect("done job exists");
    assert!(matches!(done.status, CfdiJobStatus::Done { .. }));

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn cfdi_download_rejects_malformed_dates_before_starting_jobs() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company = create_company(
        &state,
        "CFDI Date Guard",
        "cfdi-date-guard",
        "MXN",
        true,
        None,
    )
    .await
    .unwrap();
    let admin_id = create_user(
        &state,
        "cfdi-date-guard-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let token = create_session(&state, &admin.username).await.unwrap();
    let config_id = bson::oid::ObjectId::new();
    create_sat_config(
        &state,
        config_id.clone(),
        company.clone(),
        "XAXX010101000".to_string(),
        "/tmp/missing.cer".to_string(),
        "/tmp/missing.key".to_string(),
        "secret".to_string(),
        Some("Test SAT".to_string()),
    )
    .await
    .unwrap();

    let (status, body) = post_json_with_cookie(
        build_app(shared),
        "cfdi-date-guard.miapp.local",
        &format!("/api/admin/companies/{}/cfdi/download", company.to_hex()),
        &token,
        serde_json::json!({
            "sat_config_id": config_id.to_hex(),
            "start": "20206-06-01",
            "end": "2026-07-07",
            "download_type": "both",
            "auto_create_payments": false
        }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body.contains("YYYY-MM-DD"),
        "expected a format error, got: {body}"
    );
    assert!(
        list_cfdi_jobs(&state, &company.to_hex())
            .await
            .unwrap()
            .is_empty(),
        "invalid input must not create SAT jobs"
    );

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn sat_config_json_endpoints_scope_and_redact_sensitive_fields() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company_a = create_company(&state, "SAT JSON A", "sat-json-a", "MXN", true, None)
        .await
        .unwrap();
    let company_b = create_company(&state, "SAT JSON B", "sat-json-b", "MXN", true, None)
        .await
        .unwrap();
    let admin_id = create_user(
        &state,
        "sat-json-admin@example.com",
        "SECRET",
        &[(company_a.clone(), UserRole::Admin)],
    )
    .await
    .unwrap();
    let staff_id = create_user(
        &state,
        "sat-json-staff@example.com",
        "SECRET",
        &[(company_a.clone(), UserRole::Staff)],
    )
    .await
    .unwrap();
    let admin = get_user_by_id(&state, &admin_id).await.unwrap().unwrap();
    let staff = get_user_by_id(&state, &staff_id).await.unwrap().unwrap();
    let admin_token = create_session(&state, &admin.username).await.unwrap();
    let staff_token = create_session(&state, &staff.username).await.unwrap();
    let host_a = "sat-json-a.miapp.local";

    let config_a = bson::oid::ObjectId::new();
    create_sat_config(
        &state,
        config_a.clone(),
        company_a.clone(),
        "AAA010101AAA".into(),
        "uploads/sat/company-a/cert.cer".into(),
        "uploads/sat/company-a/private.key".into(),
        "dummy-password-a".into(),
        Some("Primary FIEL".into()),
    )
    .await
    .unwrap();
    let config_b = bson::oid::ObjectId::new();
    create_sat_config(
        &state,
        config_b.clone(),
        company_b.clone(),
        "BBB010101BBB".into(),
        "uploads/sat/company-b/cert.cer".into(),
        "uploads/sat/company-b/private.key".into(),
        "dummy-password-b".into(),
        Some("Hidden FIEL".into()),
    )
    .await
    .unwrap();

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(app, host_a, "/api/admin/sat-configs", &admin_token).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("AAA010101AAA"));
    assert!(body.contains("Primary FIEL"));
    assert!(!body.contains("BBB010101BBB"));
    assert!(!body.contains("dummy-password-a"));
    assert!(!body.contains("private.key"));
    assert!(!body.contains("cert.cer"));

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(
        app,
        host_a,
        &format!("/api/admin/sat-configs/{}", config_a.to_hex()),
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let config: serde_json::Value = serde_json::from_str(&body).expect("config must be JSON");
    assert_eq!(config["rfc"], "AAA010101AAA");
    assert_eq!(config["label"], "Primary FIEL");
    assert!(config.get("key_password").is_none());
    assert!(config.get("key_path").is_none());
    assert!(config.get("cer_path").is_none());

    let app = build_app(shared.clone());
    let (status, _body) = get_with_cookie(
        app,
        host_a,
        &format!("/api/admin/sat-configs/{}", config_b.to_hex()),
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let app = build_app(shared.clone());
    let (status, body) = post_json_with_cookie(
        app,
        host_a,
        "/api/admin/sat-configs",
        &admin_token,
        serde_json::json!({
            "rfc": "CCC010101CCC",
            "cer_path": "uploads/sat/company-a/new.cer",
            "key_path": "uploads/sat/company-a/new.key",
            "key_password": "new-secret",
            "label": "New FIEL"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    assert!(!body.contains("new-secret"));
    assert!(!body.contains("new.key"));
    let created: serde_json::Value = serde_json::from_str(&body).expect("create response JSON");
    let created_id = created["id"].as_str().expect("created id").to_string();

    let app = build_app(shared.clone());
    let (status, body) = post_json_with_cookie(
        app,
        host_a,
        &format!("/api/admin/sat-configs/{created_id}/update"),
        &admin_token,
        serde_json::json!({
            "rfc": "DDD010101DDD",
            "cer_path": "uploads/sat/company-a/updated.cer",
            "key_path": "uploads/sat/company-a/updated.key",
            "key_password": "updated-secret",
            "label": "Updated FIEL"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(!body.contains("updated-secret"));
    assert!(!body.contains("updated.key"));

    let app = build_app(shared.clone());
    let (status, body) = get_with_cookie(
        app,
        host_a,
        &format!("/api/admin/sat-configs/{created_id}"),
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(body.contains("DDD010101DDD"));
    assert!(!body.contains("updated-secret"));
    assert!(!body.contains("updated.key"));

    let app = build_app(shared.clone());
    let (status, _body) = post_json_with_cookie(
        app,
        host_a,
        "/api/admin/sat-configs",
        &staff_token,
        serde_json::json!({
            "rfc": "EEE010101EEE",
            "cer_path": "x.cer",
            "key_path": "x.key",
            "key_password": "secret"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let app = build_app(shared.clone());
    let (status, body) = post_json_with_cookie(
        app,
        host_a,
        &format!("/api/admin/sat-configs/{created_id}/delete"),
        &admin_token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");

    let app = build_app(shared);
    let (status, _body) =
        get_with_cookie(app, host_a, "/api/admin/sat-configs", &staff_token).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    common::teardown(Some(ctx)).await;
}

#[tokio::test]
async fn sat_config_upload_json_creates_config_and_enforces_admin() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());

    let company = create_company(&state, "SAT Upload Co", "sat-upload-co", "MXN", true, None)
        .await
        .unwrap();
    create_user_with_permissions(
        &state,
        "sat-upload-admin@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Admin, vec![])],
    )
    .await
    .unwrap();
    create_user_with_permissions(
        &state,
        "sat-upload-staff@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![])],
    )
    .await
    .unwrap();
    let admin_token = create_session(&state, "sat-upload-admin@example.com")
        .await
        .unwrap();
    let staff_token = create_session(&state, "sat-upload-staff@example.com")
        .await
        .unwrap();
    let host = "sat-upload-co.miapp.local";

    let cert_bytes: &[u8] = b"\x30\x82DUMMYCERTDATA";
    let key_bytes: &[u8] = b"\x30\x82DUMMYKEYDATA";
    let (status, body) = post_multipart_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/sat-configs/upload",
        &admin_token,
        &[
            ("rfc", None, b"aaa010101aaa"),
            ("label", None, b"Test FIEL"),
            ("key_password", None, b"supersecret"),
            ("cer_file", Some("cert.cer"), cert_bytes),
            ("key_file", Some("private.key"), key_bytes),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let created: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(created["id"].as_str().is_some());

    let (status, body) = get_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/sat-configs",
        &admin_token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("AAA010101AAA"),
        "RFC should be uppercased: {body}"
    );
    assert!(body.contains("Test FIEL"));
    assert!(!body.contains("supersecret"));
    assert!(!body.contains("private.key"));
    assert!(!body.contains("cert.cer"));

    // missing key_file -> validation error
    let (status, _) = post_multipart_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/sat-configs/upload",
        &admin_token,
        &[
            ("rfc", None, b"bbb010101bbb"),
            ("key_password", None, b"x"),
            ("cer_file", Some("c.cer"), b"data"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // staff cannot upload
    let (status, _) = post_multipart_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/sat-configs/upload",
        &staff_token,
        &[
            ("rfc", None, b"ccc010101ccc"),
            ("key_password", None, b"x"),
            ("cer_file", Some("c.cer"), b"data"),
            ("key_file", Some("k.key"), b"data"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let _ = std::fs::remove_dir_all(format!("uploads/sat/{}", company.to_hex()));

    common::teardown(Some(ctx)).await;
}

// ---------------------------------------------------------------------------
// Security: authentication enforcement + cross-tenant isolation
//
// These tests treat the API as hostile input: an authenticated user of tenant A
// must never be able to read, mutate, or delete a record that belongs to tenant
// B, and every protected endpoint must reject requests with no session.
// ---------------------------------------------------------------------------
