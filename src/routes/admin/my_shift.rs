//! "Mi turno" (Daniel, 2026-11-09): what a programmer sees when they arrive. Their parts
//! (any step of the part assigned to them), where each one is, and what others did to them
//! since their last look: assigned something new, finished or moved a step, recorded,
//! released or rejected pieces. Read from the work-order log, so nothing is captured twice.
//! No money: no prices, costs, PO or quote numbers.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::production::{PersonData, folio, member_names, person};
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{ProcessOperation, Project, ProjectConcept, StepState, UserPermission, UserRole, WorkOrderEvent, WorkOrderEventKind, WorkQueue},
    session::SessionUser,
    state::{
        AppState, WorkOrder, list_board_members, list_process_operations, list_work_order_events_since,
        list_work_orders, touch_my_shift_visit,
    },
};

#[derive(Serialize)]
pub struct MyStep {
    pub name: String,
    /// "pending", "done", "blocked".
    pub state: &'static str,
    pub pieces: Option<f64>,
    pub programmed: bool,
    pub note: Option<String>,
    pub assignee: Option<PersonData>,
    pub mine: bool,
    /// The step the part waits on now.
    pub current: bool,
}

#[derive(Serialize)]
pub struct MyPart {
    pub id: String,
    pub folio: String,
    pub part: String,
    pub project_id: String,
    pub project: String,
    pub client: Option<String>,
    pub priority: &'static str,
    pub priority_label: &'static str,
    pub scheduled_at: Option<String>,
    pub quantity: f64,
    pub completed_quantity: f64,
    pub released_quantity: f64,
    pub unit: Option<String>,
    /// Step it waits on: "Programa", "Setup 1"…, and who holds it.
    pub step: String,
    pub step_assignee: Option<PersonData>,
    /// Why it is held up, when a step is blocked.
    pub blocked_note: Option<String>,
    /// Material and the other steps without a queue are done: it can be run now.
    /// None in the programming queue, where material does not matter.
    pub ready: Option<bool>,
    /// Assigned to them by someone else since their last look.
    pub new: bool,
    pub steps: Vec<MyStep>,
}

#[derive(Serialize)]
pub struct MyChange {
    pub at: String,
    pub kind: WorkOrderEventKind,
    pub part_id: String,
    pub folio: String,
    pub part: String,
    pub project: String,
    pub operation: Option<String>,
    pub actor: PersonData,
    pub subject: Option<PersonData>,
    pub previous: Option<PersonData>,
    pub pieces: Option<f64>,
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct MyShiftData {
    pub person: PersonData,
    /// Start of "what changed": their last look, or the last day the first time.
    pub since: String,
    pub first_visit: bool,
    /// Its current step is theirs, in production sequence.
    pub now: Vec<MyPart>,
    /// A step is blocked.
    pub blocked: Vec<MyPart>,
    /// Theirs, but the part is at someone else's step (or nobody's yet).
    pub elsewhere: Vec<MyPart>,
    /// Newest first.
    pub changes: Vec<MyChange>,
}

#[derive(Debug, Default, Deserialize)]
pub struct MyShiftQuery {
    /// Admins may look at someone else's turn; it does not count as their look.
    pub user_id: Option<String>,
}

fn step_state(s: StepState) -> &'static str {
    match s {
        StepState::Pending => "pending",
        StepState::Done => "done",
        StepState::NotApplicable => "not_applicable",
        StepState::Blocked => "blocked",
    }
}

fn touches(concept: &ProjectConcept, user: ObjectId) -> bool {
    concept.process_steps.iter().any(|s| s.assignee_user_id == Some(user))
}

