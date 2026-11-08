//! Production board: every part number (`ProjectConcept`) is a work order (OT) that sits in
//! the queue of its current process step, ordered by the production sequence. See
//! openspec/changes/add-production-board.

use anyhow::{Context, Result};
use futures::stream::TryStreamExt;
use mongodb::bson::{self, DateTime, doc, oid::ObjectId};
use mongodb::options::ReturnDocument;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::time::SystemTime;

use crate::models::{
    Contact, PartStep, ProcessOperation, Project, ProjectConcept, ProjectPriority, ProjectStatus,
    StepState, UserPermission, UserRole, WorkOrderEvent, WorkQueue,
};

use super::AppState;

const WORK_ORDER_COUNTER: &str = "work_order";

/// Next work-order folio of the company. Atomic, so concurrent creates never share a number.
pub async fn next_work_order_number(state: &AppState, company_id: &ObjectId) -> Result<i64> {
    let counter = state
        .counters
        .find_one_and_update(
            doc! { "company_id": company_id, "name": WORK_ORDER_COUNTER },
            doc! { "$inc": { "seq": 1_i64 } },
        )
        .upsert(true)
        .return_document(ReturnDocument::After)
        .await?
        .context("work order counter missing after upsert")?;
    counter
        .get_i64("seq")
        .or_else(|_| counter.get_i32("seq").map(i64::from))
        .context("work order counter has no seq")
}

/// Gives a folio to parts created before the board existed, oldest first. Safe to run on
/// every read: a part only ever gets one number.
pub async fn ensure_work_order_numbers(state: &AppState, company_id: &ObjectId) -> Result<()> {
    let mut cursor = state
        .project_concepts
        .find(doc! { "company_id": company_id, "work_order_number": { "$exists": false } })
        .sort(doc! { "created_at": 1, "_id": 1 })
        .await?;
    let mut missing = Vec::new();
    while let Some(concept) = cursor.try_next().await? {
        if let Some(id) = concept.id {
            missing.push(id);
        }
    }
    for id in missing {
        let number = next_work_order_number(state, company_id).await?;
        state
            .project_concepts
            .update_one(
                doc! { "_id": id, "company_id": company_id, "work_order_number": { "$exists": false } },
                doc! { "$set": { "work_order_number": number } },
            )
            .await?;
    }
    Ok(())
}

/// A part as the board sees it: its project, client and current step.
#[derive(Debug, Clone)]
pub struct WorkOrder {
    pub concept: ProjectConcept,
    pub project: Project,
    pub client: Option<String>,
    pub operation: ProcessOperation,
    pub queue: WorkQueue,
    pub assignee_user_id: Option<ObjectId>,
}

impl WorkOrder {
    pub fn concept_id(&self) -> ObjectId {
        self.concept.id.expect("board parts come from the database")
    }

    pub fn priority(&self) -> ProjectPriority {
        self.concept
            .priority_override
            .clone()
            .unwrap_or_else(|| self.project.priority.clone())
    }
}

/// The first active operation with a queue that is neither done nor N/A on this part.
pub fn current_step<'a>(
    concept: &ProjectConcept,
    operations: &'a [ProcessOperation],
) -> Option<(&'a ProcessOperation, Option<ObjectId>)> {
    operations
        .iter()
        .filter(|op| op.is_active && op.queue.is_some())
        .find_map(|op| {
            let id = op.id?;
            let step = concept.process_steps.iter().find(|s| s.operation_id == id);
            match step.map(|s| s.state) {
                Some(StepState::Done) | Some(StepState::NotApplicable) => None,
                _ => Some((op, step.and_then(|s| s.assignee_user_id))),
            }
        })
}

fn priority_order(priority: &ProjectPriority) -> u8 {
    match priority {
        ProjectPriority::Urgent => 0,
        ProjectPriority::High => 1,
        ProjectPriority::Medium => 2,
        ProjectPriority::Low => 3,
    }
}

/// Pinned orders first by rank; then priority, then project date (none last), then folio.
pub fn sequence_cmp(a: &WorkOrder, b: &WorkOrder) -> Ordering {
    match (a.concept.sequence_rank, b.concept.sequence_rank) {
        (Some(x), Some(y)) => return x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    priority_order(&a.priority())
        .cmp(&priority_order(&b.priority()))
        .then_with(|| match (a.project.scheduled_at, b.project.scheduled_at) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        })
        .then_with(|| a.concept.work_order_number.cmp(&b.concept.work_order_number))
}

