// Invoice register: the XML decides the amounts. Invoices, REPs and credit notes load in any
// order and can be loaded again without duplicating anything; money received before its REP
// is replaced by the REP; a USD invoice paid in pesos keeps its balance in dollars.
#[path = "common/mod.rs"]
mod common;

use std::io::Write;

use alfredodev::models::{InvoiceStatus, Invoice};
use alfredodev::state::{
    ManualPayment, add_manual_payment, delete_manual_payment, get_invoice_by_uuid, import_files, list_invoices,
};
use common::harness::*;
use mongodb::bson::oid::ObjectId;

const US: &str = "RIAD90102219A";
const CUSTOMER: &str = "BTE131008US3";

fn invoice_xml(uuid: &str, folio: &str, total: f64, method: &str, currency: &str, extra: &str) -> String {
    // subtotal 1000 + 16% VAT − 1.25% ISR = 1147.50 unless a different total is given.
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Folio="{folio}" Fecha="2026-07-30T15:16:30" SubTotal="1000" Moneda="{currency}" TipoCambio="17.6425" Total="{total}" TipoDeComprobante="I" MetodoPago="{method}">
  {extra}
  <cfdi:Emisor Rfc="{US}" Nombre="DANIEL" />
  <cfdi:Receptor Rfc="{CUSTOMER}" Nombre="BRABA TECH" />
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" Descripcion="ZBL124-A" ValorUnitario="1000" Importe="1000" /></cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosRetenidos="12.50" TotalImpuestosTrasladados="160" />
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="{uuid}" /></cfdi:Complemento>
</cfdi:Comprobante>"#
    )
}

fn rep_xml(rep_uuid: &str, doc_uuid: &str, installment: i32, before: f64, paid: f64, after: f64, month_day: &str) -> String {
    rep_xml_in(rep_uuid, doc_uuid, installment, before, paid, after, month_day, "MXN", "MXN", "1", paid)
}

#[allow(clippy::too_many_arguments)]
fn rep_xml_in(
    rep_uuid: &str,
    doc_uuid: &str,
    installment: i32,
    before: f64,
    paid: f64,
    after: f64,
    month_day: &str,
    pay_currency: &str,
    doc_currency: &str,
    equivalence: &str,
    amount: f64,
) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" Version="4.0" Serie="REP {installment}" Folio="141" Fecha="2026-{month_day}T23:10:48" Moneda="XXX" Total="0" TipoDeComprobante="P">
  <cfdi:Emisor Rfc="{US}" />
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="2026-{month_day}T12:00:00" MonedaP="{pay_currency}" TipoCambioP="1" Monto="{amount}">
        <pago20:DoctoRelacionado IdDocumento="{doc_uuid}" Folio="141" MonedaDR="{doc_currency}" EquivalenciaDR="{equivalence}" NumParcialidad="{installment}" ImpSaldoAnt="{before}" ImpPagado="{paid}" ImpSaldoInsoluto="{after}" />
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="{rep_uuid}" />
  </cfdi:Complemento>
</cfdi:Comprobante>"#
    )
}

fn credit_note_xml(uuid: &str, total: f64, related: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Folio="9" Fecha="2026-08-02T10:00:00" Moneda="MXN" Total="{total}" TipoDeComprobante="E">
  <cfdi:CfdiRelacionados TipoRelacion="01"><cfdi:CfdiRelacionado UUID="{related}" /></cfdi:CfdiRelacionados>
  <cfdi:Emisor Rfc="{US}" />
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="{uuid}" /></cfdi:Complemento>
</cfdi:Comprobante>"#
    )
}

fn file(name: &str, xml: String) -> (String, Vec<u8>) {
    (name.to_string(), xml.into_bytes())
}

fn pdf() -> Vec<u8> {
    b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF".to_vec()
}

async fn setup() -> Option<(common::TestContext, ObjectId)> {
    let ctx = common::setup_state().await?;
    let store = std::env::temp_dir().join(format!("invoice_store_{}", ObjectId::new().to_hex()));
    unsafe { std::env::set_var("PART_FILE_STORE_DIR", &store) };
    let company = create_company(&ctx.state, "Invoice Co", "invoice-co", "MXN", true, None).await.unwrap();
    Some((ctx, company))
}

async fn one(state: &alfredodev::state::AppState, company: &ObjectId, uuid: &str) -> Invoice {
    get_invoice_by_uuid(state, company, uuid).await.unwrap().expect("invoice registered")
}

