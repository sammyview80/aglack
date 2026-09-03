//! Provider catalog: `backend/integrations/providers.yaml`, loaded once at
//! startup and validated fail-fast (a bad entry must never surface as a
//! confusing 500 mid-request). Frontend never hardcodes this list — it
//! calls `GET /integrations/providers` (see `route.rs`), matching
//! frontend/AGENTS.md rule #2.
//!
//! `openconnector_service` values are the OpenConnector catalog keys —
//! see `docs/integrations-poc-findings.md`'s "Provider keys confirmed"
//! section before adding a new provider: several plausible names (a
//! single combined `google`, a plain `microsoft-teams`) were checked
//! against the real catalog and either don't exist or map to several
//! split services instead of one.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub openconnector_service: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Marketing homepage (e.g. `https://github.com`). The frontend derives
    /// a brand favicon from its hostname (see
    /// `frontend/.../components/provider-mark.tsx`); absent means "no
    /// favicon, render the generated initials tile" — never an error.
    #[serde(default)]
    pub homepage_url: Option<String>,
    /// Env-var name PREFIX for this provider's OAuth client credentials —
    /// e.g. `GITHUB_OAUTH` means `GITHUB_OAUTH_CLIENT_ID` and
    /// `GITHUB_OAUTH_CLIENT_SECRET` (see `Provider::oauth_credentials`).
    /// Absent means this provider only supports the `api_key` connect
    /// path (see `route.rs`'s `connect_integration_route`) — never OAuth,
    /// not "OAuth not configured yet".
    #[serde(default)]
    pub oauth_client_env: Option<String>,
    /// Scopes which `execute_action` calls (via `actionId`, e.g.
    /// `github.get_current_user`) a connected agent may make against this
    /// provider — enforced in `mcp_proxy.rs`'s `sanitize_request`. An
    /// EMPTY list (the default — most providers ship no entry at all)
    /// means "every action for this provider is allowed", matching the
    /// plan's original design; a NON-EMPTY list is a strict allowlist,
    /// each entry the exact `actionId` (full `<service>.<action>` string,
    /// not just the action's own name) permitted.
    #[serde(default)]
    pub allowed_actions: Vec<String>,
}

impl Provider {
    /// `true` if `action_id` (the full `<service>.<action>` string a
    /// caller sends to `execute_action`) is permitted for this provider —
    /// always `true` when `allowed_actions` is empty (no restriction
    /// configured), otherwise an exact match against the list.
    pub fn allows_action(&self, action_id: &str) -> bool {
        self.allowed_actions.is_empty() || self.allowed_actions.iter().any(|a| a == action_id)
    }
}

impl Provider {
    /// Read this provider's OAuth client id/secret from the environment,
    /// using `oauth_client_env` as the prefix. Returns `None` if this
    /// provider has no `oauth_client_env` at all, OR if either env var is
    /// unset/empty — a provider is only OAuth-capable once BOTH halves of
    /// the credential are present, never a partial config silently
    /// treated as configured.
    pub fn oauth_credentials(&self) -> Option<(String, String)> {
        let prefix = self.oauth_client_env.as_ref()?;
        let client_id = std::env::var(format!("{prefix}_CLIENT_ID")).ok()?;
        let client_secret = std::env::var(format!("{prefix}_CLIENT_SECRET")).ok()?;
        if client_id.trim().is_empty() || client_secret.trim().is_empty() {
            return None;
        }
        Some((client_id, client_secret))
    }
}

#[derive(Debug, Deserialize)]
struct ProvidersFile {
    providers: Vec<Provider>,
}

#[derive(Debug)]
pub struct ProvidersError {
    message: String,
}

impl std::fmt::Display for ProvidersError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ProvidersError {}

