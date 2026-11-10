//! "Mi turno" (Daniel, 2026-11-09): when each person last looked, so the page can say what
//! changed on their parts since then; and the events of that window.

use anyhow::Result;
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};

use crate::models::WorkOrderEvent;

use super::AppState;

/// A gap this long between two looks starts a new visit ("since your last time").
pub const VISIT_GAP_MS: i64 = 2 * 60 * 60 * 1000;
/// First look ever: the last day.
pub const FIRST_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// Never look further back than a week.
pub const MAX_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Where the "what changed" window starts, given the stored visit. Pure, for tests.
/// Returns (window start, first visit).
pub fn shift_window(stored: Option<(i64, i64)>, now: i64) -> (i64, bool) {
    let from = match stored {
        None => now - FIRST_WINDOW_MS,
        // Same visit (reloads while at work): keep the window it opened with.
        Some((last_at, window_from)) if now - last_at < VISIT_GAP_MS => window_from,
        // New visit: everything since the last look.
        Some((last_at, _)) => last_at,
    };
    (from.max(now - MAX_WINDOW_MS), stored.is_none())
}

/// Records this look (unless `record` is false: an admin looking at someone else) and returns
/// where its window starts, and whether it is the first.
pub async fn touch_my_shift_visit(
    state: &AppState,
    company_id: &ObjectId,
    user_id: &ObjectId,
    now: DateTime,
    record: bool,
) -> Result<(DateTime, bool)> {
    let filter = doc! { "company_id": company_id, "user_id": user_id };
    let stored = state.my_shift_visits.find_one(filter.clone()).await?.and_then(|d| {
        Some((
            d.get_datetime("last_at").ok()?.timestamp_millis(),
            d.get_datetime("window_from").ok()?.timestamp_millis(),
        ))
    });
    let (from, first) = shift_window(stored, now.timestamp_millis());
    let from = DateTime::from_millis(from);
    if record {
        state
            .my_shift_visits
            .update_one(filter, doc! { "$set": { "last_at": now, "window_from": from } })
            .upsert(true)
            .await?;
    }
    Ok((from, first))
}

/// Events of the company since `from`, oldest first.
pub async fn list_work_order_events_since(
    state: &AppState,
    company_id: &ObjectId,
    from: DateTime,
) -> Result<Vec<WorkOrderEvent>> {
    let mut cursor = state
        .work_order_events
        .find(doc! { "company_id": company_id, "at": { "$gte": from } })
        .sort(doc! { "at": 1 })
        .await?;
    let mut out = Vec::new();
    while let Some(e) = cursor.try_next().await? {
        out.push(e);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows() {
        let h = 60 * 60 * 1000;
        let now = 1_000 * h;
        // First time: the last day.
        assert_eq!(shift_window(None, now), (now - 24 * h, true));
        // Reload an hour later: same window.
        assert_eq!(shift_window(Some((now - h, now - 30 * h)), now), (now - 30 * h, false));
        // Next morning: since last night's look.
        assert_eq!(shift_window(Some((now - 14 * h, now - 40 * h)), now), (now - 14 * h, false));
        // Back after a month: a week at most.
        assert_eq!(shift_window(Some((now - 700 * h, now - 800 * h)), now), (now - 168 * h, false));
    }
}