fn part_data(
    o: &WorkOrder,
    operations: &[ProcessOperation],
    me: ObjectId,
    names: &HashMap<ObjectId, (String, String)>,
    new: bool,
) -> MyPart {
    let current = o.operation.id;
    let steps: Vec<MyStep> = operations
        .iter()
        .filter(|op| op.is_active)
        .filter_map(|op| {
            let id = op.id?;
            let s = o.concept.process_steps.iter().find(|s| s.operation_id == id);
            let state = s.map(|s| s.state).unwrap_or(StepState::Pending);
            if state == StepState::NotApplicable {
                return None;
            }
            Some(MyStep {
                name: s.map(|s| s.name.clone()).unwrap_or_else(|| op.name.clone()),
                state: step_state(state),
                pieces: s.and_then(|s| s.pieces),
                programmed: s.is_some_and(|s| s.programmed),
                note: s.and_then(|s| s.note.clone()).filter(|n| !n.trim().is_empty()),
                assignee: s.and_then(|s| s.assignee_user_id).map(|u| person(u, names)),
                mine: s.is_some_and(|s| s.assignee_user_id == Some(me)),
                current: Some(id) == current,
            })
        })
        .collect();
    let blocked_note = steps
        .iter()
        .find(|s| s.state == "blocked")
        .map(|s| s.note.clone().unwrap_or_else(|| format!("{} detenido", s.name)));
    let priority = o.priority();
    MyPart {
        id: o.concept_id().to_hex(),
        folio: folio(o.concept.work_order_number),
        part: o.concept.name.clone(),
        project_id: o.concept.project_id.to_hex(),
        project: o.project.title.clone(),
        client: o.client.clone(),
        priority: priority.as_str(),
        priority_label: priority.label(),
        scheduled_at: o.project.scheduled_at.map(iso),
        quantity: o.concept.quantity,
        completed_quantity: o.concept.completed_quantity,
        released_quantity: o.concept.released_quantity,
        unit: o.concept.unit.clone(),
        step: o.operation.name.clone(),
        step_assignee: o.assignee_user_id.map(|u| person(u, names)),
        blocked_note,
        ready: (o.queue != WorkQueue::Programming).then_some(o.ready),
        new,
        steps,
    }
}

/// Whether an event is news for `me`: someone else did it, on a part of theirs or about them.
fn is_news(e: &WorkOrderEvent, me: ObjectId, mine: &HashSet<ObjectId>) -> bool {
    if e.actor_user_id == me || matches!(e.kind, WorkOrderEventKind::Pinned | WorkOrderEventKind::Unpinned) {
        return false;
    }
    mine.contains(&e.concept_id) || e.subject_user_id == Some(me) || e.previous_user_id == Some(me)
}

/// Everyone who opens "Mi turno" (board viewers and people who take work), for the admin's
/// "ver el turno de" picker (Daniel, 2026-11-09: "saber que estan viendo ellos"). Admin only.
pub async fn api_my_shift_people(session_user: SessionUser, State(state): State<Arc<AppState>>) -> Response {
    if !session_user.is_admin() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let err = || json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load people");
    let Ok(mut cursor) = state.user_companies.find(doc! { "company_id": company_id }).await else {
        return err();
    };
    let mut ids = Vec::new();
    while let Ok(Some(m)) = cursor.try_next().await {
        if m.role != UserRole::Admin
            && (m.permissions.contains(&UserPermission::TakeWorkOrders)
                || m.permissions.contains(&UserPermission::ViewProductionBoard))
        {
            ids.push(m.user_id);
        }
    }
    let mut people = Vec::new();
    if !ids.is_empty() {
        let Ok(mut cursor) = state.users.find(doc! { "_id": { "$in": &ids } }).await else {
            return err();
        };
        while let Ok(Some(u)) = cursor.try_next().await {
            let Some(id) = u.id else { continue };
            let name = u
                .display_name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| u.username.split('@').next().unwrap_or_default().to_string());
            people.push(PersonData { id: id.to_hex(), username: u.username, name });
        }
    }
    people.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Json(people).into_response()
}

