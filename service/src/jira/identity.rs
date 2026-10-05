//! Jira site identity helpers (R17-A), ported from the fork's
//! `src/main/jira/site-identity.ts`, plus C06's stable task identity: an
//! explicitly PROVISIONAL endpoint label, a source-backed instance
//! identity tier with provenance, and the immutable issue id that survive
//! reconnects, key/title renames and daemon restarts.
//! MIT Copyright (c) 2026 Lovecast Inc.

use crate::protocol::jira::JiraViewer;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::Digest as _;

/// Domain separation for [`provisional_endpoint_id`], so an endpoint label
/// can never collide with a legacy [`get_site_id`] connection id or any
/// other hash built from the same URL alphabet.
const ENDPOINT_ID_DOMAIN: &[u8] = b"drogon-jira-endpoint-v1";

/// Trim, default to `https://`, keep origin + path without trailing slash,
/// and drop query/fragment — the fork's `normalizeJiraSiteUrl`.
pub fn normalize_jira_site_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Enter a valid Jira site URL.".to_string());
    }
    let with_protocol = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    // Split scheme from the rest.
    let (scheme, rest) = match with_protocol.split_once("://") {
        Some((scheme, rest))
            if scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
                && !scheme.is_empty() =>
        {
            (scheme.to_ascii_lowercase(), rest)
        }
        _ => return Err("Enter a valid Jira site URL.".to_string()),
    };
    if rest.is_empty() {
        return Err("Enter a valid Jira site URL.".to_string());
    }
    // Authority + path, without query/fragment.
    let authority_and_path = rest.split(['?', '#']).next().unwrap_or("");
    let (authority, path) = match authority_and_path.find('/') {
        Some(index) => (&authority_and_path[..index], &authority_and_path[index..]),
        None => (authority_and_path, ""),
    };
    let host = authority.rsplit('@').next().unwrap_or(authority);
    if host.is_empty() {
        return Err("Enter a valid Jira site URL.".to_string());
    }
    let path = path.trim_end_matches('/');
    Ok(format!("{scheme}://{host}{path}"))
}

/// Stable per-(site, account) id: sha256, base64url, first 24 chars — the
/// fork's `getSiteId`.
///
/// C06: this is a CONNECTION id (credential pair), not an instance id — it
/// changes when the same Jira site reconnects with another account. Never
/// use it as proof of which Jira instance an issue belongs to; use
/// [`jira_instance_id`] for that.
pub fn get_site_id(site_url: &str, email: &str) -> String {
    let mut hash = sha2::Sha256::new();
    hash.update(site_url.as_bytes());
    hash.update(b"\n");
    hash.update(email.to_lowercase().as_bytes());
    let digest = hash.finalize();
    URL_SAFE_NO_PAD.encode(digest)[..24].to_string()
}

