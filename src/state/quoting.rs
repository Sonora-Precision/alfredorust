//! Quoting a part the way Daniel does by hand (openspec add-part-quoting): the weight of the
//! blank × price per kg of its material = material cost; × a multiplier (3.5 unless set) =
//! suggested unit price. The quoted price stays his to set. Admin only: it is money.

use anyhow::{Context, Result};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};

use crate::models::{MaterialPrice, MaterialPricePoint, MaterialReceipt, PartMaterial, PartQuote, ProjectConcept, ReceiptLine};

use super::AppState;

pub const DEFAULT_MULTIPLIER: f64 = 3.5;
const CM3_PER_IN3: f64 = 16.387064;

/// Density in g/cm³ by keyword of the material name; None when unknown.
pub fn density_g_cm3(material: &str) -> Option<f64> {
    let m = material.to_lowercase();
    let has = |k: &str| m.contains(k);
    Some(if has("7075") {
        2.81
    } else if has("alum") {
        2.70
    } else if has("inox") || has("304") || has("316") {
        8.00
    } else if has("4140") || has("1018") || has("1045") || has("4340") || has("acero") || has("d2") {
        7.85
    } else if has("delrin") || has("acetal") {
        1.41
    } else if has("g10") || has("g-10") {
        1.85
    } else if has("nylamid") || has("nylon") {
        1.15
    } else if has("latón") || has("laton") || has("brass") {
        8.50
    } else if has("cobre") || has("copper") {
        8.96
    } else {
        return None;
    })
}

/// Weight of the blank in kg from its size (a round bar keeps its diameter in thickness).
pub fn blank_kg(material: &PartMaterial) -> Option<f64> {
    let density = density_g_cm3(material.material.as_deref()?)?;
    let length = material.length?;
    let round = material.shape.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("redondo"));
    let in3 = if round {
        let d = material.thickness?;
        std::f64::consts::PI * (d / 2.0).powi(2) * length
    } else {
        material.thickness? * material.width? * length
    };
    Some(in3 * CM3_PER_IN3 * density / 1000.0)
}

/// The price of the material, or of its base ("Delrin negro" → "Delrin").
pub fn price_for<'a>(prices: &'a [MaterialPrice], material: &str) -> Option<&'a MaterialPrice> {
    // "Acero 1045", "1045" and "redondo 1045" are the same material: read the alloy the way
    // invoices are read, then compare.
    let norm = |s: &str| {
        super::material_of(s).unwrap_or_else(|| s.to_string()).trim().to_lowercase().replace("acetal", "delrin")
    };
    let wanted = norm(material);
    prices
        .iter()
        .find(|p| norm(&p.material) == wanted)
        .or_else(|| {
            let base = wanted.split_whitespace().next()?;
            prices.iter().find(|p| norm(&p.material) == base)
        })
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuoteLine {
    pub weight_kg: Option<f64>,
    /// "solidworks" (entered) or "tocho" (computed).
    pub weight_source: Option<&'static str>,
    pub price_per_kg: Option<f64>,
    pub material_cost: Option<f64>,
    pub multiplier: f64,
    pub suggested_unit_price: Option<f64>,
    /// What is missing for a suggestion, in the shop's words.
    pub missing: Vec<&'static str>,
}

pub fn quote_line(concept: &ProjectConcept, prices: &[MaterialPrice]) -> QuoteLine {
    suggest_line(concept.material.as_ref(), &concept.quote.clone().unwrap_or_default(), prices)
}

/// The same suggestion for a line of a quote that has no part yet.
pub fn suggest_line(material: Option<&PartMaterial>, quote: &PartQuote, prices: &[MaterialPrice]) -> QuoteLine {
    let mut missing = Vec::new();
    let (weight_kg, weight_source) = match (quote.weight_kg, material.and_then(blank_kg)) {
        (Some(w), _) => (Some(w), Some("solidworks")),
        (None, Some(w)) => (Some(w), Some("tocho")),
        (None, None) => {
            missing.push(if material.and_then(|m| m.material.as_ref()).is_none() {
                "material"
            } else {
                "medidas del tocho o peso"
            });
            (None, None)
        }
    };
    let price_per_kg = material
        .and_then(|m| m.material.as_deref())
        .and_then(|name| price_for(prices, name))
        .map(|p| p.price_per_kg);
    if price_per_kg.is_none() && material.and_then(|m| m.material.as_ref()).is_some() {
        missing.push("precio por kg del material");
    }
    let material_cost = weight_kg.zip(price_per_kg).map(|(w, p)| w * p);
    let multiplier = quote.multiplier.unwrap_or(DEFAULT_MULTIPLIER);
    QuoteLine {
        weight_kg,
        weight_source,
        price_per_kg,
        material_cost,
        multiplier,
        suggested_unit_price: material_cost.map(|c| (c * multiplier - 1e-9).ceil()),
        missing,
    }
}

