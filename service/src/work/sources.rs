//! The sources a Work board can sync with, which ones the owner allows, and
//! how each connects.
//!
//! [`SOURCES`] is the registry: adding a source is one entry here, one
//! provider module and one arm in [`Engine::work_provider`]. Every source
//! starts allowed; the owner turns any of them off (`work.source_update`),
//! and a source that is off is never read or written: no import, no sync,
//! no push.
//!
//! Connections: Jira takes its site URL, the account email and an API token
//! (Cloud), or a personal access token (Server/Data Center). Linear takes a
//! personal API key; GitHub uses the `gh` login, or a pasted token (and an
//! optional GitHub Enterprise API URL). Pasted keys are sealed on disk in
//! the board's data folder, never stored in SQLite and never echoed back.

use std::path::PathBuf;

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::github::GithubProvider;
use super::linear::LinearProvider;
use super::provider::{JiraProvider, WorkProvider};
use super::{reject_unknown, required, str_field};
use crate::integrations::seal;
use crate::protocol::RpcError;
use crate::{Engine, error};

#[derive(Debug)]
pub(crate) struct SourceInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// What the source calls a board and a sprint, for the UI and CLI.
    pub board_term: &'static str,
    /// The plural, for lists ("boards", "teams", "projects and
    /// repositories").
    pub boards_term: &'static str,
    pub sprint_term: &'static str,
    /// `jira_token` (site + email + API token), `api_key`, or `gh_or_token`.
    pub connect: &'static str,
    /// Where the owner creates a key or token.
    pub help_url: Option<&'static str>,
}

pub(crate) const SOURCES: &[SourceInfo] = &[
    SourceInfo {
        id: "jira",
        name: "Jira",
        board_term: "board",
        boards_term: "boards",
        sprint_term: "sprint",
        connect: "jira_token",
        help_url: Some("https://id.atlassian.com/manage-profile/security/api-tokens"),
    },
    SourceInfo {
        id: "linear",
        name: "Linear",
        board_term: "team",
        boards_term: "teams",
        sprint_term: "cycle",
        connect: "api_key",
        help_url: Some("https://linear.app/settings/account/security"),
    },
    SourceInfo {
        id: "github",
        name: "GitHub",
        board_term: "project or repository",
        boards_term: "projects and repositories",
        sprint_term: "iteration",
        connect: "gh_or_token",
        help_url: Some(
            "https://github.com/settings/tokens/new?scopes=repo,project&description=Orca%20Work%20board",
        ),
    },
];

pub(crate) fn source_info(id: &str) -> Result<&'static SourceInfo, RpcError> {
    SOURCES.iter().find(|s| s.id == id).ok_or_else(|| {
        error::invalid_argument(format!(
            "unknown ticket source {id}; known: {}",
            SOURCES.iter().map(|s| s.id).collect::<Vec<_>>().join(", ")
        ))
    })
}

#[derive(Default)]
struct SourceRow {
    enabled: bool,
    api_url: Option<String>,
    site_url: Option<String>,
    account: Option<String>,
}

