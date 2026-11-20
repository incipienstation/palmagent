//! Exclusive access for the native Tasks composition. Product composition must
//! select this owner or the retained API owner before opening Tasks for writes.
use crate::{
    modules::tasks::{
        adapters::outbound::{
            sqlite_events::SqliteEvents, sqlite_lifecycle::SqliteLifecycle,
            sqlite_message_queue::SqliteMessageQueue, sqlite_recovery::SqliteRecovery,
        },
        application::{
            event_batches::{Assigned, Batch, DisplayRenderer, EventRepository},
            lifecycle::{Change, LifecycleRepository},
            message_queue::{self, Command, QueueError, Transition},
            recovery::{self, ExecutionRecovery, Recovery, RecoveryRepository},
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
    file_depth: usize,
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
        ensure!(parent.is_dir(), "Missing product state directory");
        let lock = platform::lock(&parent.join("runtime.lock"))?;
        Self::with_lease(database, lock)
    }

    /// The API coordinator holds this open file description across bootstrap,
    /// native commands, and shutdown. Check the inode before using its lease.
    pub fn with_lease(database: &Path, lock: File) -> Result<Self> {
        use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
        ensure!(
            database.is_absolute(),
            "Expected an absolute product database path"
        );
        let path = database.with_file_name("runtime.lock");
        let target = std::fs::symlink_metadata(&path)?;
        let held = lock.metadata()?;
        ensure!(
            held.is_file()
                && target.is_file()
                && held.dev() == target.dev()
                && held.ino() == target.ino()
                && held.uid() == unsafe { libc::geteuid() },
            "Invalid Task runtime lease"
        );
        ensure!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "Task runtime ownership is already held"
        );
        let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.pragma_update(None, "foreign_keys", true)?;
        Ok(Self {
            db,
            _lock: lock,
            file_depth: 0,
        })
    }

    pub fn file_transaction(&mut self, action: FileTransaction) -> Result<()> {
        use FileTransaction::*;
        let depth = self.file_depth;
        let sql = match (action, depth) {
            (Begin, 0) => "BEGIN IMMEDIATE",
            (Begin, _) => "SAVEPOINT task_files",
            (_, 0) => anyhow::bail!("Missing Task file transaction"),
            (Commit, 1) => "COMMIT",
            (Commit, _) => "RELEASE task_files",
            (Rollback, 1) => "ROLLBACK",
            (Rollback, _) => "ROLLBACK TO task_files; RELEASE task_files",
        };
        self.db.execute_batch(sql)?;
        self.file_depth = if matches!(action, Begin) {
            depth + 1
        } else {
            depth - 1
        };
        Ok(())
    }

    pub fn files(
        &self,
        command: crate::modules::tasks::adapters::outbound::sqlite_files::FileCommand,
    ) -> Result<serde_json::Value> {
        crate::modules::tasks::adapters::outbound::sqlite_files::files(&self.db, command)
    }

    pub fn create(&self, row: &str) -> Result<()> {
        crate::modules::tasks::adapters::outbound::sqlite_lifecycle::create(&self.db, row)
    }

    pub fn append(
        &mut self,
        batch: &Batch,
        renderer: &mut impl DisplayRenderer,
    ) -> Result<Vec<Assigned>> {
        SqliteEvents(&mut self.db).append(batch, renderer)
    }

    pub fn write_lifecycle(&mut self, changes: &[Change]) -> Result<Option<i64>> {
        SqliteLifecycle(&mut self.db).write(changes)
    }

    pub fn update_queue(
        &mut self,
        task_id: &str,
        command: Command<'_>,
    ) -> Result<Transition, QueueError> {
        message_queue::apply(&mut SqliteMessageQueue::new(&mut self.db), task_id, command)
    }

    pub fn prepare_recovery(
        &mut self,
        execution: &mut impl ExecutionRecovery,
    ) -> Result<(Recovery, std::collections::BTreeSet<String>)> {
        let tasks = SqliteRecovery::new(&mut self.db).tasks()?;
        recovery::prepare(&tasks, execution)
    }

    pub fn commit_recovery(
        &mut self,
        plan: &Recovery,
        retained: &std::collections::BTreeSet<String>,
        now: i64,
    ) -> Result<()> {
        SqliteRecovery::new(&mut self.db).recover(&plan.interrupted, retained, now)
    }

    pub fn recover(
        &mut self,
        execution: &mut impl ExecutionRecovery,
        now: i64,
    ) -> Result<Recovery> {
        recovery::recover(&mut SqliteRecovery::new(&mut self.db), execution, now)
    }
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileTransaction {
    Begin,
    Commit,
    Rollback,
}