#[tokio::test]
async fn exact_balance_from_the_xml_in_any_order_and_idempotent() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let inv = "11111111-1111-1111-1111-111111111111";
    let files = vec![
        // The REPs come first on purpose: the order of the files must not matter.
        file("rep1.xml", rep_xml("aaaaaaaa-0000-0000-0000-000000000001", inv, 1, 1147.50, 500.0, 647.50, "08-01")),
        file("rep2.xml", rep_xml("aaaaaaaa-0000-0000-0000-000000000002", inv, 2, 647.50, 647.50, 0.0, "08-15")),
        file("factura.xml", invoice_xml(inv, "141", 1147.50, "PPD", "MXN", "")),
    ];
    let report = import_files(state, &company, &rfcs, files.clone()).await.unwrap();
    assert_eq!(report.invoices_new, 1);
    assert_eq!(report.payments_new, 2);
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    let i = one(state, &company, inv).await;
    assert_eq!(i.total, 1147.50);
    assert_eq!(i.withholding, 12.50);
    assert_eq!(i.paid(), 1147.50);
    assert_eq!(i.balance(), 0.0);
    assert_eq!(i.pending_pct(), 0.0);
    assert_eq!(i.files.len(), 3, "invoice XML and both REP XML");

    // Loading the same files again changes nothing.
    let again = import_files(state, &company, &rfcs, files).await.unwrap();
    assert_eq!(again.invoices_new, 0);
    assert_eq!(again.payments_new, 0);
    assert_eq!(again.payments_updated, 2);
    let i = one(state, &company, inv).await;
    assert_eq!(i.payments.len(), 2);
    assert_eq!(i.files.len(), 3);
    assert_eq!(list_invoices(state, &company).await.unwrap().len(), 1);
}

#[tokio::test]
async fn partial_payment_leaves_the_exact_share_pending() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let inv = "22222222-2222-2222-2222-222222222222";
    import_files(
        state,
        &company,
        &rfcs,
        vec![
            file("f.xml", invoice_xml(inv, "142", 1147.50, "PPD", "MXN", "")),
            file("r.xml", rep_xml("bbbbbbbb-0000-0000-0000-000000000001", inv, 1, 1147.50, 500.0, 647.50, "08-01")),
        ],
    )
    .await
    .unwrap();
    let i = one(state, &company, inv).await;
    assert_eq!(i.balance(), 647.50);
    assert_eq!(i.pending_pct(), 56.43);
}

#[tokio::test]
async fn money_received_before_the_rep_is_replaced_by_it() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let inv = "33333333-3333-3333-3333-333333333333";
    import_files(state, &company, &rfcs, vec![file("f.xml", invoice_xml(inv, "143", 1147.50, "PPD", "MXN", ""))])
        .await
        .unwrap();
    let id = one(state, &company, inv).await.id.unwrap();

    let after = add_manual_payment(
        state,
        &company,
        &id,
        ManualPayment { paid_on_ms: 1_790_000_000_000, amount: 500.0, currency: "MXN".into(), exchange_rate: None, note: None },
    )
    .await
    .unwrap();
    assert_eq!(after.balance(), 647.50);
    assert_eq!(after.payments[0].source, "manual");

    // The REP for that payment arrives: it takes the manual entry's place.
    import_files(
        state,
        &company,
        &rfcs,
        vec![file("r.xml", rep_xml("cccccccc-0000-0000-0000-000000000001", inv, 1, 1147.50, 500.0, 647.50, "08-01"))],
    )
    .await
    .unwrap();
    let i = one(state, &company, inv).await;
    assert_eq!(i.payments.len(), 1);
    assert_eq!(i.payments[0].source, "rep");
    assert_eq!(i.balance(), 647.50);

    // A payment backed by a CFDI cannot be removed by hand.
    assert!(delete_manual_payment(state, &company, &id, &i.payments[0].id).await.is_err());
}

