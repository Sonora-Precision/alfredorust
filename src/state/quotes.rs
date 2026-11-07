//! Quotes (openspec add-quote-document): the shop's quote template as data. Folio
//! "AAMMDD-NN-RR", totals exactly like the Excel template, revisions as new records.

use anyhow::Result;
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};

use crate::models::{ClientQuoteDefaults, Quote, QuoteFile, QuoteSettings};

use super::AppState;

/// Hermosillo is UTC-7 all year.
const SHOP_UTC_OFFSET_MS: i64 = -7 * 3_600_000;

/// "261103" for 2026-11-03 in Hermosillo.
pub fn folio_day(at: DateTime) -> String {
    let local = chrono::DateTime::from_timestamp_millis(at.timestamp_millis() + SHOP_UTC_OFFSET_MS)
        .unwrap_or_default();
    local.format("%y%m%d").to_string()
}

pub fn folio(base: &str, revision: i32) -> String {
    format!("{base}-{revision:02}")
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuoteTotals {
    pub subtotal: f64,
    pub discount: f64,
    pub iva: f64,
    pub retention: f64,
    pub net: f64,
    /// 100 − advance.
    pub remaining_pct: f64,
}

fn cents(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Like the template: subtotal, minus discount, plus IVA, minus ISR retention.
pub fn quote_totals(q: &Quote) -> QuoteTotals {
    let subtotal = cents(q.lines.iter().map(|l| l.quantity * l.unit_price).sum());
    let base = subtotal - q.discount;
    let iva = if q.iva { cents(base * q.iva_rate) } else { 0.0 };
    let retention = if q.retention { cents(base * q.retention_rate) } else { 0.0 };
    QuoteTotals {
        subtotal,
        discount: q.discount,
        iva,
        retention,
        net: cents(base + iva - retention),
        remaining_pct: (100.0 - q.advance_pct).max(0.0),
    }
}

/// Next daily folio base: "261103-01", "261103-02"… for the company.
pub async fn next_folio_base(state: &AppState, company_id: &ObjectId, at: DateTime) -> Result<String> {
    let day = folio_day(at);
    let bases: Vec<String> = state
        .quotes
        .distinct("folio_base", doc! { "company_id": company_id, "folio_base": { "$regex": format!("^{day}-") } })
        .await?
        .into_iter()
        .filter_map(|b| b.as_str().map(str::to_string))
        .collect();
    let next = bases
        .iter()
        .filter_map(|b| b.rsplit('-').next()?.parse::<i32>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    Ok(format!("{day}-{next:02}"))
}

pub async fn insert_quote(state: &AppState, mut quote: Quote) -> Result<Quote> {
    let res = state.quotes.insert_one(&quote).await?;
    quote.id = res.inserted_id.as_object_id();
    Ok(quote)
}

pub async fn get_quote(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<Option<Quote>> {
    Ok(state.quotes.find_one(doc! { "_id": id, "company_id": company_id }).await?)
}

pub async fn list_project_quotes(state: &AppState, company_id: &ObjectId, project_id: &ObjectId) -> Result<Vec<Quote>> {
    Ok(state
        .quotes
        .find(doc! { "company_id": company_id, "project_id": project_id })
        .sort(doc! { "created_at": -1 })
        .await?
        .try_collect()
        .await?)
}

/// Every quote of the company, newest first (each revision is its own record).
pub async fn list_quotes(state: &AppState, company_id: &ObjectId) -> Result<Vec<Quote>> {
    Ok(state
        .quotes
        .find(doc! { "company_id": company_id })
        .sort(doc! { "created_at": -1 })
        .await?
        .try_collect()
        .await?)
}

/// The project a folio already became, if any revision of it did.
pub async fn folio_project(state: &AppState, company_id: &ObjectId, base: &str) -> Result<Option<ObjectId>> {
    Ok(state
        .quotes
        .find_one(doc! { "company_id": company_id, "folio_base": base, "project_id": { "$exists": true, "$ne": null } })
        .await?
        .and_then(|q| q.project_id))
}

/// Every revision of the folio points to the project it became.
pub async fn link_folio_to_project(state: &AppState, company_id: &ObjectId, base: &str, project_id: &ObjectId) -> Result<()> {
    state
        .quotes
        .update_many(doc! { "company_id": company_id, "folio_base": base }, doc! { "$set": { "project_id": project_id } })
        .await?;
    Ok(())
}

/// Highest revision of a folio base.
pub async fn last_revision(state: &AppState, company_id: &ObjectId, base: &str) -> Result<i32> {
    Ok(state
        .quotes
        .find_one(doc! { "company_id": company_id, "folio_base": base })
        .sort(doc! { "revision": -1 })
        .await?
        .map(|q| q.revision)
        .unwrap_or(0))
}

pub async fn mark_quote_sent(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<bool> {
    let res = state
        .quotes
        .update_one(doc! { "_id": id, "company_id": company_id }, doc! { "$set": { "sent_at": DateTime::now() } })
        .await?;
    Ok(res.matched_count > 0)
}

/// Replaces a draft as it is being filled; a generated quote is never changed in place.
pub async fn replace_draft_quote(state: &AppState, quote: &Quote) -> Result<bool> {
    let res = state
        .quotes
        .replace_one(doc! { "_id": quote.id, "company_id": quote.company_id, "draft": true }, quote)
        .await?;
    Ok(res.matched_count > 0)
}

/// Stores the PDF drawing of a quote line.
pub async fn save_quote_file(
    state: &AppState,
    company_id: &ObjectId,
    filename: &str,
    bytes: &[u8],
    uploaded_by: ObjectId,
) -> Result<QuoteFile> {
    if bytes.is_empty() {
        anyhow::bail!("el archivo está vacío");
    }
    if bytes.len() > super::MAX_PART_FILE_BYTES {
        anyhow::bail!("el plano excede el tamaño máximo (40 MB)");
    }
    if !super::looks_like_pdf(bytes) {
        anyhow::bail!("el plano debe ser un PDF");
    }
    let id = ObjectId::new();
    let storage_key = format!("quotes/{}/{}.pdf", company_id.to_hex(), id.to_hex());
    let path = super::part_file_store_root().join(&storage_key);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    tokio::fs::write(&path, bytes).await?;
    let name = filename.rsplit(['/', '\\']).next().unwrap_or(filename).trim();
    let file = QuoteFile {
        id: Some(id),
        company_id: *company_id,
        original_filename: if name.is_empty() { "plano.pdf".into() } else { name.chars().take(160).collect() },
        size_bytes: bytes.len() as i64,
        sha256: {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(bytes))
        },
        storage_key,
        uploaded_by,
        uploaded_at: DateTime::now(),
    };
    if let Err(err) = state.quote_files.insert_one(&file).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(err.into());
    }
    Ok(file)
}

pub async fn get_quote_file(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<Option<QuoteFile>> {
    Ok(state.quote_files.find_one(doc! { "_id": id, "company_id": company_id }).await?)
}

pub async fn read_quote_file(file: &QuoteFile) -> Result<Vec<u8>> {
    Ok(tokio::fs::read(super::part_file_store_root().join(&file.storage_key)).await?)
}

pub async fn get_quote_settings(state: &AppState, company_id: &ObjectId) -> Result<QuoteSettings> {
    Ok(state
        .quote_settings
        .find_one(doc! { "company_id": company_id })
        .await?
        .unwrap_or_else(|| QuoteSettings { company_id: *company_id, iva_rate: 0.16, retention_rate: 0.0125, ..Default::default() }))
}

pub async fn save_quote_settings(state: &AppState, mut settings: QuoteSettings) -> Result<()> {
    settings.id = None;
    state
        .quote_settings
        .replace_one(doc! { "company_id": settings.company_id }, &settings)
        .upsert(true)
        .await?;
    Ok(())
}

pub async fn get_client_quote_defaults(
    state: &AppState,
    company_id: &ObjectId,
    contact_id: &ObjectId,
) -> Result<Option<ClientQuoteDefaults>> {
    Ok(state
        .client_quote_defaults
        .find_one(doc! { "company_id": company_id, "contact_id": contact_id })
        .await?)
}

pub async fn list_client_quote_defaults(state: &AppState, company_id: &ObjectId) -> Result<Vec<ClientQuoteDefaults>> {
    Ok(state
        .client_quote_defaults
        .find(doc! { "company_id": company_id })
        .await?
        .try_collect()
        .await?)
}

pub async fn save_client_quote_defaults(state: &AppState, mut defaults: ClientQuoteDefaults) -> Result<()> {
    defaults.id = None;
    state
        .client_quote_defaults
        .replace_one(doc! { "company_id": defaults.company_id, "contact_id": defaults.contact_id }, &defaults)
        .upsert(true)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::QuoteItem;

    fn quote(lines: &[(f64, f64)]) -> Quote {
        Quote {
            id: None,
            company_id: ObjectId::new(),
            project_id: None,
            contact_id: None,
            client_name: "Brabatech".into(),
            attention: Some("Angel Cedillo".into()),
            attention_initials: Some("AC".into()),
            folio_base: "261103-01".into(),
            revision: 0,
            date: DateTime::now(),
            currency: "MXN".into(),
            language: "es".into(),
            iva: true,
            retention: true,
            iva_rate: 0.16,
            retention_rate: 0.0125,
            discount: 0.0,
            delivery_time: 20,
            delivery_unit: "dias".into(),
            validity_days: 5,
            advance_pct: 50.0,
            notes: Vec::new(),
            lines: lines
                .iter()
                .enumerate()
                .map(|(i, (q, p))| QuoteItem { item: i as i32 + 1, quantity: *q, description: "P".into(), unit_price: *p, concept_id: None, material: None, weight_kg: None, multiplier: None, drawing_id: None, drawing_name: None })
                .collect(),
            sent_at: None,
            created_by: ObjectId::new(),
            created_at: DateTime::now(),
            draft: false,
        }
    }

    #[test]
    fn totals_like_quote_261103_01_00() {
        // The 14 priced lines of 261103-01-00 (Brabatech): 69,600 → IVA 11,136, ret 870, neto 79,866.
        let q = quote(&[
            (3.0, 1250.0), (3.0, 3850.0), (6.0, 850.0), (3.0, 800.0), (3.0, 950.0), (3.0, 1800.0), (6.0, 700.0),
            (3.0, 2000.0), (3.0, 1100.0), (3.0, 1100.0), (3.0, 3850.0), (6.0, 850.0), (6.0, 600.0), (6.0, 250.0),
        ]);
        let t = quote_totals(&q);
        assert_eq!((t.subtotal, t.iva, t.retention, t.net, t.remaining_pct), (69_600.0, 11_136.0, 870.0, 79_866.0, 50.0));

        // Discount comes off before taxes; no retention for clients without it.
        let mut q = quote(&[(1.0, 1000.0)]);
        q.discount = 100.0;
        q.retention = false;
        let t = quote_totals(&q);
        assert_eq!((t.iva, t.retention, t.net), (144.0, 0.0, 1044.0));
    }

    #[test]
    fn folio_uses_the_hermosillo_day() {
        // 2026-11-04 05:00 UTC is still Nov 3 in Hermosillo.
        let at = DateTime::parse_rfc3339_str("2026-11-04T05:00:00Z").unwrap();
        assert_eq!(folio_day(at), "261103");
        assert_eq!(folio("261103-01", 0), "261103-01-00");
        assert_eq!(folio("261103-01", 1), "261103-01-01");
    }
}
