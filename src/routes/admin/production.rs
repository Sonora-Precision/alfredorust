//! Production board JSON API: work-order queues in production sequence, assigning, taking
//! and releasing orders, moving them in the sequence and marking the current step done.
//! Nothing here returns money: no prices, costs, budgets, PO or quote numbers, and no part
//! description (shops write quoted prices there).

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mongodb::bson::{DateTime, oid::ObjectId};
use serde::{Deserialize, Serialize};

use super::finance::helpers::require_active_company;
use super::part_progress::log_step_change;
use super::project_backend::{iso, json_error, parse_oid};
use crate::{
    models::{StepState, UserPermission, WorkOrderEvent, WorkOrderEventKind, WorkQueue},
    session::SessionUser,
    state::{
        AppState, AssignOutcome, BoardMember, PartProgressUpdate, SequenceMove, WorkOrder,
        get_project_concept_by_id_for_company, list_board_members, list_work_orders,
        log_work_order_event, move_in_sequence, set_step_assignee, update_part_progress,
    },
};

fn can_view(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::ViewProductionBoard)
}

fn can_manage(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::ManageProductionBoard)
}

fn can_take(user: &SessionUser) -> bool {
    user.has_permission(UserPermission::TakeWorkOrders)
}

#[derive(Serialize)]
pub struct PersonData {
    pub id: String,
    pub username: String,
    /// Shop-floor name (display name, or the handle before the @).
    pub name: String,
}

#[derive(Serialize)]
pub struct WorkOrderData {
    pub id: String,
    pub folio: String,
    pub work_order_number: Option<i64>,
    pub part: String,
    pub quantity: f64,
    pub completed_quantity: f64,
    pub unit: Option<String>,
    pub project_id: String,
    pub project: String,
    pub client: Option<String>,
    pub priority: &'static str,
    pub priority_label: &'static str,
    pub pinned: bool,
    pub scheduled_at: Option<String>,
    pub queue: &'static str,
    pub operation_id: String,
    pub operation: String,
    pub assignee: Option<PersonData>,
}

pub(crate) fn folio(number: Option<i64>) -> String {
    number.map(|n| format!("OT-{n:04}")).unwrap_or_else(|| "OT-?".to_string())
}

/// Partial match on the item name or the folio, any case. A folio may be typed short:
/// "OT-58", "ot58", "#58" or "58" all find OT-0058. Mirrors `matchesWorkOrder` in the SPA.
pub fn matches_work_order(number: Option<i64>, name: &str, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() || name.to_lowercase().contains(&q) || folio(number).to_lowercase().contains(&q) {
        return true;
    }
    let bare = q.trim_start_matches("ot").trim_start_matches(['-', ' ', '#']);
    !bare.is_empty()
        && bare.chars().all(|c| c.is_ascii_digit())
        && bare.parse::<i64>().ok() == number
}

#[cfg(test)]
mod tests {
    use super::matches_work_order;

    #[test]
    fn short_folios_and_item_names_match() {
        for q in ["OT-0058", "OT-58", "ot58", "#58", "58", " ot 58 "] {
            assert!(matches_work_order(Some(58), "TYE3022-TP", q), "{q}");
        }
        assert!(matches_work_order(Some(58), "TYE3022-7.2L-TP", "7.2l-tp"));
        assert!(!matches_work_order(Some(58), "TYE3022-TP", "OT-5"));
        assert!(!matches_work_order(Some(7), "PALLET", "58"));
    }
}

fn work_order_data(o: &WorkOrder, names: &HashMap<ObjectId, (String, String)>) -> WorkOrderData {
    let priority = o.priority();
    WorkOrderData {
        id: o.concept_id().to_hex(),
        folio: folio(o.concept.work_order_number),
        work_order_number: o.concept.work_order_number,
        part: o.concept.name.clone(),
        quantity: o.concept.quantity,
        completed_quantity: o.concept.completed_quantity,
        unit: o.concept.unit.clone(),
        project_id: o.concept.project_id.to_hex(),
        project: o.project.title.clone(),
        client: o.client.clone(),
        priority: priority.as_str(),
        priority_label: priority.label(),
        pinned: o.concept.sequence_rank.is_some(),
        scheduled_at: o.project.scheduled_at.map(iso),
        queue: o.queue.as_str(),
        operation_id: o.operation.id.map(|id| id.to_hex()).unwrap_or_default(),
        operation: o.operation.name.clone(),
        assignee: o.assignee_user_id.map(|id| person(id, names)),
    }
}

