use anyhow::{Context, Result, bail};
use data_encoding::{BASE32_NOPAD, HEXLOWER};
use mongodb::bson::{DateTime, doc, oid::ObjectId};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};
use subtle::ConstantTimeEq;

use crate::models::ApiToken;

use super::{AppState, UserWithCompany, get_user_by_id};

const TOKEN_PREFIX: &str = "spat";

pub async fn create_api_token(
    state: &AppState,
    user_id: &ObjectId,
    name: &str,
    expires_in_days: u32,
) -> Result<(ApiToken, String)> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        bail!("token name must be between 1 and 80 characters");
    }
    if !(1..=365).contains(&expires_in_days) {
        bail!("token expiration must be between 1 and 365 days");
    }

    let mut id_bytes = [0_u8; 10];
    let mut secret_bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut id_bytes);
    rand::rng().fill_bytes(&mut secret_bytes);
    let public_id = BASE32_NOPAD.encode(&id_bytes).to_lowercase();
    let secret = BASE32_NOPAD.encode(&secret_bytes);
    let plaintext = format!("{TOKEN_PREFIX}_{public_id}_{secret}");
    let now = SystemTime::now();
    let token = ApiToken {
        id: None,
        public_id,
        secret_hash: token_hash(&plaintext),
        token_prefix: plaintext.chars().take(18).collect(),
        user_id: *user_id,
        name: name.to_string(),
        created_at: DateTime::from_system_time(now),
        expires_at: DateTime::from_system_time(
            now + Duration::from_secs(u64::from(expires_in_days) * 86_400),
        ),
        last_used_at: None,
        revoked_at: None,
    };
    let result = state.api_tokens.insert_one(token.clone()).await?;
    let mut token = token;
    token.id = result.inserted_id.as_object_id();
    Ok((token, plaintext))
}

pub async fn list_api_tokens(state: &AppState, user_id: &ObjectId) -> Result<Vec<ApiToken>> {
    use futures::stream::TryStreamExt;
    let mut cursor = state.api_tokens.find(doc! { "user_id": user_id }).await?;
    let mut tokens = Vec::new();
    while let Some(token) = cursor.try_next().await? {
        tokens.push(token);
    }
    tokens.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(tokens)
}

pub async fn revoke_api_token(
    state: &AppState,
    user_id: &ObjectId,
    token_id: &ObjectId,
) -> Result<bool> {
    let result = state
        .api_tokens
        .update_one(
            doc! { "_id": token_id, "user_id": user_id, "revoked_at": null },
            doc! { "$set": { "revoked_at": DateTime::now() } },
        )
        .await?;
    Ok(result.modified_count == 1)
}

pub async fn find_user_by_api_token(
    state: &AppState,
    plaintext: &str,
) -> Result<Option<UserWithCompany>> {
    let Some(public_id) = token_public_id(plaintext) else {
        return Ok(None);
    };
    let Some(token) = state
        .api_tokens
        .find_one(doc! { "public_id": public_id })
        .await?
    else {
        return Ok(None);
    };
    if token.revoked_at.is_some() || token.expires_at.to_system_time() <= SystemTime::now() {
        return Ok(None);
    }

    let expected = HEXLOWER
        .decode(token.secret_hash.as_bytes())
        .context("stored personal access token hash is invalid")?;
    let actual = Sha256::digest(plaintext.as_bytes());
    if expected.len() != actual.len() || expected.ct_eq(actual.as_slice()).unwrap_u8() != 1 {
        return Ok(None);
    }

    if let Some(id) = token.id {
        let _ = state
            .api_tokens
            .update_one(
                doc! { "_id": id },
                doc! { "$set": { "last_used_at": DateTime::now() } },
            )
            .await;
    }
    get_user_by_id(state, &token.user_id).await
}

fn token_hash(token: &str) -> String {
    HEXLOWER.encode(&Sha256::digest(token.as_bytes()))
}

fn token_public_id(token: &str) -> Option<&str> {
    let mut parts = token.split('_');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(TOKEN_PREFIX), Some(public_id), Some(secret), None)
            if public_id.len() == 16 && secret.len() == 52 =>
        {
            Some(public_id)
        }
        _ => None,
    }
}