/// Every open work order of the company, in production sequence. Open = project neither
/// delivered nor cancelled, part not in a terminal/cancelled status, pieces still pending
/// and at least one queued step left.
pub async fn list_work_orders(state: &AppState, company_id: &ObjectId) -> Result<Vec<WorkOrder>> {
    ensure_work_order_numbers(state, company_id).await?;

    let operations = super::list_process_operations(state, company_id, false).await?;
    if !operations.iter().any(|op| op.queue.is_some()) {
        return Ok(Vec::new());
    }

    let closed = [ProjectStatus::Entregado, ProjectStatus::Cancelado];
    let closed: Vec<bson::Bson> = closed
        .iter()
        .map(|s| bson::to_bson(s))
        .collect::<std::result::Result<_, _>>()?;
    let mut cursor = state
        .projects
        .find(doc! { "company_id": company_id, "status": { "$nin": closed } })
        .await?;
    let mut projects = HashMap::new();
    while let Some(project) = cursor.try_next().await? {
        if let Some(id) = project.id {
            projects.insert(id, project);
        }
    }
    if projects.is_empty() {
        return Ok(Vec::new());
    }

    let mut closed_statuses = HashSet::new();
    let mut cursor = state
        .concept_statuses
        .find(doc! { "company_id": company_id, "$or": [ { "is_terminal": true }, { "is_cancelled": true } ] })
        .await?;
    while let Some(status) = cursor.try_next().await? {
        if let Some(id) = status.id {
            closed_statuses.insert(id);
        }
    }

    let contact_ids: Vec<ObjectId> = projects.values().filter_map(|p| p.contact_id).collect();
    let mut clients = HashMap::new();
    if !contact_ids.is_empty() {
        let mut cursor = state
            .contacts
            .find(doc! { "company_id": company_id, "_id": { "$in": &contact_ids } })
            .await?;
        while let Some(Contact { id: Some(id), name, .. }) = cursor.try_next().await? {
            clients.insert(id, name);
        }
    }

    let project_ids: Vec<ObjectId> = projects.keys().cloned().collect();
    let mut cursor = state
        .project_concepts
        .find(doc! { "company_id": company_id, "project_id": { "$in": &project_ids } })
        .await?;
    let mut orders = Vec::new();
    while let Some(concept) = cursor.try_next().await? {
        if concept.id.is_none()
            || closed_statuses.contains(&concept.status_id)
            || concept.completed_quantity - concept.rejected_quantity >= concept.quantity
        {
            continue;
        }
        let Some((op, assignee)) = current_step(&concept, &operations) else {
            continue;
        };
        let Some(project) = projects.get(&concept.project_id) else {
            continue;
        };
        orders.push(WorkOrder {
            client: project.contact_id.and_then(|c| clients.get(&c).cloned()),
            project: project.clone(),
            operation: op.clone(),
            queue: op.queue.expect("filtered to queued operations"),
            assignee_user_id: assignee,
            concept,
        });
    }
    orders.sort_by(sequence_cmp);
    Ok(orders)
}

/// Who may hold work orders in this company: admins and staff allowed to take them.
#[derive(Debug, Clone)]
pub struct BoardMember {
    pub user_id: ObjectId,
    pub username: String,
    /// The display name, or the login handle before the @ when there is none.
    pub name: String,
    pub is_admin: bool,
}

pub async fn list_board_members(state: &AppState, company_id: &ObjectId) -> Result<Vec<BoardMember>> {
    let mut cursor = state
        .user_companies
        .find(doc! { "company_id": company_id })
        .await?;
    let mut eligible = HashMap::new();
    while let Some(m) = cursor.try_next().await? {
        let is_admin = m.role == UserRole::Admin;
        if is_admin || m.permissions.contains(&UserPermission::TakeWorkOrders) {
            eligible.insert(m.user_id, is_admin);
        }
    }
    let ids: Vec<ObjectId> = eligible.keys().cloned().collect();
    let mut members = Vec::new();
    if ids.is_empty() {
        return Ok(members);
    }
    let mut cursor = state.users.find(doc! { "_id": { "$in": &ids } }).await?;
    while let Some(user) = cursor.try_next().await? {
        let Some(id) = user.id else { continue };
        let name = user
            .display_name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| user.username.split('@').next().unwrap_or_default().to_string());
        members.push(BoardMember {
            user_id: id,
            username: user.username,
            name,
            is_admin: eligible.get(&id).copied().unwrap_or(false),
        });
    }
    members.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(members)
}

pub enum AssignOutcome {
    Done,
    /// The step already had a different assignee (take) or not the expected one (release).
    Conflict,
    NotFound,
}

