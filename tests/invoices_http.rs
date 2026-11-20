// Invoice register over HTTP: admin only, load XML/PDF, list with the share still owed,
// summary totals, a payment typed by hand, edits and files.
#[path = "common/mod.rs"]
mod common;

use common::harness::*;
use mongodb::bson::oid::ObjectId;

const US: &str = "RIAD90102219A";
const INV: &str = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const REP: &str = "b2b2b2b2-0000-0000-0000-000000000001";

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

fn invoice_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Folio="141" Fecha="2026-07-30T15:16:30" SubTotal="1000" Moneda="MXN" Total="1147.50" TipoDeComprobante="I" MetodoPago="PPD">
  <cfdi:Emisor Rfc="{US}" Nombre="DANIEL" />
  <cfdi:Receptor Rfc="BTE131008US3" Nombre="BRABA TECH" />
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" Descripcion="ZBL124-A" ValorUnitario="1000" Importe="1000" /></cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosRetenidos="12.50" TotalImpuestosTrasladados="160" />
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="{INV}" /></cfdi:Complemento>
</cfdi:Comprobante>"#
    )
}

fn rep_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" Version="4.0" Serie="REP 1" Folio="141" Fecha="2026-08-01T23:10:48" Moneda="XXX" Total="0" TipoDeComprobante="P">
  <cfdi:Emisor Rfc="{US}" />
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="2026-08-01T12:00:00" MonedaP="MXN" TipoCambioP="1" Monto="500">
        <pago20:DoctoRelacionado IdDocumento="{INV}" Folio="141" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="1147.50" ImpPagado="500" ImpSaldoInsoluto="647.50" />
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="{REP}" />
  </cfdi:Complemento>
</cfdi:Comprobante>"#
    )
}