pub async fn list_material_prices(state: &AppState, company_id: &ObjectId) -> Result<Vec<MaterialPrice>> {
    Ok(state
        .material_prices
        .find(doc! { "company_id": company_id })
        .sort(doc! { "material": 1 })
        .await?
        .try_collect()
        .await?)
}

/// Sets (or with None removes) the price per kg of a material.
pub async fn set_material_price(
    state: &AppState,
    company_id: ObjectId,
    material: &str,
    price_per_kg: Option<f64>,
    note: Option<String>,
    updated_by: ObjectId,
) -> Result<()> {
    // "Acero 1045" written by hand and "1045" learned from an invoice are one row.
    let existing = list_material_prices(state, &company_id).await?;
    let same = existing.iter().find(|p| same_name(&p.material, material));
    let filter = match same.and_then(|p| p.id) {
        Some(id) => doc! { "_id": id },
        None => doc! { "company_id": company_id, "material": material },
    };
    match price_per_kg {
        Some(price) => {
            let now = DateTime::now();
            let row = MaterialPrice {
                id: None,
                company_id,
                material: same.map(|p| p.material.clone()).unwrap_or_else(|| material.to_string()),
                price_per_kg: price,
                source: "manual".into(),
                note,
                updated_by,
                updated_at: now,
                as_of: Some(now),
            };
            state.material_prices.replace_one(filter, &row).upsert(true).await?;
        }
        None => {
            state.material_prices.delete_one(filter).await?;
        }
    }
    Ok(())
}

/// Same material by name, alloy read like an invoice ("Acero 1045" = "1045"), exact otherwise.
pub fn same_name(a: &str, b: &str) -> bool {
    let key = |s: &str| super::material_of(s).unwrap_or_else(|| s.to_string()).trim().to_lowercase().replace("acetal", "delrin");
    key(a) == key(b)
}

/// Kilos and $/kg of one invoice line from its amount before tax. Billed by kg (KGM) the
/// quantity is the kilos; billed by piece the kilos come from the bar: density × volume ×
/// bars. None when the line has no material or size to weigh it.
pub fn line_price_per_kg(line: &ReceiptLine, amount: f64) -> Option<(f64, f64, &'static str)> {
    if !amount.is_finite() || amount <= 0.0 {
        return None;
    }
    line.material.as_ref()?;
    let unit = line.unit.trim().to_lowercase();
    let (kg, source) = if unit == "kgm" || unit == "kg" || unit.starts_with("kilo") {
        (line.quantity, "factura")
    } else {
        let bar = PartMaterial {
            material: line.material.clone(),
            shape: line.shape.clone(),
            thickness: line.thickness,
            width: line.width,
            length: line.length,
            ..Default::default()
        };
        // Billed by piece: the quantity is the number of bars ("( 2 pz )" when it says so).
        let bars = if line.quantity > 0.0 { line.quantity } else { line.pieces };
        (blank_kg(&bar)? * bars, "calculado")
    };
    (kg.is_finite() && kg > 0.0).then(|| (kg, ((amount / kg) * 100.0).round() / 100.0, source))
}

