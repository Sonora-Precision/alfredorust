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
    pub project_code: Option<String>,
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

/// Project code = letters followed by digits at the start of the title ("ZBL149 Braba Tech" -> "ZBL149").
pub fn project_code_from_title(title: &str) -> Option<String> {
    let t = title.trim_start();
    let letters = t.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    let digits = t[letters..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .count();
    if letters >= 2 && digits >= 2 {
        Some(t[..letters + digits].to_ascii_uppercase())
    } else {
        None
    }
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
        let project_code = run
            .project_code
            .map(|p| normalize_part(&p))
            .filter(|p| !p.is_empty());
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
                        "project_code": project_code,
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
pub struct PartCandidate {
    pub concept_id: ObjectId,
    pub project_id: ObjectId,
    pub project_code: Option<String>,
    project_title_key: String,
    open: bool,
}

/// Part number -> candidate concepts, for every non-cancelled project of a company.
#[derive(Debug, Default)]
pub struct PartIndex {
    by_key: HashMap<String, Vec<PartCandidate>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RunMatch {
    Matched {
        project_id: String,
        concept_id: String,
    },
    /// The header had no part number (old programs, "O0010").
    NoPart,
    /// No concept with that part number (or not in the project given in the header).
    NotFound,
    /// Same part number in several open projects and the header names no project.
    Ambiguous { project_ids: Vec<String> },
}

impl PartIndex {
    pub fn insert(
        &mut self,
        part_name: &str,
        concept_id: ObjectId,
        project_id: ObjectId,
        project_title: &str,
        project_status: &ProjectStatus,
    ) {
        if *project_status == ProjectStatus::Cancelado {
            return;
        }
        self.by_key
            .entry(normalize_part(part_name))
            .or_default()
            .push(PartCandidate {
                concept_id,
                project_id,
                project_code: project_code_from_title(project_title),
                project_title_key: normalize_part(project_title),
                open: *project_status != ProjectStatus::Entregado,
            });
    }

    pub fn match_run(&self, part_key: Option<&str>, project_code: Option<&str>) -> RunMatch {
        let Some(key) = part_key.filter(|k| !k.is_empty()) else {
            return RunMatch::NoPart;
        };
        let Some(all) = self.by_key.get(key) else {
            return RunMatch::NotFound;
        };
        let mut found: Vec<&PartCandidate> = match project_code.filter(|c| !c.is_empty()) {
            Some(code) => all
                .iter()
                .filter(|c| {
                    c.project_code.as_deref() == Some(code) || c.project_title_key.contains(code)
                })
                .collect(),
            None => all.iter().collect(),
        };
        if found.len() > 1 {
            let open: Vec<&PartCandidate> = found.iter().copied().filter(|c| c.open).collect();
            if !open.is_empty() {
                found = open;
            }
        }
        match found.as_slice() {
            [] => RunMatch::NotFound,
            [one] => RunMatch::Matched {
                project_id: one.project_id.to_hex(),
                concept_id: one.concept_id.to_hex(),
            },
            many => RunMatch::Ambiguous {
                project_ids: many.iter().map(|c| c.project_id.to_hex()).collect(),
            },
        }
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
            &project.title,
            &project.status,
        );
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> (PartIndex, ObjectId, ObjectId, ObjectId) {
        let (p1, p2, p3) = (ObjectId::new(), ObjectId::new(), ObjectId::new());
        let mut ix = PartIndex::default();
        ix.insert(
            "ZBL149-CST-Y261007-1",
            ObjectId::new(),
            p1,
            "ZBL149 Braba",
            &ProjectStatus::Produccion,
        );
        // same part in two projects
        ix.insert(
            "PIN-10",
            ObjectId::new(),
            p1,
            "ZBL149 Braba",
            &ProjectStatus::Produccion,
        );
        ix.insert(
            "pin-10 ",
            ObjectId::new(),
            p2,
            "TY2157 Otro / F-96",
            &ProjectStatus::Produccion,
        );
        // delivered project: loses to an open one
        ix.insert(
            "BUJE-2",
            ObjectId::new(),
            p3,
            "AB100 Viejo",
            &ProjectStatus::Entregado,
        );
        ix.insert(
            "BUJE-2",
            ObjectId::new(),
            p2,
            "TY2157 Otro / F-96",
            &ProjectStatus::Calidad,
        );
        // cancelled projects never match
        ix.insert(
            "TAPA-1",
            ObjectId::new(),
            p3,
            "AB100 Viejo",
            &ProjectStatus::Cancelado,
        );
        (ix, p1, p2, p3)
    }

    #[test]
    fn project_code_is_the_leading_letters_and_digits() {
        assert_eq!(
            project_code_from_title("ZBL149 Braba Tech").as_deref(),
            Some("ZBL149")
        );
        assert_eq!(
            project_code_from_title("  ty2157-x").as_deref(),
            Some("TY2157")
        );
        assert_eq!(project_code_from_title("Pines varios"), None);
        assert_eq!(project_code_from_title("Ñ12 raro"), None);
    }

    #[test]
    fn runs_match_by_part_number_and_project() {
        let (ix, p1, p2, _) = index();
        let m = |part: Option<&str>, code: Option<&str>| {
            ix.match_run(part.map(normalize_part).as_deref(), code)
        };
        assert!(
            matches!(m(Some("zbl149-cst-y261007-1"), None), RunMatch::Matched { project_id, .. } if project_id == p1.to_hex())
        );
        assert_eq!(m(None, None), RunMatch::NoPart);
        assert_eq!(m(Some("NO-EXISTE-1"), None), RunMatch::NotFound);
        assert!(
            matches!(m(Some("PIN-10"), None), RunMatch::Ambiguous { project_ids } if project_ids.len() == 2)
        );
        assert!(
            matches!(m(Some("PIN-10"), Some("TY2157")), RunMatch::Matched { project_id, .. } if project_id == p2.to_hex())
        );
        // the header can also carry the invoice folio written in the title
        assert!(
            matches!(m(Some("PIN-10"), Some("F-96")), RunMatch::Matched { project_id, .. } if project_id == p2.to_hex())
        );
        assert_eq!(m(Some("PIN-10"), Some("XX999")), RunMatch::NotFound);
        assert!(
            matches!(m(Some("BUJE-2"), None), RunMatch::Matched { project_id, .. } if project_id == p2.to_hex())
        );
        assert_eq!(m(Some("TAPA-1"), None), RunMatch::NotFound);
    }
}
