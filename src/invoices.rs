//! Reads the CFDIs that matter for the invoice register: the invoices we issue (tipo I),
//! their payment complements (REP, tipo P) and credit notes (tipo E). Pure parsing, no
//! database: `state::invoices` decides what to do with the result.

use anyhow::{Context, Result, bail};
use chrono::NaiveDateTime;
use roxmltree::{Document, Node};

use crate::models::InvoiceLine;

/// Local time of the shop (Hermosillo has no daylight saving: UTC−7). The SAT writes
/// dates in the issuer's local time without an offset.
const LOCAL_UTC_OFFSET_MS: i64 = 7 * 3_600_000;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedInvoice {
    pub uuid: String,
    pub serie: String,
    pub folio: String,
    pub issued_at_ms: i64,
    pub issuer_rfc: String,
    pub customer_rfc: String,
    pub customer_name: String,
    pub currency: String,
    pub exchange_rate: Option<f64>,
    pub subtotal: f64,
    pub tax: f64,
    pub withholding: f64,
    pub total: f64,
    pub payment_method: String,
    pub lines: Vec<InvoiceLine>,
    /// (TipoRelacion, UUID): "04" means this invoice replaces another.
    pub related: Vec<(String, String)>,
}

/// One document a payment applies to.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPaidDoc {
    pub doc_uuid: String,
    pub folio: String,
    pub installment: i32,
    pub previous_balance: f64,
    /// Paid on it, in the invoice's currency.
    pub paid: f64,
    pub balance_after: f64,
    pub doc_currency: String,
    /// Exchange rate between the payment and the invoice currency (1 when equal).
    pub equivalence: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRepPayment {
    pub paid_on_ms: i64,
    pub currency: String,
    /// Exchange rate written on the payment.
    pub rate: f64,
    pub amount: f64,
    pub docs: Vec<ParsedPaidDoc>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRep {
    pub uuid: String,
    pub serie: String,
    pub folio: String,
    pub issuer_rfc: String,
    pub payments: Vec<ParsedRepPayment>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCreditNote {
    pub uuid: String,
    pub serie: String,
    pub folio: String,
    pub issued_at_ms: i64,
    pub issuer_rfc: String,
    pub currency: String,
    pub total: f64,
    pub related: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedCfdi {
    Invoice(ParsedInvoice),
    Rep(ParsedRep),
    CreditNote(ParsedCreditNote),
    /// Payroll, transfer… not part of the register.
    Other(String),
}

fn num(node: Node, attr: &str) -> f64 {
    node.attribute(attr).and_then(|v| v.trim().parse().ok()).unwrap_or(0.0)
}

fn text(node: Node, attr: &str) -> String {
    node.attribute(attr).unwrap_or("").trim().to_string()
}

fn child<'a, 'input>(node: Node<'a, 'input>, local: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|n| n.is_element() && n.tag_name().name() == local)
}

fn descendants<'a, 'input: 'a>(node: Node<'a, 'input>, local: &'a str) -> impl Iterator<Item = Node<'a, 'input>> + 'a {
    node.descendants().filter(move |n| n.is_element() && n.tag_name().name() == local)
}

/// "2026-07-30T15:16:30" (or just a date) → UTC milliseconds, reading it as shop time.
pub fn local_ms(value: &str) -> Result<i64> {
    let value = value.trim();
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(value.get(..10).unwrap_or(value), "%Y-%m-%d")
                .map(|d| d.and_hms_opt(12, 0, 0).unwrap_or_default())
        })
        .with_context(|| format!("fecha inválida: {value}"))?;
    Ok(naive.and_utc().timestamp_millis() + LOCAL_UTC_OFFSET_MS)
}

fn related(root: Node) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for group in descendants(root, "CfdiRelacionados") {
        let kind = text(group, "TipoRelacion");
        for one in descendants(group, "CfdiRelacionado") {
            let uuid = text(one, "UUID").to_lowercase();
            if !uuid.is_empty() {
                out.push((kind.clone(), uuid));
            }
        }
    }
    out
}

fn stamp_uuid(root: Node) -> Result<String> {
    let tfd = descendants(root, "TimbreFiscalDigital")
        .next()
        .context("el CFDI no está timbrado (falta el TimbreFiscalDigital)")?;
    let uuid = text(tfd, "UUID").to_lowercase();
    if uuid.is_empty() {
        bail!("el CFDI no trae UUID");
    }
    Ok(uuid)
}

