//! Jira site + token file store (R17-A), ported from the fork's
//! `src/main/jira/site-credential-store.ts`.
//!
//! Layout under the daemon data dir (NEVER `~/.orca`):
//! `<data-dir>/integrations/jira/sites.json` (version, activeSiteId,
//! selectedSiteId, sites[]) and `<data-dir>/integrations/jira/tokens/
//! <base64url(siteId)>.enc`, one encrypted API token per site
//! ([`super::seal`]). Missing or corrupt site files read back as an empty
//! store — the fork's error surface; per-site decryption failures are
//! recorded in `credential_errors` so `jira.status` can explain a failing
//! read without re-touching the token files.
//! MIT Copyright (c) 2026 Lovecast Inc.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::seal::{self, CredentialDecryptionError};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraSiteFile {
    pub version: u32,
    pub active_site_id: Option<String>,
    pub selected_site_id: Option<String>,
    pub sites: Vec<JiraSiteRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraSiteRecord {
    pub id: String,
    pub site_url: String,
    pub email: String,
    pub display_name: String,
    pub account_id: String,
    #[serde(default)]
    pub auth_type: crate::protocol::jira::JiraAuthType,
}

impl From<&JiraSiteRecord> for crate::protocol::jira::JiraSite {
    fn from(site: &JiraSiteRecord) -> Self {
        crate::protocol::jira::JiraSite {
            id: site.id.clone(),
            site_url: site.site_url.clone(),
            email: site.email.clone(),
            display_name: site.display_name.clone(),
            account_id: site.account_id.clone(),
            auth_type: site.auth_type,
        }
    }
}

/// Site-selection value the fork calls `JiraSiteSelection`: a site id or
/// the literal `all` fan-out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SiteSelection {
    All,
    Site(String),
}

fn empty_site_file() -> JiraSiteFile {
    JiraSiteFile {
        version: 1,
        active_site_id: None,
        selected_site_id: None,
        sites: Vec::new(),
    }
}

/// Normalize one untrusted entry of a parsed site file; returns `None` for
/// anything missing a required string field (the fork's `normalizeSite`).
fn normalize_site(value: &Value) -> Option<JiraSiteRecord> {
    let record = value.as_object()?;
    let string = |key: &str| record.get(key).and_then(Value::as_str);
    let auth_type = match record.get("authType").and_then(Value::as_str) {
        Some("server") => crate::protocol::jira::JiraAuthType::Server,
        _ => crate::protocol::jira::JiraAuthType::Cloud,
    };
    Some(JiraSiteRecord {
        id: string("id")?.to_string(),
        site_url: string("siteUrl")?.to_string(),
        email: string("email")?.to_string(),
        display_name: string("displayName")?.to_string(),
        account_id: string("accountId")?.to_string(),
        auth_type,
    })
}

/// Per-Engine Jira persistence state. One instance lives on `Engine`.
pub struct SiteStore {
    jira_dir: PathBuf,
    /// Why: under an `all` selection one un-decryptable site must not
    /// collapse reads for the healthy ones (the fork's client.ts comment);
    /// decrypt failures are recorded here so `jira.status` can surface the
    /// message without re-reading the token file on every status poll.
    credential_errors: Mutex<HashMap<String, String>>,
}

