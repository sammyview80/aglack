mod agent_history_proxy;
mod agent_seeder_proxy;
mod chat_proxy;
mod desktop_proxy;
mod hermes_webui_proxy;
mod onboarding_proxy;
mod wrapper_prefix_proxy;

// `pub`, not `pub(crate)`: workspaces/mod.rs re-exports these onward as
// fully `pub` (unchanged from before this move — app.rs and the crate's
// public surface depend on that), so re-exporting them here at only
// `pub(crate)` would be a visibility narrowing Rust rejects at compile
// time (E0364: re-exporting a less-public item as more-public).
pub use agent_history_proxy::{
    agent_history_proxy_route_root, agent_history_proxy_route_with_path,
};
pub use agent_seeder_proxy::{
    agent_seeder_proxy_route_root, agent_seeder_proxy_route_with_path,
};
pub use chat_proxy::{chat_proxy_route_root, chat_proxy_route_with_path};
pub use desktop_proxy::{desktop_proxy_route_root, desktop_proxy_route_with_path};
pub use hermes_webui_proxy::{
    hermes_webui_proxy_route_root, hermes_webui_proxy_route_with_path,
};
pub use onboarding_proxy::{onboarding_proxy_route_root, onboarding_proxy_route_with_path};