/// Sets (or clears) the assignee of one step of a part. With `only_if` the write happens only
/// while the step's assignee is that value (`Some(None)` = unassigned), so two people taking
/// the same order at once cannot both win.
pub async fn set_step_assignee(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
    operation: &ProcessOperation,
    assignee: Option<ObjectId>,
    only_if: Option<Option<ObjectId>>,
) -> Result<AssignOutcome> {
    let operation_id = operation.id.context("operation missing _id")?;
    let now = DateTime::from_system_time(SystemTime::now());
    let mut elem = doc! { "operation_id": operation_id };
    if let Some(expected) = only_if {
        elem.insert("assignee_user_id", expected.map(bson::Bson::ObjectId).unwrap_or(bson::Bson::Null));
    }
    let update = doc! { "$set": {
        "process_steps.$.assignee_user_id": assignee.map(bson::Bson::ObjectId).unwrap_or(bson::Bson::Null),
        "process_steps.$.assigned_at": now,
        "updated_at": now,
    } };
    let on_part = doc! { "_id": concept_id, "company_id": company_id, "process_steps": { "$elemMatch": elem.clone() } };
    if state.project_concepts.update_one(on_part, update.clone()).await?.matched_count > 0 {
        return Ok(AssignOutcome::Done);
    }

    // The step may simply not be recorded yet (nobody marked it): add it as pending.
    let exists = doc! { "_id": concept_id, "company_id": company_id, "process_steps.operation_id": operation_id };
    if state.project_concepts.find_one(exists).await?.is_some() {
        return Ok(AssignOutcome::Conflict);
    }
    if matches!(only_if, Some(Some(_))) {
        // Releasing a step nobody holds.
        return Ok(AssignOutcome::Conflict);
    }
    let step = bson::to_bson(&PartStep {
        operation_id,
        name: operation.name.clone(),
        state: StepState::Pending,
        updated_by: None,
        updated_at: None,
        assignee_user_id: assignee,
        assigned_at: Some(now),
        note: None,
        pieces: None,
        programmed: false,
        programmed_by: None,
    })?;
    let pushed = state
        .project_concepts
        .update_one(
            doc! { "_id": concept_id, "company_id": company_id, "process_steps.operation_id": { "$ne": operation_id } },
            doc! { "$push": { "process_steps": step }, "$set": { "updated_at": now } },
        )
        .await?;
    if pushed.matched_count > 0 {
        return Ok(AssignOutcome::Done);
    }
    if state
        .project_concepts
        .find_one(doc! { "_id": concept_id, "company_id": company_id })
        .await?
        .is_none()
    {
        return Ok(AssignOutcome::NotFound);
    }
    // Someone recorded the step in between: retry against it once.
    let on_part = doc! { "_id": concept_id, "company_id": company_id, "process_steps": { "$elemMatch": elem } };
    if state.project_concepts.update_one(on_part, update).await?.matched_count > 0 {
        Ok(AssignOutcome::Done)
    } else {
        Ok(AssignOutcome::Conflict)
    }
}

pub enum SequenceMove {
    Before(ObjectId),
    After(ObjectId),
    Unpin,
}

/// Moves a work order within its queue. Everything from the top down to the moved order is
/// pinned in its current order so the move holds; pinned orders below keep their order.
pub async fn move_in_sequence(
    state: &AppState,
    company_id: &ObjectId,
    queue_orders: &[WorkOrder],
    concept_id: &ObjectId,
    movement: SequenceMove,
) -> Result<bool> {
    if !queue_orders.iter().any(|o| &o.concept_id() == concept_id) {
        return Ok(false);
    }
    if let SequenceMove::Unpin = movement {
        state
            .project_concepts
            .update_one(
                doc! { "_id": concept_id, "company_id": company_id },
                doc! { "$unset": { "sequence_rank": "" } },
            )
            .await?;
        return Ok(true);
    }
    let mut order: Vec<&WorkOrder> = queue_orders
        .iter()
        .filter(|o| &o.concept_id() != concept_id)
        .collect();
    let (target, after) = match movement {
        SequenceMove::Before(t) => (t, false),
        SequenceMove::After(t) => (t, true),
        SequenceMove::Unpin => unreachable!(),
    };
    let Some(pos) = order.iter().position(|o| o.concept_id() == target) else {
        return Ok(false);
    };
    let index = if after { pos + 1 } else { pos };
    let mover = queue_orders
        .iter()
        .find(|o| &o.concept_id() == concept_id)
        .expect("checked above");
    order.insert(index, mover);

    let mut rank = 1.0_f64;
    for (i, o) in order.iter().enumerate() {
        if i > index && o.concept.sequence_rank.is_none() {
            continue;
        }
        state
            .project_concepts
            .update_one(
                doc! { "_id": o.concept_id(), "company_id": company_id },
                doc! { "$set": { "sequence_rank": rank } },
            )
            .await?;
        rank += 1.0;
    }
    Ok(true)
}

pub async fn log_work_order_event(state: &AppState, event: WorkOrderEvent) -> Result<()> {
    state.work_order_events.insert_one(event).await?;
    Ok(())
}