/// The price points of one receipt, replacing what it had: one per line with an amount
/// that can be weighed. Then each material takes the receipt's price (Σ amount ÷ Σ kg of its
/// lines) unless it already has a price dated after this invoice.
pub async fn record_receipt_prices(
    state: &AppState,
    receipt: &MaterialReceipt,
    amounts: &[(i32, f64)],
    by: ObjectId,
) -> Result<Vec<MaterialPricePoint>> {
    let receipt_id = receipt.id.context("receipt without id")?;
    let now = DateTime::now();
    let points: Vec<MaterialPricePoint> = amounts
        .iter()
        .filter_map(|(n, amount)| {
            let line = receipt.lines.iter().find(|l| l.line == *n)?;
            let (kg, ppk, kg_source) = line_price_per_kg(line, *amount)?;
            Some(MaterialPricePoint {
                id: None,
                company_id: receipt.company_id,
                material: line.material.clone()?,
                receipt_id,
                line: *n,
                supplier: receipt.supplier.clone(),
                folio: receipt.folio.clone(),
                amount: *amount,
                kg,
                price_per_kg: ppk,
                kg_source: kg_source.to_string(),
                at: receipt.received_at,
                created_at: now,
            })
        })
        .collect();
    state
        .material_price_points
        .delete_many(doc! { "company_id": receipt.company_id, "receipt_id": receipt_id })
        .await?;
    if !points.is_empty() {
        state.material_price_points.insert_many(&points).await?;
    }

    let mut by_material: Vec<(String, f64, f64)> = Vec::new();
    for p in &points {
        match by_material.iter_mut().find(|(m, _, _)| same_name(m, &p.material)) {
            Some(row) => {
                row.1 += p.amount;
                row.2 += p.kg;
            }
            None => by_material.push((p.material.clone(), p.amount, p.kg)),
        }
    }
    let existing = list_material_prices(state, &receipt.company_id).await?;
    let day = super::folio_day(receipt.received_at);
    let note = format!(
        "{} {} ({}/{}/{})",
        receipt.supplier,
        receipt.folio.clone().unwrap_or_default(),
        &day[4..6],
        &day[2..4],
        &day[0..2],
    )
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ");
    for (material, amount, kg) in by_material {
        let price = ((amount / kg) * 100.0).round() / 100.0;
        let current = existing.iter().find(|p| same_name(&p.material, &material));
        let current_date = current.map(|p| p.as_of.unwrap_or(p.updated_at));
        if current_date.is_some_and(|d| d > receipt.received_at) {
            continue;
        }
        let filter = match current.and_then(|p| p.id) {
            Some(id) => doc! { "_id": id },
            None => doc! { "company_id": receipt.company_id, "material": &material },
        };
        let row = MaterialPrice {
            id: None,
            company_id: receipt.company_id,
            material: current.map(|p| p.material.clone()).unwrap_or(material),
            price_per_kg: price,
            source: "factura".into(),
            note: Some(note.clone()),
            updated_by: by,
            updated_at: now,
            as_of: Some(receipt.received_at),
        };
        state.material_prices.replace_one(filter, &row).upsert(true).await?;
    }
    Ok(points)
}

/// Price points of a material, newest invoice first (its price history).
pub async fn material_price_history(state: &AppState, company_id: &ObjectId) -> Result<Vec<MaterialPricePoint>> {
    Ok(state
        .material_price_points
        .find(doc! { "company_id": company_id })
        .sort(doc! { "at": -1, "line": 1 })
        .await?
        .try_collect()
        .await?)
}

/// Price points of one receipt, by line.
pub async fn receipt_price_points(state: &AppState, company_id: &ObjectId, receipt_id: &ObjectId) -> Result<Vec<MaterialPricePoint>> {
    Ok(state
        .material_price_points
        .find(doc! { "company_id": company_id, "receipt_id": receipt_id })
        .sort(doc! { "line": 1 })
        .await?
        .try_collect()
        .await?)
}

