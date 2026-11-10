//! Time-clock checks pushed by the shop PC agent, and the employees registered in the terminal.

use anyhow::{Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};

use crate::models::{AttendanceCorrection, AttendanceEmployee, AttendanceEvent, AttendanceShift};

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

/// Corrections with `from <= date <= to` (YYYY-MM-DD compares as text).
pub async fn list_attendance_corrections(
    state: &AppState,
    company_id: &ObjectId,
    from: &str,
    to: &str,
) -> Result<Vec<AttendanceCorrection>> {
    let cursor = state
        .attendance_corrections
        .find(doc! { "company_id": company_id, "date": { "$gte": from, "$lte": to } })
        .await?;
    Ok(cursor.try_collect().await?)
}

/// Sets (or replaces) the correction of that employee's day.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_attendance_correction(
    state: &AppState,
    company_id: &ObjectId,
    employee_no: &str,
    date: &str,
    entry: Option<&str>,
    exit: Option<&str>,
    note: Option<&str>,
    author: &str,
) -> Result<()> {
    state
        .attendance_corrections
        .update_one(
            doc! { "company_id": company_id, "employee_no": employee_no, "date": date },
            doc! { "$set": {
                "entry": entry,
                "exit": exit,
                "note": note,
                "author": author,
                "updated_at": DateTime::now(),
            } },
        )
        .upsert(true)
        .await?;
    Ok(())
}

/// Removes it; false when there was none.
pub async fn delete_attendance_correction(
    state: &AppState,
    company_id: &ObjectId,
    employee_no: &str,
    date: &str,
) -> Result<bool> {
    let r = state
        .attendance_corrections
        .delete_one(doc! { "company_id": company_id, "employee_no": employee_no, "date": date })
        .await?;
    Ok(r.deleted_count > 0)
}

/// The terminal name used for checks typed by an admin.
pub const MANUAL_DEVICE: &str = "manual";

/// Stable, non-negative serial for a manual check of `employee_no` at `at` (FNV-1a).
pub fn manual_serial(employee_no: &str, at: DateTime) -> i64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in employee_no
        .bytes()
        .chain(at.timestamp_millis().to_le_bytes())
    {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h >> 1) as i64
}

/// Adds a check typed by an admin (forgotten check, no fingerprint yet...). Returns its id.
pub async fn insert_manual_attendance_event(
    state: &AppState,
    company_id: &ObjectId,
    employee_no: &str,
    at: DateTime,
    note: Option<String>,
    author: &str,
) -> Result<ObjectId> {
    let event = AttendanceEvent {
        id: None,
        company_id: *company_id,
        device: MANUAL_DEVICE.to_string(),
        // The unique key is (device, serial, time): derive the serial from the employee so two
        // people can have a manual check at the same time, while the same person can't twice.
        serial_no: manual_serial(employee_no, at),
        employee_no: employee_no.to_string(),
        at,
        method: "manual".to_string(),
        created_at: DateTime::now(),
        note,
        author: Some(author.to_string()),
    };
    let r = state.attendance_events.insert_one(event).await?;
    r.inserted_id
        .as_object_id()
        .ok_or_else(|| anyhow::anyhow!("no id"))
}

/// Deletes a manual check; checks from the terminal can't be deleted.
pub async fn delete_manual_attendance_event(
    state: &AppState,
    company_id: &ObjectId,
    id: ObjectId,
) -> Result<bool> {
    let r = state
        .attendance_events
        .delete_one(doc! { "_id": id, "company_id": company_id, "device": MANUAL_DEVICE })
        .await?;
    Ok(r.deleted_count > 0)
}

/// Creates or replaces the employee with that number.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_attendance_employee(
    state: &AppState,
    company_id: &ObjectId,
    employee_no: &str,
    name: &str,
    user_id: Option<ObjectId>,
    shift: Option<AttendanceShift>,
    alternates: Vec<AttendanceShift>,
    active: bool,
    intern: bool,
    weekly_pay: Option<f64>,
    weekly_hours: Option<f64>,
    // None = keep what they have (a new employee gets `default_start`); Some("") = clear it.
    start_date: Option<&str>,
    default_start: &str,
) -> Result<()> {
    let shift = match shift {
        Some(s) => Some(mongodb::bson::to_bson(&s)?),
        None => None,
    };
    let alternates = mongodb::bson::to_bson(&alternates)?;
    let mut set = doc! {
        "name": name,
        "user_id": user_id,
        "shift": shift,
        "alternates": alternates,
        "active": active,
        "intern": intern,
        "weekly_pay": weekly_pay,
        "weekly_hours": weekly_hours,
        "updated_at": DateTime::now(),
    };
    let mut update = doc! {};
    match start_date {
        Some("") => {
            update.insert("$unset", doc! { "start_date": "" });
        }
        Some(d) => {
            set.insert("start_date", d);
        }
        None => {
            update.insert("$setOnInsert", doc! { "start_date": default_start });
        }
    }
    update.insert("$set", set);
    state
        .attendance_employees
        .update_one(
            doc! { "company_id": company_id, "employee_no": employee_no },
            update,
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