/// Parses one CFDI 3.3/4.0 XML.
pub fn parse_cfdi(xml: &str) -> Result<ParsedCfdi> {
    let xml = xml.strip_prefix('\u{FEFF}').unwrap_or(xml);
    let doc = Document::parse(xml).context("el archivo no es un XML válido")?;
    let root = doc.root_element();
    if root.tag_name().name() != "Comprobante" {
        bail!("el XML no es un CFDI (Comprobante)");
    }
    let uuid = stamp_uuid(root)?;
    let kind = text(root, "TipoDeComprobante");
    let serie = text(root, "Serie");
    let folio = text(root, "Folio");
    let issuer_rfc = child(root, "Emisor").map(|e| text(e, "Rfc")).unwrap_or_default().to_uppercase();

    match kind.as_str() {
        "I" => {
            let receptor = child(root, "Receptor");
            let tax_node = root
                .children()
                .find(|n| n.is_element() && n.tag_name().name() == "Impuestos");
            let lines = child(root, "Conceptos")
                .map(|c| {
                    c.children()
                        .filter(|n| n.is_element() && n.tag_name().name() == "Concepto")
                        .map(|n| InvoiceLine {
                            description: text(n, "Descripcion"),
                            quantity: num(n, "Cantidad"),
                            unit_value: num(n, "ValorUnitario"),
                            amount: num(n, "Importe"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let currency = text(root, "Moneda");
            Ok(ParsedCfdi::Invoice(ParsedInvoice {
                uuid,
                serie,
                folio,
                issued_at_ms: local_ms(&text(root, "Fecha"))?,
                issuer_rfc,
                customer_rfc: receptor.map(|r| text(r, "Rfc")).unwrap_or_default().to_uppercase(),
                customer_name: receptor.map(|r| text(r, "Nombre")).unwrap_or_default(),
                exchange_rate: if currency == "MXN" || currency.is_empty() {
                    None
                } else {
                    root.attribute("TipoCambio").and_then(|v| v.trim().parse().ok())
                },
                currency: if currency.is_empty() { "MXN".into() } else { currency },
                subtotal: num(root, "SubTotal"),
                tax: tax_node.map(|n| num(n, "TotalImpuestosTrasladados")).unwrap_or(0.0),
                withholding: tax_node.map(|n| num(n, "TotalImpuestosRetenidos")).unwrap_or(0.0),
                total: num(root, "Total"),
                payment_method: text(root, "MetodoPago"),
                lines,
                related: related(root),
            }))
        }
        "E" => Ok(ParsedCfdi::CreditNote(ParsedCreditNote {
            uuid,
            serie,
            folio,
            issued_at_ms: local_ms(&text(root, "Fecha"))?,
            issuer_rfc,
            currency: text(root, "Moneda"),
            total: num(root, "Total"),
            related: related(root),
        })),
        "P" => {
            let mut payments = Vec::new();
            for pago in descendants(root, "Pago") {
                let currency = text(pago, "MonedaP");
                let rate = pago.attribute("TipoCambioP").and_then(|v| v.trim().parse().ok()).unwrap_or(1.0);
                let docs = descendants(pago, "DoctoRelacionado")
                    .map(|d| {
                        let doc_currency = text(d, "MonedaDR");
                        // CFDI 4.0 writes EquivalenciaDR; the older complement, TipoCambioDR.
                        let equivalence = d
                            .attribute("EquivalenciaDR")
                            .or_else(|| d.attribute("TipoCambioDR"))
                            .and_then(|v| v.trim().parse().ok())
                            .unwrap_or(1.0);
                        ParsedPaidDoc {
                            doc_uuid: text(d, "IdDocumento").to_lowercase(),
                            folio: text(d, "Folio"),
                            installment: d.attribute("NumParcialidad").and_then(|v| v.trim().parse().ok()).unwrap_or(1),
                            previous_balance: num(d, "ImpSaldoAnt"),
                            paid: num(d, "ImpPagado"),
                            balance_after: num(d, "ImpSaldoInsoluto"),
                            doc_currency,
                            equivalence,
                        }
                    })
                    .collect();
                payments.push(ParsedRepPayment {
                    paid_on_ms: local_ms(&text(pago, "FechaPago"))?,
                    currency,
                    rate,
                    amount: num(pago, "Monto"),
                    docs,
                });
            }
            Ok(ParsedCfdi::Rep(ParsedRep { uuid, serie, folio, issuer_rfc, payments }))
        }
        other => Ok(ParsedCfdi::Other(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INVOICE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Folio="141" Fecha="2026-07-30T15:16:30" SubTotal="810447.63" Moneda="MXN" Total="929988.65" TipoDeComprobante="I" MetodoPago="PPD">
  <cfdi:Emisor Rfc="RIAD90102219A" Nombre="DANIEL" />
  <cfdi:Receptor Rfc="BTE131008US3" Nombre="BRABA TECH" />
  <cfdi:Conceptos>
    <cfdi:Concepto Cantidad="1" Descripcion="ZBL124-BSE-C260210-13A" ValorUnitario="58900" Importe="58900.000000" />
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosRetenidos="10130.60" TotalImpuestosTrasladados="129671.62" />
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="8D06895E-E3DB-496F-A09A-69CE00FF93BF" />
  </cfdi:Complemento>
</cfdi:Comprobante>"#;

    const REP: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" Version="4.0" Serie="REP 1" Folio="141" Fecha="2026-07-31T23:10:48" Moneda="XXX" Total="0" TipoDeComprobante="P">
  <cfdi:Emisor Rfc="RIAD90102219A" />
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="2026-07-31T12:00:00" MonedaP="MXN" TipoCambioP="1" Monto="464994.33">
        <pago20:DoctoRelacionado IdDocumento="8D06895E-E3DB-496F-A09A-69CE00FF93BF" Folio="141" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="929988.65" ImpPagado="464994.33" ImpSaldoInsoluto="464994.32" />
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="069317D2-0DD7-4900-8522-7B34191938BE" />
  </cfdi:Complemento>
</cfdi:Comprobante>"#;

    #[test]
    fn reads_an_invoice() {
        let ParsedCfdi::Invoice(i) = parse_cfdi(INVOICE).unwrap() else { panic!("not an invoice") };
        assert_eq!(i.uuid, "8d06895e-e3db-496f-a09a-69ce00ff93bf");
        assert_eq!(i.folio, "141");
        assert_eq!(i.customer_name, "BRABA TECH");
        assert_eq!(i.currency, "MXN");
        assert_eq!(i.exchange_rate, None);
        assert_eq!(i.total, 929988.65);
        assert_eq!(i.withholding, 10130.60);
        assert_eq!(i.payment_method, "PPD");
        assert_eq!(i.lines.len(), 1);
        assert_eq!(i.lines[0].description, "ZBL124-BSE-C260210-13A");
        // 15:16:30 in Hermosillo is 22:16:30 UTC.
        assert_eq!(i.issued_at_ms, local_ms("2026-07-30T15:16:30").unwrap());
        assert_eq!(i.issued_at_ms % 86_400_000, (22 * 3600 + 16 * 60 + 30) * 1000);
    }

    #[test]
    fn reads_a_payment_complement() {
        let ParsedCfdi::Rep(r) = parse_cfdi(REP).unwrap() else { panic!("not a REP") };
        assert_eq!(r.uuid, "069317d2-0dd7-4900-8522-7b34191938be");
        assert_eq!(r.payments.len(), 1);
        let p = &r.payments[0];
        assert_eq!(p.amount, 464994.33);
        assert_eq!(p.docs.len(), 1);
        let d = &p.docs[0];
        assert_eq!(d.doc_uuid, "8d06895e-e3db-496f-a09a-69ce00ff93bf");
        assert_eq!(d.installment, 1);
        assert_eq!(d.paid, 464994.33);
        assert_eq!(d.balance_after, 464994.32);
    }

    #[test]
    fn rejects_what_is_not_a_cfdi() {
        assert!(parse_cfdi("<hola/>").is_err());
        assert!(parse_cfdi("no es xml").is_err());
    }

    #[test]
    fn payroll_is_not_part_of_the_register() {
        let xml = INVOICE.replace("TipoDeComprobante=\"I\"", "TipoDeComprobante=\"N\"");
        assert_eq!(parse_cfdi(&xml).unwrap(), ParsedCfdi::Other("N".into()));
    }
}
