//! Private, synchronous owner handoff. The API coordinator yields its lifetime
//! lease and waits for the native transaction before it can dispatch callbacks.
use super::task_owner::TaskOwner;
use crate::modules::tasks::application::event_batches::{
    Assigned, Batch, DisplayRenderer, Projection,
};
use crate::modules::tasks::application::{
    message_queue::{Command, QueueError},
    recovery::{ExecutionRecovery, Recovery, RecoveryTask},
};
use crate::modules::tasks::{
    application::turns::{Ticket, Turns},
    domain::turn::TurnEvent,
};
use crate::platform::json_wire::{protect_utf16, restore_utf16};
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, BufRead, Write},
    os::fd::FromRawFd,
    path::Path,
};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    Creation {
        id: String,
        repo: String,
        agent: String,
        prompt: String,
    },
    TaskAction {
        id: String,
        request: crate::modules::tasks::application::task_actions::Request,
    },
    SharedSnapshot {
        task_id: String,
        observation: crate::modules::tasks::application::shared_session::SharedObservation,
    },
    SpaceCatalog {
        mutation: crate::modules::spaces::application::CatalogMutation,
    },
    Subscription {
        operation: crate::modules::tasks::adapters::outbound::sqlite_subscriptions::Subscription,
    },
    Records {
        task_id: String,
        query: crate::modules::tasks::adapters::outbound::sqlite_records::RecordQuery,
    },
    Files {
        command: crate::modules::tasks::adapters::outbound::sqlite_files::FileCommand,
    },
    TaskTransaction {
        action: super::task_owner::TaskTransaction,
    },
    Create {
        row: String,
    },
    Append {
        #[serde(flatten)]
        batch: Batch,
    },
    Lifecycle {
        changes: Vec<crate::modules::tasks::application::lifecycle::Change>,
    },
    Track {
        task_id: String,
        run_id: Option<String>,
        baseline: i64,
    },
    Observe {
        ticket: Ticket,
        expected_session: Option<String>,
        observed_session: Option<String>,
        raw_seq: Option<i64>,
        event: Observation,
    },
    End {
        ticket: Ticket,
        #[serde(default)]
        compacting: bool,
        #[serde(default)]
        steer_restart: bool,
    },
    Plan {
        live: Vec<String>,
    },
    Recover {
        attached: Vec<String>,
        now: i64,
    },
    Queue {
        task_id: String,
        operation: String,
    },
    Start {
        task_id: String,
        run_id: String,
        now: i64,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Observation {
    Error { message: Option<String> },
    Result { failed: bool },
    ProcessExit { success: bool },
    ReattachFailed,
    Output,
}
impl Observation {
    fn event(&self) -> TurnEvent<'_> {
        match self {
            Self::Error { message } => TurnEvent::Error(message.as_deref()),
            Self::Result { failed } => TurnEvent::Result { failed: *failed },
            Self::ProcessExit { success } => TurnEvent::ProcessExit { success: *success },
            Self::ReattachFailed => TurnEvent::ReattachFailed,
            Self::Output => TurnEvent::Output,
        }
    }
}

/// The host adapter in the coordinator supplies the inventory and installs
/// handles synchronously between plan and commit.
struct Retained {
    live: Vec<String>,
}

impl ExecutionRecovery for Retained {
    fn independent(&self) -> bool {
        true
    }
    fn list_live(&mut self) -> Result<Vec<String>> {
        Ok(std::mem::take(&mut self.live))
    }
    fn reattach(&mut self, _task: &RecoveryTask) -> Result<()> {
        Ok(())
    }
}

enum Startup {
    Closed,
    Planned(Recovery, BTreeSet<String>),
    Ready,
}

pub fn run(database: &Path) -> Result<()> {
    // dup reports EBADF if this invocation has no inherited lease.
    let fd = unsafe { libc::fcntl(3, libc::F_DUPFD_CLOEXEC, 4) };
    ensure!(fd >= 0, "Task command requires the coordinator lease");
    let mut owner = TaskOwner::with_lease(database, unsafe { File::from_raw_fd(fd) })?;
    let mut startup = Startup::Closed;
    let mut turns = Turns::default();
    let mut pipe = Pipe {
        input: io::stdin().lock(),
        output: io::stdout().lock(),
    };
    while let Some(command) = pipe.line()? {
        let reply = match serde_json::from_str(&command)
            .map_err(anyhow::Error::from)
            .and_then(|request| execute(&mut owner, &mut startup, &mut turns, request, &mut pipe))
        {
            Ok(value) => json!({"ok":true, "value":value}),
            Err(error) => json!({"ok":false, "error":error.to_string()}),
        };
        pipe.send(&reply)?;
    }
    Ok(())
}

