//! Machine queue (design §9c): the work orders waiting to run on each machine, in order.
//! No uniqueness: one order can be queued several times on a machine (Setup 1, 2, 3) and on
//! several machines at once (Daniel, 2026-11-03).

use anyhow::Result;
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use std::collections::HashMap;

use crate::models::MachineQueueEntry;

use super::AppState;

/// Every queue of the company, by machine, first to run first.
pub async fn list_machine_queues(
    state: &AppState,
    company_id: &ObjectId,
) -> Result<HashMap<ObjectId, Vec<MachineQueueEntry>>> {
    let mut cursor = state
        .machine_queue
        .find(doc! { "company_id": company_id })
        .sort(doc! { "resource_id": 1, "rank": 1, "added_at": 1 })
        .await?;
    let mut out: HashMap<ObjectId, Vec<MachineQueueEntry>> = HashMap::new();
    while let Some(e) = cursor.try_next().await? {
        out.entry(e.resource_id).or_default().push(e);
    }
    Ok(out)
}

/// Adds an order at the end of a machine's queue.
pub async fn add_machine_queue_entry(
    state: &AppState,
    company_id: ObjectId,
    resource_id: ObjectId,
    concept_id: ObjectId,
    label: Option<String>,
    added_by: ObjectId,
) -> Result<MachineQueueEntry> {
    let last = state
        .machine_queue
        .find_one(doc! { "company_id": company_id, "resource_id": resource_id })
        .sort(doc! { "rank": -1 })
        .await?;
    let mut entry = MachineQueueEntry {
        id: None,
        company_id,
        resource_id,
        concept_id,
        label,
        rank: last.map(|e| e.rank + 1).unwrap_or(1),
        added_by,
        added_at: DateTime::now(),
    };
    let res = state.machine_queue.insert_one(&entry).await?;
    entry.id = res.inserted_id.as_object_id();
    Ok(entry)
}

pub async fn get_machine_queue_entry(
    state: &AppState,
    company_id: &ObjectId,
    id: &ObjectId,
) -> Result<Option<MachineQueueEntry>> {
    Ok(state
        .machine_queue
        .find_one(doc! { "_id": id, "company_id": company_id })
        .await?)
}

pub async fn remove_machine_queue_entry(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<bool> {
    let res = state
        .machine_queue
        .delete_one(doc! { "_id": id, "company_id": company_id })
        .await?;
    Ok(res.deleted_count > 0)
}

/// Takes every entry of a part off one machine's queue (its cut is done).
pub async fn remove_part_from_machine_queue(
    state: &AppState,
    company_id: &ObjectId,
    resource_id: &ObjectId,
    concept_id: &ObjectId,
) -> Result<u64> {
    let res = state
        .machine_queue
        .delete_many(doc! { "company_id": company_id, "resource_id": resource_id, "concept_id": concept_id })
        .await?;
    Ok(res.deleted_count)
}

/// Moves an entry one place up or down in its machine's queue. Ranks are renumbered 1..n
/// so ties from older data never block a move. Returns false at either end.
pub async fn move_machine_queue_entry(
    state: &AppState,
    company_id: &ObjectId,
    entry: &MachineQueueEntry,
    up: bool,
) -> Result<bool> {
    let mut queue = list_machine_queues(state, company_id)
        .await?
        .remove(&entry.resource_id)
        .unwrap_or_default();
    let Some(at) = queue.iter().position(|e| e.id == entry.id) else {
        return Ok(false);
    };
    let to = if up { at.checked_sub(1) } else { Some(at + 1).filter(|&i| i < queue.len()) };
    let Some(to) = to else { return Ok(false) };
    queue.swap(at, to);
    for (i, e) in queue.iter().enumerate() {
        state
            .machine_queue
            .update_one(doc! { "_id": e.id, "company_id": company_id }, doc! { "$set": { "rank": i as i64 + 1 } })
            .await?;
    }
    Ok(true)
}
