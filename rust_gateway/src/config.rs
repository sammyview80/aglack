//! All gateway configuration comes from the environment — nothing here is
//! hardcoded in source. See .env.example (this directory) and
//! ../.env.shared.example for the variables this reads and their defaults.
//!
//! Loading `.env` files themselves is intentionally NOT this module's job:
//! call `load_dotenv_files()` once at process start (main.rs / test_backend
//! both do this) before constructing a config, so the shared file loads
//! first and a service-local `.env` can still override it, matching the
//! layering convention already established in ../.env.shared.example.

use std::env;
use std::fmt;

/// Reads GATEWAY_* variables lazily loads ../.env.shared and ./.env first
/// (via `dotenvy`) so plain `env::var` calls below see both.
pub fn load_dotenv_files() {
    // Shared file first (repo root, one level up from rust_gateway/), then
    // this service's own .env — matching ../.env.shared.example's own
    // documented layering ("each service loads .env.shared FIRST, then its
    // own .env, so a service-specific .env can override a shared default").
    // Both calls are best-effort: a missing .env file in local dev (before
    // anyone has run `cp .env.example .env`) is not an error, only real env
    // vars set some other way (shell export, Docker, CI secrets) not being
    // present is ever a hard failure, and that is enforced by
    // GatewayConfig::from_env's own required-value checks below, not here.
    let _ = dotenvy::from_filename("../.env.shared");
    let _ = dotenvy::from_filename(".env");
}

#[derive(Debug)]
pub struct ConfigError {
    message: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ConfigError {}

fn required_env(key: &str) -> Result<String, ConfigError> {
    env::var(key).map_err(|_| ConfigError {
        message: format!(
            "missing required environment variable {key} (see rust_gateway/.env.example)"
        ),
    })
}

pub struct GatewayConfig {
    pub host: String,
    pub port: u16,
    pub backend_host: String,
    pub backend_port: u16,
    /// Origin allowed to make browser (CORS) requests to this gateway —
    /// the frontend dev server or deployed frontend origin, e.g.
    /// `http://127.0.0.1:5173`. Required, like every other address in this
    /// file: no hardcoded fallback (AGENTS.md rule #2). See app.rs for
    /// where this is applied.
    pub frontend_origin: String,
    /// The default agent's workspace directory INSIDE a workspace
    /// container, e.g. `/workspace/default` — passed to the container as
    /// `HERMES_WEBUI_DEFAULT_WORKSPACE` (see
    /// `workspaces::container::boot_script`). Required, like every other
    /// path in this file (AGENTS.md rule #2) — previously hardcoded
    /// directly in the boot script, which is exactly the thing this rule
    /// exists to prevent.
    pub workspace_default_path: String,
    /// Whether this gateway applies its own browser-facing `CorsLayer`
    /// (see `app::build_router`). Optional — unset means `true`, which
    /// preserves the exact current behavior for every existing
    /// deployment/test. Set to `false` only when something in front of
    /// this gateway (e.g. a reverse proxy) already enforces origin
    /// checks, so this gateway does not need to also do it. Unrelated to
    /// `wrapper_allowed_origins`/`HERMES_WEBUI_ALLOWED_ORIGINS`, which is
    /// a separate, container-side CORS concern.
    ///
    /// SCOPE: this only controls headers `CorsLayer` itself would add to
    /// a response this router builds directly (e.g. an OPTIONS preflight,
    /// or an error response). It does NOT strip `Access-Control-*`
    /// headers a real upstream backend/wrapper response already carries
    /// — `proxy::forward::forward_to` copies every non-hop-by-hop
    /// response header through verbatim, `false` here included. If a
    /// proxied backend sends its own CORS headers, they still reach the
    /// browser regardless of this setting.
    pub cors_enabled: bool,
}

impl GatewayConfig {
    /// Every field is required — there is deliberately no baked-in default
    /// port/host anywhere in this codebase (per explicit instruction: no
    /// hardcoded port/url/host). Missing a variable fails loudly at startup
    /// instead of silently picking a value nobody configured.
    pub fn from_env() -> Result<Self, ConfigError> {
        let host = required_env("GATEWAY_HOST")?;
        let port = parse_port(&required_env("GATEWAY_PORT")?, "GATEWAY_PORT")?;
        let backend_host = required_env("GATEWAY_BACKEND_HOST")?;
        let backend_port = parse_port(
            &required_env("GATEWAY_BACKEND_PORT")?,
            "GATEWAY_BACKEND_PORT",
        )?;
        let frontend_origin = required_env("FRONTEND_ORIGIN")?;
        let workspace_default_path = required_env("WORKSPACE_DEFAULT_PATH")?;
        let cors_enabled = parse_cors_enabled(cors_enabled_env_value(env::var(
            "CORS_ENABLED",
        ))?)?;

        Ok(Self {
            host,
            port,
            backend_host,
            backend_port,
            frontend_origin,
            workspace_default_path,
            cors_enabled,
        })
    }

