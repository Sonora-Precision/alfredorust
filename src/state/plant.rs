//! Plant view: the company's shop layout and what each machine is doing, from the DNC
//! monitor's runs or a state set by hand.

use anyhow::Result;
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use std::collections::HashMap;

use crate::models::{
    MachineRun, MachineState, MachineStatus, PlantLayout, WorkOrderEventKind, WorkQueue,
};

use super::AppState;

pub async fn get_plant_layout(state: &AppState, company_id: &ObjectId) -> Result<Option<PlantLayout>> {
    Ok(state
        .plant_layouts
        .find_one(doc! { "company_id": company_id })
        .await?)
}

/// Replaces the company's layout.
pub async fn save_plant_layout(state: &AppState, mut layout: PlantLayout) -> Result<()> {
    layout.id = None;
    layout.updated_at = Some(DateTime::now());
    state
        .plant_layouts
        .replace_one(doc! { "company_id": layout.company_id }, &layout)
        .upsert(true)
        .await?;
    Ok(())
}

pub async fn set_machine_state(state: &AppState, machine_state: MachineState) -> Result<()> {
    state
        .machine_states
        .replace_one(
            doc! { "company_id": machine_state.company_id, "resource_id": machine_state.resource_id },
            &machine_state,
        )
        .upsert(true)
        .await?;
    Ok(())
}

pub async fn list_machine_states(
    state: &AppState,
    company_id: &ObjectId,
) -> Result<HashMap<ObjectId, MachineState>> {
    let mut cursor = state
        .machine_states
        .find(doc! { "company_id": company_id })
        .await?;
    let mut out = HashMap::new();
    while let Some(s) = cursor.try_next().await? {
        out.insert(s.resource_id, s);
    }
    Ok(out)
}

/// "VF-3", "vf 3", "VF3" → "VF3": DNC machine names and resource names differ in dashes,
/// spaces and case.
pub fn machine_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

/// Latest run per machine key over the last `days` days.
pub async fn latest_runs_by_machine(
    state: &AppState,
    company_id: &ObjectId,
    days: i64,
) -> Result<HashMap<String, MachineRun>> {
    let since = DateTime::from_millis(DateTime::now().timestamp_millis() - days * 86_400_000);
    let mut cursor = state
        .machine_runs
        .find(doc! { "company_id": company_id, "ended_at": { "$gte": since } })
        .sort(doc! { "ended_at": -1 })
        .await?;
    let mut out: HashMap<String, MachineRun> = HashMap::new();
    while let Some(run) = cursor.try_next().await? {
        out.entry(machine_key(&run.machine)).or_insert(run);
    }
    Ok(out)
}

/// A run whose last sample is this recent counts as running (the monitor re-sends open runs
/// every few minutes).
pub const RUNNING_WINDOW_MS: i64 = 15 * 60 * 1000;

/// What the plant view shows for a machine.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedStatus {
    pub status: Option<MachineStatus>,
    pub source: &'static str,
    pub since: Option<DateTime>,
}

/// DNC wins while a run is live; otherwise the newer of the last run end and the manual
/// state; with neither, the status is unknown.
pub fn resolve_status(
    run: Option<&MachineRun>,
    manual: Option<&MachineState>,
    now: DateTime,
) -> ResolvedStatus {
    if let Some(run) = run {
        if now.timestamp_millis() - run.ended_at.timestamp_millis() <= RUNNING_WINDOW_MS {
            return ResolvedStatus {
                status: Some(MachineStatus::Working),
                source: if run.inferred { "movimiento" } else { "dnc" },
                since: Some(run.started_at),
            };
        }
    }
    match (run, manual) {
        (Some(run), Some(m)) if m.at > run.ended_at => ResolvedStatus {
            status: Some(m.status),
            source: "manual",
            since: Some(m.at),
        },
        (None, Some(m)) => ResolvedStatus {
            status: Some(m.status),
            source: "manual",
            since: Some(m.at),
        },
        (Some(run), _) => ResolvedStatus {
            status: Some(MachineStatus::Stopped),
            source: "dnc",
            since: Some(run.ended_at),
        },
        (None, None) => ResolvedStatus {
            status: None,
            source: "none",
            since: None,
        },
    }
}

