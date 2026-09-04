//! Shared crypto primitives: a SHA-256-hex helper (for bearer/session
//! tokens compared but never decrypted — see `sha256_hex`'s own doc
//! comment) and AES-256-GCM encrypt/decrypt (for the one value this
//! crate must actually recover in plaintext to use: OpenConnector's own
//! bearer, forwarded to it on every MCP call — see `TokenCipher`).

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use base64::Engine;
use sha2::{Digest, Sha256};

/// Used everywhere this crate hashes a bearer/session token before
/// storing or comparing it at rest — `integrations::mcp_proxy` (workspace
/// runtime tokens) and `auth::route` (gateway admin sessions) both need
/// the exact same primitive, and a security-sensitive hash function is
/// worth sharing one implementation for rather than risking two copies
/// drifting apart. One-way: never used for a value this process needs
/// back in plaintext — see `TokenCipher` below for that case.
pub fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Debug)]
pub struct CryptoError {
    pub message: String,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CryptoError {}

/// AES-256-GCM encryption for `workspace_runtime_tokens.openconnector_bearer`
/// (see `integrations::store`'s column comment — that value was plaintext
/// at rest from the moment the column was introduced, flagged as a
/// required fix, not a new discovery). One key for the whole process,
/// read once at startup from `GATEWAY_TOKEN_ENCRYPTION_KEY` (see
/// `config::GatewayAuthConfig`... actually its own config struct — see
/// `bin/rust_gateway.rs`), never derived from anything request-scoped.
pub struct TokenCipher {
    cipher: Aes256Gcm,
}

impl TokenCipher {
    /// `key` must be exactly 32 raw bytes (AES-256's key size) — see
    /// `parse_key` for the base64 decode + length check callers use to
    /// produce this from the env var.
    pub fn new(key: &[u8; 32]) -> Self {
        Self {
            cipher: Aes256Gcm::new(key.into()),
        }
    }

    /// Returns `base64(nonce || ciphertext)` — a single self-contained
    /// string safe to store directly in one TEXT column, matching every
    /// other token-ish value in this crate's SQLite schema. A fresh
    /// random 96-bit nonce every call (AES-GCM's own requirement: never
    /// reuse a nonce under the same key) — `OsRng` is the OS's real CSPRNG,
    /// not `uuid`'s (a different trust boundary: nonce uniqueness is a
    /// hard cryptographic requirement, not just "probably won't collide").
    pub fn encrypt(&self, plaintext: &str) -> Result<String, CryptoError> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|err| CryptoError {
                message: format!("failed to encrypt: {err}"),
            })?;
        let mut combined = Vec::with_capacity(nonce.len() + ciphertext.len());
        combined.extend_from_slice(&nonce);
        combined.extend_from_slice(&ciphertext);
        Ok(base64::engine::general_purpose::STANDARD.encode(&combined))
    }

    /// Inverse of `encrypt`. Fails closed on anything malformed (wrong
    /// base64, too short to contain a nonce, wrong key, tampered
    /// ciphertext — AES-GCM's own authentication tag catches that last
    /// one) rather than ever returning a partially-decrypted or
    /// unauthenticated value.
    pub fn decrypt(&self, encoded: &str) -> Result<String, CryptoError> {
        let combined = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|err| CryptoError {
                message: format!("stored value is not valid base64: {err}"),
            })?;
        if combined.len() < 12 {
            return Err(CryptoError {
                message: "stored value is too short to contain a nonce".to_string(),
            });
        }
        let (nonce_bytes, ciphertext) = combined.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|err| CryptoError {
                message: format!("failed to decrypt (wrong key, or tampered value): {err}"),
            })?;
        String::from_utf8(plaintext).map_err(|err| CryptoError {
            message: format!("decrypted value is not valid UTF-8: {err}"),
        })
    }
}

/// Parses `GATEWAY_TOKEN_ENCRYPTION_KEY` (base64, must decode to exactly
/// 32 bytes) into the fixed-size array `TokenCipher::new` needs. A
/// separate free function (not inherent to `TokenCipher`) so
/// `config::GatewayAuthConfig`-style env parsing can validate this at
/// startup, matching every other required env var in this crate failing
/// loudly before the server ever binds a port, rather than only at first
/// use.
pub fn parse_encryption_key(base64_value: &str) -> Result<[u8; 32], CryptoError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_value.trim())
        .map_err(|err| CryptoError {
            message: format!("GATEWAY_TOKEN_ENCRYPTION_KEY is not valid base64: {err}"),
        })?;
    bytes.try_into().map_err(|bytes: Vec<u8>| CryptoError {
        message: format!(
            "GATEWAY_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes, got {}",
            bytes.len()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn encrypt_then_decrypt_recovers_the_plaintext() {
        let cipher = TokenCipher::new(&test_key());
        let ciphertext = cipher.encrypt("super-secret-bearer").expect("encrypt");
        assert_ne!(
            ciphertext, "super-secret-bearer",
            "must not store plaintext"
        );
        let plaintext = cipher.decrypt(&ciphertext).expect("decrypt");
        assert_eq!(plaintext, "super-secret-bearer");
    }

    #[test]
    fn two_encryptions_of_the_same_plaintext_differ() {
        // Different random nonce each call — a static ciphertext would
        // leak "these two rows hold the same token" to anyone with read
        // access to the database, even without the key.
        let cipher = TokenCipher::new(&test_key());
        let a = cipher.encrypt("same-value").expect("encrypt a");
        let b = cipher.encrypt("same-value").expect("encrypt b");
        assert_ne!(a, b);
    }

    #[test]
    fn decrypt_fails_closed_with_the_wrong_key() {
        let encrypted = TokenCipher::new(&test_key())
            .encrypt("secret")
            .expect("encrypt");
        let wrong_key = [9u8; 32];
        let result = TokenCipher::new(&wrong_key).decrypt(&encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_fails_closed_on_tampered_ciphertext() {
        let cipher = TokenCipher::new(&test_key());
        let mut encrypted = cipher.encrypt("secret").expect("encrypt");
        // Flip a character deep enough to land in the ciphertext, not the
        // nonce prefix's own base64 characters only.
        let mut chars: Vec<char> = encrypted.chars().collect();
        let flip_at = chars.len() - 1;
        chars[flip_at] = if chars[flip_at] == 'A' { 'B' } else { 'A' };
        encrypted = chars.into_iter().collect();
        assert!(cipher.decrypt(&encrypted).is_err());
    }

    #[test]
    fn parse_encryption_key_rejects_wrong_length() {
        let short_key_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
        let err = parse_encryption_key(&short_key_b64).expect_err("must reject");
        assert!(err.to_string().contains("32 bytes"));
    }

    #[test]
    fn parse_encryption_key_accepts_a_real_32_byte_key() {
        let key_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        assert!(parse_encryption_key(&key_b64).is_ok());
    }
}