    pub fn listen_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    pub fn backend_addr(&self) -> String {
        format!("{}:{}", self.backend_host, self.backend_port)
    }

    /// The full set of origins a browser may legitimately present when
    /// talking to a workspace's wrapper THROUGH this gateway, as a
    /// comma-separated string ready for a workspace container's
    /// `HERMES_WEBUI_ALLOWED_ORIGINS` (see
    /// `workspaces::container::DockerCliLauncher::allowed_origins`'s doc
    /// comment for the full mechanism this feeds).
    ///
    /// Two real, independently-confirmed-live deployment shapes both need
    /// to be in this list, not just one:
    ///   1. `frontend_origin` — a browser talking to the Vite dev server,
    ///      which forwards to this gateway (`Origin: http://localhost:5173`
    ///      while `Host` names the gateway/backend it forwards to).
    ///   2. `http://{listen_addr}` — a browser talking to THIS GATEWAY'S
    ///      OWN published address directly (no Vite dev server in front
    ///      at all). Real bug found live: a captured real browser request
    ///      with `Origin: http://127.0.0.1:8080` (this gateway's own
    ///      listen address) still got rejected with the "Cross-origin
    ///      mismatch" 403 when only `frontend_origin` was in the
    ///      allowlist — that origin was simply never a member.
    ///
    /// Always includes both, deduplicated — a deployment where
    /// `frontend_origin` and this gateway's own address happen to be the
    /// same value must not produce a duplicate entry.
    pub fn wrapper_allowed_origins(&self) -> String {
        let gateway_origin = format!("http://{}", self.listen_addr());
        let mut origins = vec![self.frontend_origin.clone()];
        if gateway_origin != self.frontend_origin {
            origins.push(gateway_origin);
        }
        origins.join(",")
    }
}

fn parse_port(raw: &str, key: &str) -> Result<u16, ConfigError> {
    raw.trim().parse::<u16>().map_err(|_| ConfigError {
        message: format!("{key} must be a valid port number (0-65535), got {raw:?}"),
    })
}

/// Turns `env::var("CORS_ENABLED")`'s `Result` into the `Option<String>`
/// `parse_cors_enabled` expects: `NotPresent` (the var is simply unset) is
/// a normal `None`, but `NotUnicode` (the var IS set, to something that
/// isn't valid UTF-8) is a real config error, not a silent default —
/// `.ok()` alone would collapse both cases into `None` and silently pick
/// `true` for a value someone actually set.
fn cors_enabled_env_value(raw: Result<String, env::VarError>) -> Result<Option<String>, ConfigError> {
    match raw {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError {
            message: "CORS_ENABLED is set but not valid UTF-8".to_string(),
        }),
    }
}

/// `CORS_ENABLED` is optional — absent means `true` (preserves current
/// behavior for every existing deployment/test). Present, it must be
/// `"true"`/`"false"` case-insensitively; any other value is a hard
/// config error at startup (fail closed), matching `parse_port`'s
/// required-value convention.
fn parse_cors_enabled(raw: Option<String>) -> Result<bool, ConfigError> {
    match raw {
        None => Ok(true),
        Some(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(ConfigError {
                message: format!("CORS_ENABLED must be \"true\" or \"false\", got {value:?}"),
            }),
        },
    }
}

/// Config for the create-workspace feature (`crate::workspaces`). See
/// docs/create-workspace-plan.md.
pub struct WorkspacesConfig {
    /// SQLite database file path. Read from the shared `DATABASE_URL`
    /// (see ../.env.shared.example) rather than a rust_gateway-only
    /// variable, since this file format documents it as the one place a
    /// value shared across services belongs. Expected form:
    /// `sqlite://<path>` — the `sqlite://` prefix is stripped here so
    /// callers get a plain filesystem path.
    pub database_path: std::path::PathBuf,
    /// The Docker image tag to launch workspace containers from — built
    /// from `../backend/workspace-image/Dockerfile`. No default: the
    /// image name/tag is a deployment decision, not something safe to
    /// guess.
    pub workspace_image_tag: String,
}

