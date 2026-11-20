//! Recover Task and queue state against the existing product database schema.
use super::super::super::{
    application::recovery::{RecoveryRepository, RecoveryTask, TaskStatus},
    domain::message_queue::Queue,
};
use crate::platform::json_wire::{protect_utf16, restore_utf16};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use std::collections::BTreeSet;

pub struct SqliteRecovery<'a> {
    connection: &'a mut Connection,
}

impl<'a> SqliteRecovery<'a> {
    /// The caller must hold exclusive Tasks ownership and keep admission closed
    /// until the host has been probed and recovery has committed.
    pub fn new(connection: &'a mut Connection) -> Self {
        Self { connection }
    }
}

#[derive(Deserialize)]
struct SessionControl {
    owner: SessionOwner,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionOwner {
    Palmagent,
    Local,
    Returning,
    Shared,
}

fn status(value: &str) -> Result<TaskStatus> {
    Ok(match value {
        "queued" => TaskStatus::Queued,
        "running" => TaskStatus::Running,
        "awaiting_approval" => TaskStatus::AwaitingApproval,
        "awaiting_input" => TaskStatus::AwaitingInput,
        "idle" => TaskStatus::Idle,
        "archived" => TaskStatus::Archived,
        "failed" => TaskStatus::Failed,
        "cancelled" => TaskStatus::Cancelled,
        _ => bail!("Unknown Task status"),
    })
}

impl RecoveryRepository for SqliteRecovery<'_> {
    fn tasks(&mut self) -> Result<Vec<RecoveryTask>> {
        let mut query = self
            .connection
            .prepare("SELECT id, status, session_control FROM tasks ORDER BY id")?;
        let rows = query.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (id, value, control) = row?;
            let shared = control
                .as_deref()
                .map(serde_json::from_str::<SessionControl>)
                .transpose()
                .context("Invalid Task session control")?
                .is_some_and(|control| matches!(control.owner, SessionOwner::Shared));
            Ok(RecoveryTask {
                id,
                status: status(&value)?,
                shared,
            })
        })
        .collect()
    }

    fn recover(
        &mut self,
        interrupted: &[String],
        retained: &BTreeSet<String>,
        now: i64,
    ) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        {
            let mut reset = transaction.prepare(
                "UPDATE tasks SET status='idle', interrupted=1, pending_input=NULL,
                 pending_approval=NULL, updated_at=?1
                 WHERE id=?2 AND status IN ('running','queued','awaiting_approval','awaiting_input')",
            )?;
            for id in interrupted {
                ensure!(
                    reset.execute(params![now, id])? == 1,
                    "Task status changed during recovery"
                );
            }

            let mut first = transaction.prepare(
                "SELECT task_id, state FROM task_message_state ORDER BY task_id LIMIT 1",
            )?;
            let mut next = transaction.prepare(
                "SELECT task_id, state FROM task_message_state WHERE task_id > ? ORDER BY task_id LIMIT 1",
            )?;
            let mut save =
                transaction.prepare("UPDATE task_message_state SET state=?1 WHERE task_id=?2")?;
            let read_row =
                |row: &rusqlite::Row<'_>| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?));
            let mut row = first.query_row([], read_row).optional()?;
            while let Some((task_id, state)) = row {
                let mut queue: Queue = serde_json::from_str(&protect_utf16(&state))
                    .context("Invalid persisted queue state")?;
                queue.normalize();
                queue.recover(retained.contains(&task_id));
                queue.normalize();
                queue.revision = queue
                    .revision
                    .checked_add(1)
                    .context("Queue revision overflow")?;
                save.execute(params![
                    restore_utf16(serde_json::to_string(&queue)?),
                    task_id
                ])?;
                row = next.query_row([task_id], read_row).optional()?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}
