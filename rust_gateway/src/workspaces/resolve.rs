//! Shared "resolve a caller-supplied workspace_id to a forwarding target"
//! logic, used by every proxy route keyed on workspace_id (today:
//! `onboarding_proxy.rs`, `hermes_webui_proxy.rs`, `desktop_proxy.rs`).
//!
//! This is the ONE place `workspace_id` is validated before a caller can
//! reach anything belonging to that workspace — "only the successfully
//! created workspace can be reached" is enforced HERE, not duplicated
//! (and potentially drifting) across three separate route modules.

use axum::http::StatusCode;
use axum::response::Response;

use super::store::{WorkspaceRecord, WorkspaceStatus};
use super::WorkspaceStore;
use crate::response::error;

/// A `Ready` workspace's two published host ports — never constructed for
/// any other status (see `resolve_ready_workspace`).
pub struct ReadyWorkspacePorts {
    pub wrapper_port: u16,
    pub desktop_port: u16,
}

/// Look up `workspace_id` and return its ready-to-forward ports, or an
/// error `Response` already shaped in the shared envelope
/// (`workspace_not_found` 404, `workspace_not_ready` 409,
/// `workspace_lookup_failed` / `workspace_port_missing` 500) — callers
/// just propagate that `Response` straight back with `?`-like early
/// return (see call sites: `match resolve_ready_workspace(...).await { Ok(ports) => ..., Err(response) => return response }`).
pub async fn resolve_ready_workspace(
    store: &WorkspaceStore,
    workspace_id: &str,
) -> Result<ReadyWorkspacePorts, Response> {
    let record: WorkspaceRecord = match store.find_by_workspace_id(workspace_id).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "workspace_not_found",
                format!("no workspace with id {workspace_id:?}"),
            ));
        }
        Err(err) => {
            eprintln!("rust_gateway: workspace lookup error: {err}");
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_lookup_failed",
                "failed to look up workspace",
            ));
        }
    };

    if record.status != WorkspaceStatus::Ready {
        return Err(error(
            StatusCode::CONFLICT,
            "workspace_not_ready",
            format!("workspace {workspace_id:?} is not ready yet"),
        ));
    }

    // `status == Ready` is only ever set together with BOTH ports (see
    // store.rs's `mark_ready`, the one place all three are written in the
    // same UPDATE) — a `Ready` record missing either would mean that
    // invariant broke elsewhere, not a normal/expected state for a caller
    // to hit. Fail closed rather than forwarding to a garbage address.
    let (Some(wrapper_port), Some(desktop_port)) = (record.host_port, record.desktop_port) else {
        eprintln!(
            "rust_gateway: workspace {workspace_id:?} is Ready but is missing a recorded port \
             (host_port={:?}, desktop_port={:?})",
            record.host_port, record.desktop_port
        );
        return Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "workspace_port_missing",
            "workspace is ready but has no recorded host port",
        ));
    };

    Ok(ReadyWorkspacePorts {
        // Ports are stored as i64 (sqlite has no native u16/u32) but are
        // always assigned from a real u16 port at write time (see
        // container.rs's `pick_free_port`) — this cast is lossless by
        // construction, not a truncation risk in practice.
        wrapper_port: wrapper_port as u16,
        desktop_port: desktop_port as u16,
    })
}