pub(crate) fn person(id: ObjectId, names: &HashMap<ObjectId, (String, String)>) -> PersonData {
    let (username, name) = names
        .get(&id)
        .cloned()
        .unwrap_or_else(|| ("?".to_string(), "?".to_string()));
    PersonData {
        id: id.to_hex(),
        username,
        name,
    }
}

/// user id → (username, shop-floor name)
pub(crate) fn member_names(members: &[BoardMember]) -> HashMap<ObjectId, (String, String)> {
    members
        .iter()
        .map(|m| (m.user_id, (m.username.clone(), m.name.clone())))
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct BoardQuery {
    /// "programming" (default), "setup", "machining" or "finishing".
    pub queue: Option<String>,
    /// Only orders whose current step is assigned to the caller.
    #[serde(default)]
    pub mine: bool,
}

fn queue_param(value: Option<&str>) -> Result<WorkQueue, Response> {
    match value {
        None | Some("") => Ok(WorkQueue::Programming),
        Some(v) => WorkQueue::parse(v)
            .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "unknown queue")),
    }
}

async fn load(
    state: &AppState,
    company_id: &ObjectId,
) -> Result<(Vec<WorkOrder>, Vec<BoardMember>), Response> {
    let orders = list_work_orders(state, company_id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load the board"))?;
    let members = list_board_members(state, company_id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load people"))?;
    Ok((orders, members))
}

pub async fn api_production_board(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(query): Query<BoardQuery>,
) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let queue = match queue_param(query.queue.as_deref()) {
        Ok(q) => q,
        Err(resp) => return resp,
    };
    let company_id = require_active_company(&session_user);
    let (orders, members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let names = member_names(&members);
    let me = *session_user.user_id();
    let items: Vec<WorkOrderData> = orders
        .iter()
        .filter(|o| o.queue == queue)
        .filter(|o| !query.mine || o.assignee_user_id == Some(me))
        .map(|o| work_order_data(o, &names))
        .collect();
    Json(items).into_response()
}

#[derive(Serialize)]
pub struct MemberLoadData {
    pub id: String,
    pub username: String,
    pub name: String,
    pub is_admin: bool,
    /// Orders whose current step is assigned to this person, in sequence order.
    pub assigned: Vec<String>,
    /// The same orders in full, across every queue (Daniel, 2026-11-02: the admin sees
    /// everything assigned to each programmer). No money.
    pub orders: Vec<WorkOrderData>,
}

pub async fn api_production_members(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let (orders, members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let names = member_names(&members);
    let items: Vec<MemberLoadData> = members
        .iter()
        .map(|m| {
            let mine: Vec<&WorkOrder> = orders
                .iter()
                .filter(|o| o.assignee_user_id == Some(m.user_id))
                .collect();
            MemberLoadData {
                id: m.user_id.to_hex(),
                username: m.username.clone(),
                name: m.name.clone(),
                is_admin: m.is_admin,
                assigned: mine.iter().map(|o| folio(o.concept.work_order_number)).collect(),
                orders: mine.iter().map(|o| work_order_data(o, &names)).collect(),
            }
        })
        .collect();
    Json(items).into_response()
}

fn find_order<'a>(orders: &'a [WorkOrder], id: &ObjectId) -> Option<&'a WorkOrder> {
    orders.iter().find(|o| &o.concept_id() == id)
}

fn event(
    o: &WorkOrder,
    kind: WorkOrderEventKind,
    actor: ObjectId,
    subject: Option<ObjectId>,
) -> WorkOrderEvent {
    WorkOrderEvent {
        id: None,
        company_id: o.concept.company_id,
        concept_id: o.concept_id(),
        project_id: o.concept.project_id,
        kind,
        operation_id: o.operation.id,
        operation_name: Some(o.operation.name.clone()),
        queue: Some(o.queue),
        actor_user_id: actor,
        subject_user_id: subject,
        related_to: None,
        reason: None,
        pieces_delta: None,
        unit_price: None,
        at: DateTime::now(),
    }
}

async fn log(state: &AppState, e: WorkOrderEvent) {
    if let Err(err) = log_work_order_event(state, e).await {
        eprintln!("[production] could not log event: {err}");
    }
}

fn outcome_response(outcome: anyhow::Result<AssignOutcome>, conflict: &str) -> Option<Response> {
    match outcome {
        Ok(AssignOutcome::Done) => None,
        Ok(AssignOutcome::Conflict) => Some(json_error(StatusCode::CONFLICT, conflict)),
        Ok(AssignOutcome::NotFound) => Some(json_error(StatusCode::NOT_FOUND, "order not found")),
        Err(_) => Some(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not update the order",
        )),
    }
}