pub async fn set_part_quote(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
    quote: &PartQuote,
) -> Result<bool> {
    let res = state
        .project_concepts
        .update_one(
            doc! { "_id": concept_id, "company_id": company_id },
            doc! { "$set": { "quote": mongodb::bson::to_bson(quote)?, "updated_at": DateTime::now() } },
        )
        .await?;
    Ok(res.matched_count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price(material: &str, p: f64) -> MaterialPrice {
        MaterialPrice {
            id: None,
            company_id: ObjectId::new(),
            material: material.into(),
            price_per_kg: p,
            source: "manual".into(),
            note: None,
            updated_by: ObjectId::new(),
            updated_at: DateTime::now(),
            as_of: None,
        }
    }

    fn part(material: &str, shape: &str, t: f64, w: Option<f64>, l: f64, quote: Option<PartQuote>) -> ProjectConcept {
        ProjectConcept {
            id: Some(ObjectId::new()),
            company_id: ObjectId::new(),
            project_id: ObjectId::new(),
            status_id: ObjectId::new(),
            name: "P".into(),
            quantity: 30.0,
            unit: None,
            description: None,
            estimated_hours: None,
            estimated_cost: None,
            unit_price: None,
            notes: None,
            position: 1,
            work_order_number: None,
            sequence_rank: None,
            priority_override: None,
            completed_quantity: 0.0,
            released_quantity: 0.0,
            rejected_quantity: 0.0,
            process_steps: Vec::new(),
            material: Some(PartMaterial {
                material: Some(material.into()),
                shape: Some(shape.into()),
                thickness: Some(t),
                width: w,
                length: Some(l),
                ..Default::default()
            }),
            quote,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn quotes_from_the_blank_like_daniel() {
        let prices = [price("Aluminio 6061", 250.0)];
        // CG-15296-A: 1 x 1.5 x 1.5 in of 6061 → 0.0996 kg → $24.89 → × 3.5 → $88.
        let q = quote_line(&part("Aluminio 6061", "solera", 1.0, Some(1.5), 1.5, None), &prices);
        assert!((q.weight_kg.unwrap() - 0.09955).abs() < 1e-4, "{q:?}");
        assert_eq!(q.weight_source, Some("tocho"));
        assert!((q.material_cost.unwrap() - 24.888).abs() < 0.01);
        assert_eq!(q.suggested_unit_price, Some(88.0));

        // SolidWorks weight and multiplier 4.
        let sw = Some(PartQuote { weight_kg: Some(0.2), multiplier: Some(4.0) });
        let q = quote_line(&part("Aluminio 6061", "solera", 1.0, Some(1.5), 1.5, sw), &prices);
        assert_eq!((q.material_cost, q.suggested_unit_price, q.weight_source), (Some(50.0), Some(200.0), Some("solidworks")));

        // Round bar: π (0.25)² × 2.25 in³ of steel.
        let q = quote_line(&part("4140", "redondo", 0.5, None, 2.25, None), &[price("4140", 100.0)]);
        assert!((q.weight_kg.unwrap() - 0.0569).abs() < 1e-3, "{q:?}");

        // No price per kg: no suggestion, and it says why.
        let q = quote_line(&part("4140", "solera", 0.5, Some(1.125), 6.375, None), &prices);
        assert_eq!(q.suggested_unit_price, None);
        assert_eq!(q.missing, ["precio por kg del material"]);

        // A color falls back to the base price ("Delrin negro" → "Delrin").
        let q = quote_line(&part("Delrin negro", "solera", 0.375, Some(1.75), 4.125, None), &[price("Delrin", 180.0)]);
        assert_eq!(q.price_per_kg, Some(180.0));
    }

    #[test]
    fn steel_by_name_or_alloy() {
        // An invoice learns "1045"; Daniel writes "Acero 1045" in the quote.
        let q = quote_line(&part("Acero 1045", "redondo", 2.5, None, 16.0, None), &[price("1045", 40.0)]);
        assert_eq!(q.price_per_kg, Some(40.0));
        // Ø2.5 × 16 in of steel ≈ 10.1 kg → 404 of material × 3.5 → 1,414.
        assert!((q.weight_kg.unwrap() - 10.106).abs() < 0.01, "{:?}", q.weight_kg);
        assert_eq!(q.suggested_unit_price, Some(1415.0));
    }

    fn receipt_line(desc: &str, quantity: f64, unit: &str) -> ReceiptLine {
        super::super::read_line(1, desc, quantity, unit)
    }

    #[test]
    fn price_per_kg_from_invoice_lines() {
        // Billed by kg (HG F86241): the quantity is the kilos.
        let l = receipt_line("Aluminio solera 6061 de 1 1/4\" x 1 1/2\" x 125\" ( 1 pz )", 11.17, "KGM");
        let (kg, ppk, src) = line_price_per_kg(&l, 1340.4).unwrap();
        assert_eq!((kg, ppk, src), (11.17, 120.0, "factura"));
        // Billed by piece: kilos from the bar, density × volume × bars.
        let l = receipt_line("Redondo 1045 de 2 1/2\" x 16\"", 2.0, "H87");
        let (kg, ppk, src) = line_price_per_kg(&l, 808.26).unwrap();
        assert!((kg - 20.21).abs() < 0.02, "{kg}");
        assert_eq!((ppk, src), (40.0, "calculado"));
        // Nothing to weigh, or no amount.
        assert!(line_price_per_kg(&receipt_line("Flete", 1.0, "E48"), 300.0).is_none());
        assert!(line_price_per_kg(&receipt_line("Redondo 1045 de 2 1/2\" x 16\"", 1.0, "H87"), 0.0).is_none());
    }
}
