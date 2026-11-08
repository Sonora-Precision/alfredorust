//! Shop-floor progress per part number: the company's catalog of process operations (the
//! checklist columns) and, per `ProjectConcept`, finished pieces and the state of each step.
//! Steps are stored only once someone marks them; unmarked catalog operations are pending.

use anyhow::{Context, Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{self, DateTime, doc, oid::ObjectId};
use std::time::SystemTime;

use crate::models::{PartStep, ProcessOperation, ProjectConcept, StepState, WorkQueue};

use super::{AppState, get_project_concept_by_id_for_company};

pub async fn list_process_operations(
    state: &AppState,
    company_id: &ObjectId,
    include_inactive: bool,
) -> Result<Vec<ProcessOperation>> {
    let filter = if include_inactive {
        doc! { "company_id": company_id }
    } else {
        doc! { "company_id": company_id, "is_active": true }
    };
    let mut cursor = state
        .process_operations
        .find(filter)
        .sort(doc! { "position": 1, "created_at": 1 })
        .await?;
    let mut items = Vec::new();
    while let Some(op) = cursor.try_next().await? {
        items.push(op);
    }
    Ok(items)
}

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        bail!("operation name must be between 1 and 60 characters");
    }
    Ok(name.to_string())
}

pub async fn create_process_operation(
    state: &AppState,
    company_id: &ObjectId,
    name: &str,
    position: i32,
    queue: Option<WorkQueue>,
) -> Result<ObjectId> {
    let name = clean_name(name)?;
    let res = state
        .process_operations
        .insert_one(ProcessOperation {
            id: None,
            company_id: company_id.clone(),
            name,
            position,
            is_active: true,
            queue,
            created_at: Some(DateTime::from_system_time(SystemTime::now())),
            updated_at: None,
        })
        .await?;
    res.inserted_id
        .as_object_id()
        .context("process operation insert missing _id")
}

/// Renaming does not touch steps already recorded on parts (they keep their name snapshot).
pub async fn update_process_operation(
    state: &AppState,
    id: &ObjectId,
    company_id: &ObjectId,
    name: &str,
    position: i32,
    is_active: bool,
    queue: Option<WorkQueue>,
) -> Result<bool> {
    let name = clean_name(name)?;
    let res = state
        .process_operations
        .update_one(
            doc! { "_id": id, "company_id": company_id },
            doc! { "$set": {
                "name": name,
                "position": position,
                "is_active": is_active,
                "queue": queue.map(|q| q.as_str()),
                "updated_at": DateTime::from_system_time(SystemTime::now()),
            } },
        )
        .await?;
    Ok(res.matched_count > 0)
}

/// Recorded steps keep their snapshot, so deleting only removes the column from the checklist.
pub async fn delete_process_operation(
    state: &AppState,
    id: &ObjectId,
    company_id: &ObjectId,
) -> Result<bool> {
    let res = state
        .process_operations
        .delete_one(doc! { "_id": id, "company_id": company_id })
        .await?;
    Ok(res.deleted_count > 0)
}

/// What a progress update may change; `None` leaves the field as it is.
#[derive(Debug, Default)]
pub struct PartProgressUpdate {
    pub completed_quantity: Option<f64>,
    pub step: Option<(ObjectId, StepState)>,
    /// Why a blocked step is held up; cleared for any other state.
    pub note: Option<String>,
    /// Pieces through one step (cut 12/30, Setup 1 6/30).
    pub pieces: Option<(ObjectId, f64)>,
    /// A setup whose program is ready (or not).
    pub programmed: Option<(ObjectId, bool)>,
}

