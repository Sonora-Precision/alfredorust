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
