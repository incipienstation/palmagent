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
    depth: usize,
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
        // The product database is bootstrapped by better-sqlite3 in WAL mode
        // with SQLITE_DEFAULT_WAL_SYNCHRONOUS=NORMAL. Match the retained writer.
        let journal: String = db.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if journal.eq_ignore_ascii_case("wal") {
            db.pragma_update(None, "synchronous", "NORMAL")?;
        }
        Ok(Self {
            db,
            _lock: lock,
            depth: 0,
        })
    }

    pub fn transaction(&mut self, action: TaskTransaction) -> Result<()> {
        use TaskTransaction::*;
        let depth = self.depth;
        let sql = match (action, depth) {
            (BeginRead, 0) => "BEGIN DEFERRED",
            (Begin, 0) => "BEGIN IMMEDIATE",
            (Begin | BeginRead, _) => "SAVEPOINT task_group",
            (_, 0) => anyhow::bail!("Missing Task transaction"),
            (Commit, 1) => "COMMIT",
            (Commit, _) => "RELEASE task_group",
            (Rollback, 1) => "ROLLBACK",
            (Rollback, _) => "ROLLBACK TO task_group; RELEASE task_group",
        };
        self.db.execute_batch(sql)?;
        self.depth = if matches!(action, Begin | BeginRead) {
            depth + 1
        } else {
            depth - 1
        };
        Ok(())
    }

    pub fn creation(
        &self,
        id: &str,
        repo: &str,
        agent: &str,
        prompt: &str,
    ) -> Result<Option<bool>> {
        crate::modules::tasks::adapters::outbound::sqlite_actions::creation(
            &self.db, id, repo, agent, prompt,
        )
    }
    pub fn task_action(
        &mut self,
        id: &str,
        request: &crate::modules::tasks::application::task_actions::Request,
    ) -> Result<std::result::Result<crate::modules::tasks::application::task_actions::Effect, String>>
    {
        crate::modules::tasks::adapters::outbound::sqlite_actions::apply(&mut self.db, id, request)
    }

    pub fn shared_snapshot(
        &mut self,
        id: &str,
        observation: crate::modules::tasks::application::shared_session::SharedObservation,
    ) -> Result<Option<crate::modules::tasks::application::shared_session::SharedReceipt>> {
        self.transaction(TaskTransaction::Begin)?;
        let result = (|| {
            let (status, interrupted, running) =
                crate::modules::tasks::adapters::outbound::sqlite_lifecycle::shared_state(
                    &self.db, id,
                )?;
            let Some(receipt) = observation.reconcile(&status, interrupted) else {
                return Ok(None);
            };
            self.write_lifecycle(&observation.metadata(id, &receipt))?;
            let command = if observation.running && !running {
                Some(Command::BeginRun {
                    id: observation.run_id,
                    initial_message: None,
                    compaction: None,
                    retained: false,
                })
            } else if !observation.running && (receipt.was_active || running) {
                Some(Command::Finish {
                    failed: observation.completed != Some(true),
                    error: None,
                })
            } else {
                None
            };
            if let Some(command) = command {
                self.update_queue(id, command)
                    .map_err(|err| anyhow::anyhow!("Shared queue transition failed: {err:?}"))?;
            }
            Ok(Some(receipt))
        })();
        match result {
            Ok(value) => {
                if let Err(err) = self.transaction(TaskTransaction::Commit) {
                    self.transaction(TaskTransaction::Rollback)?;
                    return Err(err);
                }
                Ok(value)
            }
            Err(err) => {
                self.transaction(TaskTransaction::Rollback)?;
                Err(err)
            }
        }
    }

    pub fn mutate_space(
        &mut self,
        mutation: crate::modules::spaces::application::CatalogMutation,
    ) -> Result<()> {
        crate::modules::spaces::adapters::outbound::sqlite_catalog::apply(&mut self.db, mutation)
    }
    pub fn subscription(
        &self,
        operation: crate::modules::tasks::adapters::outbound::sqlite_subscriptions::Subscription,
    ) -> Result<serde_json::Value> {
        crate::modules::tasks::adapters::outbound::sqlite_subscriptions::apply(&self.db, operation)
    }

    pub fn records(
        &self,
        task_id: &str,
        query: crate::modules::tasks::adapters::outbound::sqlite_records::RecordQuery,
    ) -> Result<serde_json::Value> {
        crate::modules::tasks::adapters::outbound::sqlite_records::read(&self.db, task_id, query)
    }

    pub fn files(
        &self,
        command: crate::modules::tasks::adapters::outbound::sqlite_files::FileCommand,
    ) -> Result<serde_json::Value> {
        crate::modules::tasks::adapters::outbound::sqlite_files::files(&self.db, command)
    }

    pub fn create(&mut self, row: &str) -> Result<()> {
        crate::modules::tasks::adapters::outbound::sqlite_lifecycle::create(&mut self.db, row)
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
pub enum TaskTransaction {
    Begin,
    BeginRead,
    Commit,
    Rollback,
}