#[tokio::test]
async fn usd_invoice_paid_in_pesos_keeps_its_balance_in_dollars() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let inv = "44444444-4444-4444-4444-444444444444";
    import_files(state, &company, &rfcs, vec![file("f.xml", invoice_xml(inv, "157", 172.12, "PPD", "USD", ""))])
        .await
        .unwrap();
    let i = one(state, &company, inv).await;
    assert_eq!(i.currency, "USD");
    assert_eq!(i.exchange_rate, Some(17.6425));

    // Paid in pesos: the day's DOF rate turns it into dollars.
    let id = i.id.unwrap();
    let after = add_manual_payment(
        state,
        &company,
        &id,
        ManualPayment { paid_on_ms: 1_790_000_000_000, amount: 172.05, currency: "MXN".into(), exchange_rate: Some(18.5798), note: None },
    )
    .await
    .unwrap();
    assert_eq!(after.payments[0].applied, 9.26);
    assert_eq!(after.balance(), 162.86);
    // A payment in another currency needs its exchange rate.
    assert!(
        add_manual_payment(
            state,
            &company,
            &id,
            ManualPayment { paid_on_ms: 1_790_000_000_000, amount: 100.0, currency: "MXN".into(), exchange_rate: None, note: None },
        )
        .await
        .is_err()
    );

    // The REP states the same conversion.
    import_files(
        state,
        &company,
        &rfcs,
        vec![file(
            "r.xml",
            rep_xml_in("dddddddd-0000-0000-0000-000000000001", inv, 1, 172.12, 9.26, 162.86, "10-30", "MXN", "USD", "18.5798", 172.05),
        )],
    )
    .await
    .unwrap();
    let i = one(state, &company, inv).await;
    assert_eq!(i.payments.len(), 1, "the REP replaced the manual entry");
    assert_eq!(i.payments[0].currency, "MXN");
    assert_eq!(i.payments[0].exchange_rate, 18.5798);
    assert_eq!(i.payments[0].amount, 172.05);
    assert_eq!(i.balance(), 162.86);
}

#[tokio::test]
async fn credit_note_takes_its_amount_off_the_invoice() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let inv = "55555555-5555-5555-5555-555555555555";
    import_files(
        state,
        &company,
        &rfcs,
        vec![
            file("f.xml", invoice_xml(inv, "119", 1147.50, "PPD", "MXN", "")),
            file("r.xml", rep_xml("eeeeeeee-0000-0000-0000-000000000001", inv, 1, 1147.50, 1000.0, 147.50, "08-01")),
            file("nc.xml", credit_note_xml("eeeeeeee-0000-0000-0000-0000000000ff", 147.50, inv)),
        ],
    )
    .await
    .unwrap();
    let i = one(state, &company, inv).await;
    assert_eq!(i.payments.len(), 2);
    assert_eq!(i.balance(), 0.0);
    assert!(i.payments.iter().any(|p| p.source == "nota_credito"));
}

#[tokio::test]
async fn pue_is_paid_when_issued_and_foreign_invoices_are_left_out() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let pue = "66666666-6666-6666-6666-666666666666";
    let foreign = "77777777-7777-7777-7777-777777777777";
    let other = invoice_xml(foreign, "1", 100.0, "PPD", "MXN", "").replace(US, "AAA010101AAA");
    let report = import_files(
        state,
        &company,
        &rfcs,
        vec![file("pue.xml", invoice_xml(pue, "10", 1147.50, "PUE", "MXN", "")), file("otra.xml", other)],
    )
    .await
    .unwrap();
    assert_eq!(report.invoices_new, 1);
    assert_eq!(report.ignored, 1);
    assert_eq!(one(state, &company, pue).await.balance(), 0.0);
    assert!(get_invoice_by_uuid(state, &company, foreign).await.unwrap().is_none());
}

#[tokio::test]
async fn a_substitute_marks_the_old_invoice_replaced_whichever_loads_first() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let old = "88888888-8888-8888-8888-888888888888";
    let new = "99999999-9999-9999-9999-999999999999";
    let relation = format!(r#"<cfdi:CfdiRelacionados TipoRelacion="04"><cfdi:CfdiRelacionado UUID="{old}" /></cfdi:CfdiRelacionados>"#);
    // The substitute first, then the old one.
    import_files(state, &company, &rfcs, vec![file("n.xml", invoice_xml(new, "146", 1147.50, "PPD", "MXN", &relation))])
        .await
        .unwrap();
    import_files(state, &company, &rfcs, vec![file("o.xml", invoice_xml(old, "146", 1147.50, "PPD", "MXN", ""))])
        .await
        .unwrap();
    let o = one(state, &company, old).await;
    assert_eq!(o.status, InvoiceStatus::Replaced);
    assert_eq!(o.replaced_by.as_deref(), Some(new));
    assert_eq!(o.balance(), 0.0, "a replaced invoice owes nothing");
    assert_eq!(one(state, &company, new).await.balance(), 1147.50);
}

