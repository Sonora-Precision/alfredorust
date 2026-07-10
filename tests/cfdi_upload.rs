// Manual CFDI upload path: `cfdi::import_upload` parses an XML, upserts by UUID
// into MongoDB, and mirrors the raw XML into the on-disk store — deduping on a
// repeat upload and picking emitido/recibido from the company's own RFC.
#[path = "common/mod.rs"]
mod common;

use common::harness::*;

const COMPANY_RFC: &str = "EKU9003173C9";
const RECEPTOR_RFC: &str = "XAXX010101000";

/// A minimal but valid timbrado CFDI 4.0. Emisor RFC = the company's RFC, so it
/// should be classified as `emitido`.
fn sample_xml(uuid: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0"
  Fecha="2024-05-10T12:00:00" TipoDeComprobante="I" Total="116.00" Moneda="MXN"
  Serie="A" Folio="123">
  <cfdi:Emisor Rfc="{COMPANY_RFC}" Nombre="Emisor SA"/>
  <cfdi:Receptor Rfc="{RECEPTOR_RFC}" Nombre="Receptor SA"/>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
      UUID="{uuid}" FechaTimbrado="2024-05-10T12:01:00"/>
  </cfdi:Complemento>
</cfdi:Comprobante>"#
    )
}

#[tokio::test]
async fn manual_upload_persists_dedupes_and_classifies() {
    let ctx = match common::setup_state().await {
        Some(c) => c,
        None => return,
    };
    let state = ctx.state.clone();

    let company_id = create_company(&state, "Upload Co", "upload-co", "MXN", true, None)
        .await
        .unwrap();
    let company_hex = company_id.to_hex();
    let slug = "upload-co";

    // Isolated temp store rooted at a per-run unique dir.
    let root = std::env::temp_dir().join(format!("cfdi_upload_test_{company_hex}"));
    let _ = std::fs::remove_dir_all(&root);

    let uuid = "abcd1234-5678-90ab-cdef-1234567890ab";
    let xml = sample_xml(uuid);

    // 1) First upload: imports one CFDI, writes the file under emitido/2024.
    let imported = alfredodev::cfdi::import_upload(
        &state.cfdis,
        &company_hex,
        "invoice.xml",
        xml.as_bytes(),
        &root,
        slug,
        COMPANY_RFC,
    )
    .await
    .unwrap();
    assert_eq!(imported.len(), 1, "one CFDI imported");
    assert_eq!(imported[0].uuid, uuid);

    let expected_file = root
        .join(slug)
        .join(COMPANY_RFC)
        .join("emitido")
        .join("2024")
        .join(format!("{uuid}.xml"));
    assert!(expected_file.exists(), "raw XML stored at {expected_file:?}");

    let count = state
        .cfdis
        .count_documents(doc! { "uuid": uuid, "company_id": &company_hex })
        .await
        .unwrap();
    assert_eq!(count, 1, "CFDI upserted into the company's collection");

    // 2) Re-upload the same UUID: still exactly one document (dedup by UUID).
    let again = alfredodev::cfdi::import_upload(
        &state.cfdis,
        &company_hex,
        "invoice-copy.xml",
        xml.as_bytes(),
        &root,
        slug,
        COMPANY_RFC,
    )
    .await
    .unwrap();
    assert_eq!(again.len(), 1);
    let count_after = state
        .cfdis
        .count_documents(doc! { "uuid": uuid })
        .await
        .unwrap();
    assert_eq!(count_after, 1, "repeat upload updates in place, no duplicate");

    // 3) When the company RFC matches the *receptor*, it is classified recibido.
    let uuid2 = "11112222-3333-4444-5555-666677778888";
    let xml2 = sample_xml(uuid2);
    alfredodev::cfdi::import_upload(
        &state.cfdis,
        &company_hex,
        "in.xml",
        xml2.as_bytes(),
        &root,
        slug,
        RECEPTOR_RFC, // company is the receptor here
    )
    .await
    .unwrap();
    let recibido_file = root
        .join(slug)
        .join(RECEPTOR_RFC)
        .join("recibido")
        .join("2024")
        .join(format!("{uuid2}.xml"));
    assert!(recibido_file.exists(), "recibido file at {recibido_file:?}");

    let _ = std::fs::remove_dir_all(&root);
    common::teardown(Some(ctx)).await;
}
