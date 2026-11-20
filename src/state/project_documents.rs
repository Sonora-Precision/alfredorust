//! PDFs kept with a project (purchase order, quote, other). Same disk store as the part
//! drawings, under `{company}/projects/{project}/`; Mongo keeps the metadata.

use anyhow::{Context, Result, bail};
use futures::stream::TryStreamExt;
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use sha2::{Digest, Sha256};

use crate::models::{Project, ProjectDocument};

use super::{AppState, MAX_PART_FILE_BYTES, looks_like_pdf, part_file_store_root};

pub const PROJECT_DOCUMENT_KINDS: [&str; 5] = ["orden_compra", "cotizacion", "otro", KIND_PREVIEW, KIND_ASSEMBLY];

/// The main assembly at a glance in the projects list (Daniel, 2026-11-19): a small image
/// (PNG/JPG, usually the isometric view cut from the customer's drawing) and the assembly
/// drawing PDF shown large on hover. One of each per project: a new upload replaces the old.
/// No prices, so anyone who sees projects sees them.
pub const KIND_PREVIEW: &str = "vista_previa";
pub const KIND_ASSEMBLY: &str = "plano_ensamble";
pub const MAX_PREVIEW_BYTES: usize = 5 * 1024 * 1024;

pub fn is_visual_kind(kind: &str) -> bool {
    kind == KIND_PREVIEW || kind == KIND_ASSEMBLY
}

/// "png" or "jpg" when the bytes are one of those images.
pub fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else {
        None
    }
}

/// The preview image and assembly drawing of a project (document ids), newest of each.
#[derive(Debug, Default, Clone)]
pub struct ProjectVisuals {
    pub preview: Option<ObjectId>,
    pub assembly: Option<ObjectId>,
}

/// Visuals per project: of every project of the company, or only of `project_id`.
pub async fn project_visuals(
    state: &AppState,
    company_id: &ObjectId,
    project_id: Option<&ObjectId>,
) -> Result<std::collections::HashMap<ObjectId, ProjectVisuals>> {
    let mut filter = doc! {
        "company_id": company_id,
        "kind": { "$in": [KIND_PREVIEW, KIND_ASSEMBLY] },
        "deleted_at": { "$exists": false },
    };
    if let Some(p) = project_id {
        filter.insert("project_id", p);
    }
    let mut cursor = state.project_documents.find(filter).sort(doc! { "uploaded_at": -1 }).await?;
    let mut out: std::collections::HashMap<ObjectId, ProjectVisuals> = std::collections::HashMap::new();
    while let Some(d) = cursor.try_next().await? {
        let entry = out.entry(d.project_id).or_default();
        let slot = if d.kind == KIND_PREVIEW { &mut entry.preview } else { &mut entry.assembly };
        if slot.is_none() {
            *slot = d.id;
        }
    }
    Ok(out)
}

/// Stores a PDF for the project and returns its record.
pub async fn save_project_document(
    state: &AppState,
    project: &Project,
    kind: &str,
    filename: &str,
    bytes: &[u8],
    uploaded_by: ObjectId,
) -> Result<ProjectDocument> {
    let project_id = project.id.context("project without id")?;
    if !PROJECT_DOCUMENT_KINDS.contains(&kind) {
        bail!("tipo de documento no válido");
    }
    if bytes.is_empty() {
        bail!("el archivo está vacío");
    }
    if bytes.len() > MAX_PART_FILE_BYTES {
        bail!("el archivo excede el tamaño máximo (40 MB)");
    }
    let ext = if kind == KIND_PREVIEW {
        if bytes.len() > MAX_PREVIEW_BYTES {
            bail!("la vista previa excede el tamaño máximo (5 MB)");
        }
        image_extension(bytes).context("la vista previa debe ser una imagen PNG o JPG")?
    } else if looks_like_pdf(bytes) {
        "pdf"
    } else {
        bail!("el documento debe ser un PDF");
    };
    let file_id = ObjectId::new();
    let storage_key = format!(
        "{}/projects/{}/{}.{ext}",
        project.company_id.to_hex(),
        project_id.to_hex(),
        file_id.to_hex()
    );
    let path = part_file_store_root().join(&storage_key);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.context("creating the file store folder")?;
    }
    tokio::fs::write(&path, bytes).await.context("writing the document")?;

    let name = filename.rsplit(['/', '\\']).next().unwrap_or(filename).trim();
    let doc = ProjectDocument {
        id: Some(file_id),
        company_id: project.company_id,
        project_id,
        kind: kind.to_string(),
        original_filename: if name.is_empty() { format!("documento.{ext}") } else { name.to_string() },
        size_bytes: bytes.len() as i64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        storage_key,
        uploaded_by,
        uploaded_at: DateTime::now(),
        deleted_at: None,
    };
    if let Err(err) = state.project_documents.insert_one(&doc).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(err.into());
    }
    // One preview and one assembly drawing per project: the new one replaces the old.
    if is_visual_kind(kind) {
        let _ = state
            .project_documents
            .update_many(
                doc! {
                    "company_id": project.company_id,
                    "project_id": project_id,
                    "kind": kind,
                    "_id": { "$ne": file_id },
                    "deleted_at": { "$exists": false },
                },
                doc! { "$set": { "deleted_at": DateTime::now() } },
            )
            .await;
    }
    Ok(doc)
}

/// Documents of a project that are not deleted, newest first.
pub async fn list_project_documents(
    state: &AppState,
    company_id: &ObjectId,
    project_id: &ObjectId,
) -> Result<Vec<ProjectDocument>> {
    let mut cursor = state
        .project_documents
        .find(doc! { "company_id": company_id, "project_id": project_id, "deleted_at": { "$exists": false } })
        .sort(doc! { "uploaded_at": -1 })
        .await?;
    let mut out = Vec::new();
    while let Some(d) = cursor.try_next().await? {
        out.push(d);
    }
    Ok(out)
}

/// Every document of the company that is not deleted, newest first (the projects list).
pub async fn list_company_project_documents(state: &AppState, company_id: &ObjectId) -> Result<Vec<ProjectDocument>> {
    let mut cursor = state
        .project_documents
        .find(doc! { "company_id": company_id, "deleted_at": { "$exists": false } })
        .sort(doc! { "uploaded_at": -1 })
        .await?;
    let mut out = Vec::new();
    while let Some(d) = cursor.try_next().await? {
        out.push(d);
    }
    Ok(out)
}

pub async fn get_project_document(
    state: &AppState,
    company_id: &ObjectId,
    id: &ObjectId,
) -> Result<Option<ProjectDocument>> {
    Ok(state
        .project_documents
        .find_one(doc! { "_id": id, "company_id": company_id, "deleted_at": { "$exists": false } })
        .await?)
}

pub async fn read_project_document(doc: &ProjectDocument) -> Result<Vec<u8>> {
    tokio::fs::read(part_file_store_root().join(&doc.storage_key))
        .await
        .context("reading the document")
}

/// Soft delete: the record and bytes stay for audit; the document stops being listed.
pub async fn delete_project_document(state: &AppState, company_id: &ObjectId, id: &ObjectId) -> Result<bool> {
    let res = state
        .project_documents
        .update_one(
            doc! { "_id": id, "company_id": company_id, "deleted_at": { "$exists": false } },
            doc! { "$set": { "deleted_at": DateTime::now() } },
        )
        .await?;
    Ok(res.matched_count > 0)
}