/// Map a `/myself` response to a viewer. Server/DC has no accountId; its
/// stable identifiers are name/key (the fork's `toViewer`).
pub fn to_viewer(data: &serde_json::Value, fallback_email: &str) -> JiraViewer {
    let avatar_urls = data.get("avatarUrls");
    let pick_avatar = |key: &str| {
        avatar_urls
            .and_then(|urls| urls.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let account_id = data
        .get("accountId")
        .and_then(serde_json::Value::as_str)
        .or_else(|| data.get("name").and_then(serde_json::Value::as_str))
        .or_else(|| data.get("key").and_then(serde_json::Value::as_str))
        .unwrap_or_default()
        .to_string();
    JiraViewer {
        account_id,
        display_name: data
            .get("displayName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(fallback_email)
            .to_string(),
        email: Some(
            data.get("emailAddress")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(fallback_email)
                .to_string(),
        ),
        avatar_url: pick_avatar("48x48").or_else(|| pick_avatar("32x32")),
    }
}

// --- C06: stable task identity -------------------------------------------

/// Stable PROVISIONAL endpoint label: sha256 over a domain-separated,
/// authority-case-folded normalized site URL, base64url, first 24 chars.
///
/// This proves which endpoint was CONFIGURED — never which Jira instance
/// actually answered. Two accounts configuring the same URL get the same
/// label (the authority folds to lowercase), and two different hosts can
/// never share one label, but a label is NOT a verified instance identity:
/// see [`JiraInstanceIdentity::SourceBacked`] for the identity of record.
/// Errs exactly when [`normalize_jira_site_url`] errs.
pub fn provisional_endpoint_id(site_url: &str) -> Result<String, String> {
    let normalized = normalize_jira_site_url(site_url)?;
    // DNS host case is not significant and the fork's normalizer keeps the
    // entered case, so the hash folds the authority to lowercase — the same
    // endpoint typed as ACME.atlassian.net and acme.atlassian.net resolves
    // to ONE label across accounts.
    let (scheme, rest) = normalized
        .split_once("://")
        .unwrap_or(("", normalized.as_str()));
    let (host, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let mut hash = sha2::Sha256::new();
    hash.update(ENDPOINT_ID_DOMAIN);
    hash.update(b"\n");
    hash.update(scheme.as_bytes());
    hash.update(b"://");
    hash.update(host.to_ascii_lowercase().as_bytes());
    hash.update(path.as_bytes());
    let digest = hash.finalize();
    Ok(URL_SAFE_NO_PAD.encode(digest)[..24].to_string())
}

/// Where a source-backed identity claim came from. Only identifiers
/// read from an ACTUAL instance response payload (never from user
/// configuration, never from the credential email) count; producers are
/// deterministic and covered by fixture payloads. Evidence tiers differ:
/// only the Cloud tenant id proves IMMUTABLE installation continuity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceIdentitySource {
    /// Jira Cloud tenant id (`cloudId`) from an accessible-resources-style
    /// response payload, matched to the configured site URL. The tenant id
    /// survives endpoint/domain changes: this is the one source that
    /// proves immutable installation continuity.
    CloudTenantId,
}

impl InstanceIdentitySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CloudTenantId => "cloud-tenant-id",
        }
    }

    /// Namespace prefix so a source-backed key can never collide with (or
    /// be forged by) a provisional endpoint label.
    fn prefix(self) -> &'static str {
        match self {
            Self::CloudTenantId => "cloudid",
        }
    }
}

/// How the Jira instance is KNOWN. A configured URL alone yields only the
/// [`JiraInstanceIdentity::Provisional`] tier. Server-attested endpoint
/// responses yield [`JiraInstanceIdentity::EndpointAttested`] — continuity
/// evidence for the endpoint, explicitly NOT an immutable installation id
/// (a moved endpoint can keep the same installation). Only
/// [`JiraInstanceIdentity::SourceBacked`] with the Cloud tenant id proves
/// immutable installation continuity, and it is the identity of record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JiraInstanceIdentity {
    Provisional {
        endpoint_id: String,
        endpoint_url: String,
    },
    /// The instance's OWN serverInfo-attested base URL: stronger than user
    /// configuration for ENDPOINT continuity, but unresolved for immutable
    /// installation identity — never labeled verified stable identity.
    EndpointAttested {
        attested_url: String,
        observed_at: String,
    },
    SourceBacked {
        instance_key: String,
        source: InstanceIdentitySource,
        endpoint_url: String,
        /// RFC3339 timestamp of the observation (fixture clock in tests).
        observed_at: String,
    },
}

impl JiraInstanceIdentity {
    /// Namespaced composite key for stores: the three tiers live in
    /// DIFFERENT namespaces, so no weaker tier can masquerade as a stronger
    /// one.
    pub fn key(&self) -> String {
        match self {
            Self::Provisional { endpoint_id, .. } => format!("provisional:{endpoint_id}"),
            Self::EndpointAttested { attested_url, .. } => {
                format!("attested:{}", attested_url)
            }
            Self::SourceBacked {
                instance_key,
                source,
                ..
            } => format!("{}:{instance_key}", source.prefix()),
        }
    }

