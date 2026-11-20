use anyhow::Result;
use palmagent_runtime::modules::tasks::{
    adapters::outbound::{
        sqlite_message_queue::SqliteMessageQueue, sqlite_recovery::SqliteRecovery,
    },
    application::{
        message_queue::{Command, QueueError, apply},
        recovery::{ExecutionRecovery, RecoveryTask, recover},
        turns::{Disposition, Turns},
    },
    domain::message_queue::{
        Action, CompactionStatus, Delivery, Message, Queue, QueueConflict, Status,
    },
    domain::turn::TurnEvent,
};
use palmagent_runtime::{composition::task_owner::TaskOwner, platform};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Command as Process, Stdio},
};

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    bootstrap(&db);
    db
}

fn bootstrap(db: &Connection) {
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE tasks (
            id TEXT PRIMARY KEY, status TEXT NOT NULL, interrupted INTEGER NOT NULL DEFAULT 0,
            session_control TEXT, pending_input TEXT, pending_approval TEXT,
            updated_at INTEGER NOT NULL DEFAULT 0, last_raw_seq INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE task_message_state (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, state TEXT NOT NULL
         );
         INSERT INTO tasks(id, status) VALUES ('task', 'idle');",
    )
    .unwrap();
}

struct StateDirectory(PathBuf);
impl Drop for StateDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn native_owner_shares_the_retained_servers_process_lifetime_lease() {
    let directory = StateDirectory(std::env::temp_dir().join(format!(
        "palmagent-task-owner-test-{}",
        platform::unique_id().unwrap()
    )));
    platform::directory(&directory.0).unwrap();
    let database = directory.0.join("test.db");
    let db = Connection::open(&database).unwrap();
    bootstrap(&db);
    write(&db, "task", &queue(vec![message("first", "queued")]));
    drop(db);

    // The retained server uses flock on an inherited file descriptor and
    // keeps its copy open after the command exits.
    let path = directory.0.join("runtime.lock");
    fs::File::create(&path).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(0o600);
    fs::set_permissions(&path, permissions).unwrap();
    let legacy_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let legacy_lock = |file: &fs::File| {
        Process::new("flock")
            .args([
                "--exclusive",
                "--nonblock",
                "--conflict-exit-code",
                "75",
                "0",
            ])
            .stdin(Stdio::from(file.try_clone().unwrap()))
            .status()
            .unwrap()
    };
    assert!(legacy_lock(&legacy_file).success());
    let error = TaskOwner::open(&database)
        .err()
        .expect("legacy owner holds the lease");
    assert!(error.to_string().contains("ownership"));
    drop(legacy_file);

    let mut owner = TaskOwner::open(&database).unwrap();
    let legacy_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    assert_eq!(legacy_lock(&legacy_file).code(), Some(75));
    let claim = owner
        .update_queue(
            "task",
            Command::ClaimNext {
                now: 0,
                can_start: true,
            },
        )
        .unwrap()
        .claimed
        .unwrap();
    assert_eq!(claim.id, "first");
    drop(owner);
    assert!(legacy_lock(&legacy_file).success());
    let db = Connection::open(&database).unwrap();
    assert_eq!(read(&db, "task").messages[0].status, Status::Sending);
}

fn message(id: &str, status: &str) -> Value {
    json!({
        "id": id, "version": 1, "mode": "queue", "text": "payload",
        "status": status, "fingerprint": format!("fingerprint-{id}"),
    })
}

fn queue(messages: Vec<Value>) -> Value {
    json!({"revision": 7, "paused": false, "runId": null, "messages": messages})
}

fn write(db: &Connection, id: &str, value: &Value) {
    db.execute(
        "INSERT INTO task_message_state(task_id,state) VALUES (?1,?2)",
        params![id, value.to_string()],
    )
    .unwrap();
}

