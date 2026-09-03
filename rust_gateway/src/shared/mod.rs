//! Small, crate-wide helpers that do not belong to any one feature.
//! Currently just `http` (shared `reqwest::Client` builders) — a new
//! shared concern earns its own file here, not a bigger `http.rs`.

pub mod http;