/// Who programmed a part: the credit of the last net "Programa" completion, else whoever
/// holds the programming step now.
/// Who answers for the part's pieces: its responsible person, else its programmer.
pub async fn responsible_of(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
) -> Result<Option<ObjectId>> {
    let owner = state
        .project_concepts
        .find_one(doc! { "_id": concept_id, "company_id": company_id })
        .await?
        .and_then(|c| c.owner_user_id);
    match owner {
        Some(o) => Ok(Some(o)),
        None => programmer_of(state, company_id, concept_id).await,
    }
}

/// Sets the part's responsible person (None clears it).
pub async fn set_part_owner(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
    owner: Option<ObjectId>,
) -> Result<bool> {
    let update = match owner {
        Some(o) => doc! { "$set": { "owner_user_id": o, "updated_at": DateTime::now() } },
        None => doc! { "$unset": { "owner_user_id": "" }, "$set": { "updated_at": DateTime::now() } },
    };
    let res = state
        .project_concepts
        .update_one(doc! { "_id": concept_id, "company_id": company_id }, update)
        .await?;
    Ok(res.matched_count > 0)
}

/// The first person who takes or is given a step past programming becomes responsible,
/// unless someone already is.
pub async fn claim_part_owner(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
    user: ObjectId,
) -> Result<()> {
    state
        .project_concepts
        .update_one(
            doc! { "_id": concept_id, "company_id": company_id, "owner_user_id": null },
            doc! { "$set": { "owner_user_id": user } },
        )
        .await?;
    Ok(())
}

pub async fn programmer_of(
    state: &AppState,
    company_id: &ObjectId,
    concept_id: &ObjectId,
) -> Result<Option<ObjectId>> {
    let last = state
        .work_order_events
        .find_one(doc! {
            "company_id": company_id,
            "concept_id": concept_id,
            "queue": WorkQueue::Programming.as_str(),
            "kind": { "$in": ["step_done", "step_reopened"] },
        })
        .sort(doc! { "at": -1 })
        .await?;
    if let Some(e) = last {
        if e.kind == WorkOrderEventKind::StepDone {
            return Ok(e.subject_user_id);
        }
    }
    let Some(concept) = state
        .project_concepts
        .find_one(doc! { "_id": concept_id, "company_id": company_id })
        .await?
    else {
        return Ok(None);
    };
    let programming_ops: Vec<ObjectId> = super::list_process_operations(state, company_id, true)
        .await?
        .into_iter()
        .filter(|op| op.queue == Some(WorkQueue::Programming))
        .filter_map(|op| op.id)
        .collect();
    Ok(concept
        .process_steps
        .iter()
        .find(|s| programming_ops.contains(&s.operation_id))
        .and_then(|s| s.assignee_user_id))
}

/// Hermosillo is UTC-7 all year (no daylight saving).
const SHOP_UTC_OFFSET_MS: i64 = -7 * 3_600_000;
const WEEK_MS: i64 = 7 * 86_400_000;

/// Monday 00:00 shop time of the week containing `at`, as a UTC instant.
pub fn shop_week_start(at: DateTime) -> DateTime {
    let local = at.timestamp_millis() + SHOP_UTC_OFFSET_MS;
    let day = local.div_euclid(86_400_000);
    // 1970-01-01 was a Thursday: days since the last Monday.
    let since_monday = (day + 3).rem_euclid(7);
    DateTime::from_millis((day - since_monday) * 86_400_000 - SHOP_UTC_OFFSET_MS)
}

/// Finished pieces per part in [from, to): pieces quality released (net of corrections).
pub async fn pieces_by_part(
    state: &AppState,
    company_id: &ObjectId,
    from: DateTime,
    to: DateTime,
) -> Result<HashMap<ObjectId, f64>> {
    let mut cursor = state
        .work_order_events
        .find(doc! {
            "company_id": company_id,
            "kind": "pieces_released",
            "at": { "$gte": from, "$lt": to },
        })
        .await?;
    let mut out: HashMap<ObjectId, f64> = HashMap::new();
    while let Some(e) = cursor.try_next().await? {
        *out.entry(e.concept_id).or_default() += e.pieces_delta.unwrap_or(0.0);
    }
    Ok(out)
}