impl WorkspacesConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let database_url = required_env("DATABASE_URL")?;
        let database_path = database_url
            .strip_prefix("sqlite://")
            .ok_or_else(|| ConfigError {
                message: format!("DATABASE_URL must start with sqlite:// (got {database_url:?})"),
            })?
            .into();
        let workspace_image_tag = required_env("WORKSPACE_IMAGE_TAG")?;

        Ok(Self {
            database_path,
            workspace_image_tag,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    fn config(host: &str, port: u16, frontend_origin: &str) -> GatewayConfig {
        GatewayConfig {
            host: host.to_string(),
            port,
            backend_host: "127.0.0.1".to_string(),
            backend_port: 9999,
            frontend_origin: frontend_origin.to_string(),
            workspace_default_path: "/workspace/default".to_string(),
            cors_enabled: true,
        }
    }

    /// The common local-dev shape: Vite dev server in front, gateway on
    /// its own separate port — both are real, distinct origins a browser
    /// might use, so both must be present.
    #[test]
    fn wrapper_allowed_origins_includes_both_frontend_and_gateway_when_different() {
        let cfg = config("127.0.0.1", 8080, "http://localhost:5173");
        let origins = cfg.wrapper_allowed_origins();
        assert!(
            origins.split(',').any(|o| o == "http://localhost:5173"),
            "must include the Vite dev-server origin, got {origins:?}"
        );
        assert!(
            origins.split(',').any(|o| o == "http://127.0.0.1:8080"),
            "must include the gateway's own listen address as an origin — real bug found \
             live: a browser hitting the gateway directly (Origin: http://127.0.0.1:8080) \
             was rejected with a 403 'Cross-origin mismatch' because this exact origin was \
             never in the allowlist, got {origins:?}"
        );
    }

    /// A deployment where the gateway's own address IS the configured
    /// frontend origin (e.g. no separate Vite dev server) must not
    /// produce a duplicate comma-separated entry.
    #[test]
    fn wrapper_allowed_origins_deduplicates_when_frontend_origin_equals_gateway_origin() {
        let cfg = config("127.0.0.1", 8080, "http://127.0.0.1:8080");
        let origins = cfg.wrapper_allowed_origins();
        assert_eq!(origins, "http://127.0.0.1:8080");
    }

    #[test]
    fn cors_enabled_env_value_maps_not_present_to_none() {
        let value = cors_enabled_env_value(Err(env::VarError::NotPresent)).unwrap();
        assert_eq!(value, None);
    }

    #[test]
    fn cors_enabled_env_value_maps_ok_to_some() {
        let value = cors_enabled_env_value(Ok("false".to_string())).unwrap();
        assert_eq!(value, Some("false".to_string()));
    }

    #[test]
    fn cors_enabled_env_value_fails_closed_on_non_unicode() {
        // A real, present-but-invalid CORS_ENABLED must be a config error,
        // not silently treated the same as "unset" (which would default
        // to true) — this is exactly what plain `.ok()` would get wrong.
        let bad = std::ffi::OsString::from_vec(vec![0x66, 0xff, 0x6f]);
        let err = cors_enabled_env_value(Err(env::VarError::NotUnicode(bad))).unwrap_err();
        assert!(err.to_string().contains("CORS_ENABLED"));
    }

    #[test]
    fn parse_cors_enabled_defaults_to_true_when_unset() {
        assert_eq!(parse_cors_enabled(None).unwrap(), true);
    }

    #[test]
    fn parse_cors_enabled_parses_false() {
        assert_eq!(parse_cors_enabled(Some("false".to_string())).unwrap(), false);
    }

    #[test]
    fn parse_cors_enabled_is_case_insensitive() {
        assert_eq!(parse_cors_enabled(Some("TRUE".to_string())).unwrap(), true);
        assert_eq!(parse_cors_enabled(Some("False".to_string())).unwrap(), false);
    }

    #[test]
    fn parse_cors_enabled_rejects_invalid_value() {
        let err = parse_cors_enabled(Some("bogus".to_string())).unwrap_err();
        assert!(err.to_string().contains("CORS_ENABLED"));
    }
}