#[derive(Debug, Deserialize)]
pub struct AssignPayload {
    /// Who gets the order's current step; null clears it.
    pub user_id: Option<String>,
}

pub async fn api_work_order_assign(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<AssignPayload>,
) -> Response {
    if !can_manage(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let assignee = match payload.user_id.as_deref() {
        None | Some("") => None,
        Some(u) => match parse_oid(u) {
            Ok(u) => Some(u),
            Err(resp) => return resp,
        },
    };
    let (orders, members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if let Some(a) = assignee {
        if !members.iter().any(|m| m.user_id == a) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "that person cannot hold work orders in this company",
            );
        }
    }
    let Some(order) = find_order(&orders, &id) else {
        return json_error(StatusCode::NOT_FOUND, "order not on the board");
    };
    let outcome =
        set_step_assignee(&state, &company_id, &id, &order.operation, assignee, None).await;
    if let Some(resp) = outcome_response(outcome, "the order changed, try again") {
        return resp;
    }
    let kind = if assignee.is_some() {
        WorkOrderEventKind::Assigned
    } else {
        WorkOrderEventKind::Unassigned
    };
    log(&state, event(order, kind, *session_user.user_id(), assignee)).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Debug, Default, Deserialize)]
pub struct TakePayload {
    /// Take this order next to one you already hold (similar part), out of sequence.
    pub related_to: Option<String>,
    pub reason: Option<String>,
}

