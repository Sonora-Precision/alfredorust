// In-process daily CFDI download cron. Runs at 05:00 Mexico time (approximated
// as UTC-6) and, for every company with a SAT config, spawns persisted download
// jobs covering a small recent window. Never blocks the web server.

use std::sync::Arc;

use bson::doc;
use chrono::{Datelike, Duration, NaiveDate, Utc, Weekday};
use futures::TryStreamExt;
use tokio::sync::Semaphore;

use crate::models::SatConfig;
use crate::routes::admin::cfdi_download::spawn_cfdi_download_jobs;
use crate::sat::DownloadType;
use crate::state::AppState;

/// Approximate "now" in Mexico City by subtracting 6h from UTC. Matches the
/// convention `monthly_chunks` uses (safe: always slightly in the past).
fn mexico_now() -> chrono::NaiveDateTime {
    (Utc::now() - Duration::hours(6)).naive_utc()
}

/// Infinite loop: sleep until the next 05:00 Mexico time, run one pass, repeat.
pub async fn run_daily_cfdi_cron(state: Arc<AppState>) {
    loop {
        let now = mexico_now();
        let today_five = now.date().and_hms_opt(5, 0, 0).unwrap();
        let next = if now < today_five {
            today_five
        } else {
            (now.date() + Duration::days(1))
                .and_hms_opt(5, 0, 0)
                .unwrap()
        };

        let sleep_for = (next - now)
            .to_std()
            .unwrap_or_else(|_| std::time::Duration::from_secs(60));
        tokio::time::sleep(sleep_for).await;

        daily_download(&state).await;
    }
}

/// One cron pass: derive the date range from today's Mexico date, then spawn
/// download jobs for every SAT config, sharing one concurrency semaphore.
async fn daily_download(state: &Arc<AppState>) {
    let today = mexico_now().date();

    let (start, end) = if today.day() == 1 {
        // The entire previous month.
        let first_this = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap();
        let last_prev = first_this - Duration::days(1);
        let first_prev =
            NaiveDate::from_ymd_opt(last_prev.year(), last_prev.month(), 1).unwrap();
        (fmt(first_prev), fmt(last_prev))
    } else if today.weekday() == Weekday::Mon {
        // The past week: most recent Monday (7 days ago) .. today.
        (fmt(today - Duration::days(7)), fmt(today))
    } else {
        // Just yesterday.
        let yesterday = today - Duration::days(1);
        (fmt(yesterday), fmt(yesterday))
    };

    let configs: Vec<SatConfig> = match state.sat_configs.find(doc! {}).await {
        Ok(cursor) => match cursor.try_collect().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[cron] failed to collect sat_configs: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("[cron] failed to query sat_configs: {e}");
            return;
        }
    };

    // Cap concurrent SAT requests across ALL companies in this pass.
    let semaphore = Arc::new(Semaphore::new(3));
    let config_count = configs.len();
    let mut total_jobs = 0usize;

    for config in &configs {
        let company_object_id = config.company_id;
        let company_id = company_object_id.to_hex();
        let started = spawn_cfdi_download_jobs(
            state.clone(),
            company_id,
            company_object_id,
            config,
            &start,
            &end,
            vec![DownloadType::Issued, DownloadType::Received],
            false,
            "cron",
            semaphore.clone(),
        )
        .await;
        total_jobs += started.len();
    }

    println!(
        "[cron] daily CFDI download: {config_count} configs, {total_jobs} jobs spawned for {start}..{end}"
    );
}

fn fmt(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}
