//! At-rest encryption for integration credentials (P0 secrets store).
//!
//! Generalization of the Jira token seal (`crate::jira::seal`, itself
//! ported from the fork's `src/main/integration-credential-file.ts` and
//! `src/main/jira/site-credential-store.ts`): a random 32-byte key held at
//! `<dir>/.token-key` (0600) seals each credential as
//! `v1.<base64url(nonce || mac || ciphertext)>`. Keystream blocks are
//! HMAC-SHA256(key_enc, nonce || counter); `mac` is HMAC-SHA256 over
//! nonce||ciphertext, so tampering or a wrong key reads back as a
//! decryption error, never as token junk. Legacy/imported plaintext files
//! (printable UTF-8) are still honored, mirroring the fork's legacy read
//! path; binary blobs that are neither sealed nor printable plaintext
//! surface as [`CredentialDecryptionError`].
//!
//! The only generalization over the Jira module is the `service` label on
//! [`open_token`] (error messages name the integration) — the key format,
//! seal format and file discipline are byte-identical, so a store sealed by
//! the Jira module reads back here and vice versa. No new cryptography.
//! MIT Copyright (c) 2026 Lovecast Inc.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use getrandom::fill;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const NONCE_LEN: usize = 16;
const MAC_LEN: usize = 32;
const SEAL_PREFIX: &str = "v1.";

/// Sealing key length in bytes; re-exported by `crate::jira::seal` so its
/// original untouched tests keep compiling against the moved impl.
pub const KEY_LEN: usize = 32;

/// Mirrors the fork's `CredentialDecryptionError`
/// (`src/main/integration-credential-file.ts`): raised when a file holds
/// bytes that cannot be turned back into a usable credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialDecryptionError(pub String);

impl std::fmt::Display for CredentialDecryptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for CredentialDecryptionError {}

/// Mirrors the fork's `credentialDecryptionMessage`.
pub fn credential_decryption_message(service: &str) -> String {
    format!("{service} credential could not be decrypted. Reconnect to store a fresh token.")
}

/// Load (or lazily create) the 32-byte sealing key for an integration dir.
pub fn load_or_create_key(dir: &std::path::Path) -> std::result::Result<[u8; KEY_LEN], String> {
    let key_path = dir.join(".token-key");
    if let Ok(raw) = std::fs::read(&key_path) {
        if raw.len() == KEY_LEN {
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&raw);
            return Ok(key);
        }
        // A wrong-sized key file is treated as corruption: rotate it so the
        // next save reseals every secret, exactly like a keychain re-sign.
        rotate_key(&key_path)?;
    }
    let mut key = [0u8; KEY_LEN];
    fill(&mut key).map_err(|e| format!("cannot generate secret key: {e}"))?;
    write_key(&key_path, &key)?;
    Ok(key)
}

fn rotate_key(key_path: &std::path::Path) -> std::result::Result<(), String> {
    let mut key = [0u8; KEY_LEN];
    fill(&mut key).map_err(|e| format!("cannot rotate secret key: {e}"))?;
    write_key(key_path, &key)
}

fn write_key(key_path: &std::path::Path, key: &[u8; KEY_LEN]) -> std::result::Result<(), String> {
    if let Some(parent) = key_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create integration dir: {e}"))?;
    }
    write_file_600(key_path, key)
}

/// Write `data` to `path` atomically (sibling temp + rename, like the
/// fork's `writeCredentialFileAtomic`) with 0600 permissions.
pub fn write_file_600(path: &std::path::Path, data: &[u8]) -> std::result::Result<(), String> {
    let temp = path.with_extension("tmp");
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&temp)
            .map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
        // Why: a single write may be short; loop like the fork's writeSync.
        file.write_all(data)
            .map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
        file.sync_all()
            .map_err(|e| format!("cannot fsync {}: {e}", temp.display()))?;
    }
    std::fs::rename(&temp, path).map_err(|e| format!("cannot rename temp file: {e}"))?;
    restrict_to_owner(path);
    Ok(())
}

/// Best-effort chmod 0600 (documented no-op where POSIX modes do not apply).
fn restrict_to_owner(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    let _ = path;
}

fn hmac(key: &[u8; KEY_LEN], label: u8, data: &[u8]) -> [u8; MAC_LEN] {
    // Domain separation between keystream blocks and the MAC.
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(&[label]);
    mac.update(data);
    let out = mac.finalize().into_bytes();
    let mut bytes = [0u8; MAC_LEN];
    bytes.copy_from_slice(&out);
    bytes
}

fn keystream_block(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], counter: u32) -> [u8; MAC_LEN] {
    let mut buf = Vec::with_capacity(NONCE_LEN + 4);
    buf.extend_from_slice(nonce);
    buf.extend_from_slice(&counter.to_be_bytes());
    hmac(key, 0x01, &buf)
}

/// Seal a credential: `v1.<base64url(nonce || mac || ciphertext)>`.
pub fn seal_token(key: &[u8; KEY_LEN], token: &str) -> Vec<u8> {
    let plain = token.as_bytes();
    let mut nonce = [0u8; NONCE_LEN];
    fill(&mut nonce).expect("random source for credential nonce");
    let mut ciphertext = Vec::with_capacity(plain.len());
    for (index, byte) in plain.iter().enumerate() {
        let block = keystream_block(key, &nonce, (index / MAC_LEN) as u32);
        ciphertext.push(byte ^ block[index % MAC_LEN]);
    }
    let mut mac_input = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    mac_input.extend_from_slice(&nonce);
    mac_input.extend_from_slice(&ciphertext);
    let mac = hmac(key, 0x02, &mac_input);
    let mut sealed = Vec::with_capacity(NONCE_LEN + MAC_LEN + ciphertext.len());
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&mac);
    sealed.extend_from_slice(&ciphertext);
    format!("{SEAL_PREFIX}{}", URL_SAFE_NO_PAD.encode(sealed)).into_bytes()
}

