//! Part material and material receipts (openspec add-part-material): reads supplier invoice
//! lines as bars, matches them against the blank each part needs and keeps which bar went
//! to which part. No prices anywhere.

use anyhow::Result;
use futures::stream::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId};
use std::collections::{HashMap, HashSet};

use crate::models::{MaterialReceipt, PartMaterial, ProjectConcept, ReceiptLine, StepState};

use super::AppState;

/// Saw cut width used to count pieces per bar (1/16").
pub const KERF_IN: f64 = 0.0625;
const EPS: f64 = 0.005;

/// Derived status, first that applies: customer supplied, cut ("Material habilitado" ✔),
/// received (a receipt bar assigned), ordered, pending. None when nothing is recorded.
pub fn material_status(concept: &ProjectConcept, received: bool) -> Option<&'static str> {
    let m = concept.material.as_ref();
    let cut = concept.process_steps.iter().any(|s| {
        s.name.trim().eq_ignore_ascii_case("material habilitado") && s.state == StepState::Done
    });
    if m.is_none() && !received && !cut {
        return None;
    }
    Some(if m.is_some_and(|m| m.customer_supplied) {
        "surtido_por_cliente"
    } else if cut {
        "cortado"
    } else if received {
        "recibido"
    } else if m.is_some_and(|m| m.ordered) {
        "pedido"
    } else {
        "pendiente"
    })
}

pub async fn set_part_material(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
    material: Option<&PartMaterial>,
) -> Result<bool> {
    let value = match material {
        Some(m) => mongodb::bson::to_bson(m)?,
        None => mongodb::bson::Bson::Null,
    };
    let res = state
        .project_concepts
        .update_one(
            doc! { "_id": concept_id, "company_id": company_id },
            doc! { "$set": { "material": value, "updated_at": mongodb::bson::DateTime::now() } },
        )
        .await?;
    Ok(res.matched_count > 0)
}

// --- reading invoice lines -------------------------------------------------------------

/// "1 1/4" → 1.25, "1/8" → 0.125, ".625" → 0.625, "65" → 65.
fn parse_number(s: &str) -> Option<f64> {
    let s = s.trim();
    let mut total = 0.0;
    let mut any = false;
    for part in s.split_whitespace() {
        if let Some((n, d)) = part.split_once('/') {
            let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
            if d == 0.0 {
                return None;
            }
            total += n / d;
        } else {
            total += part.parse::<f64>().ok()?;
        }
        any = true;
    }
    any.then_some(total)
}

/// Dimensions written "A x B x C" (fractions, decimals, optional inch marks). Each value is
/// the number group at the end of its chunk ("… de 1 1/4"), or at its start ("65 pz").
fn parse_dimensions(text: &str) -> Vec<f64> {
    let cleaned: String = text
        .chars()
        .map(|c| match c {
            '"' | '”' | '“' | '\'' => ' ',
            'X' | '×' | '*' => 'x',
            c => c,
        })
        .collect();
    let numeric = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '/');
    cleaned
        .split('x')
        .filter_map(|chunk| {
            let tokens: Vec<&str> = chunk.split_whitespace().collect();
            let n = tokens.len();
            let last = *tokens.last()?;
            if !numeric(last) {
                let first = *tokens.first()?;
                return if numeric(first) { parse_number(first) } else { None };
            }
            // "1 1/4": a whole number right before a fraction.
            if last.contains('/') && n >= 2 && tokens[n - 2].chars().all(|c| c.is_ascii_digit()) {
                return parse_number(&format!("{} {last}", tokens[n - 2]));
            }
            parse_number(last)
        })
        .collect()
}

/// Alloy or plastic named in a description, normalized to how the shop writes it.
pub fn material_of(text: &str) -> Option<String> {
    let t = text.to_lowercase();
    let alu = t.contains("alum");
    for alloy in ["6061", "7075", "6063", "5052", "2024"] {
        if t.contains(alloy) {
            return Some(format!("Aluminio {alloy}"));
        }
    }
    for steel in ["4140", "1018", "1045", "4340", "d2", "a2", "o1"] {
        if t.split(|c: char| !c.is_alphanumeric()).any(|w| w == steel) {
            return Some(steel.to_uppercase());
        }
    }
    if t.contains("delrin") || t.contains("acetal") {
        let color = if t.contains("negro") { " negro" } else if t.contains("blanco") { " blanco" } else { "" };
        return Some(format!("Delrin{color}"));
    }
    if t.contains("g10") || t.contains("g-10") {
        return Some("G10".into());
    }
    if t.contains("nylamid") {
        return Some("Nylamid".into());
    }
    if alu {
        return Some("Aluminio".into());
    }
    None
}

fn shape_of(text: &str) -> Option<String> {
    let t = text.to_lowercase();
    ["solera", "placa", "redondo", "barra", "tubo", "angulo", "ángulo"]
        .into_iter()
        .find(|s| t.contains(s))
        .map(|s| s.replace('á', "a"))
}

