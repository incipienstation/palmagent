//! Reconcile an external session only after its terminal evidence arrives.
use super::lifecycle::{Action, Change};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedObservation {
    pub running: bool,
    pub sending: bool,
    pub completed: Option<bool>,
    pub question: Option<String>,
    pub approval: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub run_id: String,
    pub now: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedReceipt {
    pub status: &'static str,
    pub interrupted: bool,
    pub was_active: bool,
}
impl SharedObservation {
    pub fn reconcile(&self, previous: &str, interrupted: bool) -> Option<SharedReceipt> {
        let was_active = !matches!(previous, "idle" | "failed");
        if !self.running && (self.sending || (was_active && self.completed.is_none())) {
            return None;
        }
        let status = if self.question.is_some() {
            "awaiting_input"
        } else if self.approval.is_some() {
            "awaiting_approval"
        } else if self.running {
            "running"
        } else {
            "idle"
        };
        Some(SharedReceipt {
            status,
            was_active,
            interrupted: !self.running
                && !self.completed.unwrap_or(false)
                && (self.completed == Some(false) || interrupted),
        })
    }
    pub fn metadata(&self, id: &str, receipt: &SharedReceipt) -> Vec<Change> {
        let now = self.now;
        [
            Action::PendingInput {
                body: self.question.clone(),
                now,
            },
            Action::PendingApproval {
                body: self.approval.clone(),
                now,
            },
            Action::Status {
                status: receipt.status.into(),
                interrupted: receipt.interrupted,
                now,
            },
            Action::Settings {
                model: self.model.clone(),
                effort: self.effort.clone(),
                permission: "managed".into(),
                now,
            },
        ]
        .into_iter()
        .map(|action| Change {
            task_id: id.into(),
            action,
        })
        .collect()
    }
}