fn read_row(conn: &rusqlite::Connection, id: &str) -> Result<SourceRow, RpcError> {
    Ok(conn
        .query_row(
            "SELECT enabled, api_url, site_url, account FROM work_sources WHERE provider = ?1",
            params![id],
            |r| {
                Ok(SourceRow {
                    enabled: r.get::<_, i64>(0)? != 0,
                    api_url: r.get(1)?,
                    site_url: r.get(2)?,
                    account: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(error::from_sqlite)?
        // Every source starts allowed.
        .unwrap_or(SourceRow {
            enabled: true,
            ..SourceRow::default()
        }))
}

fn write_row(conn: &rusqlite::Connection, id: &str, row: &SourceRow) -> Result<(), RpcError> {
    conn.execute(
        "INSERT INTO work_sources (provider, enabled, api_url, site_url, account, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, api_url = excluded.api_url,
           site_url = excluded.site_url, account = excluded.account, updated_at = excluded.updated_at",
        params![id, row.enabled as i64, row.api_url, row.site_url, row.account, crate::now_unix_ms() as i64],
    )
    .map_err(error::from_sqlite)?;
    Ok(())
}

/// A resolved connection to Linear or GitHub.
pub(crate) struct Connection {
    pub token: String,
    pub api_url: Option<String>,
    pub site_url: Option<String>,
    pub account: Option<String>,
    /// `token` (pasted, sealed) or `gh` (the gh login, read each time).
    pub via: &'static str,
}

/// The `gh` login's token, when gh is installed and signed in.
fn gh_token() -> Option<String> {
    let output = std::process::Command::new(crate::engine::gh_bin())
        .args(["auth", "token"])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !token.is_empty()).then_some(token)
}

impl Engine {
    pub(crate) fn sources_dir(&self) -> PathBuf {
        self.data_dir.join("integrations").join("work")
    }

    fn token_path(&self, id: &str) -> PathBuf {
        self.sources_dir().join(format!("{id}.token"))
    }

    fn read_token(&self, id: &str, name: &str) -> Result<Option<String>, RpcError> {
        let Ok(raw) = std::fs::read(self.token_path(id)) else {
            return Ok(None);
        };
        let key = seal::load_or_create_key(&self.sources_dir()).map_err(error::internal_error)?;
        seal::open_token(&key, &raw, name).map_err(|e| RpcError::new("credential_unreadable", e.0))
    }

    fn write_token(&self, id: &str, token: &str) -> Result<(), RpcError> {
        std::fs::create_dir_all(self.sources_dir())
            .map_err(|e| error::internal_error(e.to_string()))?;
        let key = seal::load_or_create_key(&self.sources_dir()).map_err(error::internal_error)?;
        seal::write_file_600(&self.token_path(id), &seal::seal_token(&key, token))
            .map_err(error::internal_error)
    }

    pub(crate) fn source_enabled(&self, id: &str) -> bool {
        let conn = self.db.lock().unwrap();
        read_row(&conn, id).map(|r| r.enabled).unwrap_or(true)
    }

    fn source_connection(&self, id: &str) -> Result<Option<Connection>, RpcError> {
        let info = source_info(id)?;
        let row = {
            let conn = self.db.lock().unwrap();
            read_row(&conn, id)?
        };
        if let Some(token) = self.read_token(id, info.name)? {
            return Ok(Some(Connection {
                token,
                api_url: row.api_url,
                site_url: row.site_url,
                account: row.account,
                via: "token",
            }));
        }
        if id == "github"
            && let Some(token) = gh_token()
        {
            return Ok(Some(Connection {
                token,
                api_url: row.api_url,
                site_url: row.site_url,
                account: row.account,
                via: "gh",
            }));
        }
        Ok(None)
    }

    /// The provider for a source, refusing a source that is turned off or
    /// not connected (in words that say where to fix it). `site` selects a
    /// Jira site; the other sources have one account each.
    pub(crate) fn work_provider(
        &self,
        kind: &str,
        site: Option<&str>,
    ) -> Result<Box<dyn WorkProvider + '_>, RpcError> {
        let info = source_info(kind)?;
        if !self.source_enabled(kind) {
            return Err(RpcError::new(
                "source_disabled",
                format!(
                    "{} is turned off for Work; turn it on in Work → Sources",
                    info.name
                ),
            ));
        }
        match kind {
            "jira" => Ok(Box::new(
                JiraProvider::new(&self.jira, site).map_err(RpcError::from)?,
            )),
            "linear" => {
                let c = self.source_connection(kind)?.ok_or_else(|| {
                    RpcError::new(
                        "linear_not_connected",
                        "Linear is not connected. Connect it in Work → Sources with a Linear API key.",
                    )
                })?;
                Ok(Box::new(LinearProvider::new(
                    c.token, c.api_url, c.site_url,
                )))
            }
            "github" => {
                let c = self.source_connection(kind)?.ok_or_else(|| {
                    RpcError::new(
                        "github_not_connected",
                        "GitHub is not connected. Sign in with `gh auth login`, or connect a token in Work → Sources.",
                    )
                })?;
                Ok(Box::new(GithubProvider::new(c.token, c.api_url)))
            }
            other => Err(error::invalid_argument(format!("no provider for {other}"))),
        }
    }

    fn source_json(&self, info: &SourceInfo) -> Result<Value, RpcError> {
        let (row, boards) = {
            let conn = self.db.lock().unwrap();
            let boards: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM work_boards WHERE provider = ?1",
                    params![info.id],
                    |r| r.get(0),
                )
                .map_err(error::from_sqlite)?;
            (read_row(&conn, info.id)?, boards)
        };
        let (connected, account, via, problem) = match info.id {
            "jira" => match crate::jira::ops::first_client(&self.jira, None) {
                Ok(Some(client)) => (
                    true,
                    Some(
                        client
                            .site
                            .site_url
                            .trim_start_matches("https://")
                            .trim_start_matches("http://")
                            .to_string(),
                    ),
                    Some("token"),
                    None,
                ),
                Ok(None) => (false, None, None, None),
                Err(e) => (false, None, None, Some(e.message)),
            },
            _ => match self.source_connection(info.id) {
                Ok(Some(c)) => (true, c.account, Some(c.via), None),
                Ok(None) => (false, None, None, None),
                Err(e) => (false, None, None, Some(e.message)),
            },
        };
        Ok(json!({
            "id": info.id,
            "name": info.name,
            "enabled": row.enabled,
            "connected": connected,
            "account": account,
            "via": via,
            "apiUrl": row.api_url,
            "error": problem,
            "boardTerm": info.board_term,
            "boardsTerm": info.boards_term,
            "sprintTerm": info.sprint_term,
            "connect": info.connect,
            "helpUrl": info.help_url,
            "boards": boards,
        }))
    }

    /// `work.sources`: every source, allowed or not, and its connection.
    pub(crate) fn work_sources(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &[])?;
        let sources = SOURCES
            .iter()
            .map(|s| self.source_json(s))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({ "sources": sources }))
    }

    /// `work.source_update`: allow or turn off a source.
    pub(crate) fn do_work_source_update(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["provider", "enabled"])?;
        let info = source_info(&required(params, "provider")?)?;
        let enabled = super::bool_field(params, "enabled")?
            .ok_or_else(|| error::invalid_argument("enabled is required"))?;
        {
            let conn = self.db.lock().unwrap();
            let mut row = read_row(&conn, info.id)?;
            row.enabled = enabled;
            write_row(&conn, info.id, &row)?;
        }
        self.source_json(info)
    }

    /// `work.source_connect`: validates a Linear API key or a GitHub token
    /// (or the gh login when none is given) against the service, then keeps
    /// it sealed. Not routed through the mutation ledger: the key must
    /// never be recorded.
    pub(crate) fn work_source_connect(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(
            params,
            &[
                "provider", "apiKey", "apiUrl", "siteUrl", "email", "authType",
            ],
        )?;
        let info = source_info(&required(params, "provider")?)?;
        let key = str_field(params, "apiKey")?
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned);
        let api_url = str_field(params, "apiUrl")?
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(|u| super::validate_url(u, "apiUrl"))
            .transpose()?;
        let (token, account, site_url, pasted) = match info.id {
            "jira" => {
                let site_url = str_field(params, "siteUrl")?
                    .map(str::trim)
                    .filter(|u| !u.is_empty())
                    .ok_or_else(|| error::invalid_argument("siteUrl is required: your Jira address, e.g. https://acme.atlassian.net"))?;
                let auth_type = match str_field(params, "authType")? {
                    None | Some("cloud") => crate::protocol::jira::JiraAuthType::Cloud,
                    Some("server") => crate::protocol::jira::JiraAuthType::Server,
                    Some(_) => {
                        return Err(error::invalid_argument(
                            "authType must be \"cloud\" or \"server\"",
                        ));
                    }
                };
                let viewer = crate::jira::ops::connect(
                    &self.jira,
                    &crate::protocol::jira::JiraConnectParams {
                        site_url: site_url.to_string(),
                        email: str_field(params, "email")?.unwrap_or("").to_string(),
                        api_token: key.clone().unwrap_or_default(),
                        auth_type: Some(auth_type),
                    },
                )?;
                let _ = viewer;
                return self.source_json(info);
            }
            "linear" => {
                let key = key.ok_or_else(|| error::invalid_argument("apiKey is required: create a personal API key in Linear → Settings → Security & access"))?;
                let (name, org, url_key) = LinearProvider::new(key.clone(), api_url.clone(), None)
                    .viewer()
                    .map_err(RpcError::from)?;
                let account = if org.is_empty() {
                    name
                } else {
                    format!("{name} · {org}")
                };
                (
                    key,
                    account,
                    Some(format!("https://linear.app/{url_key}")),
                    true,
                )
            }
            "github" => {
                let (token, pasted) = match key {
                    Some(k) => (k, true),
                    None => (
                        gh_token().ok_or_else(|| {
                            RpcError::new(
                                "github_not_connected",
                                "No GitHub login: paste a token, or run `gh auth login` and connect again",
                            )
                        })?,
                        false,
                    ),
                };
                let login = GithubProvider::new(token.clone(), api_url.clone())
                    .viewer()
                    .map_err(RpcError::from)?;
                (token, login, None, pasted)
            }
            other => {
                return Err(error::invalid_argument(format!(
                    "{other} cannot be connected here"
                )));
            }
        };
        if pasted {
            self.write_token(info.id, &token)?;
        } else {
            let _ = std::fs::remove_file(self.token_path(info.id));
        }
        {
            let conn = self.db.lock().unwrap();
            let mut row = read_row(&conn, info.id)?;
            row.api_url = api_url;
            row.site_url = site_url;
            row.account = Some(account);
            write_row(&conn, info.id, &row)?;
        }
        self.source_json(info)
    }

    /// `work.source_disconnect`: forgets a pasted key (the gh login itself
    /// is left alone). Imported boards stay; they sync again on reconnect.
    pub(crate) fn do_work_source_disconnect(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["provider"])?;
        let info = source_info(&required(params, "provider")?)?;
        if info.id == "jira" {
            crate::jira::ops::disconnect(&self.jira, None);
            return self.source_json(info);
        }
        let _ = std::fs::remove_file(self.token_path(info.id));
        {
            let conn = self.db.lock().unwrap();
            let mut row = read_row(&conn, info.id)?;
            row.api_url = None;
            row.site_url = None;
            row.account = None;
            write_row(&conn, info.id, &row)?;
        }
        self.source_json(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_names_every_source_once() {
        let ids: Vec<&str> = SOURCES.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["jira", "linear", "github"]);
        assert!(
            source_info("gitlab")
                .unwrap_err()
                .message
                .contains("known: jira, linear, github")
        );
        assert_eq!(source_info("linear").unwrap().sprint_term, "cycle");
    }
}
