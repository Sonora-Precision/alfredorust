//! Files attached to part numbers (today the PDF drawing). Bytes go to local disk under
//! `PART_FILE_STORE_DIR` (default `data/part_files`); Mongo keeps the metadata. The storage
//! key is relative so the tree can later move to object storage (R2) unchanged.

use anyhow::{Context, Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use crate::models::{PartFile, ProjectConcept};

use super::AppState;

/// Largest drawing accepted (bytes).
pub const MAX_PART_FILE_BYTES: usize = 40 * 1024 * 1024;

pub fn part_file_store_root() -> PathBuf {
    PathBuf::from(std::env::var("PART_FILE_STORE_DIR").unwrap_or_else(|_| "data/part_files".to_string()))
}

/// A PDF starts with "%PDF-" (allowing a little leading junk some tools write).
pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes.len() >= 5 && bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

/// Stores a PDF drawing for the part and returns its record.
pub async fn save_part_drawing(
    state: &AppState,
    concept: &ProjectConcept,
    filename: &str,
    bytes: &[u8],
    uploaded_by: ObjectId,
) -> Result<PartFile> {
    let concept_id = concept.id.context("part without id")?;
    if bytes.is_empty() {
        bail!("el archivo está vacío");
    }
    if bytes.len() > MAX_PART_FILE_BYTES {
        bail!("el plano excede el tamaño máximo (40 MB)");
    }
    if !looks_like_pdf(bytes) {
        bail!("el plano debe ser un PDF");
    }
    let file_id = ObjectId::new();
    let storage_key = format!("{}/{}/{}.pdf", concept.company_id.to_hex(), concept_id.to_hex(), file_id.to_hex());
    let path = part_file_store_root().join(&storage_key);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.context("creating the file store folder")?;
    }
    tokio::fs::write(&path, bytes).await.context("writing the drawing")?;

    let name = filename.rsplit(['/', '\\']).next().unwrap_or(filename).trim();
    let file = PartFile {
        id: Some(file_id),
        company_id: concept.company_id,
        project_id: concept.project_id,
        concept_id,
        kind: "drawing".to_string(),
        original_filename: if name.is_empty() { "plano.pdf".to_string() } else { name.to_string() },
        content_type: "application/pdf".to_string(),
        size_bytes: bytes.len() as i64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        storage_key,
        uploaded_by,
        uploaded_at: DateTime::now(),
        deleted_at: None,
    };
    if let Err(err) = state.part_files.insert_one(&file).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(err.into());
    }
    Ok(file)
}

/// Files of the given parts that are not deleted, newest first.
pub async fn list_part_files(
    state: &AppState,
    company_id: &ObjectId,
    concept_ids: &[ObjectId],
) -> Result<Vec<PartFile>> {
    let mut cursor = state
        .part_files
        .find(doc! {
            "company_id": company_id,
            "concept_id": { "$in": concept_ids },
            "deleted_at": { "$exists": false },
        })
        .sort(doc! { "uploaded_at": -1 })
        .await?;
    let mut out = Vec::new();
    while let Some(f) = cursor.try_next().await? {
        out.push(f);
    }
    Ok(out)
}

pub async fn get_part_file(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<Option<PartFile>> {
    Ok(state
        .part_files
        .find_one(doc! { "_id": id, "company_id": company_id, "deleted_at": { "$exists": false } })
        .await?)
}

pub async fn read_part_file(file: &PartFile) -> Result<Vec<u8>> {
    tokio::fs::read(part_file_store_root().join(&file.storage_key))
        .await
        .context("reading the drawing")
}

/// Soft delete: the record and bytes stay for audit; the file stops being listed.
pub async fn delete_part_file(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<bool> {
    let res = state
        .part_files
        .update_one(
            doc! { "_id": id, "company_id": company_id, "deleted_at": { "$exists": false } },
            doc! { "$set": { "deleted_at": DateTime::now() } },
        )
        .await?;
    Ok(res.matched_count > 0)
}

#[cfg(test)]
mod tests {
    use super::looks_like_pdf;

    #[test]
    fn pdf_magic() {
        assert!(looks_like_pdf(b"%PDF-1.7\n..."));
        assert!(looks_like_pdf(b"\xef\xbb\xbf%PDF-1.4"));
        assert!(!looks_like_pdf(b"PK\x03\x04 zip"));
        assert!(!looks_like_pdf(b""));
    }
}
