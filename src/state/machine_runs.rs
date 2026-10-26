//! Machine runs reported by the shop-floor monitor (taller-vision) and their link
//! to project parts. Runs are intervals (one document per program run), upserted
//! by `external_id`, and matched to a `ProjectConcept` at read time by part number.

use std::collections::HashMap;

use anyhow::{Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use serde::Serialize;

use crate::models::{MachineRun, ProjectStatus};

use super::AppState;

pub const MAX_RUNS_PER_INGEST: usize = 2000;

/// What the monitor sends for one run (already validated by the route).
#[derive(Debug, Clone)]
pub struct NewMachineRun {
    pub external_id: String,
    pub machine: String,
    pub program: String,
    pub part_number: Option<String>,
    pub header_date: Option<String>,
    pub started_at: DateTime,
    pub ended_at: DateTime,
    pub minutes: f64,
    pub cutting_minutes: f64,
    pub cycles: i32,
}

/// Uppercase, without whitespace: "zbl149-cst-y261007-1 " == "ZBL149-CST-Y261007-1".
pub fn normalize_part(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

pub async fn upsert_machine_runs(
    state: &AppState,
    company_id: &ObjectId,
    source: &str,
    runs: Vec<NewMachineRun>,
) -> Result<(u64, u64)> {
    if runs.len() > MAX_RUNS_PER_INGEST {
        bail!("at most {MAX_RUNS_PER_INGEST} runs per request");
    }
    let now = DateTime::now();
    let (mut inserted, mut updated) = (0, 0);
    for run in runs {
        let part_number = run
            .part_number
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        let part_key = part_number.as_deref().map(normalize_part);
        let result = state
            .machine_runs
            .update_one(
                doc! { "company_id": company_id, "source": source, "external_id": &run.external_id },
                doc! {
                    "$set": {
                        "machine": run.machine,
                        "program": run.program,
                        "part_number": part_number,
                        "part_key": part_key,
                        "header_date": run.header_date,
                        "started_at": run.started_at,
                        "ended_at": run.ended_at,
                        "minutes": run.minutes,
                        "cutting_minutes": run.cutting_minutes,
                        "cycles": run.cycles,
                    },
                    "$setOnInsert": { "created_at": now, "updated_at": now },
                },
            )
            .upsert(true)
            .await?;
        if result.upserted_id.is_some() {
            inserted += 1;
        } else if result.modified_count > 0 {
            // re-sent unchanged runs leave `updated_at` alone, so it tells when the data last changed
            updated += 1;
            state
                .machine_runs
                .update_one(
                    doc! { "company_id": company_id, "source": source, "external_id": &run.external_id },
                    doc! { "$set": { "updated_at": now } },
                )
                .await?;
        }
    }
    Ok((inserted, updated))
}

pub async fn list_machine_runs(
    state: &AppState,
    company_id: &ObjectId,
    from: Option<DateTime>,
    to: Option<DateTime>,
) -> Result<Vec<MachineRun>> {
    let mut filter = doc! { "company_id": company_id };
    let mut range = doc! {};
    if let Some(from) = from {
        range.insert("$gte", from);
    }
    if let Some(to) = to {
        range.insert("$lt", to);
    }
    if !range.is_empty() {
        filter.insert("started_at", range);
    }
    let mut cursor = state
        .machine_runs
        .find(filter)
        .sort(doc! { "started_at": 1 })
        .await?;
    let mut items = Vec::new();
    while let Some(run) = cursor.try_next().await? {
        items.push(run);
    }
    Ok(items)
}

/// A part (concept) that a run could belong to.
#[derive(Debug, Clone)]
struct PartCandidate {
    concept_id: ObjectId,
    project_id: ObjectId,
    quantity: f64,
    /// Delivered/cancelled projects stop receiving time after this moment.
    active_until: Option<DateTime>,
}

/// Part number -> candidate concepts, for every project of a company that was active at some point.
#[derive(Debug, Default)]
pub struct PartIndex {
    by_key: HashMap<String, Vec<PartCandidate>>,
}

/// Fraction of a run that goes to one part of one project.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunShare {
    pub project_id: String,
    pub concept_id: String,
    pub ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RunMatch {
    /// One share per active project that has the part; several = time split by pieces ordered.
    Matched { shares: Vec<RunShare> },
    /// The header had no part number (old programs, "O0010").
    NoPart,
    /// No active project had a part with that number when the run happened.
    NotFound,
}

impl PartIndex {
    /// `completed_at` = when a delivered project stopped being active (None and not delivered = still active).
    pub fn insert(
        &mut self,
        part_name: &str,
        concept_id: ObjectId,
        project_id: ObjectId,
        quantity: f64,
        project_status: &ProjectStatus,
        completed_at: Option<DateTime>,
    ) {
        let active_until = match project_status {
            ProjectStatus::Cancelado => return,
            // delivered without a date: unknown when it ended, so it no longer takes time
            ProjectStatus::Entregado => Some(completed_at.unwrap_or(DateTime::from_millis(0))),
            _ => None,
        };
        self.by_key
            .entry(normalize_part(part_name))
            .or_default()
            .push(PartCandidate {
                concept_id,
                project_id,
                quantity,
                active_until,
            });
    }

    /// The programmers only know the part, not the project: the run goes to every project that was
    /// active when it started and has that part, split by the pieces each one ordered (an estimate:
    /// 8 h for a part ordered 6 by A and 2 by B -> 6 h to A, 2 h to B).
    pub fn match_run(&self, part_key: Option<&str>, at: DateTime) -> RunMatch {
        let Some(key) = part_key.filter(|k| !k.is_empty()) else {
            return RunMatch::NoPart;
        };
        let found: Vec<&PartCandidate> = self
            .by_key
            .get(key)
            .into_iter()
            .flatten()
            .filter(|c| c.active_until.is_none_or(|until| until >= at))
            .collect();
        if found.is_empty() {
            return RunMatch::NotFound;
        }
        let total: f64 = found.iter().map(|c| c.quantity.max(0.0)).sum();
        let shares = found
            .iter()
            .map(|c| RunShare {
                project_id: c.project_id.to_hex(),
                concept_id: c.concept_id.to_hex(),
                ratio: if total > 0.0 {
                    c.quantity.max(0.0) / total
                } else {
                    1.0 / found.len() as f64
                },
            })
            .collect();
        RunMatch::Matched { shares }
    }
}

pub async fn build_part_index(state: &AppState, company_id: &ObjectId) -> Result<PartIndex> {
    let mut projects = HashMap::new();
    let mut cursor = state
        .projects
        .find(doc! { "company_id": company_id })
        .await?;
    while let Some(p) = cursor.try_next().await? {
        if let Some(id) = p.id {
            projects.insert(id, p);
        }
    }
    let mut index = PartIndex::default();
    let mut cursor = state
        .project_concepts
        .find(doc! { "company_id": company_id })
        .await?;
    while let Some(c) = cursor.try_next().await? {
        let (Some(concept_id), Some(project)) = (c.id, projects.get(&c.project_id)) else {
            continue;
        };
        index.insert(
            &c.name,
            concept_id,
            c.project_id,
            c.quantity,
            &project.status,
            project.completed_at,
        );
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime {
        DateTime::parse_rfc3339_str(s).unwrap()
    }

    #[test]
    fn runs_go_to_active_projects_split_by_pieces() {
        let (a, b, old, gone) = (
            ObjectId::new(),
            ObjectId::new(),
            ObjectId::new(),
            ObjectId::new(),
        );
        let mut ix = PartIndex::default();
        ix.insert(
            "ZBL149-CST-Y261007-1",
            ObjectId::new(),
            a,
            4.0,
            &ProjectStatus::Produccion,
            None,
        );
        // same part in two active projects: 6 pieces for A, 2 for B
        ix.insert(
            "PIN-10",
            ObjectId::new(),
            a,
            6.0,
            &ProjectStatus::Produccion,
            None,
        );
        ix.insert(
            "pin-10 ",
            ObjectId::new(),
            b,
            2.0,
            &ProjectStatus::Ingenieria,
            None,
        );
        // delivered on Oct 10: takes time from runs before that, not after
        ix.insert(
            "PIN-10",
            ObjectId::new(),
            old,
            8.0,
            &ProjectStatus::Entregado,
            Some(t("2026-10-10T00:00:00Z")),
        );
        ix.insert(
            "TAPA-1",
            ObjectId::new(),
            gone,
            1.0,
            &ProjectStatus::Cancelado,
            None,
        );
        let now = t("2026-10-20T15:00:00Z");
        let m = |part: &str, at| ix.match_run(Some(&normalize_part(part)), at);

        let RunMatch::Matched { shares } = m("zbl149-cst-y261007-1", now) else {
            panic!()
        };
        assert_eq!(
            (shares.len(), shares[0].ratio, shares[0].project_id.clone()),
            (1, 1.0, a.to_hex())
        );

        let RunMatch::Matched { shares } = m("PIN-10", now) else {
            panic!()
        };
        let ratio = |p: ObjectId| {
            shares
                .iter()
                .find(|s| s.project_id == p.to_hex())
                .map(|s| s.ratio)
        };
        assert_eq!(
            (ratio(a), ratio(b), ratio(old)),
            (Some(0.75), Some(0.25), None)
        );

        let RunMatch::Matched { shares } = m("PIN-10", t("2026-10-05T12:00:00Z")) else {
            panic!()
        };
        assert_eq!(shares.len(), 3);
        assert_eq!(shares.iter().map(|s| s.ratio).sum::<f64>(), 1.0);

        assert_eq!(ix.match_run(None, now), RunMatch::NoPart);
        assert_eq!(m("NO-EXISTE-1", now), RunMatch::NotFound);
        assert_eq!(m("TAPA-1", now), RunMatch::NotFound);
    }
}
