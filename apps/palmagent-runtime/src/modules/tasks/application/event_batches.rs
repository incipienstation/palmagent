//! Committed provider batches. The shared display renderer receives assigned
//! sequences and compact payloads while the repository holds the transaction.
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct Event {
    pub kind: String,
    pub payload: String,
    pub ts: i64,
}

#[derive(Deserialize, PartialEq, Eq)]
pub struct ImportMarker {
    pub length: Option<i64>,
    pub hash: Option<String>,
}
#[derive(Deserialize)]
pub struct ImportChange {
    pub source: String,
    pub previous: Option<ImportMarker>,
    pub next: ImportMarker,
}
#[derive(Deserialize)]
pub struct SessionImport {
    pub control: Option<String>,
    pub changes: Vec<ImportChange>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub provider: Option<ProviderLine>,
    pub task_id: String,
    pub events: Vec<Event>,
    pub raw_seq: Option<i64>,
    pub now: i64,
    pub session: Option<SessionImport>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLine {
    pub session_id: Option<String>,
    pub independent: bool,
    pub subtype: Option<String>,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
}

impl ProviderLine {
    pub fn changes(
        &self,
        event: &Event,
        status: &str,
        interrupted: bool,
        session: Option<&str>,
        question: Option<&str>,
        now: i64,
    ) -> Vec<super::lifecycle::Action> {
        use super::lifecycle::Action;
        let mut changes = Vec::new();
        if let Some(id) = self
            .session_id
            .as_ref()
            .filter(|id| !id.is_empty() && Some(id.as_str()) != session)
        {
            changes.push(Action::Session {
                session_id: id.clone(),
                now,
            });
        }
        let next = match (event.kind.as_str(), self.subtype.as_deref()) {
            ("question", _) => {
                changes.push(Action::PendingInput {
                    body: Some(event.payload.clone()),
                    now,
                });
                Some(if status == "running" {
                    "awaiting_input"
                } else {
                    status
                })
            }
            ("approval_request", _) if status == "running" => {
                changes.push(Action::PendingApproval {
                    body: Some(event.payload.clone()),
                    now,
                });
                Some("awaiting_approval")
            }
            ("status", Some("answer" | "input_resolved"))
                if self.request_id.is_some() && self.request_id.as_deref() == question =>
            {
                changes.push(Action::PendingInput { body: None, now });
                Some(if status == "awaiting_input" {
                    "running"
                } else {
                    status
                })
            }
            ("status", Some("execution_queued")) if self.independent && status != "cancelled" => {
                Some("queued")
            }
            ("status", Some("execution_started")) if self.independent && status != "cancelled" => {
                Some("running")
            }
            _ => None,
        };
        if let Some(status) = next {
            changes.push(Action::Status {
                status: status.into(),
                interrupted,
                now,
            });
        }
        changes
    }
}

#[derive(Serialize)]
pub struct Assigned {
    pub id: i64,
    pub seq: i64,
    pub compact: Option<String>,
}

#[derive(Deserialize)]
pub struct DisplayChange {
    pub key: i64,
    pub start: i64,
    pub end: i64,
    pub revision: i64,
    pub body: Option<String>,
    pub wire: Option<String>,
}
#[derive(Deserialize)]
pub struct ContextChange {
    pub body: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrChange {
    pub evidence: String,
    pub body: String,
    pub first: Option<String>,
    pub updated_at: Option<i64>,
}
#[derive(Deserialize)]
pub struct Projection {
    pub cursor: i64,
    pub start: i64,
    pub log: String,
    pub activity: String,
    pub changes: Vec<DisplayChange>,
    pub context: Option<ContextChange>,
    pub prs: Option<PrChange>,
}

pub trait DisplayRenderer {
    fn project(&mut self, rows: &[Assigned]) -> anyhow::Result<Projection>;
}
pub trait EventRepository {
    fn append(
        &mut self,
        batch: &Batch,
        renderer: &mut impl DisplayRenderer,
    ) -> anyhow::Result<Vec<Assigned>>;
}