#[tokio::test]
async fn invoice_register_flow_and_permissions() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let store = std::env::temp_dir().join(format!("invoice_http_{}", ObjectId::new().to_hex()));
    unsafe { std::env::set_var("PART_FILE_STORE_DIR", &store) };
    let state = ctx.state.clone();
    let shared = Arc::new(state.clone());
    let company = create_company(&state, "Fact Co", "fact-co", "MXN", true, None).await.unwrap();
    create_sat_config(&state, ObjectId::new(), company, US.to_string(), "x.cer".into(), "x.key".into(), "pw".into(), None)
        .await
        .unwrap();
    let admin_id = create_user(&state, "fact-admin@example.com", "SECRET", &[(company.clone(), UserRole::Admin)])
        .await
        .unwrap();
    let staff_id = create_user_with_permissions(
        &state,
        "fact-staff@example.com",
        "SECRET",
        &[(company.clone(), UserRole::Staff, vec![UserPermission::ViewProjects, UserPermission::ViewProjectMoney])],
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
    let staff = token(staff_id).await;
    let host = "fact-co.miapp.local";
    let get = |path: String, tok: String| {
        let shared = shared.clone();
        async move { get_with_cookie(build_app(shared), host, &path, &tok).await }
    };
    let post = |path: String, tok: String, body: serde_json::Value| {
        let shared = shared.clone();
        async move { post_json_with_cookie(build_app(shared), host, &path, &tok, body).await }
    };

    // Money: not even a staff member with the money permission may see or load invoices.
    assert_eq!(get("/api/admin/invoices".into(), staff.clone()).await.0.as_u16(), 403);
    assert_eq!(get("/api/admin/invoices/summary".into(), staff.clone()).await.0.as_u16(), 403);
    let (status, _) = post_multipart_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/invoices/import",
        &staff,
        &[("files", Some("f.xml"), invoice_xml().as_bytes())],
    )
    .await;
    assert_eq!(status.as_u16(), 403);
    assert_requires_auth_get(&shared, "/api/admin/invoices").await;

    // Load the REP before the invoice, with a PDF named after the invoice UUID.
    let pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF".to_vec();
    let pdf_name = format!("{INV}.pdf");
    let (status, body) = post_multipart_with_cookie(
        build_app(shared.clone()),
        host,
        "/api/admin/invoices/import",
        &admin,
        &[
            ("files", Some("rep.xml"), rep_xml().as_bytes()),
            ("files", Some("factura.xml"), invoice_xml().as_bytes()),
            ("files", Some(pdf_name.as_str()), &pdf),
        ],
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let report = json(&body);
    assert_eq!(report["invoices_new"], 1);
    assert_eq!(report["payments_new"], 1);
    assert_eq!(report["pdfs"], 1);

    // The list shows the exact share owed.
    let (status, body) = get("/api/admin/invoices".into(), admin.clone()).await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let list = json(&body);
    assert_eq!(list["total"], 1);
    let row = &list["items"][0];
    assert_eq!(row["folio"], "141");
    assert_eq!(row["customer_name"], "BRABA TECH");
    assert_eq!(row["total"], 1147.5);
    assert_eq!(row["paid"], 500.0);
    assert_eq!(row["balance"], 647.5);
    assert_eq!(row["pending_pct"], 56.43);
    assert_eq!(row["state"], "parcial");
    let id = row["id"].as_str().unwrap().to_string();

    // Filters.
    let (_, body) = get("/api/admin/invoices?state=pagada".into(), admin.clone()).await;
    assert_eq!(json(&body)["total"], 0);
    let (_, body) = get("/api/admin/invoices?state=abiertas&q=braba".into(), admin.clone()).await;
    assert_eq!(json(&body)["total"], 1);

    // Detail: payments with their REP, files with their URL.
    let (status, body) = get(format!("/api/admin/invoices/{id}"), admin.clone()).await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let detail = json(&body);
    assert_eq!(detail["payments"][0]["source"], "rep");
    assert_eq!(detail["payments"][0]["balance_after"], 647.5);
    assert_eq!(detail["lines"][0]["description"], "ZBL124-A");
    let kinds: Vec<String> = detail["files"].as_array().unwrap().iter().map(|f| f["kind"].as_str().unwrap().to_string()).collect();
    for k in ["factura_xml", "factura_pdf", "rep_xml"] {
        assert!(kinds.contains(&k.to_string()), "{k} in {kinds:?}");
    }
    let pdf_url = detail["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "factura_pdf")
        .unwrap()["url"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, _, bytes) = get_with_cookie_bytes_pdf(shared.clone(), host, &pdf_url, &admin).await;
    assert_eq!(status.as_u16(), 200);
    assert!(bytes.starts_with(b"%PDF-"));

    // Money received before the REP.
    let (status, body) = post(
        format!("/api/admin/invoices/{id}/payments"),
        admin.clone(),
        serde_json::json!({ "paid_on": "2026-08-20", "amount": 647.5, "note": "transferencia" }),
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let d = json(&body);
    assert_eq!(d["balance"], 0.0);
    assert_eq!(d["state"], "pagada");
    assert_eq!(d["missing_rep"], true, "paid by hand on a PPD invoice: the REP is still to ask for");
    let manual = d["payments"].as_array().unwrap().iter().find(|p| p["source"] == "manual").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Bad input.
    let (status, _) = post(
        format!("/api/admin/invoices/{id}/payments"),
        admin.clone(),
        serde_json::json!({ "paid_on": "ayer", "amount": 10 }),
    )
    .await;
    assert_eq!(status.as_u16(), 400);
    let (status, _) = post(
        format!("/api/admin/invoices/{id}/payments"),
        admin.clone(),
        serde_json::json!({ "paid_on": "2026-08-20", "amount": -5 }),
    )
    .await;
    assert_eq!(status.as_u16(), 400);

    // Summary: billed, collected, owed.
    let (status, body) = get("/api/admin/invoices/summary".into(), admin.clone()).await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let s = json(&body);
    assert_eq!(s["totals"][0]["currency"], "MXN");
    assert_eq!(s["totals"][0]["billed"], 1147.5);
    assert_eq!(s["totals"][0]["balance"], 0.0);
    assert_eq!(s["missing_rep"], 1);

    // Remove the manual payment: the balance comes back; a REP payment cannot be removed.
    let (status, body) = post(
        format!("/api/admin/invoices/{id}/payments/{manual}/delete"),
        admin.clone(),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{body}");
    assert_eq!(json(&body)["balance"], 647.5);
    let rep_payment = json(&body)["payments"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = post(
        format!("/api/admin/invoices/{id}/payments/{rep_payment}/delete"),
        admin.clone(),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status.as_u16(), 400);

    // Edits: purchase order, due date, notes; cancel.
    let (status, body) = post(
        format!("/api/admin/invoices/{id}/update"),
        admin.clone(),
        serde_json::json!({ "purchase_order": "OC-123", "due_on": "2026-09-15", "notes": "pendiente REP 2" }),
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let d = json(&body);
    assert_eq!(d["purchase_order"], "OC-123");
    assert!(d["due_on"].as_str().unwrap().starts_with("2026-09-15"));
    assert_eq!(d["overdue"], true);
    let (_, body) = post(
        format!("/api/admin/invoices/{id}/update"),
        admin.clone(),
        serde_json::json!({ "status": "cancelled" }),
    )
    .await;
    let d = json(&body);
    assert_eq!(d["state"], "cancelada");
    assert_eq!(d["balance"], 0.0);
    let (status, _) = post(format!("/api/admin/invoices/{id}/update"), admin.clone(), serde_json::json!({ "status": "otra" })).await;
    assert_eq!(status.as_u16(), 400);

    // A PDF added by hand; something that is not a PDF is refused.
    let (status, body) = post_multipart_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/invoices/{id}/files"),
        &admin,
        &[("kind", None, b"rep_pdf"), ("file", Some("rep.pdf"), &pdf)],
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{body}");
    assert!(json(&body)["files"].as_array().unwrap().iter().any(|f| f["kind"] == "rep_pdf"));
    let (status, _) = post_multipart_with_cookie(
        build_app(shared.clone()),
        host,
        &format!("/api/admin/invoices/{id}/files"),
        &admin,
        &[("kind", None, b"rep_pdf"), ("file", Some("x.pdf"), b"no es pdf")],
    )
    .await;
    assert_eq!(status.as_u16(), 400);

    // Projects: the part numbers on the invoice suggest the project, the link is many-to-many
    // and the project lists the invoice with its files and payments.
    create_concept_status(&state, &company, "En espera", 1, None, true, false, false, true).await.unwrap();
    let project = create_project(&state, &company, "Estaciones Braba", None, None, None, ProjectPriority::Medium, Some(9000.0), None, None)
        .await
        .unwrap();
    let other = create_project(&state, &company, "Otro proyecto", None, None, None, ProjectPriority::Medium, Some(1.0), None, None)
        .await
        .unwrap();
    create_project_concept(
        &state, &company, &project, None, "ZBL124-A", 1.0, Some("pza".into()), None, None, Some(1000.0), None, 1,
    )
    .await
    .unwrap();
    let (status, body) = get(format!("/api/admin/invoices/{id}/project_suggestions"), admin.clone()).await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let sug = json(&body);
    assert_eq!(sug.as_array().unwrap().len(), 1);
    assert_eq!(sug[0]["project_id"], project.to_hex());
    assert_eq!(sug[0]["matches"], 1);
    let (status, body) = post(
        format!("/api/admin/invoices/{id}/update"),
        admin.clone(),
        serde_json::json!({ "project_ids": [project.to_hex(), other.to_hex(), project.to_hex()] }),
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{body}");
    assert_eq!(json(&body)["project_ids"].as_array().unwrap().len(), 2, "no duplicates");
    let (status, body) = get(format!("/api/admin/projects/{}/invoices", project.to_hex()), admin.clone()).await;
    assert_eq!(status.as_u16(), 200, "{body}");
    let linked = json(&body);
    assert_eq!(linked.as_array().unwrap().len(), 1);
    assert_eq!(linked[0]["folio"], "141");
    assert!(linked[0]["files"].as_array().unwrap().iter().any(|f| f["kind"] == "rep_xml"));
    assert!(linked[0]["payments"].as_array().unwrap().iter().any(|p| p["source"] == "rep"));
    let (_, body) = post(
        format!("/api/admin/invoices/{id}/update"),
        admin.clone(),
        serde_json::json!({ "project_ids": [other.to_hex()] }),
    )
    .await;
    assert_eq!(json(&body)["project_ids"].as_array().unwrap().len(), 1);
    let (_, body) = get(format!("/api/admin/projects/{}/invoices", project.to_hex()), admin.clone()).await;
    assert_eq!(json(&body).as_array().unwrap().len(), 0, "unlinked from the first project");
    let (status, _) = post(
        format!("/api/admin/invoices/{id}/update"),
        admin.clone(),
        serde_json::json!({ "project_ids": [ObjectId::new().to_hex()] }),
    )
    .await;
    assert_eq!(status.as_u16(), 404, "a project that does not exist");
    assert_eq!(get(format!("/api/admin/projects/{}/invoices", project.to_hex()), staff.clone()).await.0.as_u16(), 403);

    // Another company never sees it.
    let (status, _) = get(format!("/api/admin/invoices/{}", ObjectId::new().to_hex()), admin.clone()).await;
    assert_eq!(status.as_u16(), 404);
}

/// GET returning the raw bytes (the harness helper for text would mangle a PDF).
async fn get_with_cookie_bytes_pdf(
    shared: Arc<alfredodev::state::AppState>,
    host: &str,
    path: &str,
    token: &str,
) -> (axum::http::StatusCode, axum::http::HeaderMap, Vec<u8>) {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let req = Request::builder()
        .method("GET")
        .uri(path)
        .header("host", host)
        .header("cookie", format!("{SESSION_COOKIE_NAME}={token}"))
        .body(Body::empty())
        .unwrap();
    let res = build_app(shared).oneshot(req).await.expect("request failed");
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = axum::body::to_bytes(res.into_body(), 8 * 1024 * 1024).await.unwrap().to_vec();
    (status, headers, bytes)
}