    pub fn endpoint_url(&self) -> &str {
        match self {
            Self::Provisional { endpoint_url, .. }
            | Self::EndpointAttested {
                attested_url: endpoint_url,
                ..
            }
            | Self::SourceBacked { endpoint_url, .. } => endpoint_url,
        }
    }

    pub fn is_source_backed(&self) -> bool {
        matches!(self, Self::SourceBacked { .. })
    }

    /// True ONLY when this identity proves immutable installation
    /// continuity (the Cloud tenant id). Endpoint attestation does not:
    /// a moved endpoint keeps the same installation, so an attested URL
    /// must stay unresolved for immutable-instance continuity.
    pub fn is_immutable_instance_identity(&self) -> bool {
        matches!(
            self,
            Self::SourceBacked {
                source: InstanceIdentitySource::CloudTenantId,
                ..
            }
        )
    }
}

/// Extracts the Cloud tenant id (`cloudId`) for the configured site from an
/// accessible-resources-style payload (an array of `{id, url, ...}`), the
/// deterministic producer for [`InstanceIdentitySource::CloudTenantId`].
/// Pure payload parsing — no network, no credential probing.
pub fn cloud_tenant_id_from_accessible_resources(
    payload: &serde_json::Value,
    site_url: &str,
) -> Option<String> {
    let endpoint = fold_authority_case(&normalize_jira_site_url(site_url).ok()?);
    for entry in payload.as_array()? {
        let id = entry.get("id").and_then(serde_json::Value::as_str)?.trim();
        let url = entry.get("url").and_then(serde_json::Value::as_str)?;
        let entry_url = fold_authority_case(&normalize_jira_site_url(url).ok()?);
        if !id.is_empty() && id.len() <= 128 && entry_url == endpoint {
            return Some(id.to_string());
        }
    }
    None
}

/// Extracts the Server/DC server-attested base URL from a serverInfo
/// payload, the deterministic producer for
/// [`JiraInstanceIdentity::EndpointAttested`]. Returns the normalized,
/// case-folded URL the SERVER attests (which may differ from what the user
/// configured). ATTENTION: this is ENDPOINT continuity evidence only — a
/// moved endpoint can keep the same installation, so it is unresolved for
/// immutable-instance continuity, never verified stable identity. Pure
/// payload parsing.
pub fn server_attested_base_url_from_server_info(payload: &serde_json::Value) -> Option<String> {
    let base_url = payload.get("baseUrl").and_then(serde_json::Value::as_str)?;
    let normalized = normalize_jira_site_url(base_url).ok()?;
    Some(fold_authority_case(&normalized))
}

/// Fold the authority segment of a normalized URL to lowercase (scheme is
/// already lowercase). Path case is significant and preserved.
fn fold_authority_case(normalized: &str) -> String {
    let Some((scheme, rest)) = normalized.split_once("://") else {
        return normalized.to_string();
    };
    match rest.find('/') {
        Some(index) => format!(
            "{scheme}://{}{}",
            rest[..index].to_ascii_lowercase(),
            &rest[index..]
        ),
        None => format!("{scheme}://{}", rest.to_ascii_lowercase()),
    }
}

/// The stable external identity of a Jira task (C06): HOW the instance is
/// known (provisional label vs source-backed identifier) plus the
/// immutable REST issue id. `key` is display-only and may drift; `title`
/// never participates at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraTaskIdentity {
    pub instance: JiraInstanceIdentity,
    /// Immutable Jira REST id (`issues[].id`) — survives key renames and
    /// project moves within the instance.
    pub issue_id: String,
    /// Display key (`DROG-42`), refreshed on every successful bind.
    pub key: String,
}

