use tokio::process::Command;

use super::ContainerState;

/// Parse `docker inspect --format '{{json .State}}' <container_name>`'s
/// JSON output into a `ContainerState`. A separate free function (not a
/// method) so it can be unit-tested against literal `docker inspect`-shaped
/// JSON strings without needing a real Docker daemon (mirrors this crate's
/// existing convention of keeping pure parsing/string-building logic —
/// see `boot_script.rs` — separate from the `Command`-running code
/// around it).
pub(crate) async fn inspect_container_state(
    container_name: &str,
) -> Result<ContainerState, super::super::CreateWorkspaceError> {
    let output = Command::new("docker")
        .args(["inspect", "--format", "{{json .State}}", container_name])
        .output()
        .await
        .map_err(|err| {
            super::super::CreateWorkspaceError::Container(format!(
                "failed to run `docker inspect` for container {container_name}: {err}"
            ))
        })?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        // A missing container is a real, distinct diagnosis finding (the
        // container was removed entirely, e.g. by something outside this
        // gateway) — not a command failure. `running: false` with no exit
        // code communicates that state; `diagnosis.rs`'s caller decides
        // what to do about it, this function only reports what it saw.
        if detail.contains("No such container") {
            return Ok(ContainerState {
                running: false,
                exit_code: None,
                oom_killed: false,
            });
        }
        return Err(super::super::CreateWorkspaceError::Container(format!(
            "`docker inspect` failed for container {container_name}: {}",
            detail.trim()
        )));
    }

    parse_container_state_json(&output.stdout, container_name)
}

/// The subset of `docker inspect`'s `.State` object this codebase reads.
/// `#[serde(default)]` on every field: real `docker inspect` output
/// always has all of these, but failing closed (treating a missing field
/// as "not running" / "no exit code" / "not OOM-killed" rather than
/// erroring the whole parse) is safer than a hard parse failure blocking
/// a diagnosis over one unexpected Docker version's field naming.
#[derive(serde::Deserialize)]
struct DockerInspectState {
    #[serde(default, rename = "Running")]
    running: bool,
    #[serde(default, rename = "ExitCode")]
    exit_code: Option<i64>,
    #[serde(default, rename = "OOMKilled")]
    oom_killed: bool,
}

fn parse_container_state_json(
    raw_stdout: &[u8],
    container_name: &str,
) -> Result<ContainerState, super::super::CreateWorkspaceError> {
    let parsed: DockerInspectState = serde_json::from_slice(raw_stdout).map_err(|err| {
        super::super::CreateWorkspaceError::Container(format!(
            "failed to parse `docker inspect` output for container {container_name}: {err}"
        ))
    })?;

    Ok(ContainerState {
        running: parsed.running,
        // Docker reports 0 for a container that has never exited (still
        // running) — collapsing that specific case to `None` here, so a
        // real, meaningful non-zero-or-zero exit code is never confused
        // with "hasn't exited yet."
        exit_code: if parsed.running {
            None
        } else {
            parsed.exit_code
        },
        oom_killed: parsed.oom_killed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `docker inspect --format '{{json .State}}'` shape for a
    /// currently-running container — `ExitCode` present but must be
    /// ignored (collapsed to `None`) since the container hasn't actually
    /// exited (see `parse_container_state_json`'s doc comment).
    #[test]
    fn parse_container_state_reports_running_with_no_exit_code() {
        let raw = br#"{"Running":true,"ExitCode":0,"OOMKilled":false}"#;
        let state = parse_container_state_json(raw, "some-container").expect("parses");
        assert!(state.running);
        assert_eq!(state.exit_code, None);
        assert!(!state.oom_killed);
    }

    /// A container that exited with a real non-zero code must surface
    /// that exact code — this is the core diagnostic signal a live HTTP
    /// health check alone cannot provide.
    #[test]
    fn parse_container_state_reports_exit_code_for_a_stopped_container() {
        let raw = br#"{"Running":false,"ExitCode":137,"OOMKilled":false}"#;
        let state = parse_container_state_json(raw, "some-container").expect("parses");
        assert!(!state.running);
        assert_eq!(state.exit_code, Some(137));
    }

    #[test]
    fn parse_container_state_reports_oom_killed() {
        let raw = br#"{"Running":false,"ExitCode":137,"OOMKilled":true}"#;
        let state = parse_container_state_json(raw, "some-container").expect("parses");
        assert!(state.oom_killed);
    }

    #[test]
    fn parse_container_state_fails_closed_on_garbage_input() {
        let raw = b"not json at all";
        let result = parse_container_state_json(raw, "some-container");
        assert!(result.is_err());
    }
}