impl SiteStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            jira_dir: data_dir.join("integrations").join("jira"),
            credential_errors: Mutex::new(HashMap::new()),
        }
    }

    fn site_file_path(&self) -> PathBuf {
        self.jira_dir.join("sites.json")
    }

    fn token_dir(&self) -> PathBuf {
        self.jira_dir.join("tokens")
    }

    fn token_path(&self, site_id: &str) -> PathBuf {
        self.token_dir().join(format!(
            "{}.enc",
            URL_SAFE_NO_PAD.encode(site_id.as_bytes())
        ))
    }

    /// The fork keys tokens by base64url(siteId) and stores them under
    /// `~/.orca/jira-tokens`; Drogon keeps the same filename scheme under
    /// the daemon data dir.
    pub fn read_site_file(&self) -> JiraSiteFile {
        let path = self.site_file_path();
        let Ok(text) = std::fs::read_to_string(&path) else {
            return empty_site_file();
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            return empty_site_file();
        };
        let sites: Vec<JiraSiteRecord> = parsed
            .get("sites")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(normalize_site)
                    .filter(|site| self.has_stored_token(&site.id))
                    .collect()
            })
            .unwrap_or_default();
        let active_site_id = parsed
            .get("activeSiteId")
            .and_then(Value::as_str)
            .filter(|id| sites.iter().any(|site| site.id == *id))
            .map(str::to_string)
            .or_else(|| sites.first().map(|site| site.id.clone()));
        let selected_site_id = match parsed.get("selectedSiteId").and_then(Value::as_str) {
            Some("all") => Some("all".to_string()),
            Some(id) if sites.iter().any(|site| site.id == id) => Some(id.to_string()),
            _ => active_site_id.clone(),
        };
        JiraSiteFile {
            version: 1,
            active_site_id,
            selected_site_id,
            sites,
        }
    }

    pub fn write_site_file(&self, file: &JiraSiteFile) -> Result<(), String> {
        std::fs::create_dir_all(&self.jira_dir)
            .map_err(|e| format!("cannot create jira dir: {e}"))?;
        let sites: Vec<JiraSiteRecord> = file
            .sites
            .iter()
            .filter(|site| self.has_stored_token(&site.id))
            .cloned()
            .collect();
        let active_site_id = file
            .active_site_id
            .clone()
            .filter(|id| sites.iter().any(|site| site.id == *id))
            .or_else(|| sites.first().map(|site| site.id.clone()));
        let selected_site_id = match file.selected_site_id.as_deref() {
            Some("all") => Some("all".to_string()),
            Some(id) if sites.iter().any(|site| site.id == id) => Some(id.to_string()),
            _ => active_site_id.clone(),
        };
        let normalized = JiraSiteFile {
            version: 1,
            active_site_id,
            selected_site_id,
            sites,
        };
        let text = serde_json::to_string_pretty(&normalized)
            .map_err(|e| format!("cannot encode jira sites file: {e}"))?;
        seal::write_file_600(&self.site_file_path(), text.as_bytes())
    }

    /// A token file counts as a saved credential only when non-empty (the
    /// fork's `credentialFileHasContent`, against split-brain status). The
    /// fork also consults a process-wide token cache because keychain
    /// decryption may prompt; Drogon's file seal never prompts, so the
    /// file is the single source of truth and tampering is observable.
    pub fn has_stored_token(&self, site_id: &str) -> bool {
        std::fs::metadata(self.token_path(site_id))
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
    }

    fn seal_key(&self) -> Result<[u8; 32], String> {
        seal::load_or_create_key(&self.jira_dir)
    }

    /// Read a site's token. `Ok(None)` = no usable token; decryption
    /// failures are recorded in `credential_errors` and returned as
    /// `Err(CredentialDecryptionError)` — the caller decides whether the
    /// selection policy downgrades it (the `all` fan-out) or surfaces it.
    pub fn read_token(&self, site_id: &str) -> Result<Option<String>, CredentialDecryptionError> {
        let path = self.token_path(site_id);
        let Ok(raw) = std::fs::read(&path) else {
            return Ok(None);
        };
        let key = self.seal_key().map_err(CredentialDecryptionError)?;
        match seal::open_token(&key, &raw) {
            Ok(token) => {
                self.credential_errors.lock().unwrap().remove(site_id);
                Ok(token)
            }
            Err(error) => {
                self.credential_errors
                    .lock()
                    .unwrap()
                    .insert(site_id.to_string(), error.0.clone());
                Err(error)
            }
        }
    }

    pub fn save_token(&self, site_id: &str, token: &str) -> Result<(), String> {
        std::fs::create_dir_all(self.token_dir())
            .map_err(|e| format!("cannot create jira token dir: {e}"))?;
        let key = self.seal_key()?;
        let sealed = seal::seal_token(&key, token);
        seal::write_file_600(&self.token_path(site_id), &sealed)?;
        self.credential_errors.lock().unwrap().remove(site_id);
        Ok(())
    }

    pub fn delete_token(&self, site_id: &str) {
        self.credential_errors.lock().unwrap().remove(site_id);
        let _ = std::fs::remove_file(self.token_path(site_id));
    }

    /// The recorded decrypt failure for a site, if any.
    pub fn credential_error(&self, site_id: &str) -> Option<String> {
        self.credential_errors.lock().unwrap().get(site_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_site_file_reads_as_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = SiteStore::new(dir.path());
        let file = store.read_site_file();
        assert_eq!(file.version, 1);
        assert!(file.sites.is_empty());
        assert_eq!(file.active_site_id, None);
    }

    #[test]
    fn corrupt_site_file_reads_as_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = SiteStore::new(dir.path());
        std::fs::create_dir_all(&store.jira_dir).unwrap();
        std::fs::write(store.site_file_path(), "{not json").unwrap();
        assert!(store.read_site_file().sites.is_empty());
    }

    #[test]
    fn token_round_trips_sealed_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = SiteStore::new(dir.path());
        store.save_token("site-1", "tok").unwrap();
        drop(store);
        let store = SiteStore::new(dir.path());
        assert_eq!(store.read_token("site-1").unwrap().as_deref(), Some("tok"));
        assert!(store.has_stored_token("site-1"));
        assert_eq!(store.credential_error("site-1"), None);
    }

    #[test]
    fn tampered_token_records_a_per_site_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = SiteStore::new(dir.path());
        store.save_token("site-1", "tok").unwrap();
        let path = store.token_path("site-1");
        let mut raw = std::fs::read(&path).unwrap();
        raw[10] ^= 0x01;
        std::fs::write(&path, raw).unwrap();
        let error = store.read_token("site-1").unwrap_err();
        assert!(error.0.contains("could not be decrypted"));
        assert_eq!(store.credential_error("site-1"), Some(error.0));
        // Status can explain the failure without re-touching the store:
        // the recorded error is returned directly.
        assert!(store.credential_error("site-1").is_some());
    }

    #[test]
    fn write_filters_sites_without_tokens_and_repairs_selection() {
        let dir = tempfile::tempdir().unwrap();
        let store = SiteStore::new(dir.path());
        store.save_token("keep", "t").unwrap();
        let file = JiraSiteFile {
            version: 1,
            active_site_id: Some("gone".to_string()),
            selected_site_id: Some("gone".to_string()),
            sites: vec![
                JiraSiteRecord {
                    id: "gone".to_string(),
                    site_url: "https://gone".to_string(),
                    email: String::new(),
                    display_name: String::new(),
                    account_id: String::new(),
                    auth_type: crate::protocol::jira::JiraAuthType::Cloud,
                },
                JiraSiteRecord {
                    id: "keep".to_string(),
                    site_url: "https://keep".to_string(),
                    email: "e".to_string(),
                    display_name: "K".to_string(),
                    account_id: "a".to_string(),
                    auth_type: crate::protocol::jira::JiraAuthType::Cloud,
                },
            ],
        };
        store.write_site_file(&file).unwrap();
        let read = store.read_site_file();
        assert_eq!(read.sites.len(), 1);
        assert_eq!(read.active_site_id.as_deref(), Some("keep"));
        assert_eq!(read.selected_site_id.as_deref(), Some("keep"));
    }
}