pub async fn api_work_order_take(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    payload: Option<Json<TakePayload>>,
) -> Response {
    if !can_take(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let payload = payload.map(|Json(p)| p).unwrap_or_default();
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let related_to = match payload.related_to.as_deref() {
        None | Some("") => None,
        Some(r) => match parse_oid(r) {
            Ok(r) => Some(r),
            Err(resp) => return resp,
        },
    };
    let reason = payload
        .reason
        .map(|r| r.trim().chars().take(200).collect::<String>())
        .filter(|r| !r.is_empty());
    let (orders, _members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let me = *session_user.user_id();
    let Some(order) = find_order(&orders, &id) else {
        return json_error(StatusCode::NOT_FOUND, "order not on the board");
    };
    if order.assignee_user_id.is_some() {
        return json_error(StatusCode::CONFLICT, "someone already has this order");
    }

    // Any free order can be taken for yourself (Daniel, 2026-11-02); the log shows who took
    // what. Grouping next to one of your orders only changes where it lands.
    if let Some(rel) = related_to {
        let Some(related) = find_order(&orders, &rel) else {
            return json_error(StatusCode::BAD_REQUEST, "related order not on the board");
        };
        if related.assignee_user_id != Some(me) {
            return json_error(StatusCode::BAD_REQUEST, "the related order must be yours");
        }
    }

    let outcome = set_step_assignee(
        &state,
        &company_id,
        &id,
        &order.operation,
        Some(me),
        Some(None),
    )
    .await;
    if let Some(resp) = outcome_response(outcome, "someone already has this order") {
        return resp;
    }

    // A grouped order goes right after the one it was grouped with.
    if let Some(rel) = related_to {
        let queue_orders: Vec<WorkOrder> = orders
            .iter()
            .filter(|o| o.queue == order.queue)
            .cloned()
            .collect();
        let _ = move_in_sequence(&state, &company_id, &queue_orders, &id, SequenceMove::After(rel))
            .await;
    }

    let mut e = event(order, WorkOrderEventKind::Taken, me, Some(me));
    e.related_to = related_to;
    e.reason = reason;
    log(&state, e).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

pub async fn api_work_order_release(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !can_take(&session_user) && !can_manage(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let (orders, _members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let me = *session_user.user_id();
    let Some(order) = find_order(&orders, &id) else {
        return json_error(StatusCode::NOT_FOUND, "order not on the board");
    };
    let Some(holder) = order.assignee_user_id else {
        return json_error(StatusCode::CONFLICT, "nobody has this order");
    };
    if holder != me && !can_manage(&session_user) {
        return json_error(StatusCode::FORBIDDEN, "you can only release your own orders");
    }
    let outcome =
        set_step_assignee(&state, &company_id, &id, &order.operation, None, Some(Some(holder)))
            .await;
    if let Some(resp) = outcome_response(outcome, "the order changed, try again") {
        return resp;
    }
    log(&state, event(order, WorkOrderEventKind::Released, me, Some(holder))).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
pub struct SequencePayload {
    pub before_id: Option<String>,
    pub after_id: Option<String>,
    #[serde(default)]
    pub unpin: bool,
}

pub async fn api_work_order_sequence(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<SequencePayload>,
) -> Response {
    if !can_manage(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let movement = match (payload.before_id.as_deref(), payload.after_id.as_deref(), payload.unpin) {
        (Some(b), None, false) => match parse_oid(b) {
            Ok(b) => SequenceMove::Before(b),
            Err(resp) => return resp,
        },
        (None, Some(a), false) => match parse_oid(a) {
            Ok(a) => SequenceMove::After(a),
            Err(resp) => return resp,
        },
        (None, None, true) => SequenceMove::Unpin,
        _ => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "send exactly one of before_id, after_id or unpin",
            );
        }
    };
    let pinned = !matches!(movement, SequenceMove::Unpin);
    let (orders, _members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(order) = find_order(&orders, &id) else {
        return json_error(StatusCode::NOT_FOUND, "order not on the board");
    };
    let queue_orders: Vec<WorkOrder> = orders
        .iter()
        .filter(|o| o.queue == order.queue)
        .cloned()
        .collect();
    match move_in_sequence(&state, &company_id, &queue_orders, &id, movement).await {
        Ok(true) => {}
        Ok(false) => return json_error(StatusCode::BAD_REQUEST, "both orders must be in the same queue"),
        Err(_) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not move the order");
        }
    }
    let kind = if pinned {
        WorkOrderEventKind::Pinned
    } else {
        WorkOrderEventKind::Unpinned
    };
    log(&state, event(order, kind, *session_user.user_id(), None)).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Marks the order's current step done. The holder of the step can do it; so can whoever
/// manages the board.
pub async fn api_work_order_complete(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if !can_take(&session_user) && !can_manage(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let id = match parse_oid(&id) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let (orders, _members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let me = *session_user.user_id();
    let Some(order) = find_order(&orders, &id) else {
        return json_error(StatusCode::NOT_FOUND, "order not on the board");
    };
    if order.assignee_user_id != Some(me) && !can_manage(&session_user) {
        return json_error(StatusCode::FORBIDDEN, "this order is not yours");
    }
    let Some(operation_id) = order.operation.id else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "operation missing id");
    };
    let before = match get_project_concept_by_id_for_company(&state, &id, &company_id).await {
        Ok(Some(c)) => c,
        _ => return json_error(StatusCode::NOT_FOUND, "order not found"),
    };
    let update = PartProgressUpdate {
        completed_quantity: None,
        step: Some((operation_id, StepState::Done)),
    };
    let username = session_user.user().username.clone();
    match update_part_progress(&state, &id, &company_id, update, &username).await {
        Ok(Some(after)) => {
            log_step_change(&state, &session_user, &before, &after, operation_id, StepState::Done)
                .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "order not found"),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

#[derive(Serialize)]
pub struct PersonPiecesData {
    /// null = pieces of parts nobody programmed yet.
    pub id: Option<String>,
    pub name: String,
    pub pieces: f64,
    pub previous_week: f64,
    /// Admin only: released pieces × each part's quoted unit price (Daniel, 2026-11-05).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_amount: Option<f64>,
}

#[derive(Serialize)]
pub struct PartPiecesData {
    pub id: String,
    pub folio: String,
    pub part: String,
    pub pieces: f64,
}

#[derive(Serialize)]
pub struct WeeklyPiecesData {
    pub week_start: String,
    pub week_end: String,
    pub team: f64,
    pub team_previous_week: f64,
    /// Admin only, like each person's `amount`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_previous_amount: Option<f64>,
    /// Everyone's pieces (Daniel, 2026-11-02: programmers see the pieces of all). Money
    /// only for the admin.
    pub people: Vec<PersonPiecesData>,
    /// The caller's pieces this week, per part.
    pub mine_by_part: Vec<PartPiecesData>,
}

/// Finished pieces this shop week (Monday–Sunday, Hermosillo) and the week before, per
/// person who programmed each part and for the whole team. Money (pieces × unit price)
/// goes to the admin only.
pub async fn api_production_weekly_pieces(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let company_id = require_active_company(&session_user);
    let ((start, end), (prev_start, prev_end)) = crate::state::this_and_last_week(DateTime::now());
    let loaded = tokio::try_join!(
        crate::state::pieces_by_part(&state, &company_id, start, end),
        crate::state::pieces_by_part(&state, &company_id, prev_start, prev_end),
        list_board_members(&state, &company_id),
    );
    let Ok((this_week, last_week, members)) = loaded else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not load pieces");
    };
    let names = member_names(&members);

    // Who programmed each part (cached per part).
    let mut programmer: HashMap<ObjectId, Option<ObjectId>> = HashMap::new();
    for concept in this_week.keys().chain(last_week.keys()) {
        if programmer.contains_key(concept) {
            continue;
        }
        let who = crate::state::programmer_of(&state, &company_id, concept)
            .await
            .ok()
            .flatten();
        programmer.insert(*concept, who);
    }

    // Quoted unit price per part, only when the caller is the admin.
    let admin = session_user.is_admin();
    let mut price: HashMap<ObjectId, f64> = HashMap::new();
    if admin {
        for concept in programmer.keys() {
            if let Ok(Some(c)) = get_project_concept_by_id_for_company(&state, concept, &company_id).await {
                price.insert(*concept, c.unit_price.unwrap_or(0.0));
            }
        }
    }
    let value = |concept: &ObjectId, pieces: f64| pieces * price.get(concept).copied().unwrap_or(0.0);

    // (pieces now, pieces before, money now, money before)
    let mut per_person: HashMap<Option<ObjectId>, (f64, f64, f64, f64)> = HashMap::new();
    for m in &members {
        per_person.insert(Some(m.user_id), (0.0, 0.0, 0.0, 0.0));
    }
    for (concept, pieces) in &this_week {
        let row = per_person.entry(programmer[concept]).or_default();
        row.0 += pieces;
        row.2 += value(concept, *pieces);
    }
    for (concept, pieces) in &last_week {
        let row = per_person.entry(programmer[concept]).or_default();
        row.1 += pieces;
        row.3 += value(concept, *pieces);
    }
    let team_amount = admin.then(|| per_person.values().map(|r| r.2).sum());
    let team_previous_amount = admin.then(|| per_person.values().map(|r| r.3).sum());
    let mut people: Vec<PersonPiecesData> = per_person
        .into_iter()
        .filter(|(id, (now, prev, _, _))| id.is_some() || *now != 0.0 || *prev != 0.0)
        .map(|(id, (now, prev, money, money_prev))| PersonPiecesData {
            id: id.map(|i| i.to_hex()),
            name: match id {
                Some(i) => person(i, &names).name,
                None => "Sin programador".to_string(),
            },
            pieces: now,
            previous_week: prev,
            amount: admin.then_some(money),
            previous_amount: admin.then_some(money_prev),
        })
        .collect();
    people.sort_by(|a, b| a.name.cmp(&b.name));

    let me = *session_user.user_id();
    let mut mine_by_part = Vec::new();
    for (concept, pieces) in &this_week {
        if programmer[concept] != Some(me) || *pieces == 0.0 {
            continue;
        }
        if let Ok(Some(c)) = get_project_concept_by_id_for_company(&state, concept, &company_id).await {
            mine_by_part.push(PartPiecesData {
                id: concept.to_hex(),
                folio: folio(c.work_order_number),
                part: c.name,
                pieces: *pieces,
            });
        }
    }
    mine_by_part.sort_by(|a, b| a.folio.cmp(&b.folio));

    Json(WeeklyPiecesData {
        week_start: iso(start),
        week_end: iso(end),
        team: this_week.values().sum(),
        team_previous_week: last_week.values().sum(),
        team_amount,
        team_previous_amount,
        people,
        mine_by_part,
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

#[derive(Serialize)]
pub struct WorkOrderSearchHit {
    pub id: String,
    pub folio: String,
    pub part: String,
    pub project_id: String,
    pub project: String,
    pub client: Option<String>,
    /// Holder of the current step, or of the last step anyone held.
    pub assignee: Option<PersonData>,
    /// "programa", "setup", … while on the board; "terminada", "sin_pasos" or
    /// "proyecto_cerrado" when it left it.
    pub status: String,
    /// Human label: the current step name ("Programa") or "Terminada", …
    pub status_label: String,
    pub queue: Option<&'static str>,
    /// 1-based place in its queue's production sequence.
    pub position: Option<usize>,
    pub quantity: f64,
    /// Pieces produced.
    pub completed_quantity: f64,
    /// Pieces quality released (these count as finished) and rejected.
    pub released_quantity: f64,
    pub rejected_quantity: f64,
    /// Produced pieces waiting for quality ("En liberación").
    pub awaiting_release: f64,
}

/// "¿Dónde va esta parte?": part numbers of the company matching `q` (part name or folio,
/// partial, any case), on the board or not. No money.
pub async fn api_production_search(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Response {
    if !can_view(&session_user) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let needle = query.q.trim().to_lowercase();
    if needle.is_empty() {
        return Json(Vec::<WorkOrderSearchHit>::new()).into_response();
    }
    let company_id = require_active_company(&session_user);
    let (orders, members) = match load(&state, &company_id).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let names = member_names(&members);

    let mut cursor = match state
        .project_concepts
        .find(mongodb::bson::doc! { "company_id": company_id })
        .await
    {
        Ok(c) => c,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "could not search"),
    };
    let mut matches = Vec::new();
    while let Ok(Some(c)) = futures::TryStreamExt::try_next(&mut cursor).await {
        if matches_work_order(c.work_order_number, &c.name, &needle) {
            matches.push(c);
        }
        if matches.len() >= 30 {
            break;
        }
    }

    let mut hits = Vec::new();
    for c in matches {
        let Some(id) = c.id else { continue };
        let project = state
            .projects
            .find_one(mongodb::bson::doc! { "_id": c.project_id, "company_id": company_id })
            .await
            .ok()
            .flatten();
        let on_board = orders.iter().find(|o| o.concept_id() == id);
        let (status, status_label, queue, position, assignee_id, client) = match on_board {
            Some(o) => {
                let pos = orders
                    .iter()
                    .filter(|x| x.queue == o.queue)
                    .position(|x| x.concept_id() == id)
                    .map(|p| p + 1);
                (
                    o.queue.as_str().to_string(),
                    o.operation.name.clone(),
                    Some(o.queue.as_str()),
                    pos,
                    o.assignee_user_id,
                    o.client.clone(),
                )
            }
            None => {
                let closed = project.as_ref().is_some_and(|p| {
                    matches!(
                        p.status,
                        crate::models::ProjectStatus::Entregado | crate::models::ProjectStatus::Cancelado
                    )
                });
                let (s, l) = if c.released_quantity >= c.quantity {
                    ("terminada", "Terminada")
                } else if crate::state::awaiting_release(&c) > 0.0 {
                    ("en_liberacion", "En liberación")
                } else if closed {
                    ("proyecto_cerrado", "Proyecto cerrado")
                } else {
                    ("sin_pasos", "Sin pasos pendientes")
                };
                let last_holder = c
                    .process_steps
                    .iter()
                    .rev()
                    .find_map(|s| s.assignee_user_id);
                (s.to_string(), l.to_string(), None, None, last_holder, None)
            }
        };
        hits.push(WorkOrderSearchHit {
            id: id.to_hex(),
            folio: folio(c.work_order_number),
            part: c.name.clone(),
            project_id: c.project_id.to_hex(),
            project: project.as_ref().map(|p| p.title.clone()).unwrap_or_default(),
            client,
            assignee: assignee_id.map(|u| person(u, &names)),
            status,
            status_label,
            queue,
            position,
            quantity: c.quantity,
            completed_quantity: c.completed_quantity,
            released_quantity: c.released_quantity,
            rejected_quantity: c.rejected_quantity,
            awaiting_release: crate::state::awaiting_release(&c),
        });
    }
    hits.sort_by(|a, b| a.folio.cmp(&b.folio));
    Json(hits).into_response()
}
