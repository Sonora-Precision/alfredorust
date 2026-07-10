// Parse CFDI 3.3/4.0 XML and upsert into MongoDB by UUID.

use anyhow::{Context, Result, bail};
use bson::{Bson, doc};
use mongodb::Collection;
use roxmltree::{Document, Node};
use std::io::Read;
use zip::ZipArchive;

/// Key fields extracted from a CFDI, returned after each successful import.
#[derive(Debug, Clone)]
pub struct ImportedCfdi {
    pub uuid: String,
    /// "I" = Ingreso, "E" = Egreso, "T" = Traslado, "N" = Nómina, "P" = Pago
    pub tipo_de_comprobante: String,
    pub total: String,
    pub fecha: String,
    pub emisor_rfc: String,
    pub emisor_nombre: String,
    pub receptor_rfc: String,
    pub receptor_nombre: String,
    pub moneda: String,
    /// Serie-Folio combined, e.g. "REGT-474850" or just "474850" if no serie.
    pub folio: String,
}

/// Where to persist raw CFDI XML on disk, as a source-of-truth store deduped by
/// UUID. Files land at `{root}/{slug}/{rfc}/{direction}/{year}/{uuid}.xml`.
pub struct CfdiStoreTarget {
    pub root: std::path::PathBuf,
    pub slug: String,
    pub rfc: String,
    /// "emitido" or "recibido".
    pub direction: &'static str,
}

/// Keep only path-safe characters (ASCII alphanumeric, `-`, `_`) in a path
/// segment so a hostile slug/rfc/uuid cannot escape the store directory.
fn sanitize_segment(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// Write one CFDI's raw XML to the on-disk store, deduped by UUID. Best-effort:
/// any IO error is logged and swallowed so it never fails the import.
fn store_raw_xml(target: &CfdiStoreTarget, cfdi: &ImportedCfdi, xml: &str) {
    let slug = sanitize_segment(&target.slug);
    let rfc = sanitize_segment(&target.rfc);
    let year = if cfdi.fecha.len() >= 4 {
        sanitize_segment(&cfdi.fecha[..4])
    } else {
        "unknown".to_string()
    };
    let uuid = sanitize_segment(&cfdi.uuid);

    let dir = target
        .root
        .join(&slug)
        .join(&rfc)
        .join(target.direction)
        .join(&year);
    let path = dir.join(format!("{uuid}.xml"));

    if path.exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[cfdi] store: failed to create {}: {e}", dir.display());
        return;
    }
    if let Err(e) = std::fs::write(&path, xml) {
        eprintln!("[cfdi] store: failed to write {}: {e}", path.display());
    }
}

/// Extract and import all CFDI XML files from a ZIP. Returns imported CFDIs.
/// When `store` is `Some`, each successfully-imported CFDI's raw XML is also
/// persisted to the on-disk store (best-effort, deduped by UUID).
pub async fn import_zip(
    collection: &Collection<bson::Document>,
    company_id: &str,
    zip_bytes: &[u8],
    store: Option<&CfdiStoreTarget>,
) -> Result<Vec<ImportedCfdi>> {
    let xml_files = extract_zip_xmls(zip_bytes)?;

    let mut imported = Vec::new();
    for (name, xml) in xml_files {
        match import_xml(collection, company_id, &xml).await {
            Ok(cfdi) => {
                if let Some(target) = store {
                    store_raw_xml(target, &cfdi, &xml);
                }
                imported.push(cfdi);
            }
            Err(e) => eprintln!("[cfdi] skip {name}: {e}"),
        }
    }

    Ok(imported)
}

/// Parse a single CFDI XML string and upsert into MongoDB (keyed by UUID).
pub async fn import_xml(
    collection: &Collection<bson::Document>,
    company_id: &str,
    xml: &str,
) -> Result<ImportedCfdi> {
    let xml = xml.strip_prefix('\u{FEFF}').unwrap_or(xml);
    let xml_doc = Document::parse(xml).context("Parsing CFDI XML")?;
    let (uuid, mut bson_doc, summary) = parse_cfdi(&xml_doc)?;

    bson_doc.insert("company_id", company_id);

    collection
        .update_one(doc! { "uuid": &uuid }, doc! { "$set": &bson_doc })
        .upsert(true)
        .await
        .context("MongoDB upsert")?;

    Ok(summary)
}