/// Load and validate the provider registry. Fails loudly (process should
/// not start) on: unreadable file, invalid YAML, duplicate `id`, or an
/// empty `openconnector_service`/`id`.
pub fn load_providers(path: &Path) -> Result<Vec<Provider>, ProvidersError> {
    let raw = std::fs::read_to_string(path).map_err(|err| ProvidersError {
        message: format!("failed to read providers file {}: {err}", path.display()),
    })?;
    let parsed: ProvidersFile = serde_yaml::from_str(&raw).map_err(|err| ProvidersError {
        message: format!("failed to parse providers file {}: {err}", path.display()),
    })?;

    let mut seen = std::collections::HashSet::new();
    for provider in &parsed.providers {
        if provider.id.trim().is_empty() {
            return Err(ProvidersError {
                message: "a provider entry has an empty id".to_string(),
            });
        }
        if provider.openconnector_service.trim().is_empty() {
            return Err(ProvidersError {
                message: format!(
                    "provider {:?} has an empty openconnector_service",
                    provider.id
                ),
            });
        }
        if !seen.insert(provider.id.clone()) {
            return Err(ProvidersError {
                message: format!("duplicate provider id {:?}", provider.id),
            });
        }
    }

    Ok(parsed.providers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(contents: &str) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().expect("create temp file");
        file.write_all(contents.as_bytes())
            .expect("write temp file");
        file
    }

    #[test]
    fn loads_valid_providers() {
        let file = write_temp(
            r#"
providers:
  - id: github
    name: GitHub
    openconnector_service: github
"#,
        );
        let providers = load_providers(file.path()).expect("load succeeds");
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "github");
    }

    #[test]
    fn rejects_duplicate_ids() {
        let file = write_temp(
            r#"
providers:
  - id: github
    name: GitHub
    openconnector_service: github
  - id: github
    name: GitHub Again
    openconnector_service: github
"#,
        );
        let err = load_providers(file.path()).expect_err("must reject duplicates");
        assert!(err.to_string().contains("duplicate provider id"));
    }

    #[test]
    fn rejects_empty_openconnector_service() {
        let file = write_temp(
            r#"
providers:
  - id: github
    name: GitHub
    openconnector_service: ""
"#,
        );
        let err = load_providers(file.path()).expect_err("must reject empty service");
        assert!(err.to_string().contains("empty openconnector_service"));
    }

    #[test]
    fn missing_file_is_an_error_not_a_panic() {
        let err = load_providers(Path::new("/nonexistent/providers.yaml"))
            .expect_err("must error, not panic");
        assert!(err.to_string().contains("failed to read providers file"));
    }

    /// Each test below uses its OWN unique env var prefix (never a shared
    /// one like `GITHUB_OAUTH`) specifically so these can run in parallel
    /// with every other `cargo test` in this process without racing on
    /// `std::env::set_var`/`remove_var`, which are process-global.
    fn provider_with_oauth_env(prefix: &str) -> Provider {
        Provider {
            id: "test-provider".to_string(),
            name: "Test Provider".to_string(),
            icon: None,
            openconnector_service: "test-provider".to_string(),
            description: None,
            homepage_url: None,
            oauth_client_env: Some(prefix.to_string()),
            allowed_actions: Vec::new(),
        }
    }

    #[test]
    fn oauth_credentials_is_none_without_oauth_client_env() {
        let provider = Provider {
            id: "no-oauth".to_string(),
            name: "No OAuth".to_string(),
            icon: None,
            openconnector_service: "no-oauth".to_string(),
            description: None,
            homepage_url: None,
            oauth_client_env: None,
            allowed_actions: Vec::new(),
        };
        assert!(provider.oauth_credentials().is_none());
    }

    #[test]
    fn oauth_credentials_is_none_when_env_vars_are_unset() {
        let provider = provider_with_oauth_env("TEST_UNSET_OAUTH_PREFIX");
        assert!(provider.oauth_credentials().is_none());
    }

    #[test]
    fn oauth_credentials_is_none_when_only_one_half_is_set() {
        let provider = provider_with_oauth_env("TEST_PARTIAL_OAUTH_PREFIX");
        std::env::set_var("TEST_PARTIAL_OAUTH_PREFIX_CLIENT_ID", "abc");
        let result = provider.oauth_credentials();
        std::env::remove_var("TEST_PARTIAL_OAUTH_PREFIX_CLIENT_ID");
        assert!(
            result.is_none(),
            "a partial credential must not be treated as configured"
        );
    }

    #[test]
    fn oauth_credentials_is_some_when_both_halves_are_set() {
        let provider = provider_with_oauth_env("TEST_FULL_OAUTH_PREFIX");
        std::env::set_var("TEST_FULL_OAUTH_PREFIX_CLIENT_ID", "abc");
        std::env::set_var("TEST_FULL_OAUTH_PREFIX_CLIENT_SECRET", "xyz");
        let result = provider.oauth_credentials();
        std::env::remove_var("TEST_FULL_OAUTH_PREFIX_CLIENT_ID");
        std::env::remove_var("TEST_FULL_OAUTH_PREFIX_CLIENT_SECRET");
        assert_eq!(result, Some(("abc".to_string(), "xyz".to_string())));
    }

    #[test]
    fn allows_action_permits_everything_when_the_list_is_empty() {
        let provider = provider_with_oauth_env("TEST_UNUSED_PREFIX_A");
        assert!(provider.allows_action("anything.at_all"));
    }

    #[test]
    fn allows_action_permits_only_listed_actions_when_the_list_is_non_empty() {
        let mut provider = provider_with_oauth_env("TEST_UNUSED_PREFIX_B");
        provider.allowed_actions = vec!["github.get_current_user".to_string()];
        assert!(provider.allows_action("github.get_current_user"));
        assert!(!provider.allows_action("github.delete_repo"));
    }

    /// The REAL catalog on disk (not a temp fixture) must load: a broken
    /// entry there fails gateway startup, so catch it here first.
    #[test]
    fn real_providers_yaml_on_disk_loads_with_every_catalog_entry() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../backend/integrations/providers.yaml");
        let providers = load_providers(&path).expect("real providers.yaml loads");
        assert_eq!(providers.len(), 104);
        let unique: std::collections::HashSet<&str> =
            providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(unique.len(), providers.len(), "duplicate provider ids");
        for provider in &providers {
            assert!(
                !provider.openconnector_service.trim().is_empty(),
                "provider {:?} has an empty openconnector_service",
                provider.id
            );
        }
    }
}
