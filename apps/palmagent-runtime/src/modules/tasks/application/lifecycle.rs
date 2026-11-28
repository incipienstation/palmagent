//! Task metadata writes that share one commit across provider callbacks,
//! session handoff and public task actions.
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub task_id: String,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Pin {
        pinned: bool,
        now: i64,
    },
    MovePin {
        pinned_at: i64,
        now: i64,
    },
    ProviderTitle {
        title: Option<String>,
        first_prompt: Option<String>,
    },
    Rename {
        title: String,
        now: i64,
    },
    Status {
        status: String,
        interrupted: bool,
        now: i64,
    },
    Session {
        session_id: String,
        now: i64,
    },
    Control {
        body: Option<String>,
    },
    Settings {
        model: Option<String>,
        effort: Option<String>,
        permission: String,
        now: i64,
    },
    PullRequests {
        body: String,
        first: Option<String>,
        now: i64,
    },
    PendingInput {
        body: Option<String>,
        now: i64,
    },
    PendingApproval {
        body: Option<String>,
        now: i64,
    },
    Approval {
        event_id: Option<i64>,
        body: Option<String>,
        decision: String,
        now: i64,
    },
}

pub trait LifecycleRepository {
    /// A failed batch leaves every previous value visible.
    fn write(&mut self, changes: &[Change]) -> anyhow::Result<Option<i64>>;
}
