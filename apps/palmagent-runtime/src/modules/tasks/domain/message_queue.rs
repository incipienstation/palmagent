//! Decisions over an exclusively owned queue snapshot. Persist the new state
//! before delivering a claimed message to an execution host.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

const EDIT_MS: i64 = 60_000;
const MAX_PENDING_MESSAGES: usize = 100;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Sending,
    Delivered,
    Rejected,
    Unknown,
    Cancelled,
}
impl Status {
    fn pending(self) -> bool {
        !matches!(self, Self::Delivered | Self::Cancelled)
    }

    fn unresolved(self) -> bool {
        matches!(self, Self::Sending | Self::Unknown)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Send,
    Queue,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Interactive,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompactionStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    pub request_id: String,
    pub status: CompactionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub version: i64,
    pub mode: Mode,
    pub text: String,
    pub status: Status,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editing_until: Option<i64>,
    // Agent settings and attachment/skill references round-trip with their
    // existing shape, including retained legacy images and additive fields.
    #[serde(flatten)]
    pub payload: BTreeMap<String, Value>,
}

impl Message {
    fn editing(&self, now: i64) -> bool {
        self.editing_until.is_some_and(|until| until > now)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub revision: i64,
    pub paused: bool,
    pub run_id: Option<String>,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction: Option<Compaction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Protocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_started: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug)]
pub struct QueueConflict(pub &'static str);
impl std::fmt::Display for QueueConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for QueueConflict {}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action<'a> {
    Edit {
        version: i64,
        token: &'a str,
    },
    Renew {
        token: &'a str,
    },
    Save {
        version: i64,
        token: &'a str,
        text: String,
        attachments: Option<Value>,
        skills: Option<Value>,
    },
    Release {
        token: &'a str,
    },
    Delete {
        version: i64,
    },
    Send {
        version: i64,
        expected_run_id: Option<&'a str>,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    Delivered,
    Rejected,
    Unknown,
    ReceiptLost,
}

impl Queue {
    pub fn normalize(&mut self) {
        if !self.messages.iter().any(|message| message.status.pending()) {
            self.paused = false;
        }
    }

    pub fn begin_run(
        &mut self,
        run_id: String,
        initial_message_id: Option<String>,
        compaction_id: Option<String>,
    ) {
        for message in &mut self.messages {
            if message.status == Status::Sending && message.run_id.is_none() {
                message.run_id = Some(run_id.clone());
            }
        }
        self.extra.remove("creationReserved");
        self.run_id = Some(run_id);
        self.initial_message_id = initial_message_id;
        self.runtime_started = Some(false);
        self.protocol = Some(Protocol::Interactive);
        self.compaction = compaction_id.map(|request_id| Compaction {
            request_id,
            status: CompactionStatus::Running,
            error: None,
        });
    }

    pub fn reject_before_start(&mut self, error: &str) -> bool {
        if self.runtime_started == Some(true) {
            return false;
        }
        for message in &mut self.messages {
            if message.status == Status::Sending {
                message.status = Status::Rejected;
                message.error = Some(error.to_owned());
            }
        }
        self.run_id = None;
        self.paused = true;
        true
    }

    pub fn starting_runtime(&mut self, run_id: &str) -> Result<(), QueueConflict> {
        if self.run_id.as_deref() != Some(run_id) {
            return Err(QueueConflict("The active run changed."));
        }
        if self.runtime_started == Some(true) {
            return Err(QueueConflict("Execution admission was already recorded."));
        }
        self.runtime_started = Some(true);
        Ok(())
    }

    pub fn stop_waiting(&mut self) {
        if self.runtime_started != Some(true)
            && let Some(message) = self.messages.iter_mut().find(|message| {
                Some(&message.id) == self.initial_message_id.as_ref()
                    && message.status == Status::Sending
            })
        {
            message.status = Status::Queued;
            message.run_id = None;
        }
        self.run_id = None;
        self.paused = true;
        self.complete_compaction(Some("Context compaction was stopped."));
    }

    pub fn recover(&mut self, live: bool) {
        for message in &mut self.messages {
            if message.status != Status::Sending {
                continue;
            }
            if !live
                && self.runtime_started != Some(true)
                && Some(&message.id) == self.initial_message_id.as_ref()
            {
                message.status = Status::Queued;
                message.run_id = None;
            } else {
                message.status = Status::Unknown;
                message.error = Some("Delivery could not be confirmed after reconnecting.".into());
                self.paused = true;
            }
        }
        if !live {
            self.paused |= self.run_id.take().is_some();
            self.complete_compaction(Some(
                "Context compaction could not be confirmed after restarting. You can try again.",
            ));
        }
    }

    pub fn resume(&mut self) -> Result<(), QueueConflict> {
        if self
            .messages
            .iter()
            .any(|message| message.status.unresolved())
        {
            return Err(QueueConflict(
                "Resolve unconfirmed delivery before resuming the queue.",
            ));
        }
        self.paused = false;
        Ok(())
    }

    fn complete_compaction(&mut self, error: Option<&str>) {
        if let Some(compaction) = &mut self.compaction
            && compaction.status == CompactionStatus::Running
        {
            compaction.status = if error.is_some() {
                CompactionStatus::Failed
            } else {
                CompactionStatus::Completed
            };
            if let Some(error) = error {
                compaction.error = Some(error.to_owned());
            }
        }
    }

    pub fn finish(&mut self, failed: bool, error: Option<&str>) {
        self.run_id = None;
        self.complete_compaction(
            failed.then(|| error.unwrap_or("Context compaction did not finish. Try again.")),
        );
        self.paused |= failed;
        for message in &mut self.messages {
            if message.status == Status::Sending {
                message.status = Status::Unknown;
                message.error = Some("The run ended before delivery was confirmed.".into());
                self.paused = true;
            }
        }
    }

    pub fn delivered(&mut self, id: &str) -> bool {
        let Some(message) = self.message_mut(id) else {
            return false;
        };
        if !message.status.unresolved() {
            return false;
        }
        message.status = Status::Delivered;
        message.error = None;
        true
    }

    fn settle_failed(&mut self, id: &str, status: Status, error: &'static str) -> bool {
        let Some(message) = self.message_mut(id) else {
            return false;
        };
        if message.status == Status::Delivered {
            return false;
        }
        message.status = status;
        message.error = Some(error.into());
        self.paused = true;
        true
    }

    pub fn shared_delivery_failed(&mut self, id: &str, unknown: bool) -> bool {
        if unknown {
            self.settle_failed(
                id,
                Status::Unknown,
                "Delivery could not be confirmed. Check the conversation before sending again.",
            )
        } else {
            self.settle_failed(
                id,
                Status::Rejected,
                "The shared session rejected this message.",
            )
        }
    }

    pub fn settle_steer(&mut self, id: &str, delivery: Delivery) -> bool {
        match delivery {
            Delivery::Delivered => {
                let Some(message) = self.message_mut(id) else {
                    return false;
                };
                if message.status == Status::Delivered {
                    return false;
                }
                message.status = Status::Delivered;
                true
            }
            Delivery::Rejected => self.settle_failed(
                id,
                Status::Rejected,
                "The active run could not accept this message.",
            ),
            Delivery::Unknown => self.shared_delivery_failed(id, true),
            Delivery::ReceiptLost => {
                self.settle_failed(id, Status::Unknown, "Delivery could not be confirmed.")
            }
        }
    }

    pub fn reject_start(&mut self, id: &str, error: String) -> bool {
        if self.run_id.is_some() {
            return false;
        }
        let Some(message) = self.message_mut(id) else {
            return false;
        };
        if message.status != Status::Sending {
            return false;
        }
        message.status = Status::Rejected;
        message.error = Some(error);
        self.paused = true;
        true
    }

    pub fn has_submission(&self, id: &str, fingerprint: &str) -> Result<bool, QueueConflict> {
        match self.messages.iter().find(|message| message.id == id) {
            None => Ok(false),
            Some(message) if message.fingerprint == fingerprint => Ok(true),
            Some(_) => Err(QueueConflict(
                "This message ID was already used with different content.",
            )),
        }
    }

    pub fn assert_submission(
        &self,
        mode: Mode,
        expected_run_id: Option<&str>,
        can_start: bool,
        has_settings: bool,
    ) -> Result<(), QueueConflict> {
        if self
            .messages
            .iter()
            .filter(|message| message.status.pending())
            .count()
            >= MAX_PENDING_MESSAGES
        {
            return Err(QueueConflict("The message queue is full."));
        }
        if mode == Mode::Send {
            if expected_run_id != self.run_id.as_deref() {
                return Err(QueueConflict(
                    "The active run changed. Review the message and send again.",
                ));
            }
            self.assert_can_send(can_start)?;
            if self.run_id.is_some() && has_settings {
                return Err(QueueConflict(
                    "Model and permission changes apply to queued messages or the next run.",
                ));
            }
        }
        Ok(())
    }

    fn assert_can_send(&self, can_start: bool) -> Result<(), QueueConflict> {
        if self
            .messages
            .iter()
            .any(|message| message.status.unresolved())
        {
            return Err(QueueConflict(
                "Wait for the previous message delivery to be confirmed.",
            ));
        }
        if self.run_id.is_none() && !can_start {
            return Err(QueueConflict("The task cannot start a new run yet."));
        }
        Ok(())
    }

    fn message_mut(&mut self, id: &str) -> Option<&mut Message> {
        self.messages.iter_mut().find(|message| message.id == id)
    }

    pub fn check_action(
        &self,
        id: &str,
        action: &Action<'_>,
        now: i64,
    ) -> Result<&Message, QueueConflict> {
        let message = self
            .messages
            .iter()
            .find(|message| message.id == id)
            .ok_or(QueueConflict("Message not found."))?;
        let version = match action {
            Action::Edit { version, .. }
            | Action::Save { version, .. }
            | Action::Delete { version }
            | Action::Send { version, .. } => Some(*version),
            Action::Release { .. } | Action::Renew { .. } => None,
        };
        if version.is_some_and(|version| version != message.version) {
            return Err(QueueConflict(
                "This message changed. Reload it before editing.",
            ));
        }
        let editing = message.edit_token.is_some() && message.editing(now);
        match action {
            Action::Delete { .. } => {
                if matches!(message.status, Status::Sending | Status::Delivered) {
                    return Err(QueueConflict("The message has already been sent."));
                }
                if editing {
                    return Err(QueueConflict("This message is being edited."));
                }
            }
            Action::Send {
                expected_run_id, ..
            } => {
                if message.status != Status::Queued {
                    return Err(QueueConflict("Only waiting messages can be sent."));
                }
                if editing {
                    return Err(QueueConflict("Finish editing before sending."));
                }
                if *expected_run_id != self.run_id.as_deref() {
                    return Err(QueueConflict("The active run changed. Try again."));
                }
            }
            Action::Edit { token, .. } => {
                Self::assert_waiting(message)?;
                if editing && message.edit_token.as_deref() != Some(token) {
                    return Err(QueueConflict(
                        "This message is being edited on another device.",
                    ));
                }
            }
            Action::Release { token } | Action::Renew { token } | Action::Save { token, .. } => {
                Self::assert_waiting(message)?;
                if !editing || message.edit_token.as_deref() != Some(token) {
                    return Err(QueueConflict(
                        "The edit session expired. Your draft is preserved; reopen the message.",
                    ));
                }
            }
        }
        Ok(message)
    }

    fn assert_waiting(message: &Message) -> Result<(), QueueConflict> {
        if message.status != Status::Queued {
            return Err(QueueConflict("This message is no longer waiting."));
        }
        Ok(())
    }

    pub fn act(
        &mut self,
        id: &str,
        action: Action<'_>,
        now: i64,
        can_start: bool,
    ) -> Result<Option<Message>, QueueConflict> {
        self.check_action(id, &action, now)?;
        if matches!(action, Action::Send { .. }) {
            return self.claim_send(id, can_start).map(Some);
        }
        let Some(message) = self.message_mut(id) else {
            return Err(QueueConflict("Message not found."));
        };
        match action {
            Action::Delete { .. } => message.status = Status::Cancelled,
            Action::Edit { token, .. } => {
                message.edit_token = Some(token.to_owned());
                message.editing_until = Some(now.saturating_add(EDIT_MS));
            }
            Action::Renew { .. } => message.editing_until = Some(now.saturating_add(EDIT_MS)),
            Action::Release { .. } => {
                message.edit_token = None;
                message.editing_until = None;
            }
            Action::Save {
                text,
                attachments,
                skills,
                ..
            } => {
                message.text = text;
                message.version += 1;
                message.payload.remove("images");
                for (key, value) in [("attachments", attachments), ("skills", skills)] {
                    if let Some(value) = value {
                        message.payload.insert(key.into(), value);
                    } else {
                        message.payload.remove(key);
                    }
                }
                message.edit_token = None;
                message.editing_until = None;
            }
            Action::Send { .. } => unreachable!("handled as a claim"),
        }
        Ok(None)
    }

    pub fn claim_send(&mut self, id: &str, can_start: bool) -> Result<Message, QueueConflict> {
        self.assert_can_send(can_start)?;
        let run_id = self.run_id.clone();
        let message = self
            .message_mut(id)
            .ok_or(QueueConflict("Message not found."))?;
        Self::assert_waiting(message)?;
        message.status = Status::Sending;
        message.mode = Mode::Send;
        message.run_id = run_id;
        Ok(message.clone())
    }

    pub fn claim_next(&mut self, can_start: bool, now: i64) -> Option<Message> {
        if self.paused
            || self.run_id.is_some()
            || !can_start
            || self
                .messages
                .iter()
                .any(|message| message.status.unresolved() || message.status == Status::Rejected)
        {
            return None;
        }
        let next = self
            .messages
            .iter_mut()
            .find(|message| message.status == Status::Queued)?;
        if next.editing(now) {
            return None;
        }
        next.status = Status::Sending;
        Some(next.clone())
    }
}