/// Reads an invoice line ("Aluminio solera 6061 de 1/8\" X 2\" X 144\" ( 1 pz )") as a bar.
pub fn read_line(line: i32, description: &str, quantity: f64, unit: &str) -> ReceiptLine {
    let (body, pieces) = match description.rfind('(') {
        Some(i) => {
            let inside = &description[i + 1..];
            let digits: String = inside.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
            let pz = inside.to_lowercase().contains("pz");
            (&description[..i], if pz { digits.parse().unwrap_or(1.0) } else { 1.0 })
        }
        None => (description, 1.0),
    };
    let dims = parse_dimensions(body);
    let (thickness, width, length) = match dims.as_slice() {
        [t, w, l, ..] => (Some(*t), Some(*w), Some(*l)),
        [d, l] => (Some(*d), None, Some(*l)),
        _ => (None, None, None),
    };
    ReceiptLine {
        line,
        description: description.trim().to_string(),
        quantity,
        unit: unit.trim().to_string(),
        material: material_of(description),
        shape: shape_of(description),
        thickness,
        width,
        length,
        pieces,
        concept_ids: Vec::new(),
    }
}

// --- matching ------------------------------------------------------------------------

/// Same material: Some(true) when equal; Some(false) when one side only names the base
/// ("Aluminio" bar for an "Aluminio 6061" part, "Delrin" for "Delrin negro"); None otherwise.
fn same_material(part: &str, bar: &str) -> Option<bool> {
    let norm = |s: &str| s.to_lowercase().replace("acetal", "delrin").split_whitespace().collect::<Vec<_>>().join(" ");
    let (p, b) = (norm(part), norm(bar));
    if p == b {
        return Some(true);
    }
    let base_only = |short: &str, long: &str| !short.contains(' ') && long.starts_with(&format!("{short} "));
    (base_only(&b, &p) || base_only(&p, &b)).then_some(false)
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarFit {
    /// "exact" or "larger".
    pub fit: &'static str,
    pub note: Option<String>,
    /// Blanks this bar yields at the saw cut width.
    pub pieces: i64,
}

fn fmt(v: f64) -> String {
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Whether a received bar can make a part's blank, and how many.
pub fn fit_bar(material: &PartMaterial, bar: &ReceiptLine) -> Option<BarFit> {
    let alloy_known = same_material(material.material.as_deref()?, bar.material.as_deref()?)?;
    let length = material.length?;
    let bar_len = bar.length?;
    let mut need: Vec<f64> = [material.thickness, material.width].into_iter().flatten().collect();
    let mut have: Vec<f64> = [bar.thickness, bar.width].into_iter().flatten().collect();
    if need.is_empty() || need.len() != have.len() {
        return None;
    }
    need.sort_by(|a, b| a.total_cmp(b));
    have.sort_by(|a, b| a.total_cmp(b));
    if need.iter().zip(&have).any(|(n, h)| *n > h + EPS) {
        return None;
    }
    let mut notes = Vec::new();
    let names = if need.len() == 2 { ["espesor", "ancho"] } else { ["diámetro", ""] };
    for (i, (n, h)) in need.iter().zip(&have).enumerate() {
        if (h - n).abs() > EPS {
            notes.push(format!("{} {}\" en vez de {}\"", names[i], fmt(*h), fmt(*n)));
        }
    }
    if !alloy_known {
        notes.push("la factura no dice la aleación o el color".into());
    }
    let pieces = ((bar_len / (length + KERF_IN)).floor() as i64) * bar.pieces.max(1.0) as i64;
    Some(BarFit {
        fit: if notes.iter().any(|n| !n.starts_with("la factura")) { "larger" } else { "exact" },
        note: (!notes.is_empty()).then(|| notes.join("; ")),
        pieces,
    })
}

// --- storage -------------------------------------------------------------------------

pub async fn insert_material_receipt(state: &AppState, mut receipt: MaterialReceipt) -> Result<MaterialReceipt> {
    let res = state.material_receipts.insert_one(&receipt).await?;
    receipt.id = res.inserted_id.as_object_id();
    Ok(receipt)
}

pub async fn list_material_receipts(state: &AppState, company_id: &ObjectId) -> Result<Vec<MaterialReceipt>> {
    Ok(state
        .material_receipts
        .find(doc! { "company_id": company_id })
        .sort(doc! { "received_at": -1 })
        .await?
        .try_collect()
        .await?)
}

pub async fn get_material_receipt(
    state: &AppState,
    company_id: &ObjectId,
    id: &ObjectId,
) -> Result<Option<MaterialReceipt>> {
    Ok(state
        .material_receipts
        .find_one(doc! { "_id": id, "company_id": company_id })
        .await?)
}

pub async fn assign_receipt_line(
    state: &AppState,
    company_id: &ObjectId,
    id: &ObjectId,
    line: i32,
    concept_ids: &[ObjectId],
) -> Result<bool> {
    let res = state
        .material_receipts
        .update_one(
            doc! { "_id": id, "company_id": company_id, "lines.line": line },
            doc! { "$set": { "lines.$.concept_ids": concept_ids } },
        )
        .await?;
    Ok(res.matched_count > 0)
}

/// Parts of the given set with at least one received bar assigned.
pub async fn parts_with_received_material(
    state: &AppState,
    company_id: &ObjectId,
    concept_ids: &[ObjectId],
) -> Result<HashSet<ObjectId>> {
    let receipts: Vec<MaterialReceipt> = state
        .material_receipts
        .find(doc! { "company_id": company_id, "lines.concept_ids": { "$in": concept_ids } })
        .await?
        .try_collect()
        .await?;
    let wanted: HashSet<&ObjectId> = concept_ids.iter().collect();
    Ok(receipts
        .iter()
        .flat_map(|r| &r.lines)
        .flat_map(|l| &l.concept_ids)
        .filter(|c| wanted.contains(c))
        .copied()
        .collect())
}

/// Pieces each part gets from the bars assigned to it in this receipt.
pub fn receipt_pieces_by_part(receipt: &MaterialReceipt, parts: &HashMap<ObjectId, ProjectConcept>) -> HashMap<ObjectId, i64> {
    let mut out: HashMap<ObjectId, i64> = HashMap::new();
    for line in &receipt.lines {
        for c in &line.concept_ids {
            let fit = parts
                .get(c)
                .and_then(|p| p.material.as_ref())
                .and_then(|m| fit_bar(m, line))
                .map(|f| f.pieces)
                .unwrap_or(0);
            *out.entry(*c).or_default() += fit;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(desc: &str) -> ReceiptLine {
        read_line(1, desc, 1.0, "KGM")
    }

    #[test]
    fn reads_hg_aceros_lines() {
        let l = bar("Aluminio solera 6061 de 1 1/4\" x 1 1/2\" x 125\" ( 1 pz )");
        assert_eq!(l.material.as_deref(), Some("Aluminio 6061"));
        assert_eq!(l.shape.as_deref(), Some("solera"));
        assert_eq!((l.thickness, l.width, l.length), (Some(1.25), Some(1.5), Some(125.0)));
        assert_eq!(l.pieces, 1.0);

        let l = bar("ALUMINIO SOLERA DE 1/8\" X 2\" X 144\" ( 1 pz )");
        assert_eq!(l.material.as_deref(), Some("Aluminio"));
        assert_eq!((l.thickness, l.width, l.length), (Some(0.125), Some(2.0), Some(144.0)));

        let l = bar("Aluminio solera 6061 de 1\" x 1 1/2\" x 65 ( 1 pz )");
        assert_eq!((l.thickness, l.width, l.length), (Some(1.0), Some(1.5), Some(65.0)));

        let l = bar("Aluminio solera 6061 de 1/2\" x 3/4\" x 80\" ( 1 pz >)");
        assert_eq!((l.thickness, l.width, l.length), (Some(0.5), Some(0.75), Some(80.0)));

        let l = bar("Acero 4140 redondo de 1/2\" x 144\"");
        assert_eq!(l.material.as_deref(), Some("4140"));
        assert_eq!((l.thickness, l.width, l.length), (Some(0.5), None, Some(144.0)));
    }

    fn part(t: f64, w: f64, len: f64) -> PartMaterial {
        PartMaterial {
            material: Some("Aluminio 6061".into()),
            thickness: Some(t),
            width: Some(w),
            length: Some(len),
            ..Default::default()
        }
    }

    #[test]
    fn fits_like_the_f86241_comparison() {
        let exact = fit_bar(&part(1.0, 1.5, 1.5), &bar("Aluminio solera 6061 de 1\" x 1 1/2\" x 65 ( 1 pz )")).unwrap();
        assert_eq!((exact.fit, exact.pieces), ("exact", 41));

        let wider = fit_bar(&part(0.125, 1.75, 5.0), &bar("Aluminio solera 6061 de 1/8\" X 2\" X 144\"")).unwrap();
        assert_eq!((wider.fit, wider.pieces), ("larger", 28));
        assert!(wider.note.unwrap().contains("ancho 2\" en vez de 1.75\""));

        // Any orientation: a 1.25 x 1.5 bar makes a 1.5 x 1.25 blank.
        assert!(fit_bar(&part(1.5, 1.25, 1.75), &bar("Aluminio 6061 de 1 1/4\" x 1 1/2\" x 125\"")).is_some());

        // Thinner bar never fits; other materials never match.
        assert!(fit_bar(&part(0.25, 1.5, 5.0), &bar("Aluminio 6061 de 1/8\" x 2\" x 144\"")).is_none());
        let mut steel = part(0.5, 0.625, 1.625);
        steel.material = Some("4140".into());
        assert!(fit_bar(&steel, &bar("Aluminio 6061 de 1/2\" x 3/4\" x 80\"")).is_none());

        // A bar without alloy still fits an aluminum part, with a note.
        let unknown = fit_bar(&part(0.125, 1.75, 5.0), &bar("ALUMINIO SOLERA DE 1/8\" X 2\" X 36\"")).unwrap();
        assert!(unknown.note.unwrap().contains("aleación"));
        assert_eq!(unknown.pieces, 7);
    }
}