/// Records finished pieces and/or one step state and returns the updated part, or `None` when
/// the part is not in the company. The operation must belong to the company catalog or already
/// be on the part. Each change is a single-field update, so quick clicks on several steps of
/// the same part cannot overwrite each other.
pub async fn update_part_progress(
    state: &AppState,
    id: &ObjectId,
    company_id: &ObjectId,
    update: PartProgressUpdate,
    username: &str,
) -> Result<Option<ProjectConcept>> {
    let Some(concept) = get_project_concept_by_id_for_company(state, id, company_id).await?
    else {
        return Ok(None);
    };
    let now = DateTime::from_system_time(SystemTime::now());
    let part = doc! { "_id": id, "company_id": company_id };

    if let Some(completed) = update.completed_quantity {
        // Rejected pieces are made again, so production may go past the pieces ordered by
        // them; it cannot drop below what quality already released or rejected.
        let floor = concept.released_quantity + concept.rejected_quantity;
        let ceiling = concept.quantity + concept.rejected_quantity;
        if !completed.is_finite() || completed < floor || completed > ceiling {
            bail!("las piezas producidas deben estar entre {floor} y {ceiling}");
        }
        // A piece only counts as finished once it went through every step (Daniel,
        // 2026-11-02): adding pieces needs every active step done or N/A, counting the
        // step marked in this same request. Lowering (corrections) is always allowed.
        if completed > concept.completed_quantity {
            let operations = list_process_operations(state, company_id, false).await?;
            let pending: Vec<&str> = operations
                .iter()
                .filter(|op| {
                    let Some(op_id) = op.id else { return false };
                    let st = match update.step {
                        Some((changed, st)) if changed == op_id => Some(st),
                        _ => concept
                            .process_steps
                            .iter()
                            .find(|s| s.operation_id == op_id)
                            .map(|s| s.state),
                    };
                    !matches!(st, Some(StepState::Done) | Some(StepState::NotApplicable))
                })
                .map(|op| op.name.as_str())
                .collect();
            if !pending.is_empty() {
                bail!(
                    "para registrar piezas terminadas todos los pasos deben estar ✔ o N/A; faltan: {}",
                    pending.join(", ")
                );
            }
        }
        state
            .project_concepts
            .update_one(
                part.clone(),
                doc! { "$set": { "completed_quantity": completed, "updated_at": now } },
            )
            .await?;
    }

    if let Some((operation_id, step_state)) = update.step {
        let note = if step_state == StepState::Blocked { update.note.clone() } else { None };
        let set_existing = |filter: bson::Document| {
            state.project_concepts.update_one(
                filter,
                doc! { "$set": {
                    "process_steps.$.state": step_state.as_str(),
                    "process_steps.$.updated_by": username,
                    "process_steps.$.updated_at": now,
                    "process_steps.$.note": note.clone(),
                    "updated_at": now,
                } },
            )
        };
        let mut on_part = part.clone();
        on_part.insert("process_steps.operation_id", operation_id);
        if set_existing(on_part.clone()).await?.matched_count == 0 {
            let op = state
                .process_operations
                .find_one(doc! { "_id": operation_id, "company_id": company_id })
                .await?
                .context("process operation not found for company")?;
            let step = bson::to_bson(&PartStep {
                operation_id,
                name: op.name,
                state: step_state,
                updated_by: Some(username.to_string()),
                updated_at: Some(now),
                assignee_user_id: None,
                assigned_at: None,
                note: note.clone(),
                pieces: None,
                programmed: false,
                programmed_by: None,
            })?;
            let mut not_on_part = part.clone();
            not_on_part.insert("process_steps.operation_id", doc! { "$ne": operation_id });
            let pushed = state
                .project_concepts
                .update_one(
                    not_on_part,
                    doc! { "$push": { "process_steps": step }, "$set": { "updated_at": now } },
                )
                .await?;
            // Someone added the step in between: mark the one that is there now.
            if pushed.matched_count == 0 {
                set_existing(on_part).await?;
            }
        }
    }

    if let Some((operation_id, pieces)) = update.pieces {
        let ceiling = concept.quantity + concept.rejected_quantity;
        if !pieces.is_finite() || pieces < 0.0 || pieces > ceiling {
            bail!("las piezas deben estar entre 0 y {ceiling}");
        }
        ensure_step(state, &concept, operation_id, now).await?;
        // All pieces through it: the step is done. Fewer: still going (unless held up).
        let current = concept.process_steps.iter().find(|s| s.operation_id == operation_id).map(|s| s.state);
        let new_state = if pieces >= concept.quantity {
            StepState::Done
        } else if current == Some(StepState::Blocked) {
            StepState::Blocked
        } else {
            StepState::Pending
        };
        let mut on_part = part.clone();
        on_part.insert("process_steps.operation_id", operation_id);
        let mut set = doc! {
            "process_steps.$.pieces": pieces,
            "process_steps.$.state": new_state.as_str(),
            "process_steps.$.updated_by": username,
            "process_steps.$.updated_at": now,
            "updated_at": now,
        };
        if new_state != StepState::Blocked {
            set.insert("process_steps.$.note", bson::Bson::Null);
        }
        state.project_concepts.update_one(on_part, doc! { "$set": set }).await?;
    }

    if let Some((operation_id, programmed)) = update.programmed {
        ensure_step(state, &concept, operation_id, now).await?;
        let mut on_part = part.clone();
        on_part.insert("process_steps.operation_id", operation_id);
        state
            .project_concepts
            .update_one(
                on_part,
                doc! { "$set": {
                    "process_steps.$.programmed": programmed,
                    "process_steps.$.programmed_by": if programmed { Some(username) } else { None },
                    "updated_at": now,
                } },
            )
            .await?;
    }

    get_project_concept_by_id_for_company(state, id, company_id).await
}

