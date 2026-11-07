//! Time-clock checks pushed by the shop PC agent, and the employees registered in the terminal.

use anyhow::{Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};

use crate::models::{AttendanceEmployee, AttendanceEvent, AttendanceShift};

use super::AppState;

pub const MAX_EVENTS_PER_INGEST: usize = 2000;

/// What the agent sends for one check (already validated by the route).
#[derive(Debug, Clone)]
pub struct NewAttendanceEvent {
    pub serial_no: i64,
    pub employee_no: String,
    pub at: DateTime,
    pub method: String,
}

/// Inserts the checks that are not stored yet; re-sent checks are ignored. Returns how many were new.
pub async fn insert_attendance_events(
    state: &AppState,
    company_id: &ObjectId,
    device: &str,
    events: Vec<NewAttendanceEvent>,
) -> Result<u64> {
    if events.len() > MAX_EVENTS_PER_INGEST {
        bail!("at most {MAX_EVENTS_PER_INGEST} events per request");
    }
    let now = DateTime::now();
    let mut inserted = 0;
    for e in events {
        let result = state
            .attendance_events
            .update_one(
                doc! { "company_id": company_id, "device": device, "serial_no": e.serial_no, "at": e.at },
                doc! { "$setOnInsert": {
                    "employee_no": &e.employee_no,
                    "method": &e.method,
                    "created_at": now,
                } },
            )
            .upsert(true)
            .await?;
        if result.upserted_id.is_some() {
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// Time of the newest check stored for a terminal, so the agent knows where to resume.
pub async fn last_attendance_event_at(
    state: &AppState,
    company_id: &ObjectId,
    device: &str,
) -> Result<Option<DateTime>> {
    let last = state
        .attendance_events
        .find_one(doc! { "company_id": company_id, "device": device })
        .sort(doc! { "at": -1 })
        .await?;
    Ok(last.map(|e| e.at))
}

pub async fn list_attendance_events(
    state: &AppState,
    company_id: &ObjectId,
    from: DateTime,
    to: DateTime,
) -> Result<Vec<AttendanceEvent>> {
    let cursor = state
        .attendance_events
        .find(doc! { "company_id": company_id, "at": { "$gte": from, "$lt": to } })
        .sort(doc! { "at": 1 })
        .await?;
    Ok(cursor.try_collect().await?)
}

pub async fn list_attendance_employees(
    state: &AppState,
    company_id: &ObjectId,
) -> Result<Vec<AttendanceEmployee>> {
    let cursor = state
        .attendance_employees
        .find(doc! { "company_id": company_id })
        .sort(doc! { "employee_no": 1 })
        .await?;
    Ok(cursor.try_collect().await?)
}

/// Creates or replaces the employee with that number.
pub async fn upsert_attendance_employee(
    state: &AppState,
    company_id: &ObjectId,
    employee_no: &str,
    name: &str,
    user_id: Option<ObjectId>,
    shift: Option<AttendanceShift>,
    active: bool,
) -> Result<()> {
    let shift = match shift {
        Some(s) => Some(mongodb::bson::to_bson(&s)?),
        None => None,
    };
    state
        .attendance_employees
        .update_one(
            doc! { "company_id": company_id, "employee_no": employee_no },
            doc! { "$set": {
                "name": name,
                "user_id": user_id,
                "shift": shift,
                "active": active,
                "updated_at": DateTime::now(),
            } },
        )
        .upsert(true)
        .await?;
    Ok(())
}

pub async fn delete_attendance_employee(
    state: &AppState,
    company_id: &ObjectId,
    employee_no: &str,
) -> Result<bool> {
    let r = state
        .attendance_employees
        .delete_one(doc! { "company_id": company_id, "employee_no": employee_no })
        .await?;
    Ok(r.deleted_count > 0)
}
