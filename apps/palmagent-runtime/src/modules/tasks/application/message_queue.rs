//! Commit each queue transition before exposing a delivery claim to the caller.
use super::super::domain::message_queue::{
    Action, Delivery, Message, Queue, QueueConflict, Status,
};

pub trait QueueRepository {
    /// Load the latest state and commit the operation under the same write
    /// transaction. Dropping or rolling back a transaction returns no claim.
    fn update<T>(
        &mut self,
        task_id: &str,
        operation: impl FnOnce(&mut Queue) -> Result<Mutation<T>, QueueError>,
    ) -> Result<T, QueueError>;
}

pub struct Mutation<T> {
    pub result: T,
    pub changed: bool,
    /// If present, publish running status and reset the raw event cursor in the
    /// same transaction as the runtime-started marker.
    pub dispatch_started_at: Option<i64>,
}

#[derive(Debug)]
pub enum QueueError {
    MissingTask,
    Conflict(QueueConflict),
    Storage(anyhow::Error),
}

impl From<QueueConflict> for QueueError {
    fn from(error: QueueConflict) -> Self {
        Self::Conflict(error)
    }
}

#[derive(serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command<'a> {
    Submit {
        message: Message,
        expected_run_id: Option<&'a str>,
        can_start: bool,
        has_settings: bool,
        #[serde(skip, default = "admitted")]
        admission: Result<(), QueueConflict>,
    },
    Act {
        id: &'a str,
        #[serde(borrow)]
        action: Action<'a>,
        now: i64,
        can_start: bool,
    },
    ClaimSend {
        id: &'a str,
        can_start: bool,
    },
    ClaimNext {
        can_start: bool,
        now: i64,
    },
    BeginRun {
        id: String,
        initial_message: Option<String>,
        compaction: Option<String>,
        #[serde(default)]
        retained: bool,
    },
    StartingRuntime {
        run_id: &'a str,
        now: i64,
    },
    RejectBeforeStart {
        error: &'a str,
    },
    RejectStart {
        id: &'a str,
        error: String,
    },
    SharedRuntimeStarted,
    StopWaiting,
    Pause,
    Resume,
    Recover {
        live: bool,
    },
    Finish {
        failed: bool,
        error: Option<&'a str>,
    },
    Delivered {
        id: &'a str,
    },
    SharedDeliveryFailed {
        id: &'a str,
        unknown: bool,
    },
    SettleSteer {
        id: &'a str,
        delivery: Delivery,
    },
}

fn admitted() -> Result<(), QueueConflict> {
    Ok(())
}

#[derive(Debug)]
pub struct Transition {
    /// Includes private fingerprints and edit tokens. Never use as a public API response.
    pub queue: Queue,
    pub claimed: Option<Message>,
    pub changed: bool,
}

pub fn apply(
    repository: &mut impl QueueRepository,
    task_id: &str,
    command: Command<'_>,
) -> Result<Transition, QueueError> {
    repository.update(task_id, |queue| transition(queue, command))
}

pub fn transition(
    queue: &mut Queue,
    command: Command<'_>,
) -> Result<Mutation<Transition>, QueueError> {
    queue.normalize();
    let mut claimed = None;
    let mut dispatch_started_at = None;
    let changed = match command {
        Command::Submit {
            mut message,
            expected_run_id,
            can_start,
            has_settings,
            admission,
        } => {
            if queue.has_submission(&message.id, &message.fingerprint)? {
                false
            } else {
                // A retransmitted receipt remains readable during maintenance.
                admission?;
                queue.assert_submission(message.mode, expected_run_id, can_start, has_settings)?;
                message.status = Status::Queued;
                queue.messages.push(message);
                true
            }
        }
        Command::Act {
            id,
            action,
            now,
            can_start,
        } => {
            claimed = queue.act(id, action, now, can_start)?;
            true
        }
        Command::ClaimSend { id, can_start } => {
            claimed = Some(queue.claim_send(id, can_start)?);
            true
        }
        Command::ClaimNext { can_start, now } => {
            claimed = queue.claim_next(can_start, now);
            claimed.is_some()
        }
        Command::BeginRun {
            id,
            initial_message,
            compaction,
            retained,
        } => {
            queue.execution_id = retained.then(|| id.clone());
            queue.begin_run(id, initial_message, compaction);
            true
        }
        Command::StartingRuntime { run_id, now } => {
            queue.starting_runtime(run_id)?;
            dispatch_started_at = Some(now);
            true
        }
        Command::RejectBeforeStart { error } => queue.reject_before_start(error),
        Command::RejectStart { id, error } => queue.reject_start(id, error),
        Command::SharedRuntimeStarted => {
            queue.runtime_started = Some(true);
            true
        }
        Command::StopWaiting => {
            queue.stop_waiting();
            true
        }
        Command::Pause => {
            queue.paused = true;
            true
        }
        Command::Resume => {
            queue.resume()?;
            true
        }
        Command::Recover { live } => {
            queue.recover(live);
            true
        }
        Command::Finish { failed, error } => {
            queue.finish(failed, error);
            true
        }
        Command::Delivered { id } => queue.delivered(id),
        Command::SharedDeliveryFailed { id, unknown } => queue.shared_delivery_failed(id, unknown),
        Command::SettleSteer { id, delivery } => queue.settle_steer(id, delivery),
    };
    if changed {
        queue.normalize();
        queue.revision = queue
            .revision
            .checked_add(1)
            .ok_or_else(|| QueueError::Storage(anyhow::anyhow!("Queue revision overflow")))?;
    }
    Ok(Mutation {
        result: Transition {
            queue: queue.clone(),
            claimed,
            changed,
        },
        changed,
        dispatch_started_at,
    })
}
