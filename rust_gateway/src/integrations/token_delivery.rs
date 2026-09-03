//! Delivers a workspace's OpenConnector runtime bearer into that
//! workspace's real container, as a `0400`-permission file only `abc` can
//! read — see `docs/integrations-plan.md`'s security model, layer 5.
//!
//! Deliberately does NOT reuse `workspaces::container::docker_cli::run_docker`
//! — that module is a private submodule of `workspaces::container`
//! (`mod docker_cli;`, no `pub`), so nothing outside `container/` can see
//! it; this module is a sibling of `workspaces`, not nested under it.
//! Rather than widen that module's visibility for one caller (which would
//! let every other unrelated feature reach raw `docker` invocation too),
//! this file has its own small, self-contained `docker cp`/`docker exec`
//! calls — the same two operations, duplicated once, not a reused shared
//! abstraction. Revisit if a THIRD caller ever needs the same thing.

use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug)]
pub struct TokenDeliveryError {
    pub message: String,
}

impl std::fmt::Display for TokenDeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for TokenDeliveryError {}

/// Where the token file lives inside the container — must match
/// `backend/wrapper/src/hermes_webui_wrapper/config.py`'s
/// `resolve_integrations_token_path()` default exactly.
const CONTAINER_TOKEN_PATH: &str = "/run/hermes/integrations.token";

/// Write `bearer` into `container_name`'s `/run/hermes/integrations.token`,
/// then lock it down to `abc:abc` with mode `0400` — readable by no one
/// else, not even root reading it later via a casual `docker exec cat`
/// from an operator's shell (mode 0400 still allows root, but blocks any
/// OTHER non-root process in the container, which is the real threat
/// model here: a compromised co-located process, not the host operator).
///
/// Requires the container to already be RUNNING (unlike the boot script,
/// which is `docker cp`'d before start) — connecting an integration
/// happens long after container creation, at any point in the container's
/// lifetime, not just at boot.
pub async fn deliver_token_file(
    container_name: &str,
    bearer: &str,
) -> Result<(), TokenDeliveryError> {
    // Defensive, not redundant: confirmed LIVE that `docker cp` into a
    // nonexistent parent directory fails outright. The boot script
    // (`workspaces::container::boot_script`) creates `/run/hermes` for
    // any container created AFTER that fix shipped, but a container
    // already running from before it (real case hit live: a container
    // that had been up for 12 hours) has no such directory — this
    // gateway process has no way to know which is true for a given
    // `container_name`, so it always ensures the directory itself rather
    // than assuming the boot script already did.
    run_docker(&["exec", container_name, "mkdir", "-p", "/run/hermes"]).await?;

    let tmp_file = tempfile::Builder::new()
        .prefix("hermes-integrations-token-")
        .tempfile()
        .map_err(|err| TokenDeliveryError {
            message: format!("failed to create temp token file: {err}"),
        })?;
    std::fs::write(tmp_file.path(), bearer).map_err(|err| TokenDeliveryError {
        message: format!("failed to write temp token file: {err}"),
    })?;

    let dest = format!("{container_name}:{CONTAINER_TOKEN_PATH}");
    run_docker(&["cp", tmp_file.path().to_str().unwrap_or_default(), &dest]).await?;

    run_docker(&[
        "exec",
        container_name,
        "chown",
        "abc:abc",
        CONTAINER_TOKEN_PATH,
    ])
    .await?;
    run_docker(&[
        "exec",
        container_name,
        "chmod",
        "0400",
        CONTAINER_TOKEN_PATH,
    ])
    .await
}

/// Remove the token file entirely — called when a workspace's last
/// integration is disconnected (see `route.rs`'s `disconnect_integration_route`
/// follow-up work) or a workspace is deleted. `|| true` inside the
/// container command itself means a container that's still running but
/// already has no such file is not treated as an error — matches this
/// crate's existing convention (see `boot_script.rs`'s `2>/dev/null ||
/// true` chown lines).
///
/// A container that is ALREADY GONE ENTIRELY is a second, different case
/// this also tolerates — but NOT for free: `docker exec` itself fails
/// with `No such container` before ever reaching the `|| true` inside it
/// (confirmed live — an earlier version of this function assumed the
/// inner `|| true` alone was sufficient and was wrong). Matched on
/// stderr text rather than a docker exit-code table, since `docker`'s own
/// CLI does not document a stable distinct exit code for "no such
/// container" versus other exec failures.
pub async fn remove_token_file(container_name: &str) -> Result<(), TokenDeliveryError> {
    match run_docker(&[
        "exec",
        container_name,
        "sh",
        "-c",
        &format!("rm -f {CONTAINER_TOKEN_PATH} || true"),
    ])
    .await
    {
        Err(err) if err.message.contains("No such container") => Ok(()),
        other => other,
    }
}

async fn run_docker(args: &[&str]) -> Result<(), TokenDeliveryError> {
    let output = Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|err| TokenDeliveryError {
            message: format!("failed to spawn docker {args:?}: {err}"),
        })?;

    if output.status.success() {
        Ok(())
    } else {
        Err(TokenDeliveryError {
            message: format!(
                "docker {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        })
    }
}