/// Extract every `.xml` entry from a ZIP as `(name, contents)` pairs.
fn extract_zip_xmls(zip_bytes: &[u8]) -> Result<Vec<(String, String)>> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor).context("Opening ZIP")?;

    let mut xml_files: Vec<(String, String)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).context("Reading ZIP entry")?;
        let name = entry.name().to_lowercase();
        if !name.ends_with(".xml") {
            continue;
        }
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .with_context(|| format!("Reading {name} from ZIP"))?;
        xml_files.push((name, xml));
    }
    Ok(xml_files)
}

/// Import one CFDI XML (DB upsert by UUID) and also persist the raw XML to the
/// on-disk store, deriving `emitido`/`recibido` from the company's own RFC.
///
/// The direction (and therefore the store subfolder) is decided by which party
/// of the CFDI matches `company_rfc`: emisor → emitido, receptor → recibido.
/// When `company_rfc` is empty (no SAT config yet) or matches neither party, we
/// fall back to the receptor's RFC folder as `recibido` — the DB record is
/// unaffected either way (it is keyed purely by UUID).
pub async fn import_xml_with_store(
    collection: &Collection<bson::Document>,
    company_id: &str,
    xml: &str,
    store_root: &std::path::Path,
    slug: &str,
    company_rfc: &str,
) -> Result<ImportedCfdi> {
    let summary = import_xml(collection, company_id, xml).await?;

    let crfc = company_rfc.trim().to_uppercase();
    let (direction, store_rfc): (&'static str, String) = if !crfc.is_empty()
        && summary.emisor_rfc.trim().to_uppercase() == crfc
    {
        ("emitido", company_rfc.trim().to_string())
    } else if !crfc.is_empty() && summary.receptor_rfc.trim().to_uppercase() == crfc {
        ("recibido", company_rfc.trim().to_string())
    } else if !crfc.is_empty() {
        // Company RFC known but matches neither party — still keep it under the
        // tenant's own folder so all of a company's XML stays together.
        ("recibido", company_rfc.trim().to_string())
    } else {
        ("recibido", summary.receptor_rfc.trim().to_string())
    };

    let target = CfdiStoreTarget {
        root: store_root.to_path_buf(),
        slug: slug.to_string(),
        rfc: store_rfc,
        direction,
    };
    // Strip the BOM so the stored bytes match what we parsed.
    let clean = xml.strip_prefix('\u{FEFF}').unwrap_or(xml);
    store_raw_xml(&target, &summary, clean);

    Ok(summary)
}

/// Import CFDI(s) from a manually-uploaded file: either a single `.xml` or a
/// `.zip` of XMLs. Each CFDI is upserted by UUID and its raw XML persisted to
/// the on-disk store (deduped by UUID), exactly like the SAT download path.
/// Per-file parse errors are logged and skipped so one bad file never aborts a
/// multi-file upload. Returns the CFDIs that imported successfully.
pub async fn import_upload(
    collection: &Collection<bson::Document>,
    company_id: &str,
    filename: &str,
    bytes: &[u8],
    store_root: &std::path::Path,
    slug: &str,
    company_rfc: &str,
) -> Result<Vec<ImportedCfdi>> {
    let xmls: Vec<(String, String)> = if filename.to_lowercase().ends_with(".zip") {
        extract_zip_xmls(bytes)?
    } else {
        let xml = std::str::from_utf8(bytes).context("El XML del CFDI no es UTF-8 válido")?;
        vec![(filename.to_string(), xml.to_string())]
    };

    let mut imported = Vec::new();
    for (name, xml) in xmls {
        match import_xml_with_store(collection, company_id, &xml, store_root, slug, company_rfc)
            .await
        {
            Ok(cfdi) => imported.push(cfdi),
            Err(e) => eprintln!("[cfdi] upload skip {name}: {e}"),
        }
    }
    Ok(imported)
}

fn parse_cfdi(doc: &Document) -> Result<(String, bson::Document, ImportedCfdi)> {
    let root = doc.root_element();
    if root.tag_name().name() != "Comprobante" {
        bail!("Root element is not cfdi:Comprobante");
    }

    let tfd = descendent(root, "TimbreFiscalDigital")
        .context("TimbreFiscalDigital not found — maybe not a timbrado CFDI")?;
    let uuid = tfd
        .attribute("UUID")
        .context("UUID missing in TimbreFiscalDigital")?
        .to_lowercase();

    let comprobante = doc! {
        "version":           root.attribute("Version").unwrap_or(""),
        "folio":             root.attribute("Folio").unwrap_or(""),
        "fecha":             root.attribute("Fecha").unwrap_or(""),
        "formaPago":         root.attribute("FormaPago").unwrap_or(""),
        "metodoPago":        root.attribute("MetodoPago").unwrap_or(""),
        "tipoDeComprobante": root.attribute("TipoDeComprobante").unwrap_or(""),
        "exportacion":       root.attribute("Exportacion").unwrap_or(""),
        "moneda":            root.attribute("Moneda").unwrap_or(""),
        "subTotal":          root.attribute("SubTotal").unwrap_or(""),
        "total":             root.attribute("Total").unwrap_or(""),
        "lugarExpedicion":   root.attribute("LugarExpedicion").unwrap_or(""),
        "noCertificado":     root.attribute("NoCertificado").unwrap_or(""),
        "sello":             root.attribute("Sello").unwrap_or(""),
        "certificado":       root.attribute("Certificado").unwrap_or(""),
    };

    let tipo = root
        .attribute("TipoDeComprobante")
        .unwrap_or("")
        .to_string();
    let total_str = root.attribute("Total").unwrap_or("0").to_string();
    let fecha_str = root.attribute("Fecha").unwrap_or("").to_string();
    let moneda_str = root.attribute("Moneda").unwrap_or("MXN").to_string();
    let serie_str = root.attribute("Serie").unwrap_or("").to_string();
    let folio_str = root.attribute("Folio").unwrap_or("").to_string();
    let folio_combined = match (serie_str.is_empty(), folio_str.is_empty()) {
        (false, false) => format!("{serie_str}-{folio_str}"),
        (true, false) => folio_str,
        _ => String::new(),
    };

    let emisor_node = child(root, "Emisor");
    let emisor_rfc = emisor_node
        .and_then(|n| n.attribute("Rfc"))
        .unwrap_or("")
        .to_string();
    let emisor_nombre = emisor_node
        .and_then(|n| n.attribute("Nombre"))
        .unwrap_or("")
        .to_string();
    let emisor = doc! {
        "rfc":          &emisor_rfc,
        "nombre":       &emisor_nombre,
        "regimenFiscal":emisor_node.and_then(|n| n.attribute("RegimenFiscal")).unwrap_or(""),
    };

    let receptor_node = child(root, "Receptor");
    let receptor_rfc = receptor_node
        .and_then(|n| n.attribute("Rfc"))
        .unwrap_or("")
        .to_string();
    let receptor_nombre = receptor_node
        .and_then(|n| n.attribute("Nombre"))
        .unwrap_or("")
        .to_string();
    let receptor = doc! {
        "rfc":           &receptor_rfc,
        "nombre":        &receptor_nombre,
        "domicilioFiscal":receptor_node.and_then(|n| n.attribute("DomicilioFiscalReceptor")).unwrap_or(""),
        "regimenFiscal": receptor_node.and_then(|n| n.attribute("RegimenFiscalReceptor")).unwrap_or(""),
        "usoCFDI":       receptor_node.and_then(|n| n.attribute("UsoCFDI")).unwrap_or(""),
    };

    let conceptos: Vec<Bson> = child(root, "Conceptos")
        .map(|cn| {
            cn.children()
                .filter(|n| n.is_element() && n.tag_name().name() == "Concepto")
                .map(|c| Bson::Document(parse_concepto(c)))
                .collect()
        })
        .unwrap_or_default();

    let impuestos = child(root, "Impuestos")
        .map(parse_impuestos)
        .unwrap_or_default();

    let timbre = doc! {
        "version":        tfd.attribute("Version").unwrap_or(""),
        "uuid":           &uuid,
        "fechaTimbrado":  tfd.attribute("FechaTimbrado").unwrap_or(""),
        "rfcProvCertif":  tfd.attribute("RfcProvCertif").unwrap_or(""),
        "noCertificadoSAT": tfd.attribute("NoCertificadoSAT").unwrap_or(""),
        "selloCFD":       tfd.attribute("SelloCFD").unwrap_or(""),
        "selloSAT":       tfd.attribute("SelloSAT").unwrap_or(""),
    };

    let out = doc! {
        "uuid":                 &uuid,
        "comprobante":          comprobante,
        "emisor":               emisor,
        "receptor":             receptor,
        "conceptos":            conceptos,
        "impuestos":            impuestos,
        "timbreFiscalDigital":  timbre,
    };

    let summary = ImportedCfdi {
        uuid: uuid.clone(),
        tipo_de_comprobante: tipo,
        total: total_str,
        fecha: fecha_str,
        emisor_rfc,
        emisor_nombre,
        receptor_rfc,
        receptor_nombre,
        moneda: moneda_str,
        folio: folio_combined,
    };

    Ok((uuid, out, summary))
}

fn parse_concepto(node: Node) -> bson::Document {
    let traslados: Vec<Bson> = child(node, "Impuestos")
        .and_then(|imp| child(imp, "Traslados"))
        .map(|tr| {
            tr.children()
                .filter(|n| n.is_element() && n.tag_name().name() == "Traslado")
                .map(|t| Bson::Document(parse_traslado(t)))
                .collect()
        })
        .unwrap_or_default();

    let mut d = doc! {
        "claveProdServ":    node.attribute("ClaveProdServ").unwrap_or(""),
        "claveUnidad":      node.attribute("ClaveUnidad").unwrap_or(""),
        "cantidad":         node.attribute("Cantidad").unwrap_or(""),
        "noIdentificacion": node.attribute("NoIdentificacion").unwrap_or(""),
        "descripcion":      node.attribute("Descripcion").unwrap_or(""),
        "valorUnitario":    node.attribute("ValorUnitario").unwrap_or(""),
        "importe":          node.attribute("Importe").unwrap_or(""),
        "objetoImp":        node.attribute("ObjetoImp").unwrap_or(""),
    };
    if !traslados.is_empty() {
        d.insert("traslados", traslados);
    }
    d
}

fn parse_traslado(node: Node) -> bson::Document {
    doc! {
        "base":        node.attribute("Base").unwrap_or(""),
        "impuesto":    node.attribute("Impuesto").unwrap_or(""),
        "tipoFactor":  node.attribute("TipoFactor").unwrap_or(""),
        "tasaOCuota":  node.attribute("TasaOCuota").unwrap_or(""),
        "importe":     node.attribute("Importe").unwrap_or(""),
    }
}

fn parse_impuestos(node: Node) -> bson::Document {
    let traslados: Vec<Bson> = child(node, "Traslados")
        .map(|tr| {
            tr.children()
                .filter(|n| n.is_element() && n.tag_name().name() == "Traslado")
                .map(|t| Bson::Document(parse_traslado(t)))
                .collect()
        })
        .unwrap_or_default();

    let mut d = doc! {
        "totalImpuestosTrasladados": node.attribute("TotalImpuestosTrasladados").unwrap_or(""),
    };
    if !traslados.is_empty() {
        d.insert("traslados", traslados);
    }
    d
}

fn child<'a, 'input>(node: Node<'a, 'input>, local: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == local)
}

fn descendent<'a, 'input>(node: Node<'a, 'input>, local: &str) -> Option<Node<'a, 'input>> {
    node.descendants()
        .find(|n| n.is_element() && n.tag_name().name() == local)
}
