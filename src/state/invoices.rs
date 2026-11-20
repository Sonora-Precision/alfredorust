//! Invoice register (cuentas por cobrar): the invoices we issue, what was paid on each (REP,
//! credit notes, money received before the REP exists) and their XML/PDF files. Daniel,
//! 2026-11-19: "registro de facturas", with the REPs attached and the pending balance of
//! each, to know what is billed, what was paid and what is left to collect.
//!
//! XML is the source of truth: an invoice's total and withholdings come from its CFDI and
//! every payment from its REP, so the balance is exact instead of an estimate.

use std::io::Read;

use anyhow::{Context, Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};

use crate::invoices::{ParsedCfdi, ParsedCreditNote, ParsedInvoice, ParsedRep, parse_cfdi};
use crate::models::{Invoice, InvoiceFile, InvoicePayment, InvoiceStatus};

use super::{AppState, MAX_PART_FILE_BYTES, looks_like_pdf, part_file_store_root};

const MAX_XML_BYTES: usize = 5 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 2_000;
const MAX_UNZIPPED_BYTES: u64 = 256 * 1024 * 1024;

pub async fn list_invoices(state: &AppState, company_id: &ObjectId) -> Result<Vec<Invoice>> {
    Ok(state
        .invoices
        .find(doc! { "company_id": company_id })
        .sort(doc! { "issued_at": -1 })
        .await?
        .try_collect()
        .await?)
}

pub async fn get_invoice(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<Option<Invoice>> {
    Ok(state.invoices.find_one(doc! { "_id": id, "company_id": company_id }).await?)
}

pub async fn get_invoice_by_uuid(state: &AppState, company_id: &ObjectId, uuid: &str) -> Result<Option<Invoice>> {
    Ok(state
        .invoices
        .find_one(doc! { "company_id": company_id, "uuid": uuid.to_lowercase() })
        .await?)
}

pub async fn replace_invoice(state: &AppState, invoice: &Invoice) -> Result<()> {
    let Some(id) = invoice.id else { bail!("invoice without id") };
    state
        .invoices
        .replace_one(doc! { "_id": id, "company_id": invoice.company_id }, invoice)
        .await?;
    Ok(())
}

// ── Files ────────────────────────────────────────────────────────────────

fn extension_of(kind: &str) -> &'static str {
    if kind.ends_with("_pdf") { "pdf" } else { "xml" }
}

/// Keeps a file with the invoice (deduped by kind and CFDI UUID). Returns whether it was
/// stored now.
async fn attach_file(
    invoice: &mut Invoice,
    kind: &str,
    filename: &str,
    bytes: &[u8],
    cfdi_uuid: Option<&str>,
) -> Result<bool> {
    let Some(invoice_id) = invoice.id else { bail!("invoice without id") };
    if bytes.is_empty() {
        bail!("el archivo está vacío");
    }
    let uuid = cfdi_uuid.map(|u| u.to_lowercase());
    if let Some(u) = &uuid
        && invoice.files.iter().any(|f| f.kind == kind && f.cfdi_uuid.as_deref() == Some(u.as_str()))
    {
        return Ok(false);
    }
    let file_id = ObjectId::new();
    let storage_key = format!(
        "{}/invoices/{}/{}.{}",
        invoice.company_id.to_hex(),
        invoice_id.to_hex(),
        file_id.to_hex(),
        extension_of(kind)
    );
    let path = part_file_store_root().join(&storage_key);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.context("creating the file store folder")?;
    }
    tokio::fs::write(&path, bytes).await.context("writing the file")?;
    let name = filename.rsplit(['/', '\\']).next().unwrap_or(filename).trim();
    invoice.files.push(InvoiceFile {
        id: file_id,
        kind: kind.to_string(),
        filename: if name.is_empty() { format!("{kind}.{}", extension_of(kind)) } else { name.to_string() },
        size_bytes: bytes.len() as i64,
        storage_key,
        cfdi_uuid: uuid,
        uploaded_at: DateTime::now(),
    });
    Ok(true)
}