impl JiraTaskIdentity {
    fn build(instance: JiraInstanceIdentity, issue_id: &str, key: &str) -> Result<Self, String> {
        let issue_id = issue_id.trim();
        if issue_id.is_empty() || issue_id.len() > 64 || issue_id.contains('\0') {
            return Err("Jira issue id is required for a stable task identity".to_string());
        }
        let key = key.trim();
        if key.is_empty() || key.chars().any(|c| c.is_control()) || key.len() > 64 {
            return Err("Jira issue key is required for a stable task identity".to_string());
        }
        Ok(Self {
            instance,
            issue_id: issue_id.to_string(),
            key: key.to_string(),
        })
    }

    /// Resolves the task identity at the PROVISIONAL tier: the endpoint is
    /// known only from configuration, so the identity is explicitly a
    /// provisional binding — never presented as a verified instance. Used
    /// before a source response is available; legacy rows without an
    /// immutable issue id still fail here (unresolved stays unresolved).
    pub fn resolve_provisional(site_url: &str, issue_id: &str, key: &str) -> Result<Self, String> {
        let normalized = normalize_jira_site_url(site_url)?;
        let endpoint_id = provisional_endpoint_id(&normalized)?;
        let instance = JiraInstanceIdentity::Provisional {
            endpoint_id,
            endpoint_url: fold_authority_case(&normalized),
        };
        Self::build(instance, issue_id, key)
    }

    /// Resolves the task identity from a server-attested endpoint URL
    /// (see [`server_attested_base_url_from_server_info`]). ENDPOINT
    /// continuity only: the result is explicitly unresolved for immutable
    /// installation identity — `is_immutable_instance_identity()` is
    /// false — and must never be presented as verified stable identity.
    pub fn resolve_endpoint_attested(
        attested_url: &str,
        observed_at: impl Into<String>,
        issue_id: &str,
        key: &str,
    ) -> Result<Self, String> {
        let normalized = normalize_jira_site_url(attested_url)?;
        let instance = JiraInstanceIdentity::EndpointAttested {
            attested_url: fold_authority_case(&normalized),
            observed_at: observed_at.into(),
        };
        Self::build(instance, issue_id, key)
    }

    /// Resolves the task identity at the SOURCE-BACKED tier — the identity
    /// of record. `identifier` comes from a producer such as
    /// [`cloud_tenant_id_from_accessible_resources`], never from user
    /// configuration. Only the Cloud tenant id proves immutable
    /// installation continuity.
    pub fn resolve_source_backed(
        source: InstanceIdentitySource,
        identifier: &str,
        endpoint_url: &str,
        observed_at: impl Into<String>,
        issue_id: &str,
        key: &str,
    ) -> Result<Self, String> {
        let identifier = identifier.trim();
        if identifier.is_empty() || identifier.len() > 256 {
            return Err("instance identifier is required".to_string());
        }
        let normalized = normalize_jira_site_url(endpoint_url)?;
        let instance = JiraInstanceIdentity::SourceBacked {
            instance_key: identifier.to_string(),
            source,
            endpoint_url: fold_authority_case(&normalized),
            observed_at: observed_at.into(),
        };
        Self::build(instance, issue_id, key)
    }

