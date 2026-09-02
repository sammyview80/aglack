use tokio::net::TcpListener;
use tokio::process::Command;

/// Ask the OS for a free ephemeral port by binding to port 0, reading back
/// whatever it assigned, then dropping the listener immediately so `docker
/// create -p` can bind it instead.
///
/// Known, accepted, small race: something else on the host could claim
/// this exact port in the gap between the listener dropping and `docker
/// start` actually binding it (a launch failure in that rare case is
/// retried like any other launch failure — see `mod.rs`'s
/// `launch_and_record` — not a correctness bug, just a documented
/// TOCTOU window inherent to this technique).
pub(crate) async fn pick_free_port() -> Result<u16, super::super::CreateWorkspaceError> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|err| {
        super::super::CreateWorkspaceError::Container(format!(
            "failed to pick a free host port: {err}"
        ))
    })?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| {
            super::super::CreateWorkspaceError::Container(format!(
                "failed to read back picked host port: {err}"
            ))
        })
}

/// Cheap, real liveness check for the Docker daemon itself — `docker info`
/// exits non-zero (or the `docker` binary is entirely unreachable) when
/// the daemon is down, e.g. Docker Desktop was killed. Used by the
/// daemon-recovery watcher (`../../daemon_watch.rs`) to detect the exact
/// down→up transition that means "containers that were running before
/// the daemon died need to be started again" — a single boolean, not
/// `ContainerState`, since this is about the DAEMON's own availability,
/// not any one container's.
pub(crate) async fn docker_daemon_reachable() -> bool {
    Command::new("docker")
        .args(["info"])
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub(crate) async fn run_docker(
    container_name: &str,
    args: &[&str],
) -> Result<(), super::super::CreateWorkspaceError> {
    let output = Command::new("docker")
        .args(args)
        .output()
        .await
        .map_err(|err| {
            super::super::CreateWorkspaceError::Container(format!(
                "failed to run `docker {}` for container {container_name}: {err}",
                args.join(" ")
            ))
        })?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(super::super::CreateWorkspaceError::Container(format!(
            "`docker {}` failed for container {container_name}: {}",
            args.join(" "),
            detail.trim()
        )));
    }

    Ok(())
}
