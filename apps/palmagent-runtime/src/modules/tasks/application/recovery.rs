//! Restart recovery for one Tasks owner. Probe the execution host before
//! resetting tasks or committing any recovered queue state.
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Queued,
    Running,
    AwaitingApproval,
    AwaitingInput,
    Idle,
    Archived,
    Failed,
    Cancelled,
}

impl TaskStatus {
    fn in_flight(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::AwaitingApproval | Self::AwaitingInput
        )
    }

    fn can_reattach(self, independent: bool) -> bool {
        matches!(
            self,
            Self::Running | Self::AwaitingApproval | Self::AwaitingInput
        ) || independent && matches!(self, Self::Queued | Self::Cancelled)
    }
}

#[derive(Debug)]
pub struct RecoveryTask {
    pub id: String,
    pub status: TaskStatus,
    pub shared: bool,
    pub before_dispatch: bool,
}

pub trait ExecutionRecovery {
    fn independent(&self) -> bool;
    fn list_live(&mut self) -> anyhow::Result<Vec<String>>;
    fn reattach(&mut self, task: &RecoveryTask) -> anyhow::Result<()>;
}

pub trait RecoveryRepository {
    fn tasks(&mut self) -> anyhow::Result<Vec<RecoveryTask>>;
    /// Commit task interruption and queue recovery together. An error leaves
    /// the previous state visible, and the caller must stop startup.
    fn recover(
        &mut self,
        interrupted: &[String],
        retained: &BTreeSet<String>,
        now: i64,
    ) -> anyhow::Result<()>;
}

#[derive(Debug, PartialEq, Eq)]
pub struct Recovery {
    pub reattached: Vec<String>,
    pub interrupted: Vec<String>,
}

pub fn recover(
    repository: &mut impl RecoveryRepository,
    executions: &mut impl ExecutionRecovery,
    now: i64,
) -> anyhow::Result<Recovery> {
    let tasks = repository.tasks()?;
    let (recovery, retained) = prepare(&tasks, executions)?;
    repository.recover(&recovery.interrupted, &retained, now)?;
    Ok(recovery)
}

pub fn prepare(
    tasks: &[RecoveryTask],
    executions: &mut impl ExecutionRecovery,
) -> anyhow::Result<(Recovery, BTreeSet<String>)> {
    let independent = executions.independent();
    let in_flight = tasks
        .iter()
        .any(|task| !task.shared && task.status.in_flight());
    let live = if independent || in_flight {
        match executions.list_live() {
            Err(error) if independent => return Err(error),
            Err(_) => BTreeSet::new(),
            Ok(live) => live.into_iter().collect(),
        }
    } else {
        BTreeSet::new()
    };

    if independent
        && tasks.iter().any(|task| {
            !task.shared
                && !task.before_dispatch
                && task.status.in_flight()
                && !live.contains(&task.id)
        })
    {
        anyhow::bail!("An in-flight task has no execution identity; refusing automatic recovery");
    }

    let mut retained = BTreeSet::new();
    let mut reattached = Vec::new();
    let mut interrupted = Vec::new();
    for task in tasks {
        if task.shared {
            retained.insert(task.id.clone());
            continue;
        }
        if !task.before_dispatch && task.status.can_reattach(independent) && live.contains(&task.id)
        {
            match executions.reattach(task) {
                Ok(()) => {
                    retained.insert(task.id.clone());
                    reattached.push(task.id.clone());
                }
                Err(error) if independent => return Err(error),
                Err(_) => {}
            }
        }
        if task.status.in_flight() && !retained.contains(&task.id) {
            interrupted.push(task.id.clone());
        }
    }

    Ok((
        Recovery {
            reattached,
            interrupted,
        },
        retained,
    ))
}