#[tokio::test]
async fn zips_expand_and_pdfs_attach_by_uuid() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let inv = "abababab-abab-abab-abab-abababababab";
    let rep = "cdcdcdcd-0000-0000-0000-000000000001";

    let mut zip_bytes = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file(format!("{inv}.xml"), opts).unwrap();
        w.write_all(invoice_xml(inv, "150", 1147.50, "PPD", "MXN", "").as_bytes()).unwrap();
        w.start_file("../../evil.txt", opts).unwrap();
        w.write_all(b"ignored: not xml or pdf").unwrap();
        w.start_file(format!("{rep}.xml"), opts).unwrap();
        w.write_all(rep_xml(rep, inv, 1, 1147.50, 1147.50, 0.0, "09-01").as_bytes()).unwrap();
        w.finish().unwrap();
    }
    let report = import_files(
        state,
        &company,
        &rfcs,
        vec![
            ("cfdis.zip".to_string(), zip_bytes),
            (format!("{inv}.pdf"), pdf()),
            (format!("{rep}.pdf"), pdf()),
            ("suelto.pdf".to_string(), pdf()),
        ],
    )
    .await
    .unwrap();
    assert_eq!(report.invoices_new, 1);
    assert_eq!(report.payments_new, 1);
    assert_eq!(report.pdfs, 2);
    assert_eq!(report.warnings.len(), 1, "the PDF that belongs to nothing is reported: {:?}", report.warnings);
    let i = one(state, &company, inv).await;
    let kinds: Vec<&str> = i.files.iter().map(|f| f.kind.as_str()).collect();
    for k in ["factura_xml", "factura_pdf", "rep_xml", "rep_pdf"] {
        assert!(kinds.contains(&k), "missing {k} in {kinds:?}");
    }
    assert_eq!(i.balance(), 0.0);
}

/// Loads a folder of real XML (INVOICE_XML_DIR) and prints the register's totals. Not part of
/// the normal run: `INVOICE_XML_DIR=... cargo test --test invoices_state real_folder -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn real_folder() {
    let Ok(dir) = std::env::var("INVOICE_XML_DIR") else { return };
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "xml") {
            files.push((path.file_name().unwrap().to_string_lossy().to_string(), std::fs::read(&path).unwrap()));
        }
    }
    let n = files.len();
    let report = import_files(state, &company, &[US.to_string()], files).await.unwrap();
    println!("xml leídos: {n} | {report:?}");
    let all = list_invoices(state, &company).await.unwrap();
    let active: Vec<_> = all.iter().filter(|i| i.status == InvoiceStatus::Active).collect();
    let mxn: f64 = active.iter().filter(|i| i.currency == "MXN").map(|i| i.total).sum();
    let owed: f64 = active.iter().filter(|i| i.currency == "MXN").map(|i| i.balance()).sum();
    println!(
        "facturas {} (activas {}, sustituidas {}) | facturado MXN {:.2} | por cobrar MXN {:.2} | abiertas {}",
        all.len(),
        active.len(),
        all.iter().filter(|i| i.status == InvoiceStatus::Replaced).count(),
        mxn,
        owed,
        active.iter().filter(|i| i.balance() > 0.0).count()
    );
    for i in active.iter().filter(|i| i.balance() > 0.0) {
        println!("OPEN f{} {} {} {:.2} {} saldo {:.2} ({:.1}%)", i.folio, i.issued_at.try_to_rfc3339_string().unwrap_or_default().get(..10).unwrap_or(""), i.customer_name, i.total, i.currency, i.balance(), i.pending_pct());
    }
}

#[tokio::test]
async fn balance_follows_the_latest_rep_when_an_earlier_one_is_missing() {
    let Some((ctx, company)) = setup().await else { return };
    let state = &ctx.state;
    let rfcs = vec![US.to_string()];
    let inv = "12121212-1212-1212-1212-121212121212";
    // Only the second REP is on file: the SAT's running balance says 0 even though the sum of
    // what we hold covers half the invoice.
    import_files(
        state,
        &company,
        &rfcs,
        vec![
            file("f.xml", invoice_xml(inv, "79", 1147.50, "PPD", "MXN", "")),
            file("r2.xml", rep_xml("12121212-0000-0000-0000-000000000002", inv, 2, 573.75, 573.75, 0.0, "09-01")),
        ],
    )
    .await
    .unwrap();
    let i = one(state, &company, inv).await;
    assert_eq!(i.paid(), 573.75);
    assert_eq!(i.balance(), 0.0);
    assert_eq!(i.settled(), 1147.50);
    assert_eq!(i.pending_pct(), 0.0);
}
