// SAT public "ConsultaCFDIService" — checks whether a timbrado CFDI is Vigente
// or Cancelado from its fiscal fields (RFCs + total + UUID). Unlike descarga
// masiva (src/sat.rs) this endpoint is public: no FIEL/auth is required.
//
// Note: the `tt` (total) format inside the expresión impresa is famously
// finicky; we pass the CFDI's own `Total` string verbatim (URL-unencoded, which
// SAT accepts). Any transport/parse error degrades gracefully to `Unknown`.
use anyhow::{Context, Result};

const CONSULTA_URL: &str =
    "https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc";
const SOAP_ACTION: &str = "http://tempuri.org/IConsultaCFDIService/Consulta";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CfdiEstatus {
    /// Normalized: "vigente" | "cancelado" | "no_encontrado".
    pub estado: String,
    pub es_cancelable: Option<String>,
    pub estatus_cancelacion: Option<String>,
    pub codigo: Option<String>,
}

/// Build the `expresionImpresa` query string SAT expects.
fn expresion_impresa(emisor_rfc: &str, receptor_rfc: &str, total: &str, uuid: &str) -> String {
    format!(
        "?re={}&rr={}&tt={}&id={}",
        emisor_rfc.trim(),
        receptor_rfc.trim(),
        total.trim(),
        uuid.trim(),
    )
}

fn soap_body(expresion: &str) -> String {
    // The expresión contains `&` between params — escape it for the XML payload.
    let esc = expresion
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/"><s:Header/><s:Body><tem:Consulta><tem:expresionImpresa>{esc}</tem:expresionImpresa></tem:Consulta></s:Body></s:Envelope>"#
    )
}

/// Parse SAT's SOAP response into a normalized status. Matches elements by local
/// name so datacontract namespace prefixes don't matter.
fn parse_response(xml: &str) -> Result<CfdiEstatus> {
    let doc = roxmltree::Document::parse(xml).context("parse SAT consulta response")?;
    let by_local = |name: &str| {
        doc.descendants()
            .find(|n| n.is_element() && n.tag_name().name() == name)
            .and_then(|n| n.text())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let estado_raw = by_local("Estado").unwrap_or_default().to_lowercase();
    let estado = if estado_raw.contains("cancel") {
        "cancelado"
    } else if estado_raw.contains("vigente") {
        "vigente"
    } else {
        "no_encontrado"
    }
    .to_string();

    Ok(CfdiEstatus {
        estado,
        es_cancelable: by_local("EsCancelable"),
        estatus_cancelacion: by_local("EstatusCancelacion"),
        codigo: by_local("CodigoEstatus"),
    })
}

/// Query SAT for the status of one CFDI. Network/parse errors bubble up so the
/// caller can leave the stored status untouched.
pub async fn consulta_estatus(
    emisor_rfc: &str,
    receptor_rfc: &str,
    total: &str,
    uuid: &str,
) -> Result<CfdiEstatus> {
    let expresion = expresion_impresa(emisor_rfc, receptor_rfc, total, uuid);
    let body = soap_body(&expresion);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("build SAT consulta client")?;
    let resp = client
        .post(CONSULTA_URL)
        .header("Content-Type", "text/xml; charset=utf-8")
        .header("SOAPAction", SOAP_ACTION)
        .body(body)
        .send()
        .await
        .context("SAT consulta request")?;
    let text = resp.text().await.context("read SAT consulta body")?;
    parse_response(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expresion_impresa_layout() {
        let e = expresion_impresa("EKU9003173C9", "XAXX010101000", "116.00", "ABC-123");
        assert_eq!(e, "?re=EKU9003173C9&rr=XAXX010101000&tt=116.00&id=ABC-123");
    }

    #[test]
    fn parses_vigente() {
        let xml = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi"><a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus><a:EsCancelable>Cancelable sin aceptación</a:EsCancelable><a:Estado>Vigente</a:Estado><a:EstatusCancelacion/></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>"#;
        let r = parse_response(xml).unwrap();
        assert_eq!(r.estado, "vigente");
        assert_eq!(r.codigo.as_deref(), Some("S - Comprobante obtenido satisfactoriamente."));
    }

    #[test]
    fn parses_cancelado() {
        let xml = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://x"><a:Estado>Cancelado</a:Estado><a:EstatusCancelacion>Cancelado con aceptación</a:EstatusCancelacion></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>"#;
        let r = parse_response(xml).unwrap();
        assert_eq!(r.estado, "cancelado");
        assert_eq!(r.estatus_cancelacion.as_deref(), Some("Cancelado con aceptación"));
    }

    #[test]
    fn parses_not_found() {
        let xml = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://x"><a:CodigoEstatus>N - 601: La expresión impresa proporcionada no es válida.</a:CodigoEstatus><a:Estado/></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>"#;
        let r = parse_response(xml).unwrap();
        assert_eq!(r.estado, "no_encontrado");
    }
}
