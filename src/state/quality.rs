//! Quality release (Daniel, 2026-11-03: "calidad libera las piezas"): programmers record
//! produced pieces; quality releases or rejects them. Only released pieces count as finished
//! (weekly pieces, credit and value); rejected ones are made again.

use anyhow::{Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{self, DateTime, doc, oid::ObjectId};
use mongodb::options::ReturnDocument;
use std::collections::HashMap;

use crate::models::{Project, ProjectConcept, ProjectStatus};

use super::AppState;

/// Produced pieces quality has not looked at yet.
pub fn awaiting_release(c: &ProjectConcept) -> f64 {
    (c.completed_quantity - c.released_quantity - c.rejected_quantity).max(0.0)
}

/// Adds released and/or rejected pieces (negative = correction) in one atomic update, so two
/// inspectors cannot release the same pieces twice. Released + rejected never exceed the
/// pieces produced, and released never exceeds the pieces ordered. `None` = part not found.
pub async fn record_quality(
    state: &AppState,
    id: &ObjectId,
    company_id: &ObjectId,
    released_delta: f64,
    rejected_delta: f64,
) -> Result<Option<ProjectConcept>> {
    if !released_delta.is_finite() || !rejected_delta.is_finite() {
        bail!("las piezas deben ser números");
    }
    if released_delta == 0.0 && rejected_delta == 0.0 {
        bail!("captura piezas liberadas o rechazadas");
    }
    let Some(concept) = super::get_project_concept_by_id_for_company(state, id, company_id).await?
    else {
        return Ok(None);
    };
    let released = concept.released_quantity + released_delta;
    let rejected = concept.rejected_quantity + rejected_delta;
    if released < 0.0 || rejected < 0.0 {
        bail!("no puedes dejar piezas liberadas o rechazadas en negativo");
    }
    if released > concept.quantity {
        bail!("solo se piden {} piezas; ya hay {} liberadas", concept.quantity, concept.released_quantity);
    }
    if released + rejected > concept.completed_quantity {
        bail!(
            "solo hay {} piezas producidas por liberar",
            awaiting_release(&concept)
        );
    }
    // Guard on the values just read: a concurrent change makes this match nothing.
    let updated = state
        .project_concepts
        .find_one_and_update(
            doc! {
                "_id": id,
                "company_id": company_id,
                "completed_quantity": same(concept.completed_quantity),
                "released_quantity": same(concept.released_quantity),
                "rejected_quantity": same(concept.rejected_quantity),
            },
            doc! { "$set": {
                "released_quantity": released,
                "rejected_quantity": rejected,
                "updated_at": DateTime::now(),
            } },
        )
        .return_document(ReturnDocument::After)
        .await?;
    match updated {
        Some(c) => Ok(Some(c)),
        None => bail!("la parte cambió mientras capturabas; vuelve a intentarlo"),
    }
}

/// Matches a stored count equal to `v`; parts saved before the field existed read as 0.
fn same(v: f64) -> bson::Bson {
    if v == 0.0 {
        doc! { "$in": [0.0, 0, bson::Bson::Null] }.into()
    } else {
        v.into()
    }
}

/// A part with pieces waiting for quality, with its project.
pub struct QualityItem {
    pub concept: ProjectConcept,
    pub project: Project,
}

/// Parts of open projects with produced pieces quality has not released or rejected, oldest
/// folio first.
pub async fn list_quality_queue(state: &AppState, company_id: &ObjectId) -> Result<Vec<QualityItem>> {
    let mut cursor = state
        .project_concepts
        .find(doc! {
            "company_id": company_id,
            "$expr": { "$gt": [
                { "$ifNull": ["$completed_quantity", 0.0] },
                { "$add": [
                    { "$ifNull": ["$released_quantity", 0.0] },
                    { "$ifNull": ["$rejected_quantity", 0.0] },
                ] },
            ] },
        })
        .await?;
    let mut concepts = Vec::new();
    while let Some(c) = cursor.try_next().await? {
        concepts.push(c);
    }
    let project_ids: Vec<ObjectId> = concepts.iter().map(|c| c.project_id).collect();
    let closed: Vec<bson::Bson> = [ProjectStatus::Entregado, ProjectStatus::Cancelado]
        .iter()
        .map(bson::to_bson)
        .collect::<std::result::Result<_, _>>()?;
    let mut cursor = state
        .projects
        .find(doc! { "company_id": company_id, "_id": { "$in": &project_ids }, "status": { "$nin": closed } })
        .await?;
    let mut projects: HashMap<ObjectId, Project> = HashMap::new();
    while let Some(p) = cursor.try_next().await? {
        if let Some(id) = p.id {
            projects.insert(id, p);
        }
    }
    let mut items: Vec<QualityItem> = concepts
        .into_iter()
        .filter_map(|concept| {
            let project = projects.get(&concept.project_id)?.clone();
            Some(QualityItem { concept, project })
        })
        .collect();
    items.sort_by_key(|i| i.concept.work_order_number);
    Ok(items)
}