/// The shop week that contains `now` and the one before it.
pub fn this_and_last_week(now: DateTime) -> ((DateTime, DateTime), (DateTime, DateTime)) {
    let start = shop_week_start(now);
    let end = DateTime::from_millis(start.timestamp_millis() + WEEK_MS);
    let prev = DateTime::from_millis(start.timestamp_millis() - WEEK_MS);
    ((start, end), (prev, start))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shop_week_starts_monday_midnight_hermosillo() {
        // Sunday 2026-11-01 23:30 Hermosillo = Monday 06:30 UTC → week of Oct 26.
        let sunday_late = DateTime::parse_rfc3339_str("2026-11-02T06:30:00Z").unwrap();
        assert_eq!(
            shop_week_start(sunday_late),
            DateTime::parse_rfc3339_str("2026-10-26T07:00:00Z").unwrap()
        );
        // Monday 2026-11-02 00:10 Hermosillo → week of Nov 2.
        let monday = DateTime::parse_rfc3339_str("2026-11-02T07:10:00Z").unwrap();
        assert_eq!(
            shop_week_start(monday),
            DateTime::parse_rfc3339_str("2026-11-02T07:00:00Z").unwrap()
        );
    }

    fn run(ended_ms: i64) -> MachineRun {
        MachineRun {
            id: None,
            company_id: ObjectId::new(),
            source: "taller-vision".into(),
            external_id: "1".into(),
            machine: "VF-3".into(),
            program: "O0010.NC".into(),
            part_number: None,
            part_key: None,
            header_date: None,
            started_at: DateTime::from_millis(ended_ms - 600_000),
            ended_at: DateTime::from_millis(ended_ms),
            minutes: 10.0,
            cutting_minutes: 9.0,
            cycles: 1,
            inferred: false,
            program_loaded_at: None,
            header_name: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn manual(status: MachineStatus, at_ms: i64) -> MachineState {
        MachineState {
            id: None,
            company_id: ObjectId::new(),
            resource_id: ObjectId::new(),
            status,
            concept_id: None,
            note: None,
            label: None,
            set_by: ObjectId::new(),
            at: DateTime::from_millis(at_ms),
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn machine_keys_ignore_dashes_spaces_and_case() {
        assert_eq!(machine_key("VF-3"), "VF3");
        assert_eq!(machine_key("SL30"), machine_key("SL-30"));
        assert_eq!(machine_key("SHIZUOKA"), machine_key("Shizuoka"));
    }

    #[test]
    fn live_run_is_working_even_with_a_manual_stop() {
        let r = run(NOW - 60_000);
        let m = manual(MachineStatus::Stopped, NOW - 1_000);
        let s = resolve_status(Some(&r), Some(&m), DateTime::from_millis(NOW));
        assert_eq!(s.status, Some(MachineStatus::Working));
        assert_eq!(s.source, "dnc");
    }

    #[test]
    fn old_run_is_stopped_since_its_end() {
        let r = run(NOW - 3_600_000);
        let s = resolve_status(Some(&r), None, DateTime::from_millis(NOW));
        assert_eq!(s.status, Some(MachineStatus::Stopped));
        assert_eq!(s.since, Some(r.ended_at));
    }

    #[test]
    fn newer_manual_setup_beats_an_old_run() {
        let r = run(NOW - 3_600_000);
        let m = manual(MachineStatus::Setup, NOW - 600_000);
        let s = resolve_status(Some(&r), Some(&m), DateTime::from_millis(NOW));
        assert_eq!(s.status, Some(MachineStatus::Setup));
        assert_eq!(s.source, "manual");
    }

    #[test]
    fn no_data_is_unknown() {
        let s = resolve_status(None, None, DateTime::from_millis(NOW));
        assert_eq!(s.status, None);
        assert_eq!(s.source, "none");
    }
}
