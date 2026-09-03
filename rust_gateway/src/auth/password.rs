//! Argon2id password hashing for the gateway's own admin login. See
//! `bin/rust_gateway.rs`'s `--hash-password` CLI mode — the ONE way an
//! operator generates `GATEWAY_ADMIN_PASSWORD_HASH` for `.env`; this
//! module never accepts a plaintext password from any other source.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

#[derive(Debug)]
pub struct PasswordError {
    pub message: String,
}

impl std::fmt::Display for PasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Hash `password` with a fresh random salt. Used only by the
/// `--hash-password` CLI mode — never at request time (verifying, not
/// generating, is the per-request operation; see `verify`).
pub fn hash(password: &str) -> Result<String, PasswordError> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| PasswordError {
            message: format!("failed to hash password: {err}"),
        })
}

/// `true` if `password` matches `stored_hash` (a full PHC-format Argon2
/// hash string, as produced by `hash()` above). Never panics on a
/// malformed `stored_hash` (e.g. a misconfigured env var) — returns
/// `false`, fail-closed, matching this crate's convention of never
/// treating a config error as "let the request through."
pub fn verify(password: &str, stored_hash: &str) -> bool {
    let Ok(parsed_hash) = PasswordHash::new(stored_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_correct_password_verifies() {
        let hashed = hash("correct horse battery staple").expect("hash");
        assert!(verify("correct horse battery staple", &hashed));
    }

    #[test]
    fn an_incorrect_password_does_not_verify() {
        let hashed = hash("correct horse battery staple").expect("hash");
        assert!(!verify("wrong password", &hashed));
    }

    #[test]
    fn a_malformed_stored_hash_fails_closed_not_panics() {
        assert!(!verify("anything", "not-a-real-argon2-hash"));
    }
}