pub async fn api_my_shift(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(query): Query<MyShiftQuery>,
) -> Response {
    if !session_user.has_permission(UserPermission::TakeWorkOrders)
        && !session_user.has_permission(UserPermission::ViewProductionBoard)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let me = match query.user_id.as_deref().filter(|u| !u.is_empty()) {
        Some(u) if session_user.is_admin() => match parse_oid(u) {
            Ok(id) => id,
            Err(resp) => return resp,
        },
        Some(_) => return StatusCode::FORBIDDEN.into_response(),
        None => *session_user.user_id(),
    };
    let own = me == *session_user.user_id();

    let err = || json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load your turn");
    let (Ok(orders), Ok(members), Ok(operations)) = (
        list_work_orders(&state, &company_id).await,
        list_board_members(&state, &company_id).await,
        list_process_operations(&state, &company_id, false).await,
    ) else {
        return err();
    };
    let names = member_names(&members);
    let Ok((since, first_visit)) = touch_my_shift_visit(&state, &company_id, &me, DateTime::now(), own).await else {
        return err();
    };
    let Ok(events) = list_work_order_events_since(&state, &company_id, since).await else {
        return err();
    };

    // Parts of theirs: open ones, plus any an event of the window touched (finished since,
    // or taken away from them).
    let mut mine: HashSet<ObjectId> =
        orders.iter().filter(|o| touches(&o.concept, me)).map(|o| o.concept_id()).collect();
    let event_ids: Vec<ObjectId> = events.iter().map(|e| e.concept_id).collect::<HashSet<_>>().into_iter().collect();
    let mut concepts: HashMap<ObjectId, ProjectConcept> = HashMap::new();
    if !event_ids.is_empty() {
        let Ok(mut cursor) = state
            .project_concepts
            .find(doc! { "company_id": company_id, "_id": { "$in": &event_ids } })
            .await
        else {
            return err();
        };
        while let Ok(Some(c)) = cursor.try_next().await {
            if let Some(id) = c.id {
                if touches(&c, me) {
                    mine.insert(id);
                }
                concepts.insert(id, c);
            }
        }
    }
    let project_ids: Vec<ObjectId> =
        concepts.values().map(|c| c.project_id).collect::<HashSet<_>>().into_iter().collect();
    let mut projects: HashMap<ObjectId, Project> = HashMap::new();
    if !project_ids.is_empty() {
        if let Ok(mut cursor) = state
            .projects
            .find(doc! { "company_id": company_id, "_id": { "$in": &project_ids } })
            .await
        {
            while let Ok(Some(p)) = cursor.try_next().await {
                if let Some(id) = p.id {
                    projects.insert(id, p);
                }
            }
        }
    }

    let news: Vec<&WorkOrderEvent> = events.iter().filter(|e| is_news(e, me, &mine)).collect();
    let fresh: HashSet<ObjectId> = news
        .iter()
        .filter(|e| e.kind == WorkOrderEventKind::Assigned && e.subject_user_id == Some(me))
        .map(|e| e.concept_id)
        .collect();

    let (mut now, mut blocked, mut elsewhere) = (Vec::new(), Vec::new(), Vec::new());
    for o in orders.iter().filter(|o| touches(&o.concept, me)) {
        let part = part_data(o, &operations, me, &names, fresh.contains(&o.concept_id()));
        if part.blocked_note.is_some() {
            blocked.push(part);
        } else if o.assignee_user_id == Some(me) {
            now.push(part);
        } else {
            elsewhere.push(part);
        }
    }

    let changes: Vec<MyChange> = news
        .iter()
        .rev()
        .filter_map(|e| {
            let c = concepts.get(&e.concept_id)?;
            Some(MyChange {
                at: iso(e.at),
                kind: e.kind,
                part_id: e.concept_id.to_hex(),
                folio: folio(c.work_order_number),
                part: c.name.clone(),
                project: projects.get(&c.project_id).map(|p| p.title.clone()).unwrap_or_default(),
                operation: e.operation_name.clone(),
                actor: person(e.actor_user_id, &names),
                subject: e.subject_user_id.map(|u| person(u, &names)),
                previous: e.previous_user_id.map(|u| person(u, &names)),
                pieces: e.pieces_delta,
                reason: e.reason.clone(),
            })
        })
        .collect();

    Json(MyShiftData {
        person: person(me, &names),
        since: iso(since),
        first_visit,
        now,
        blocked,
        elsewhere,
        changes,
    })
    .into_response()
}