/// Open a stored credential. Returns `Ok(None)` for an empty file
/// ("missing"), `Err(CredentialDecryptionError)` for sealed-but-
/// undecryptable or binary-nonprintable bytes, and `Ok(Some(secret))` for
/// sealed or legacy plaintext content — the fork's
/// `readStoredCredentialToken` semantics. `service` names the integration
/// in error messages only; it never touches the sealed bytes.
pub fn open_token(
    key: &[u8; KEY_LEN],
    raw: &[u8],
    service: &str,
) -> std::result::Result<Option<String>, CredentialDecryptionError> {
    if raw.is_empty() {
        return Ok(None);
    }
    if let Some(encoded) = raw.strip_prefix(SEAL_PREFIX.as_bytes()) {
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| CredentialDecryptionError(credential_decryption_message(service)))?;
        if decoded.len() < NONCE_LEN + MAC_LEN {
            return Err(CredentialDecryptionError(credential_decryption_message(
                service,
            )));
        }
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&decoded[..NONCE_LEN]);
        let stored_mac = &decoded[NONCE_LEN..NONCE_LEN + MAC_LEN];
        let ciphertext = &decoded[NONCE_LEN + MAC_LEN..];
        let mut mac_input = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        mac_input.extend_from_slice(&nonce);
        mac_input.extend_from_slice(ciphertext);
        let expected = hmac(key, 0x02, &mac_input);
        if stored_mac != expected {
            return Err(CredentialDecryptionError(credential_decryption_message(
                service,
            )));
        }
        let mut plain = Vec::with_capacity(ciphertext.len());
        for (index, byte) in ciphertext.iter().enumerate() {
            let block = keystream_block(key, &nonce, (index / MAC_LEN) as u32);
            plain.push(byte ^ block[index % MAC_LEN]);
        }
        let secret = String::from_utf8(plain)
            .map_err(|_| CredentialDecryptionError(credential_decryption_message(service)))?;
        return Ok(if secret.is_empty() {
            None
        } else {
            Some(secret)
        });
    }
    // Legacy plaintext fallback (the fork's readPlaintextLegacyCredential):
    // printable UTF-8 only; a sealed-looking binary blob must never decode
    // into auth-header junk.
    let text = String::from_utf8(raw.to_vec())
        .map_err(|_| CredentialDecryptionError(credential_decryption_message(service)))?;
    if text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
        return Err(CredentialDecryptionError(credential_decryption_message(
            service,
        )));
    }
    Ok(if text.is_empty() { None } else { Some(text) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; KEY_LEN] {
        [7u8; KEY_LEN]
    }

    #[test]
    fn sealed_secret_round_trips() {
        let sealed = seal_token(&key(), "tok-abc-123");
        assert!(sealed.starts_with(b"v1."));
        let opened = open_token(&key(), &sealed, "Github").unwrap();
        assert_eq!(opened.as_deref(), Some("tok-abc-123"));
    }

    #[test]
    fn wrong_key_reads_back_as_decryption_error() {
        let sealed = seal_token(&key(), "tok-abc-123");
        let mut wrong = [9u8; KEY_LEN];
        wrong[0] = 0;
        let result = open_token(&wrong, &sealed, "Github");
        assert!(matches!(result, Err(CredentialDecryptionError(_))));
    }

    #[test]
    fn error_message_names_the_service_label() {
        let sealed = seal_token(&key(), "tok-abc-123");
        let wrong = [1u8; KEY_LEN];
        let error = open_token(&wrong, &sealed, "Granola").unwrap_err();
        assert!(
            error
                .0
                .starts_with("Granola credential could not be decrypted")
        );
    }

    #[test]
    fn sealing_is_interoperable_with_the_jira_module() {
        // The Jira module pins the "Jira" label over these same bytes; a
        // value sealed here must open there and vice versa.
        let sealed = crate::jira::seal::seal_token(&key(), "shared-token");
        assert_eq!(
            open_token(&key(), &sealed, "Github").unwrap().as_deref(),
            Some("shared-token")
        );
        let sealed_here = seal_token(&key(), "shared-token-2");
        assert_eq!(
            crate::jira::seal::open_token(&key(), &sealed_here)
                .unwrap()
                .as_deref(),
            Some("shared-token-2")
        );
    }

    #[test]
    fn empty_file_reads_as_missing() {
        assert_eq!(open_token(&key(), b"", "Github").unwrap(), None);
    }

    #[test]
    fn legacy_plaintext_secret_is_honored() {
        assert_eq!(
            open_token(&key(), b"plain-token", "Github")
                .unwrap()
                .as_deref(),
            Some("plain-token")
        );
    }

    #[test]
    fn binary_blob_is_a_decryption_error_not_token_junk() {
        let blob: Vec<u8> = (0u8..=255).collect();
        assert!(matches!(
            open_token(&key(), &blob, "Github"),
            Err(CredentialDecryptionError(_))
        ));
    }

    #[test]
    fn control_characters_in_plaintext_refuse_to_parse() {
        let raw = b"bad\ntoken";
        assert!(matches!(
            open_token(&key(), raw, "Github"),
            Err(CredentialDecryptionError(_))
        ));
    }

    #[test]
    fn key_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_key(dir.path()).unwrap();
        let second = load_or_create_key(dir.path()).unwrap();
        assert_eq!(first, second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.path().join(".token-key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
