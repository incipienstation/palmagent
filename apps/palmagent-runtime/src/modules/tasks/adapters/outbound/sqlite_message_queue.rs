//! Queue persistence for the exclusive Tasks owner. Schema bootstrap belongs
//! to the installed API owner until the full Tasks cutover.
use super::super::super::{
    application::message_queue::{Mutation, QueueError, QueueRepository},
    domain::message_queue::{Queue, QueueConflict},
};
use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

pub struct SqliteMessageQueue<'a> {
    connection: &'a mut Connection,
}

impl<'a> SqliteMessageQueue<'a> {
    /// The caller must already hold exclusive Tasks ownership.
    pub fn new(connection: &'a mut Connection) -> Self {
        Self { connection }
    }
}

fn storage(error: impl Into<anyhow::Error>) -> QueueError {
    QueueError::Storage(error.into())
}

impl QueueRepository for SqliteMessageQueue<'_> {
    fn update<T>(
        &mut self,
        task_id: &str,
        operation: impl FnOnce(&mut Queue) -> Result<Mutation<T>, QueueError>,
    ) -> Result<T, QueueError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let state: Option<Option<String>> = tx.query_row(
            "SELECT q.state FROM tasks t LEFT JOIN task_message_state q ON t.id = q.task_id WHERE t.id = ?",
            [task_id],
            |row| row.get(0),
        ).optional().map_err(storage)?;
        let mut queue = match state {
            Some(Some(state)) => serde_json::from_str(&state)
                .context("Invalid persisted queue state")
                .map_err(storage)?,
            Some(None) => Queue::default(),
            None => return Err(QueueError::MissingTask),
        };
        let mutation = operation(&mut queue)?;
        if let Some(now) = mutation.dispatch_started_at {
            let updated = tx.execute(
                "UPDATE tasks SET status = 'running', interrupted = 0, last_raw_seq = 0, updated_at = ?1
                 WHERE id = ?2 AND status IN ('queued', 'idle', 'failed', 'running', 'awaiting_approval', 'awaiting_input')",
                params![now, task_id],
            ).map_err(storage)?;
            if updated != 1 {
                return Err(QueueConflict("This task is closed.").into());
            }
        }
        if mutation.changed {
            let state = serde_json::to_string(&queue)
                .context("Encode queue state")
                .map_err(storage)?;
            tx.execute(
                "INSERT INTO task_message_state (task_id, state) VALUES (?1, ?2)
                 ON CONFLICT(task_id) DO UPDATE SET state = excluded.state",
                params![task_id, state],
            )
            .map_err(storage)?;
        }
        tx.commit().map_err(storage)?;
        Ok(mutation.result)
    }
}