/// Adds a catalog step to the part as pending when nobody marked it yet.
async fn ensure_step(state: &AppState, concept: &ProjectConcept, operation_id: ObjectId, now: DateTime) -> Result<()> {
    if concept.process_steps.iter().any(|s| s.operation_id == operation_id) {
        return Ok(());
    }
    let op = state
        .process_operations
        .find_one(doc! { "_id": operation_id, "company_id": concept.company_id })
        .await?
        .context("process operation not found for company")?;
    let step = bson::to_bson(&PartStep {
        operation_id,
        name: op.name,
        state: StepState::Pending,
        updated_by: None,
        updated_at: None,
        assignee_user_id: None,
        assigned_at: None,
        note: None,
        pieces: None,
        programmed: false,
        programmed_by: None,
    })?;
    // `$ne` keeps a step someone added in between from being doubled.
    state
        .project_concepts
        .update_one(
            doc! { "_id": concept.id, "company_id": concept.company_id, "process_steps.operation_id": { "$ne": operation_id } },
            doc! { "$push": { "process_steps": step }, "$set": { "updated_at": now } },
        )
        .await?;
    Ok(())
}

/// Whether one setup of the part may go to a machine: its own program is ready, or the
/// "Programa" step is done (every setup programmed, as before setups were counted).
pub fn setup_programmed(concept: &ProjectConcept, setup: Option<&str>) -> bool {
    let all_done = concept
        .process_steps
        .iter()
        .any(|s| s.name.trim().eq_ignore_ascii_case("programa") && s.state == StepState::Done);
    if all_done {
        return true;
    }
    let applies = |s: &&PartStep| s.is_setup() && s.state != StepState::NotApplicable;
    let wanted = setup.map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty());
    // The setup the queue entry names ("Setup 2"); one nobody marked is not programmed.
    if let Some(name) = wanted.as_deref().filter(|n| n.starts_with("setup")) {
        return concept.process_steps.iter().any(|s| s.name.trim().to_lowercase() == name && s.programmed);
    }
    // Any other label (or none): the first setup that applies.
    let mut setups: Vec<&PartStep> = concept.process_steps.iter().filter(applies).collect();
    setups.sort_by_key(|s| s.name.trim().to_lowercase());
    setups.first().is_some_and(|s| s.programmed)
}