pub async fn read_invoice_file(file: &InvoiceFile) -> Result<Vec<u8>> {
    tokio::fs::read(part_file_store_root().join(&file.storage_key))
        .await
        .context("reading the invoice file")
}

/// A PDF or XML added by hand to an invoice ("factura_pdf", "rep_pdf", "otro"…).
pub async fn add_invoice_file(
    state: &AppState,
    company_id: &ObjectId,
    invoice_id: &ObjectId,
    kind: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<Invoice> {
    const KINDS: [&str; 7] = ["factura_xml", "factura_pdf", "rep_xml", "rep_pdf", "nc_xml", "nc_pdf", "otro"];
    if !KINDS.contains(&kind) {
        bail!("tipo de archivo no válido");
    }
    if bytes.len() > MAX_PART_FILE_BYTES {
        bail!("el archivo excede el tamaño máximo (40 MB)");
    }
    if kind.ends_with("_pdf") || kind == "otro" {
        if !looks_like_pdf(bytes) {
            bail!("el documento debe ser un PDF");
        }
    } else if bytes.len() > MAX_XML_BYTES {
        bail!("el XML excede el tamaño máximo (5 MB)");
    }
    let Some(mut invoice) = get_invoice(state, company_id, invoice_id).await? else {
        bail!("factura no encontrada");
    };
    // A manually added file has no CFDI UUID, so it is never taken for a duplicate.
    attach_file(&mut invoice, kind, filename, bytes, None).await?;
    invoice.updated_at = DateTime::now();
    replace_invoice(state, &invoice).await?;
    Ok(invoice)
}

// ── Import ───────────────────────────────────────────────────────────────

#[derive(Debug, Default, serde::Serialize)]
pub struct ImportReport {
    pub invoices_new: usize,
    pub invoices_updated: usize,
    pub payments_new: usize,
    pub payments_updated: usize,
    pub credit_notes: usize,
    pub pdfs: usize,
    /// Files that were not part of the register (received invoices, payroll…).
    pub ignored: usize,
    /// Things worth a look: a REP whose invoice is not registered, a file that did not parse…
    pub warnings: Vec<String>,
}

/// One uploaded file, already read: `(name, bytes)`.
pub type UploadedFile = (String, Vec<u8>);

/// Expands ZIPs (one level of nesting) into their XML and PDF entries.
pub fn expand_uploads(files: Vec<UploadedFile>) -> Result<Vec<UploadedFile>> {
    let mut out = Vec::new();
    let mut budget = MAX_UNZIPPED_BYTES;
    for (name, bytes) in files {
        expand_one(name, bytes, 0, &mut budget, &mut out)?;
    }
    Ok(out)
}

fn expand_one(name: String, bytes: Vec<u8>, depth: u8, budget: &mut u64, out: &mut Vec<UploadedFile>) -> Result<()> {
    let lower = name.to_lowercase();
    if !lower.ends_with(".zip") {
        if lower.ends_with(".xml") || lower.ends_with(".pdf") {
            out.push((name, bytes));
        }
        return Ok(());
    }
    if depth >= 2 {
        return Ok(());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).with_context(|| format!("{name}: ZIP no válido"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        bail!("{name}: el ZIP trae demasiados archivos");
    }
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        // Names only: nothing is ever extracted to a path taken from the archive.
        let entry_name = entry.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
        let lower = entry_name.to_lowercase();
        if !(lower.ends_with(".xml") || lower.ends_with(".pdf") || lower.ends_with(".zip")) {
            continue;
        }
        let size = entry.size();
        if size > MAX_PART_FILE_BYTES as u64 || size > *budget {
            bail!("{name}: un archivo del ZIP es demasiado grande");
        }
        *budget -= size;
        let mut data = Vec::with_capacity(size as usize);
        entry.by_ref().take(MAX_PART_FILE_BYTES as u64).read_to_end(&mut data)?;
        expand_one(entry_name, data, depth + 1, budget, out)?;
    }
    Ok(())
}

fn to_dt(ms: i64) -> DateTime {
    DateTime::from_millis(ms)
}

fn new_invoice(company_id: ObjectId, p: &ParsedInvoice) -> Invoice {
    let now = DateTime::now();
    Invoice {
        id: Some(ObjectId::new()),
        company_id,
        uuid: p.uuid.clone(),
        serie: p.serie.clone(),
        folio: p.folio.clone(),
        issued_at: to_dt(p.issued_at_ms),
        due_on: None,
        customer_rfc: p.customer_rfc.clone(),
        customer_name: p.customer_name.clone(),
        contact_id: None,
        currency: p.currency.clone(),
        exchange_rate: p.exchange_rate,
        subtotal: p.subtotal,
        tax: p.tax,
        withholding: p.withholding,
        total: p.total,
        payment_method: p.payment_method.clone(),
        status: InvoiceStatus::Active,
        replaced_by: None,
        replaces: p.related.iter().filter(|(k, _)| k == "04").map(|(_, u)| u.clone()).collect(),
        lines: p.lines.clone(),
        payments: Vec::new(),
        files: Vec::new(),
        project_id: None,
        purchase_order: None,
        notes: None,
        created_at: now,
        updated_at: now,
    }
}

/// Refreshes what the CFDI says; keeps what we added (payments, files, links, notes, status).
fn refresh_from_cfdi(invoice: &mut Invoice, p: &ParsedInvoice) {
    invoice.serie = p.serie.clone();
    invoice.folio = p.folio.clone();
    invoice.issued_at = to_dt(p.issued_at_ms);
    invoice.customer_rfc = p.customer_rfc.clone();
    invoice.customer_name = p.customer_name.clone();
    invoice.currency = p.currency.clone();
    invoice.exchange_rate = p.exchange_rate;
    invoice.subtotal = p.subtotal;
    invoice.tax = p.tax;
    invoice.withholding = p.withholding;
    invoice.total = p.total;
    invoice.payment_method = p.payment_method.clone();
    invoice.lines = p.lines.clone();
    invoice.replaces = p.related.iter().filter(|(k, _)| k == "04").map(|(_, u)| u.clone()).collect();
    invoice.updated_at = DateTime::now();
}

fn is_ours(rfcs: &[String], rfc: &str) -> bool {
    let rfc = rfc.trim().to_uppercase();
    rfcs.iter().any(|r| r.trim().to_uppercase() == rfc)
}

fn label(serie: &str, folio: &str) -> String {
    if serie.is_empty() { folio.to_string() } else { format!("{serie} {folio}") }
}

async fn import_invoice(
    state: &AppState,
    company_id: &ObjectId,
    rfcs: &[String],
    p: &ParsedInvoice,
    file: &UploadedFile,
    report: &mut ImportReport,
) -> Result<()> {
    if !is_ours(rfcs, &p.issuer_rfc) {
        report.ignored += 1;
        return Ok(());
    }
    let mut invoice = match get_invoice_by_uuid(state, company_id, &p.uuid).await? {
        Some(mut existing) => {
            refresh_from_cfdi(&mut existing, p);
            report.invoices_updated += 1;
            existing
        }
        None => {
            report.invoices_new += 1;
            new_invoice(*company_id, p)
        }
    };
    attach_file(&mut invoice, "factura_xml", &file.0, &file.1, Some(&p.uuid)).await?;
    // Replaced by an invoice already registered?
    if let Some(newer) = state
        .invoices
        .find_one(doc! { "company_id": company_id, "replaces": &p.uuid })
        .await?
        && invoice.status == InvoiceStatus::Active
    {
        invoice.status = InvoiceStatus::Replaced;
        invoice.replaced_by = Some(newer.uuid);
    }
    state
        .invoices
        .replace_one(doc! { "_id": invoice.id, "company_id": company_id }, &invoice)
        .upsert(true)
        .await?;
    // It replaces others already registered.
    for old_uuid in &invoice.replaces {
        if let Some(mut old) = get_invoice_by_uuid(state, company_id, old_uuid).await?
            && old.status == InvoiceStatus::Active
        {
            old.status = InvoiceStatus::Replaced;
            old.replaced_by = Some(invoice.uuid.clone());
            old.updated_at = DateTime::now();
            replace_invoice(state, &old).await?;
        }
    }
    Ok(())
}

async fn import_rep(
    state: &AppState,
    company_id: &ObjectId,
    rfcs: &[String],
    rep: &ParsedRep,
    file: &UploadedFile,
    report: &mut ImportReport,
) -> Result<()> {
    if !is_ours(rfcs, &rep.issuer_rfc) {
        report.ignored += 1;
        return Ok(());
    }
    for pay in &rep.payments {
        for d in &pay.docs {
            let Some(mut invoice) = get_invoice_by_uuid(state, company_id, &d.doc_uuid).await? else {
                report.warnings.push(format!(
                    "REP {}: la factura {} no está registrada (cárgala primero)",
                    label(&rep.serie, &rep.folio),
                    d.folio
                ));
                continue;
            };
            let same_currency = d.doc_currency == pay.currency || d.doc_currency.is_empty();
            let entry = InvoicePayment {
                id: ObjectId::new(),
                paid_on: to_dt(pay.paid_on_ms),
                amount: if same_currency { d.paid } else { (d.paid * d.equivalence * 100.0).round() / 100.0 },
                currency: pay.currency.clone(),
                exchange_rate: if same_currency { 1.0 } else { d.equivalence },
                applied: d.paid,
                source: "rep".into(),
                cfdi_uuid: Some(rep.uuid.clone()),
                installment: Some(d.installment),
                balance_after: Some(d.balance_after),
                note: None,
            };
            // Same REP and instalment again: refresh it instead of duplicating.
            if let Some(slot) = invoice
                .payments
                .iter_mut()
                .find(|x| x.cfdi_uuid.as_deref() == Some(rep.uuid.as_str()) && x.installment == Some(d.installment))
            {
                let id = slot.id;
                *slot = InvoicePayment { id, ..entry };
                report.payments_updated += 1;
            } else {
                // A payment typed by hand for the same amount is now backed by this REP.
                if let Some(i) = invoice
                    .payments
                    .iter()
                    .position(|x| x.source == "manual" && (x.applied - d.paid).abs() < 0.01)
                {
                    invoice.payments.remove(i);
                }
                invoice.payments.push(entry);
                report.payments_new += 1;
            }
            attach_file(&mut invoice, "rep_xml", &file.0, &file.1, Some(&rep.uuid)).await?;
            invoice.updated_at = DateTime::now();
            replace_invoice(state, &invoice).await?;
        }
    }
    Ok(())
}

async fn import_credit_note(
    state: &AppState,
    company_id: &ObjectId,
    rfcs: &[String],
    nc: &ParsedCreditNote,
    file: &UploadedFile,
    report: &mut ImportReport,
) -> Result<()> {
    if !is_ours(rfcs, &nc.issuer_rfc) {
        report.ignored += 1;
        return Ok(());
    }
    let targets: Vec<&String> = nc.related.iter().filter(|(k, _)| k == "01").map(|(_, u)| u).collect();
    if targets.is_empty() {
        report.warnings.push(format!(
            "Nota de crédito {}: no dice a qué factura aplica; regístrala a mano en la factura",
            label(&nc.serie, &nc.folio)
        ));
        return Ok(());
    }
    for uuid in targets {
        let Some(mut invoice) = get_invoice_by_uuid(state, company_id, uuid).await? else {
            report.warnings.push(format!(
                "Nota de crédito {}: su factura no está registrada",
                label(&nc.serie, &nc.folio)
            ));
            continue;
        };
        if invoice.payments.iter().any(|p| p.cfdi_uuid.as_deref() == Some(nc.uuid.as_str())) {
            continue;
        }
        invoice.payments.push(InvoicePayment {
            id: ObjectId::new(),
            paid_on: to_dt(nc.issued_at_ms),
            amount: nc.total,
            currency: if nc.currency.is_empty() { invoice.currency.clone() } else { nc.currency.clone() },
            exchange_rate: 1.0,
            applied: nc.total,
            source: "nota_credito".into(),
            cfdi_uuid: Some(nc.uuid.clone()),
            installment: None,
            balance_after: None,
            note: Some(format!("Nota de crédito {}", label(&nc.serie, &nc.folio))),
        });
        attach_file(&mut invoice, "nc_xml", &file.0, &file.1, Some(&nc.uuid)).await?;
        invoice.updated_at = DateTime::now();
        replace_invoice(state, &invoice).await?;
        report.credit_notes += 1;
    }
    Ok(())
}

/// A PDF named after the CFDI it belongs to (`{uuid}.pdf`, as the SAT and the accountant
/// name them) is kept with that invoice, REP or credit note.
async fn import_pdf(state: &AppState, company_id: &ObjectId, file: &UploadedFile, report: &mut ImportReport) -> Result<()> {
    let stem = file.0.rsplit(['/', '\\']).next().unwrap_or(&file.0);
    let stem = stem.rsplit_once('.').map(|(s, _)| s).unwrap_or(stem).trim().to_lowercase();
    if !looks_like_pdf(&file.1) {
        report.warnings.push(format!("{}: no es un PDF", file.0));
        return Ok(());
    }
    let mut hits = 0;
    // The invoice itself.
    if let Some(mut inv) = get_invoice_by_uuid(state, company_id, &stem).await? {
        if attach_file(&mut inv, "factura_pdf", &file.0, &file.1, Some(&stem)).await? {
            inv.updated_at = DateTime::now();
            replace_invoice(state, &inv).await?;
        }
        hits += 1;
    }
    // A REP or credit note applied to one or more invoices.
    let mut cursor = state
        .invoices
        .find(doc! { "company_id": company_id, "payments.cfdi_uuid": &stem })
        .await?;
    while let Some(mut inv) = cursor.try_next().await? {
        let is_note = inv
            .payments
            .iter()
            .any(|p| p.cfdi_uuid.as_deref() == Some(stem.as_str()) && p.source == "nota_credito");
        let kind = if is_note { "nc_pdf" } else { "rep_pdf" };
        if attach_file(&mut inv, kind, &file.0, &file.1, Some(&stem)).await? {
            inv.updated_at = DateTime::now();
            replace_invoice(state, &inv).await?;
        }
        hits += 1;
    }
    if hits == 0 {
        report.warnings.push(format!("{}: no encontré a qué factura o REP pertenece", file.0));
    } else {
        report.pdfs += 1;
    }
    Ok(())
}

/// Loads XML and PDF files (ZIPs allowed): invoices first, then the payments and credit
/// notes that apply to them, so the order of the files does not matter. Safe to repeat.
pub async fn import_files(
    state: &AppState,
    company_id: &ObjectId,
    company_rfcs: &[String],
    files: Vec<UploadedFile>,
) -> Result<ImportReport> {
    let files = expand_uploads(files)?;
    let mut report = ImportReport::default();
    let mut invoices = Vec::new();
    let mut reps = Vec::new();
    let mut notes = Vec::new();
    let mut pdfs = Vec::new();
    for file in files {
        if file.0.to_lowercase().ends_with(".pdf") {
            pdfs.push(file);
            continue;
        }
        if file.1.len() > MAX_XML_BYTES {
            report.warnings.push(format!("{}: el XML es demasiado grande", file.0));
            continue;
        }
        let Ok(text) = std::str::from_utf8(&file.1) else {
            report.warnings.push(format!("{}: el XML no es UTF-8", file.0));
            continue;
        };
        match parse_cfdi(text) {
            Ok(ParsedCfdi::Invoice(p)) => invoices.push((p, file)),
            Ok(ParsedCfdi::Rep(p)) => reps.push((p, file)),
            Ok(ParsedCfdi::CreditNote(p)) => notes.push((p, file)),
            Ok(ParsedCfdi::Other(_)) => report.ignored += 1,
            Err(err) => report.warnings.push(format!("{}: {err}", file.0)),
        }
    }
    for (p, file) in &invoices {
        import_invoice(state, company_id, company_rfcs, p, file, &mut report).await?;
    }
    // REPs in order, so instalment 1 lands before instalment 2.
    reps.sort_by_key(|(r, _)| r.payments.first().map(|p| p.paid_on_ms).unwrap_or(0));
    for (p, file) in &reps {
        import_rep(state, company_id, company_rfcs, p, file, &mut report).await?;
    }
    for (p, file) in &notes {
        import_credit_note(state, company_id, company_rfcs, p, file, &mut report).await?;
    }
    for file in &pdfs {
        import_pdf(state, company_id, file, &mut report).await?;
    }
    Ok(report)
}

// ── Payments typed by hand and edits ─────────────────────────────────────

pub struct ManualPayment {
    pub paid_on_ms: i64,
    /// What came in, in `currency`.
    pub amount: f64,
    pub currency: String,
    /// Required when `currency` differs from the invoice's: the DOF rate of the day.
    pub exchange_rate: Option<f64>,
    pub note: Option<String>,
}

/// Money received whose REP is not issued yet. When the REP is loaded later for the same
/// amount it takes this entry's place.
pub async fn add_manual_payment(
    state: &AppState,
    company_id: &ObjectId,
    invoice_id: &ObjectId,
    p: ManualPayment,
) -> Result<Invoice> {
    if !(p.amount > 0.0) {
        bail!("el monto debe ser mayor a cero");
    }
    let Some(mut invoice) = get_invoice(state, company_id, invoice_id).await? else {
        bail!("factura no encontrada");
    };
    let currency = p.currency.trim().to_uppercase();
    let (applied, rate) = if currency == invoice.currency {
        (p.amount, 1.0)
    } else {
        let rate = p.exchange_rate.filter(|r| *r > 0.0).context("falta el tipo de cambio del día de pago")?;
        match (invoice.currency.as_str(), currency.as_str()) {
            ("USD", "MXN") => (p.amount / rate, rate),
            ("MXN", "USD") => (p.amount * rate, rate),
            _ => bail!("combinación de monedas no soportada"),
        }
    };
    invoice.payments.push(InvoicePayment {
        id: ObjectId::new(),
        paid_on: to_dt(p.paid_on_ms),
        amount: p.amount,
        currency,
        exchange_rate: rate,
        applied: (applied * 100.0).round() / 100.0,
        source: "manual".into(),
        cfdi_uuid: None,
        installment: None,
        balance_after: None,
        note: p.note.filter(|n| !n.trim().is_empty()),
    });
    invoice.updated_at = DateTime::now();
    replace_invoice(state, &invoice).await?;
    Ok(invoice)
}

/// Removes a payment typed by hand. Those backed by a CFDI (REP, credit note) come from the
/// XML and are not removed here.
pub async fn delete_manual_payment(
    state: &AppState,
    company_id: &ObjectId,
    invoice_id: &ObjectId,
    payment_id: &ObjectId,
) -> Result<Invoice> {
    let Some(mut invoice) = get_invoice(state, company_id, invoice_id).await? else {
        bail!("factura no encontrada");
    };
    let Some(i) = invoice.payments.iter().position(|p| p.id == *payment_id) else {
        bail!("pago no encontrado");
    };
    if invoice.payments[i].source != "manual" {
        bail!("ese pago viene de un CFDI; solo se quitan los capturados a mano");
    }
    invoice.payments.remove(i);
    invoice.updated_at = DateTime::now();
    replace_invoice(state, &invoice).await?;
    Ok(invoice)
}