struct Pipe<R, W> {
    input: R,
    output: W,
}
impl<R: BufRead, W: Write> Pipe<R, W> {
    fn line(&mut self) -> Result<Option<String>> {
        let mut line = String::new();
        Ok((self.input.read_line(&mut line)? != 0).then_some(line))
    }
    fn send(&mut self, frame: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(frame)?;
        self.output
            .write_all(&u32::try_from(bytes.len())?.to_be_bytes())?;
        self.output.write_all(&bytes)?;
        self.output.flush()?;
        Ok(())
    }
}
impl<R: BufRead, W: Write> DisplayRenderer for Pipe<R, W> {
    fn project(&mut self, rows: &[Assigned]) -> Result<Projection> {
        self.send(&json!({"project":rows}))?;
        let line = self
            .line()?
            .ok_or_else(|| anyhow::anyhow!("Projection renderer disconnected"))?;
        // A failed render, malformed reply or disconnect drops the open transaction.
        serde_json::from_str(&line).map_err(Into::into)
    }
}

fn execute(
    owner: &mut TaskOwner,
    startup: &mut Startup,
    turns: &mut Turns,
    request: Request,
    renderer: &mut impl DisplayRenderer,
) -> Result<Value> {
    let result = match request {
        Request::Plan { live } => {
            ensure!(
                matches!(startup, Startup::Closed),
                "Recovery already started"
            );
            let (plan, retained) = owner.prepare_recovery(&mut Retained { live })?;
            let ids = json!(plan.reattached);
            *startup = Startup::Planned(plan, retained);
            ids
        }
        Request::Recover { attached, now } => {
            let Startup::Planned(plan, retained) = startup else {
                anyhow::bail!("No pending recovery");
            };
            ensure!(
                attached == plan.reattached,
                "Execution attachments changed during recovery"
            );
            owner.commit_recovery(plan, retained, now)?;
            let receipt = json!({"reattached":plan.reattached, "recovered":plan.interrupted});
            *startup = Startup::Ready;
            receipt
        }
        Request::Track { task_id, run_id, baseline } if !matches!(startup, Startup::Closed) => {
            if let Startup::Planned(plan, _) = startup { ensure!(plan.reattached.contains(&task_id), "Unplanned execution attachment"); }
            json!(turns.track(task_id, run_id, baseline)?)
        }
        Request::End {ticket,compacting,steer_restart} => {
            turns.finish(&ticket).map_or(Value::Null, |evidence| json!({
                "failed":evidence.failed(compacting,steer_restart), "sawResult":evidence.result_error().is_some(), "lastResultError":evidence.result_error().unwrap_or(false),
                "errored":evidence.errored(), "abnormalExit":evidence.abnormal_exit(), "failureMessage":evidence.failure_message,
            }))
        }
        _ if !matches!(startup, Startup::Ready) => anyhow::bail!("Task recovery has not committed"),
        Request::Creation {id,repo,agent,prompt} => json!(owner.creation(&id,&repo,&agent,&prompt)?),
        Request::TaskAction {id, request} => match owner.task_action(&id,&request)? {
            Ok(effect) => json!({"effect":effect}), Err(reason)=>json!({"conflict":reason})
        },
        Request::SharedSnapshot {task_id,observation} => json!(owner.shared_snapshot(&task_id,observation)?),
        Request::SpaceCatalog {mutation} => { owner.mutate_space(mutation)?; Value::Null },
        Request::Subscription {operation} => owner.subscription(operation)?,
        Request::Records {task_id,query} => owner.records(&task_id,query)?,
        Request::Files {command} => owner.files(command)?,
        Request::TaskTransaction {action} => { owner.transaction(action)?; Value::Null }
        Request::Create {row} => {owner.create(&row)?; Value::Null}
        Request::Append {batch} => {
            let rows = owner.append(&batch, renderer)?;
            json!(rows.iter().map(|row| json!({"id":row.id,"seq":row.seq})).collect::<Vec<_>>())
        }
        Request::Lifecycle {changes} => json!(owner.write_lifecycle(&changes)?),
        Request::Observe { ticket, expected_session, observed_session, raw_seq, event } =>
            json!(turns.observe(&ticket, expected_session.as_deref(), observed_session.as_deref(), raw_seq, event.event())),
        Request::Track { .. } => anyhow::bail!("Task recovery has not started"),
        Request::Queue {
            task_id,
            operation,
        } => {
            let operation: Value = serde_json::from_str(&protect_utf16(&operation))?;
            let command = Command::deserialize(&operation)?;
            let result = owner.update_queue(&task_id, command);
            match result {
                Ok(result) => json!({"changed":result.changed, "claimed":result.claimed.map(|message| serde_json::to_string(&message).map(restore_utf16)).transpose()?,
                    "runId":result.run_id }),
                Err(QueueError::Conflict(error)) => json!({"conflict":error.0}),
                Err(QueueError::MissingTask) => {
                    anyhow::bail!("Task disappeared during queue transition")
                }
                Err(QueueError::Storage(error)) => return Err(error),
            }
        }
        Request::Start {
            task_id,
            run_id,
            now,
        } => {
            owner
                .update_queue(
                    &task_id,
                    Command::StartingRuntime {
                        run_id: &run_id,
                        now,
                    },
                )
                .map_err(|error| match error {
                    QueueError::Storage(error) => error,
                    QueueError::MissingTask => {
                        anyhow::anyhow!("Task disappeared before execution admission")
                    }
                    QueueError::Conflict(error) => error.into(),
                })?;
            Value::Null
        }
    };
    Ok(result)
}