    /// The provider half of the composite identity; matches the fork's
    /// provider strings so card-property payloads agree.
    pub fn provider() -> &'static str {
        "jira"
    }

    /// Deterministic composite link id, stable across restarts and safe to
    /// log (no URL secrets): `{instance_key}:{issue_id}` where the instance
    /// key is namespaced by identity tier.
    pub fn link_id(&self) -> String {
        format!("{}:{}", self.instance.key(), self.issue_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bare_host() {
        assert_eq!(
            normalize_jira_site_url("example.atlassian.net").unwrap(),
            "https://example.atlassian.net"
        );
    }

    #[test]
    fn keeps_path_and_strips_trailing_slash_query_and_fragment() {
        assert_eq!(
            normalize_jira_site_url("https://jira.example.com/jira/?x=1#y").unwrap(),
            "https://jira.example.com/jira"
        );
        assert_eq!(
            normalize_jira_site_url("http://localhost:2990/jira/").unwrap(),
            "http://localhost:2990/jira"
        );
    }

    #[test]
    fn rejects_empty_and_scheme_only_input() {
        assert!(normalize_jira_site_url("   ").is_err());
        assert!(normalize_jira_site_url("https://").is_err());
        assert!(normalize_jira_site_url("://bad").is_err());
    }

    #[test]
    fn site_id_is_stable_case_insensitive_on_email() {
        assert_eq!(
            get_site_id("https://a", "me@example.com"),
            get_site_id("https://a", "ME@EXAMPLE.COM")
        );
        assert_ne!(
            get_site_id("https://a", "me@example.com"),
            get_site_id("https://a", "other@example.com")
        );
        assert_eq!(get_site_id("https://a", "me@example.com").len(), 24);
    }

    #[test]
    fn viewer_falls_back_to_name_and_email() {
        let viewer = to_viewer(
            &serde_json::json!({"name": "jsmith", "displayName": "J Smith"}),
            "fallback@example.com",
        );
        assert_eq!(viewer.account_id, "jsmith");
        assert_eq!(viewer.display_name, "J Smith");
        assert_eq!(viewer.email.as_deref(), Some("fallback@example.com"));
    }

    #[test]
    fn endpoint_label_is_account_independent_and_distinct_from_connection_id() {
        // Same endpoint, another account: the provisional label survives.
        assert_eq!(
            provisional_endpoint_id("https://acme.atlassian.net").unwrap(),
            provisional_endpoint_id("https://acme.atlassian.net").unwrap()
        );
        let identity_a =
            JiraTaskIdentity::resolve_provisional("https://acme.atlassian.net", "10001", "DROG-42")
                .unwrap();
        let identity_b = JiraTaskIdentity::resolve_provisional(
            "https://ACME.atlassian.net/",
            "10001",
            "DROG-42",
        )
        .unwrap();
        assert_eq!(identity_a, identity_b);
        // A different endpoint never shares the label.
        let other = JiraTaskIdentity::resolve_provisional(
            "https://globex.atlassian.net",
            "10001",
            "DROG-42",
        )
        .unwrap();
        assert_ne!(identity_a.instance.key(), other.instance.key());
        assert_ne!(identity_a.link_id(), other.link_id());
        // Connection id stays email-tainted (legacy semantics preserved).
        assert_ne!(
            get_site_id("https://acme.atlassian.net", "a@x.com"),
            get_site_id("https://acme.atlassian.net", "b@x.com")
        );
        assert_ne!(
            identity_a.instance.key(),
            get_site_id("https://acme.atlassian.net", "a@x.com")
        );
    }

    #[test]
    fn provisional_and_source_backed_tiers_are_namespaced_apart() {
        let provisional =
            JiraTaskIdentity::resolve_provisional("https://acme.atlassian.net", "10001", "DROG-42")
                .unwrap();
        let verified = JiraTaskIdentity::resolve_source_backed(
            InstanceIdentitySource::CloudTenantId,
            "Aa1Bb2Cc3",
            "https://acme.atlassian.net",
            "2026-01-01T00:00:00Z",
            "10001",
            "DROG-42",
        )
        .unwrap();
        assert!(!provisional.instance.is_source_backed());
        assert!(verified.instance.is_source_backed());
        // A configured URL alone NEVER masquerades as the verified tier.
        assert_ne!(provisional.link_id(), verified.link_id());
        assert!(provisional.link_id().starts_with("provisional:"));
        assert!(verified.link_id().starts_with("cloudid:"));
        assert!(matches!(
            verified.instance,
            JiraInstanceIdentity::SourceBacked { ref source, .. } if *source == InstanceIdentitySource::CloudTenantId
        ));
    }

    #[test]
    fn cloud_tenant_id_producer_parses_fixture_payloads() {
        let payload = serde_json::json!([
            {"id": "Aa1Bb2Cc3", "url": "https://acme.atlassian.net", "name": "acme"},
            {"id": "Other1", "url": "https://other.atlassian.net", "name": "other"}
        ]);
        assert_eq!(
            cloud_tenant_id_from_accessible_resources(&payload, "https://acme.atlassian.net")
                .as_deref(),
            Some("Aa1Bb2Cc3")
        );
        // Case-folded matching against the configured endpoint.
        assert_eq!(
            cloud_tenant_id_from_accessible_resources(&payload, "https://ACME.atlassian.net/")
                .as_deref(),
            Some("Aa1Bb2Cc3")
        );
        // No matching entry (a different site) is honest None.
        assert_eq!(
            cloud_tenant_id_from_accessible_resources(&payload, "https://zeta.atlassian.net"),
            None
        );
    }

    #[test]
    fn server_attested_base_url_producer_yields_endpoint_attestation_only() {
        let payload = serde_json::json!({"baseUrl": "https://jira.internal.example.com/", "version": "9.4.0"});
        let attested = server_attested_base_url_from_server_info(&payload);
        assert_eq!(
            attested.as_deref(),
            Some("https://jira.internal.example.com")
        );
        assert_eq!(
            server_attested_base_url_from_server_info(&serde_json::json!({})),
            None
        );
        // Endpoint attestation is a DIFFERENT tier: source-observed, but
        // explicitly unresolved for immutable-instance continuity (a moved
        // endpoint can keep the same installation).
        let identity = JiraTaskIdentity::resolve_endpoint_attested(
            attested.as_deref().unwrap(),
            "2026-01-01T00:00:00Z",
            "10001",
            "DROG-42",
        )
        .unwrap();
        assert!(matches!(
            identity.instance,
            JiraInstanceIdentity::EndpointAttested { .. }
        ));
        assert!(!identity.instance.is_source_backed());
        assert!(!identity.instance.is_immutable_instance_identity());
        assert!(identity.link_id().starts_with("attested:"));
    }

    #[test]
    fn cloud_tenant_id_is_the_immutable_instance_evidence_tier() {
        let verified = JiraTaskIdentity::resolve_source_backed(
            InstanceIdentitySource::CloudTenantId,
            "Aa1Bb2Cc3",
            "https://acme.atlassian.net",
            "2026-01-01T00:00:00Z",
            "10001",
            "DROG-42",
        )
        .unwrap();
        assert!(verified.instance.is_source_backed());
        assert!(verified.instance.is_immutable_instance_identity());
    }

    #[test]
    fn identity_is_unresolved_without_instance_or_immutable_id() {
        assert!(
            JiraTaskIdentity::resolve_provisional("https://acme.atlassian.net", "", "DROG-42")
                .is_err()
        );
        assert!(
            JiraTaskIdentity::resolve_provisional("https://acme.atlassian.net", "  ", "DROG-42")
                .is_err()
        );
        assert!(JiraTaskIdentity::resolve_provisional("", "10001", "DROG-42").is_err());
        assert!(JiraTaskIdentity::resolve_provisional("https://", "10001", "DROG-42").is_err());
        assert!(
            JiraTaskIdentity::resolve_provisional("https://acme.atlassian.net", "10001", "")
                .is_err()
        );
        assert!(
            JiraTaskIdentity::resolve_source_backed(
                InstanceIdentitySource::CloudTenantId,
                "  ",
                "https://acme.atlassian.net",
                "2026-01-01T00:00:00Z",
                "10001",
                "DROG-42",
            )
            .is_err()
        );
        // The display key is NOT an identity input: same instance + id but a
        // renamed key still resolves to the same link id.
        let before =
            JiraTaskIdentity::resolve_provisional("https://acme.atlassian.net", "10001", "DROG-42")
                .unwrap();
        let renamed =
            JiraTaskIdentity::resolve_provisional("https://acme.atlassian.net", "10001", "OPS-9")
                .unwrap();
        assert_eq!(before.link_id(), renamed.link_id());
    }
}
