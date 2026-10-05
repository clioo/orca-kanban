//! At-rest encryption for Jira API tokens (R17-A).
//!
//! Ported behavior: the fork seals tokens with the OS keychain
//! (`safeStorage`) and falls back to a 0600 plaintext file when no keychain
//! is reachable (`src/main/integration-credential-file.ts`,
//! `src/main/jira/site-credential-store.ts`). The Drogon daemon has no
//! keychain binding, so this module implements the file-based encrypted
//! fallback the task mandates instead of the plaintext one: a random
//! 32-byte key held at `<jira-dir>/.token-key` (0600) seals each token as
//! `v1.<base64url(nonce || mac || ciphertext)>`. Keystream blocks are
//! HMAC-SHA256(key_enc, nonce || counter); `mac` is HMAC-SHA256 over
//! nonce||ciphertext, so tampering or a wrong key reads back as a
//! decryption error, never as token junk. Legacy/imported plaintext token
//! files (printable UTF-8) are still honored, mirroring the fork's legacy
//! read path; binary blobs that are neither sealed nor printable plaintext
//! surface as `CredentialDecryptionError`.
//!
//! P0: the implementation moved unchanged to
//! `crate::integrations::seal` (generalized over the integration kind; the
//! only delta is the service label on error messages, pinned here to
//! `"Jira"`). This module re-exports it so every existing caller, path,
//! sealed file and test keeps byte-identical behavior. The tests below are
//! the ORIGINAL Jira tests, untouched.
//! MIT Copyright (c) 2026 Lovecast Inc.

pub use crate::integrations::seal::{
    CredentialDecryptionError, KEY_LEN, credential_decryption_message, load_or_create_key,
    seal_token, write_file_600,
};

/// Jira-pinned open: identical semantics to
/// `crate::integrations::seal::open_token`, with error messages naming
/// `"Jira"` exactly as before the generalization.
pub fn open_token(
    key: &[u8; 32],
    raw: &[u8],
) -> std::result::Result<Option<String>, CredentialDecryptionError> {
    crate::integrations::seal::open_token(key, raw, "Jira")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; KEY_LEN] {
        [7u8; KEY_LEN]
    }

    #[test]
    fn sealed_token_round_trips() {
        let sealed = seal_token(&key(), "tok-abc-123");
        assert!(sealed.starts_with(b"v1."));
        let opened = open_token(&key(), &sealed).unwrap();
        assert_eq!(opened.as_deref(), Some("tok-abc-123"));
    }

    #[test]
    fn wrong_key_reads_back_as_decryption_error() {
        let sealed = seal_token(&key(), "tok-abc-123");
        let mut wrong = [9u8; KEY_LEN];
        wrong[0] = 0;
        let result = open_token(&wrong, &sealed);
        assert!(matches!(result, Err(CredentialDecryptionError(_))));
    }

    #[test]
    fn empty_file_reads_as_missing() {
        assert_eq!(open_token(&key(), b"").unwrap(), None);
    }

    #[test]
    fn legacy_plaintext_token_is_honored() {
        assert_eq!(
            open_token(&key(), b"plain-token").unwrap().as_deref(),
            Some("plain-token")
        );
    }

    #[test]
    fn binary_blob_is_a_decryption_error_not_token_junk() {
        let blob: Vec<u8> = (0u8..=255).collect();
        assert!(matches!(
            open_token(&key(), &blob),
            Err(CredentialDecryptionError(_))
        ));
    }

    #[test]
    fn control_characters_in_plaintext_refuse_to_parse() {
        let raw = b"bad\ntoken";
        assert!(matches!(
            open_token(&key(), raw),
            Err(CredentialDecryptionError(_))
        ));
    }

    #[test]
    fn key_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_key(dir.path()).unwrap();
        let second = load_or_create_key(dir.path()).unwrap();
        assert_eq!(first, second);
        let mut perms = std::fs::metadata(dir.path().join(".token-key"))
            .unwrap()
            .permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(perms.mode() & 0o777, 0o600);
            perms.set_mode(0o600);
        }
        std::fs::set_permissions(dir.path().join(".token-key"), perms).unwrap();
    }
}
