//! Maquila: pieces of a part sent to a supplier, whole or for some of its steps (Daniel,
//! 2026-11-13). A step the suppliers cover for every piece leaves the production board
//! while they have it, and is marked done once they hand all of it back.

use anyhow::Result;
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, Document, doc, oid::ObjectId};
use std::collections::HashMap;

use crate::models::{OutsourceJob, OutsourceStatus, PartStep, ProcessOperation, ProjectConcept, StepState};

use super::AppState;

pub async fn list_outsourcing_jobs(
    state: &AppState,
    company_id: &ObjectId,
    filter: Document,
) -> Result<Vec<OutsourceJob>> {
    let mut query = doc! { "company_id": company_id };
    query.extend(filter);
    Ok(state
        .outsourcing_jobs
        .find(query)
        .sort(doc! { "created_at": 1 })
        .await?
        .try_collect()
        .await?)
}

pub async fn get_outsourcing_job(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<Option<OutsourceJob>> {
    Ok(state
        .outsourcing_jobs
        .find_one(doc! { "_id": id, "company_id": company_id })
        .await?)
}

pub async fn insert_outsourcing_job(state: &AppState, job: &OutsourceJob) -> Result<ObjectId> {
    let res = state.outsourcing_jobs.insert_one(job).await?;
    res.inserted_id
        .as_object_id()
        .ok_or_else(|| anyhow::anyhow!("outsourcing job insert missing _id"))
}

pub async fn replace_outsourcing_job(state: &AppState, job: &OutsourceJob) -> Result<()> {
    let Some(id) = job.id else { anyhow::bail!("job without id") };
    state
        .outsourcing_jobs
        .replace_one(doc! { "_id": id, "company_id": job.company_id }, job)
        .await?;
    Ok(())
}

pub async fn delete_outsourcing_job(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<bool> {
    let res = state
        .outsourcing_jobs
        .delete_one(doc! { "_id": id, "company_id": company_id })
        .await?;
    Ok(res.deleted_count > 0)
}

/// Jobs of the company that are not cancelled, by part.
pub async fn outsourcing_by_part(state: &AppState, company_id: &ObjectId) -> Result<HashMap<ObjectId, Vec<OutsourceJob>>> {
    let jobs = list_outsourcing_jobs(state, company_id, doc! { "status": { "$ne": "cancelled" } }).await?;
    let mut by_part: HashMap<ObjectId, Vec<OutsourceJob>> = HashMap::new();
    for job in jobs {
        by_part.entry(job.concept_id).or_default().push(job);
    }
    Ok(by_part)
}

/// Pieces of the part the suppliers take on for `op` (cancelled jobs left out).
fn covered(jobs: &[OutsourceJob], op: &ObjectId) -> f64 {
    jobs.iter()
        .filter(|j| j.status != OutsourceStatus::Cancelled && j.covers(op))
        .map(|j| j.quantity)
        .sum()
}

/// The step `op` of the part is in the suppliers' hands: they take on every piece of it
/// and still have some. Then it leaves the production board.
pub fn is_outsourced(jobs: &[OutsourceJob], concept: &ProjectConcept, op: &ObjectId) -> bool {
    jobs.iter().any(|j| j.status.is_open() && j.covers(op)) && covered(jobs, op) >= concept.quantity
}

/// After a job changes: steps the suppliers did for every piece are marked done, and the
/// pieces a whole-part job brought back count as produced. Never undoes anything.
pub async fn sync_outsourced_steps(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
    operations: &[ProcessOperation],
    username: &str,
) -> Result<()> {
    let Some(mut concept) = state
        .project_concepts
        .find_one(doc! { "_id": concept_id, "company_id": company_id })
        .await?
    else {
        return Ok(());
    };
    let jobs = list_outsourcing_jobs(state, company_id, doc! { "concept_id": concept_id, "status": { "$ne": "cancelled" } })
        .await?;
    let received = |op: &ObjectId| -> f64 {
        jobs.iter()
            .filter(|j| j.covers(op))
            .map(|j| j.received_quantity)
            .sum()
    };
    let now = DateTime::now();
    let mut changed = false;
    for op in operations.iter().filter(|o| o.is_active) {
        let Some(id) = op.id else { continue };
        let ours = jobs.iter().any(|j| j.covers(&id));
        if !ours || received(&id) < concept.quantity {
            continue;
        }
        match concept.process_steps.iter_mut().find(|s| s.operation_id == id) {
            Some(step) if matches!(step.state, StepState::Done | StepState::NotApplicable) => {}
            Some(step) => {
                step.state = StepState::Done;
                step.updated_by = Some(username.to_string());
                step.updated_at = Some(now);
                step.note = None;
                changed = true;
            }
            None => {
                concept.process_steps.push(PartStep {
                    operation_id: id,
                    name: op.name.clone(),
                    state: StepState::Done,
                    updated_by: Some(username.to_string()),
                    updated_at: Some(now),
                    assignee_user_id: None,
                    assigned_at: None,
                    note: None,
                    pieces: None,
                    programmed: false,
                    programmed_by: None,
                });
                changed = true;
            }
        }
    }
    // Whole pieces back from a supplier are produced, ready for quality.
    let whole: f64 = jobs
        .iter()
        .filter(|j| j.operation_ids.is_empty())
        .map(|j| j.received_quantity)
        .sum();
    let cap = concept.quantity + concept.rejected_quantity;
    let produced = whole.min(cap);
    if produced > concept.completed_quantity {
        concept.completed_quantity = produced;
        changed = true;
    }
    if changed {
        let steps = mongodb::bson::to_bson(&concept.process_steps)?;
        state
            .project_concepts
            .update_one(
                doc! { "_id": concept_id, "company_id": company_id },
                doc! { "$set": {
                    "process_steps": steps,
                    "completed_quantity": concept.completed_quantity,
                    "updated_at": now,
                } },
            )
            .await?;
    }
    Ok(())
}