fn read(db: &Connection, id: &str) -> Queue {
    let raw: String = db
        .query_row(
            "SELECT state FROM task_message_state WHERE task_id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn existing_queue_retains_fifo_edit_deadline_and_attachment_references() {
    let mut db = database();
    let mut first = message("first", "queued");
    first["attachments"] = json!([{"id": "attachment", "mediaType": "image/png", "size": 100}]);
    first["additiveField"] = json!({"future": true});
    write(
        &db,
        "task",
        &queue(vec![first.clone(), message("second", "queued")]),
    );

    let mut repository = SqliteMessageQueue::new(&mut db);
    apply(
        &mut repository,
        "task",
        Command::Act {
            id: "first",
            action: Action::Edit {
                version: 1,
                token: "editor",
            },
            now: 1_000,
            can_start: true,
        },
    )
    .unwrap();
    let early = apply(
        &mut repository,
        "task",
        Command::ClaimNext {
            now: 60_999,
            can_start: true,
        },
    )
    .unwrap();
    assert!(!early.changed);
    assert!(early.claimed.is_none());
    let expired = apply(
        &mut repository,
        "task",
        Command::Act {
            id: "first",
            action: Action::Save {
                version: 1,
                token: "editor",
                text: "late".into(),
                attachments: None,
                skills: None,
            },
            now: 61_000,
            can_start: true,
        },
    );
    assert!(matches!(expired, Err(QueueError::Conflict(_))));
    let claimed = apply(
        &mut repository,
        "task",
        Command::ClaimNext {
            now: 61_000,
            can_start: true,
        },
    )
    .unwrap()
    .claimed
    .unwrap();
    assert_eq!(claimed.id, "first");
    assert_eq!(claimed.payload["attachments"], first["attachments"]);
    assert_eq!(claimed.payload["additiveField"], first["additiveField"]);
    assert!(
        apply(
            &mut repository,
            "task",
            Command::ClaimNext {
                now: 61_000,
                can_start: true
            }
        )
        .unwrap()
        .claimed
        .is_none()
    );

    let stored = read(&db, "task");
    assert_eq!(stored.messages[0].status, Status::Sending);
    assert_eq!(stored.messages[1].status, Status::Queued);
    assert_eq!(stored.revision, 9);
}

#[test]
fn repeated_submission_reads_the_receipt_even_while_admission_is_closed() {
    let mut db = database();
    let known = message("known", "delivered");
    write(&db, "task", &queue(vec![known.clone()]));
    let mut repository = SqliteMessageQueue::new(&mut db);
    let mut input: Message = serde_json::from_value(known).unwrap();
    let submit = |input, admission| Command::Submit {
        message: input,
        expected_run_id: Some("stale"),
        can_start: false,
        has_settings: true,
        admission,
    };
    let retry = apply(
        &mut repository,
        "task",
        submit(input.clone(), Err(QueueConflict("Maintenance"))),
    )
    .unwrap();
    assert!(!retry.changed);
    assert!(retry.claimed.is_none());
    input.fingerprint = "different".into();
    let changed = apply(&mut repository, "task", submit(input, Ok(())));
    assert!(
        matches!(changed, Err(QueueError::Conflict(error)) if error.0.contains("different content"))
    );
    assert_eq!(read(&db, "task").revision, 7);
}

#[test]
fn a_failed_claim_write_returns_no_delivery_effect() {
    let mut db = database();
    write(&db, "task", &queue(vec![message("first", "queued")]));
    db.execute_batch(
        "CREATE TRIGGER failed_claim BEFORE UPDATE ON task_message_state
         BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;",
    )
    .unwrap();
    let claimed = apply(
        &mut SqliteMessageQueue::new(&mut db),
        "task",
        Command::ClaimNext {
            now: 0,
            can_start: true,
        },
    );
    assert!(matches!(claimed, Err(QueueError::Storage(_))));
    let stored = read(&db, "task");
    assert_eq!(stored.revision, 7);
    assert_eq!(stored.messages[0].status, Status::Queued);
}

#[test]
fn dispatch_start_keeps_status_and_replay_cursor_atomic_with_its_receipt() {
    let mut db = database();
    db.execute_batch(
        "UPDATE tasks SET status='queued', interrupted=1, last_raw_seq=19;
         CREATE TRIGGER failed_start BEFORE UPDATE ON task_message_state
         BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;",
    )
    .unwrap();
    write(&db, "task", &starting_queue(false));
    let failed = apply(
        &mut SqliteMessageQueue::new(&mut db),
        "task",
        Command::StartingRuntime {
            run_id: "run",
            now: 42,
        },
    );
    assert!(matches!(failed, Err(QueueError::Storage(_))));
    assert_eq!(status(&db, "task"), ("queued".into(), true));
    assert_eq!(read(&db, "task").runtime_started, Some(false));
    db.execute_batch("DROP TRIGGER failed_start").unwrap();

    let mut repository = SqliteMessageQueue::new(&mut db);
    let stale = apply(
        &mut repository,
        "task",
        Command::StartingRuntime {
            run_id: "old",
            now: 42,
        },
    );
    assert!(matches!(stale, Err(QueueError::Conflict(_))));
    let started = apply(
        &mut repository,
        "task",
        Command::StartingRuntime {
            run_id: "run",
            now: 42,
        },
    )
    .unwrap();
    assert!(started.changed);
    let repeated = apply(
        &mut repository,
        "task",
        Command::StartingRuntime {
            run_id: "run",
            now: 44,
        },
    );
    assert!(matches!(repeated, Err(QueueError::Conflict(_))));
    assert_eq!(read(&db, "task").runtime_started, Some(true));
    assert_eq!(status(&db, "task"), ("running".into(), false));
    let cursor: i64 = db
        .query_row(
            "SELECT last_raw_seq FROM tasks WHERE id='task'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cursor, 0);
    assert_eq!(read(&db, "task").revision, 8);
}

#[derive(Default)]
struct Host {
    independent: bool,
    live: Vec<String>,
    reattached: Vec<String>,
}

impl ExecutionRecovery for Host {
    fn independent(&self) -> bool {
        self.independent
    }
    fn list_live(&mut self) -> Result<Vec<String>> {
        Ok(self.live.clone())
    }
    fn reattach(&mut self, task: &RecoveryTask) -> Result<()> {
        self.reattached.push(task.id.clone());
        Ok(())
    }
}

fn starting_queue(runtime_started: bool) -> Value {
    let mut initial = message("initial", "sending");
    initial["runId"] = json!("run");
    let mut state = queue(vec![
        initial,
        message("followup", "sending"),
        message("next", "queued"),
    ]);
    state["runId"] = json!("run");
    state["initialMessageId"] = json!("initial");
    state["runtimeStarted"] = json!(runtime_started);
    state["compaction"] = json!({"requestId": "compact", "status": "running"});
    state
}

#[test]
fn missing_independent_identity_stops_recovery_before_any_host_or_sqlite_effect() {
    let mut db = database();
    db.execute_batch(
        "UPDATE tasks SET status='running' WHERE id='task';
         INSERT INTO tasks(id, status) VALUES ('missing', 'queued');",
    )
    .unwrap();
    write(&db, "task", &starting_queue(true));
    let mut host = Host {
        independent: true,
        live: vec!["task".into()],
        ..Host::default()
    };
    let error = recover(&mut SqliteRecovery::new(&mut db), &mut host, 42).unwrap_err();
    assert!(error.to_string().contains("no execution identity"));
    assert!(host.reattached.is_empty());
    assert_eq!(read(&db, "task").revision, 7);
    assert_eq!(status(&db, "missing"), ("queued".into(), false));
}

#[test]
fn retained_and_interrupted_runs_recover_without_resending_unconfirmed_messages() {
    let mut db = database();
    db.execute_batch(
        r#"UPDATE tasks SET status='running' WHERE id='task';
         INSERT INTO tasks(id, status) VALUES ('orphan', 'awaiting_approval');
         INSERT INTO tasks(id, status, session_control)
            VALUES ('shared', 'running', '{"owner":"shared"}');"#,
    )
    .unwrap();
    write(&db, "task", &starting_queue(true));
    write(&db, "orphan", &starting_queue(false));
    write(&db, "shared", &starting_queue(true));
    let mut host = Host {
        live: vec!["task".into()],
        ..Host::default()
    };
    let result = recover(&mut SqliteRecovery::new(&mut db), &mut host, 42).unwrap();
    assert_eq!(result.reattached, ["task"]);
    assert_eq!(result.interrupted, ["orphan"]);
    assert_eq!(status(&db, "task"), ("running".into(), false));
    assert_eq!(status(&db, "shared"), ("running".into(), false));
    assert_eq!(status(&db, "orphan"), ("idle".into(), true));

    let orphan = read(&db, "orphan");
    assert!(orphan.paused);
    assert_eq!(orphan.run_id, None);
    assert_eq!(orphan.messages[0].run_id, None);
    assert_eq!(orphan.messages[0].status, Status::Queued);
    assert_eq!(orphan.messages[1].status, Status::Unknown);
    assert_eq!(orphan.compaction.unwrap().status, CompactionStatus::Failed);
    for id in ["task", "shared"] {
        let retained = read(&db, id);
        assert_eq!(retained.messages[0].status, Status::Unknown);
        assert_eq!(retained.run_id.as_deref(), Some("run"));
        assert_eq!(
            retained.compaction.unwrap().status,
            CompactionStatus::Running
        );
    }

    let mut repository = SqliteMessageQueue::new(&mut db);
    assert!(matches!(
        apply(&mut repository, "orphan", Command::Resume),
        Err(QueueError::Conflict(_))
    ));
    apply(
        &mut repository,
        "orphan",
        Command::Delivered { id: "followup" },
    )
    .unwrap();
    let late_failure = apply(
        &mut repository,
        "orphan",
        Command::SettleSteer {
            id: "followup",
            delivery: Delivery::ReceiptLost,
        },
    )
    .unwrap();
    assert!(!late_failure.changed);
    let saved = read(&db, "orphan");
    assert!(saved.paused);
    assert_eq!(saved.messages[1].status, Status::Delivered);
}

#[test]
fn recovery_rolls_back_task_reset_and_preceding_queue_writes_on_corrupt_state() {
    let mut db = database();
    db.execute_batch(
        "UPDATE tasks SET status='running' WHERE id='task';
         INSERT INTO tasks(id, status) VALUES ('z-corrupt', 'idle');
         INSERT INTO task_message_state(task_id,state) VALUES ('z-corrupt', '{not json');",
    )
    .unwrap();
    write(&db, "task", &starting_queue(true));
    let result = recover(&mut SqliteRecovery::new(&mut db), &mut Host::default(), 42);
    assert!(result.is_err());
    assert_eq!(status(&db, "task"), ("running".into(), false));
    assert_eq!(read(&db, "task").revision, 7);
    assert_eq!(read(&db, "task").messages[0].status, Status::Sending);
}

fn status(db: &Connection, id: &str) -> (String, bool) {
    db.query_row(
        "SELECT status, interrupted FROM tasks WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[test]
fn replay_rebuilds_terminal_evidence_and_ignores_callbacks_from_an_old_turn() {
    let mut turns = Turns::default();
    let old = turns
        .track("task".into(), Some("old-run".into()), 0)
        .unwrap();
    let current = turns.track("task".into(), Some("run".into()), 4).unwrap();
    assert!(!turns.may_start(&old, Some("old-run")));
    assert!(!turns.may_start(&current, Some("old-run")));
    assert!(turns.may_start(&current, Some("run")));
    assert!(turns.finish(&old).is_none());
    assert_eq!(
        turns.observe(
            &old,
            Some("session"),
            Some("session"),
            Some(5),
            TurnEvent::ReattachFailed
        ),
        Disposition::Ignore,
    );
    assert_eq!(
        turns.observe(
            &current,
            Some("session"),
            Some("session"),
            Some(3),
            TurnEvent::Error(Some("transient"))
        ),
        Disposition::Replay,
    );
    assert_eq!(
        turns.observe(
            &current,
            Some("session"),
            Some("session"),
            Some(4),
            TurnEvent::Result { failed: false }
        ),
        Disposition::Replay,
    );
    let terminal = turns.finish(&current).unwrap();
    assert!(
        !terminal.failed(true, false),
        "compaction requires the replayed terminal result"
    );

    let next = turns.track("task".into(), Some("next".into()), 0).unwrap();
    assert_eq!(
        turns.observe(
            &next,
            Some("session"),
            Some("different"),
            Some(1),
            TurnEvent::Output
        ),
        Disposition::StopForSessionMismatch,
    );
    assert_eq!(
        turns.observe(
            &next,
            Some("session"),
            Some("session"),
            Some(2),
            TurnEvent::Result { failed: false }
        ),
        Disposition::Ignore,
    );
    assert!(turns.finish(&next).unwrap().failed(false, false));
}
