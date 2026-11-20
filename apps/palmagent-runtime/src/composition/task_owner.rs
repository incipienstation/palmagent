//! Exclusive access for the native Tasks composition. Product composition must
//! select this owner or the retained API owner before opening Tasks for writes.
use crate::{
    modules::tasks::{
        adapters::outbound::{
            sqlite_message_queue::SqliteMessageQueue, sqlite_recovery::SqliteRecovery,
        },
        application::{
            message_queue::{self, Command, QueueError, Transition},
            recovery::{self, ExecutionRecovery, Recovery},
        },
    },
    platform,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OpenFlags};
use std::{fs::File, path::Path, time::Duration};

pub struct TaskOwner {
    db: Connection,
    // Drop the database connection before releasing the ownership lease.
    _lock: File,
}

impl TaskOwner {
    /// Acquire the same lease as the retained TypeScript server, before opening
    /// the already initialized database or making any recovery changes.
    pub fn open(database: &Path) -> Result<Self> {
        ensure!(
            database.is_absolute(),
            "Expected an absolute product database path"
        );
        let parent = database
            .parent()
            .context("Missing product state directory")?;
        platform::directory(parent)?;
        let lock = platform::lock(&parent.join("runtime.lock"))?;
        let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.pragma_update(None, "foreign_keys", true)?;
        Ok(Self { db, _lock: lock })
    }

    pub fn update_queue(
        &mut self,
        task_id: &str,
        command: Command<'_>,
    ) -> Result<Transition, QueueError> {
        message_queue::apply(&mut SqliteMessageQueue::new(&mut self.db), task_id, command)
    }

    pub fn recover(
        &mut self,
        execution: &mut impl ExecutionRecovery,
        now: i64,
    ) -> Result<Recovery> {
        recovery::recover(&mut SqliteRecovery::new(&mut self.db), execution, now)
    }
}
