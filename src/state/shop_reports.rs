//! The shop-floor monitor's daily reports (one document per company and day, replaced on re-send).

use anyhow::Result;
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};

use crate::models::ShopDailyReport;

use super::AppState;

pub async fn upsert_shop_report(state: &AppState, report: ShopDailyReport) -> Result<()> {
    state
        .shop_daily_reports
        .update_one(
            doc! { "company_id": report.company_id, "day": &report.day },
            doc! { "$set": {
                "source": &report.source,
                "summary": &report.summary,
                "kpis_json": &report.kpis_json,
                "report_json": &report.report_json,
                "updated_at": DateTime::now(),
            } },
        )
        .upsert(true)
        .await?;
    Ok(())
}

/// Newest first, without the heavy report body.
pub async fn list_shop_reports(
    state: &AppState,
    company_id: &ObjectId,
    limit: i64,
) -> Result<Vec<ShopDailyReport>> {
    let cursor = state
        .shop_daily_reports
        .find(doc! { "company_id": company_id })
        .projection(doc! { "report_json": 0 })
        .sort(doc! { "day": -1 })
        .limit(limit)
        .await?;
    Ok(cursor.try_collect().await?)
}

pub async fn get_shop_report(
    state: &AppState,
    company_id: &ObjectId,
    day: &str,
) -> Result<Option<ShopDailyReport>> {
    Ok(state
        .shop_daily_reports
        .find_one(doc! { "company_id": company_id, "day": day })
        .await?)
}
