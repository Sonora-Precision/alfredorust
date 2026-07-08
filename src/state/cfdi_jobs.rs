// Persistence for CFDI download jobs (formerly an in-memory HashMap). Jobs now
// survive restarts and are scoped by `company_id` on every query.

use anyhow::Result;
use bson::doc;
use futures::TryStreamExt;

use super::{AppState, CfdiJob, CfdiJobStatus};

/// Insert a freshly-created job (status usually `Queued`).
pub async fn insert_cfdi_job(state: &AppState, job: &CfdiJob) -> Result<()> {
    state.cfdi_jobs.insert_one(job).await?;
    Ok(())
}

/// Overwrite the `status` of an existing job, keyed by `job_id`.
pub async fn set_cfdi_job_status(
    state: &AppState,
    job_id: &str,
    status: &CfdiJobStatus,
) -> Result<()> {
    let status_bson = bson::to_bson(status)?;
    state
        .cfdi_jobs
        .update_one(
            doc! { "job_id": job_id },
            doc! { "$set": { "status": status_bson } },
        )
        .await?;
    Ok(())
}

/// Jobs marked active in Mongo after process startup no longer have an in-memory
/// worker behind them. Mark them as interrupted so the UI does not show a stale
/// "running" job forever after a deploy/restart.
pub async fn fail_interrupted_cfdi_jobs(state: &AppState) -> Result<u64> {
    let status_bson = bson::to_bson(&CfdiJobStatus::Failed {
        error: "Descarga interrumpida por reinicio/despliegue del servidor. Inicia una nueva descarga para reintentar con el timeout actual.".to_string(),
    })?;
    let result = state
        .cfdi_jobs
        .update_many(
            doc! { "status.status": { "$in": ["queued", "running"] } },
            doc! { "$set": { "status": status_bson } },
        )
        .await?;
    Ok(result.modified_count)
}

/// All jobs for a company, newest first.
pub async fn list_cfdi_jobs(state: &AppState, company_id: &str) -> Result<Vec<CfdiJob>> {
    let cursor = state
        .cfdi_jobs
        .find(doc! { "company_id": company_id })
        .sort(doc! { "created_at": -1 })
        .await?;
    Ok(cursor.try_collect().await?)
}

/// A single job scoped to its company.
pub async fn get_cfdi_job(
    state: &AppState,
    company_id: &str,
    job_id: &str,
) -> Result<Option<CfdiJob>> {
    Ok(state
        .cfdi_jobs
        .find_one(doc! { "company_id": company_id, "job_id": job_id })
        .await?)
}
