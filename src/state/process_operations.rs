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
    /// The programmer adds the next setup to this part ("+ Setup").
    pub add_setup: bool,
    /// Register pieces without the program/setups done (admin only; the route checks it).
    pub force: bool,
}

fn is_program_name(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("programa")
}

/// What still blocks adding finished pieces: the "Programa" step (when the catalog has it)
/// and every setup the part carries. A setup the programmer never added is not required;
/// every setup programmed also counts as the program being done.
pub fn pending_for_pieces(
    concept: &ProjectConcept,
    operations: &[ProcessOperation],
    changed: Option<(ObjectId, StepState)>,
) -> Vec<String> {
    // (name, state, programmed) of the part's steps, with the one marked in this request.
    let mut steps: Vec<(String, StepState, bool)> = concept
        .process_steps
        .iter()
        .map(|s| match changed {
            Some((op, st)) if op == s.operation_id => (s.name.clone(), st, s.programmed),
            _ => (s.name.clone(), s.state, s.programmed),
        })
        .collect();
    if let Some((op, st)) = changed {
        if !concept.process_steps.iter().any(|s| s.operation_id == op) {
            if let Some(o) = operations.iter().find(|o| o.id == Some(op)) {
                steps.push((o.name.clone(), st, false));
            }
        }
    }
    let finished = |st: StepState| matches!(st, StepState::Done | StepState::NotApplicable);
    let setups: Vec<&(String, StepState, bool)> = steps
        .iter()
        .filter(|(n, st, _)| n.trim().to_lowercase().starts_with("setup") && *st != StepState::NotApplicable)
        .collect();
    let mut pending: Vec<String> = Vec::new();
    if operations.iter().any(|o| is_program_name(&o.name)) {
        let program_step_ok = steps.iter().any(|(n, st, _)| is_program_name(n) && finished(*st));
        let all_setups_programmed = !setups.is_empty() && setups.iter().all(|(_, _, p)| *p);
        if !program_step_ok && !all_setups_programmed {
            pending.push("Programa".to_string());
        }
    }
    for (name, st, _) in setups {
        if *st != StepState::Done {
            pending.push(name.clone());
        }
    }
    pending
}

/// Adds the next setup to the part: the first "Setup N" of the catalog the part does not
/// carry yet, creating "Setup N+1" in the catalog when they are all taken.
async fn add_setup_to_part(state: &AppState, concept: &ProjectConcept, now: DateTime) -> Result<()> {
    let operations = list_process_operations(state, &concept.company_id, true).await?;
    let on_part = |op: &ProcessOperation| {
        op.id.is_some_and(|id| concept.process_steps.iter().any(|s| s.operation_id == id))
    };
    let setups: Vec<&ProcessOperation> = operations
        .iter()
        .filter(|o| o.is_active && o.name.trim().to_lowercase().starts_with("setup"))
        .collect();
    let next = match setups.iter().find(|o| !on_part(o)) {
        Some(op) => op.id.context("setup without id")?,
        None => {
            let number = setups
                .iter()
                .filter_map(|o| o.name.trim().chars().skip(5).collect::<String>().trim().parse::<u32>().ok())
                .max()
                .unwrap_or(0)
                + 1;
            if number > 12 {
                bail!("una pieza no puede tener más de 12 setups");
            }
            let position = operations.iter().map(|o| o.position).max().unwrap_or(0) + 1;
            create_process_operation(
                state,
                &concept.company_id,
                &format!("Setup {number}"),
                position,
                Some(WorkQueue::Setup),
            )
            .await?
        }
    };
    ensure_step(state, concept, next, now).await
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
        // Adding pieces needs the program and every setup the programmer created for this
        // part done or N/A (Daniel, 2026-11-19: only what someone is responsible for
        // registering blocks), counting the step marked in this same request. Lowering
        // (corrections) is always allowed, and an admin may force it (`force`).
        if completed > concept.completed_quantity && !update.force {
            let operations = list_process_operations(state, company_id, false).await?;
            let pending = pending_for_pieces(&concept, &operations, update.step);
            if !pending.is_empty() {
                bail!(
                    "para registrar piezas terminadas faltan el programa y los setups de la pieza en ✔ o N/A; faltan: {}",
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

    if update.add_setup {
        add_setup_to_part(state, &concept, now).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn op(name: &str) -> ProcessOperation {
        ProcessOperation {
            id: Some(ObjectId::new()),
            company_id: ObjectId::new(),
            name: name.into(),
            position: 0,
            is_active: true,
            queue: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn part(steps: &[(&ProcessOperation, StepState, bool)]) -> ProjectConcept {
        let steps: Vec<_> = steps
            .iter()
            .map(|(o, st, programmed)| {
                doc! { "operation_id": o.id.unwrap(), "name": &o.name, "state": st.as_str(), "programmed": *programmed }
            })
            .collect();
        bson::from_document(doc! {
            "company_id": ObjectId::new(), "project_id": ObjectId::new(), "status_id": ObjectId::new(),
            "name": "P", "process_steps": steps,
        })
        .expect("concept")
    }

    #[test]
    fn only_program_and_the_parts_own_setups_block() {
        let (material, cut, program, s1, s2, finish) =
            (op("Material"), op("Material habilitado"), op("Programa"), op("Setup 1"), op("Setup 2"), op("Rebabeado / Limpieza"));
        let catalog = [material.clone(), cut.clone(), program.clone(), s1.clone(), s2.clone(), finish];

        // Nothing marked: only the program is missing (Setup 1/2 were never added).
        assert_eq!(pending_for_pieces(&part(&[]), &catalog, None), ["Programa"]);

        // Program done, material pending: nothing blocks.
        let ok = part(&[(&program, StepState::Done, false), (&material, StepState::Pending, false)]);
        assert!(pending_for_pieces(&ok, &catalog, None).is_empty());

        // A setup the programmer added blocks until done or N/A.
        let with_setups = part(&[(&program, StepState::Done, false), (&s1, StepState::Pending, false), (&s2, StepState::NotApplicable, false)]);
        assert_eq!(pending_for_pieces(&with_setups, &catalog, None), ["Setup 1"]);
        let s1_id = s1.id.unwrap();
        assert!(pending_for_pieces(&with_setups, &catalog, Some((s1_id, StepState::Done))).is_empty());
        assert!(pending_for_pieces(&with_setups, &catalog, Some((s1_id, StepState::NotApplicable))).is_empty());

        // Every setup programmed counts as the program being done.
        let programmed = part(&[(&s1, StepState::Done, true), (&s2, StepState::Done, true)]);
        assert!(pending_for_pieces(&programmed, &catalog, None).is_empty());
        let half = part(&[(&s1, StepState::Done, true), (&s2, StepState::Done, false)]);
        assert_eq!(pending_for_pieces(&half, &catalog, None), ["Programa"]);

        // The step marked in the same request may not be on the part yet.
        let fresh = part(&[]);
        assert!(pending_for_pieces(&fresh, &catalog, Some((program.id.unwrap(), StepState::Done))).is_empty());

        // A company without a Programa step is not asked for it.
        let no_program = [material, s1];
        assert!(pending_for_pieces(&part(&[]), &no_program, None).is_empty());
    }
}
