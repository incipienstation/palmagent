//! Model the durable Task state separately from the provider handles owned by the API.
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Stop,
    Cancel,
    Archive,
    Handoff,
    Followup,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub action: Action,
    pub handle: bool,
    pub connected: bool,
    pub now: i64,
}

pub struct State {
    pub status: String,
    pub interrupted: bool,
    pub owner: Option<String>,
    pub session: bool,
    pub compacting: bool,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Effect {
    Shared,
    ResumeCommand,
    Checkpoint,
    Followup,
    Noop,
    Pause,
    Interrupt,
    Dequeue,
    Cancel,
    Archive,
}
impl State {
    pub fn decide(&self, r: &Request) -> Result<Effect, String> {
        use Effect::*;
        let shared = self.owner.as_deref() == Some("shared");
        let idle = matches!(self.status.as_str(), "idle" | "failed");
        let closed = matches!(self.status.as_str(), "archived" | "cancelled");
        if r.action == Action::Handoff && (shared || self.owner.as_deref() == Some("local")) {
            return Ok(ResumeCommand);
        }
        if shared && !r.connected {
            return Err("The shared session is reconnecting. Your draft is preserved.".into());
        }
        if !shared && self.owner.as_deref().is_some_and(|s| s != "palmagent") {
            return Err("This session is controlled in a local shell. Dispatch it back after closing the local CLI.".into());
        }
        Ok(match r.action {
            Action::Stop if shared => Shared,
            Action::Stop if closed => return Err(format!("cannot stop a {} task", self.status)),
            Action::Stop if r.handle => Interrupt,
            Action::Stop if self.status == "queued" => Dequeue,
            Action::Stop => Pause,
            Action::Cancel if shared => Shared,
            Action::Cancel if closed => Noop,
            Action::Cancel => Cancel,
            Action::Archive if shared && !idle => {
                return Err("Stop the shared turn before archiving.".into());
            }
            Action::Archive if self.status == "archived" => Noop,
            Action::Archive if self.compacting => {
                return Err("Stop context compaction before archiving.".into());
            }
            Action::Archive if r.handle => {
                return Err("cancel the active turn before archiving".into());
            }
            Action::Archive => Archive,
            Action::Handoff if r.handle || !idle => {
                return Err(
                    "Stop the active turn and wait for it to finish before handing off".into(),
                );
            }
            Action::Handoff if !self.session => {
                return Err("This task has no native session yet".into());
            }
            Action::Handoff => Checkpoint,
            Action::Followup if shared => Shared,
            Action::Followup if r.handle => return Err("a turn is already active".into()),
            Action::Followup if !idle => {
                return Err(format!("cannot follow up a {} task", self.status));
            }
            Action::Followup => Followup,
        })
    }
}
