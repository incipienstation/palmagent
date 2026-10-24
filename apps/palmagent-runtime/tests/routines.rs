use palmagent_runtime::modules::routines::{
    adapters::outbound::sqlite::SqliteRepository,
    application::{Completion, Environment, Job, Prepared, Repository, Service},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
};

struct Clock {
    now: Arc<AtomicI64>,
    updating: Arc<AtomicBool>,
    ids: AtomicU64,
}
impl Environment for Clock {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn id(&self) -> anyhow::Result<String> {
        Ok(format!("{:032x}", self.ids.fetch_add(1, Ordering::SeqCst)))
    }
    fn next_run(&self, schedule: &str, from: i64) -> Result<Option<i64>, String> {
        palmagent_runtime::modules::routines::domain::Cron::parse(schedule)?;
        Ok(Some((from / 60_000 + 1) * 60_000))
    }
    fn updating(&self) -> bool {
        self.updating.load(Ordering::SeqCst)
    }
}
struct Fixture {
    directory: PathBuf,
    clock: Arc<AtomicI64>,
    updating: Arc<AtomicBool>,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "palmagent-runtime-test-{}-{}",
            std::process::id(),
            palmagent_runtime::platform::unique_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let connection = Connection::open(directory.join("db")).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE repos (id TEXT PRIMARY KEY,path TEXT NOT NULL,default_base_ref TEXT NOT NULL,vcs TEXT NOT NULL);
            INSERT INTO repos VALUES ('space','/fixture','HEAD','none');
            CREATE TABLE routines (id TEXT PRIMARY KEY,repo_id TEXT NOT NULL REFERENCES repos(id),kind TEXT NOT NULL,script_json TEXT,
                agent TEXT NOT NULL,title TEXT,prompt TEXT NOT NULL,permission TEXT NOT NULL,model TEXT,effort TEXT,preset TEXT NOT NULL,schedule TEXT NOT NULL,
                enabled INTEGER NOT NULL,last_run_at INTEGER,next_run_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
            CREATE TABLE routine_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,routine_id TEXT NOT NULL,fired_at INTEGER NOT NULL,status TEXT NOT NULL,task_id TEXT,note TEXT,result_json TEXT);").unwrap();
        Self {
            directory,
            clock: Arc::new(AtomicI64::new(1_800_000)),
            updating: Arc::new(AtomicBool::new(false)),
        }
    }
    fn repository(&self) -> SqliteRepository {
        SqliteRepository::open(&self.directory.join("db")).unwrap()
    }
    fn environment(&self) -> Clock {
        Clock {
            now: self.clock.clone(),
            updating: self.updating.clone(),
            ids: AtomicU64::new(1),
        }
    }
    fn service(&self) -> Service {
        Service::new(Box::new(self.repository()), Box::new(self.environment())).unwrap()
    }
    fn connection(&self) -> Connection {
        Connection::open(self.directory.join("db")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn create(service: &mut Service, preset: &str) -> String {
    service.create(json!({"repoId":"space","kind":"script","script":{"command":"true","timeoutSeconds":99},"preset":preset})).unwrap()["routine"]["id"].as_str().unwrap().to_owned()
}
fn launch(service: &mut Service, routine: &str) -> i64 {
    let (_, jobs) = service.run(routine).unwrap();
    let [Job::Prepare { id, .. }] = jobs.as_slice() else {
        panic!("expected one preparation")
    };
    let id = *id;
    service.complete(Completion::Prepared(
        id,
        Ok(Prepared {
            cwd: "/fixture".into(),
            worktree: None,
        }),
    ));
    let jobs = service.poll(false);
    assert!(matches!(jobs.as_slice(), [Job::Launch { id: launched, .. }] if *launched == id));
    service.complete(Completion::Launched(id));
    id
}

#[test]
fn preserves_script_validation_cadence_and_patch_defaults() {
    let fixture = Fixture::new();
    let mut service = fixture.service();
    let id = create(&mut service, "hourly");
    let before = service.get(&id).unwrap();
    assert_eq!(before.schedule, "0 * * * *");
    assert_eq!(before.next_run_at, Some(1_860_000));
    let patched = service
        .update(
            &id,
            json!({"script":{"command":"  printf ok  "},"title":""}),
        )
        .unwrap();
    assert_eq!(
        patched["routine"]["script"],
        json!({"command":"printf ok","timeoutSeconds":99})
    );
    assert!(patched["routine"].get("title").is_none());
    for input in [
        json!({"agent":"claude"}),
        json!({"prompt":"hello"}),
        json!({"repoId":"other"}),
        json!({"script":{"command":" "}}),
        json!({"hour":24}),
    ] {
        assert_eq!(service.update(&id, input).unwrap_err().status, 400);
    }
    service
        .update(&id, json!({"preset":"weekly","hour":10,"dayOfWeek":2}))
        .unwrap();
    assert_eq!(service.get(&id).unwrap().schedule, "0 10 * * 2");
    service.update(&id, json!({"hour":12})).unwrap();
    assert_eq!(service.get(&id).unwrap().schedule, "0 12 * * 2");
    service.update(&id, json!({"enabled":false})).unwrap();
    assert!(service.get(&id).unwrap().next_run_at.is_none());
    service
        .update(&id, json!({"enabled":true,"preset":"manual"}))
        .unwrap();
    assert!(service.get(&id).unwrap().next_run_at.is_none());
}

#[test]
fn uncertain_launch_is_only_inspected_and_completed_results_survive_sqlite_contention() {
    let fixture = Fixture::new();
    let mut service = fixture.service();
    let id = create(&mut service, "hourly");
    let cadence = service.get(&id).unwrap().next_run_at;
    let run = launch(&mut service, &id);
    assert_eq!(
        service.get(&id).unwrap().next_run_at,
        cadence,
        "manual runs preserve cadence"
    );
    for _ in 0..3 {
        assert!(matches!(service.poll(true).as_slice(), [Job::Inspect { id, .. }] if *id == run));
        service.complete(Completion::Inspected(run, None));
        assert!(
            service.poll(false).is_empty(),
            "no hot-loop inspection or replay"
        );
    }
    assert_eq!(service.run(&id).unwrap_err().status, 409);
    assert_eq!(service.remove(&id).unwrap_err().status, 409);
    let connection = fixture.connection();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    service.complete(Completion::Inspected(
        run,
        Some(json!({"status":"succeeded","finishedAt":1_800_010,"output":"ok","exitCode":0})),
    ));
    assert!(service.poll(true).is_empty());
    assert_eq!(
        service.active(),
        1,
        "a result awaiting persistence retains its slot"
    );
    connection.execute_batch("ROLLBACK").unwrap();
    assert!(matches!(service.poll(true).as_slice(), [Job::Acknowledge { id }] if *id == run));
    service.complete(Completion::Acknowledged(run, false));
    assert!(matches!(
        service.poll(true).as_slice(),
        [Job::Acknowledge { .. }]
    ));
    service.complete(Completion::Acknowledged(run, true));
    assert_eq!(service.active(), 0);
    assert_eq!(service.runs(&id).unwrap()["runs"][0]["output"], "ok");
    assert!(service.run(&id).is_ok());
}

#[test]
fn admission_and_cadence_rollback_together_before_any_launch() {
    let fixture = Fixture::new();
    let mut service = fixture.service();
    let id = create(&mut service, "hourly");
    let original = serde_json::to_value(service.get(&id).unwrap()).unwrap();
    fixture.connection().execute_batch("CREATE TRIGGER reject_run BEFORE INSERT ON routine_runs BEGIN SELECT RAISE(ABORT,'unavailable'); END;").unwrap();
    fixture.clock.store(1_900_000, Ordering::SeqCst);
    assert_eq!(service.run(&id).unwrap_err().status, 503);
    assert_eq!(
        serde_json::to_value(service.get(&id).unwrap()).unwrap(),
        original
    );
    assert_eq!(service.active(), 0);
    assert!(service.poll(true).is_empty());
    assert_eq!(service.runs(&id).unwrap()["runs"], json!([]));
}

#[test]
fn scheduled_capacity_and_maintenance_preserve_admission_rules() {
    let fixture = Fixture::new();
    let mut service = fixture.service();
    let ids: Vec<_> = (0..5).map(|_| create(&mut service, "hourly")).collect();
    fixture.clock.store(1_860_000, Ordering::SeqCst);
    fixture.updating.store(true, Ordering::SeqCst);
    assert!(service.poll(true).is_empty());
    assert_eq!(service.run(&ids[0]).unwrap_err().status, 503);
    fixture.updating.store(false, Ordering::SeqCst);
    assert_eq!(service.poll(true).len(), 4);
    assert_eq!(service.active(), 4);
    let runs: Vec<Value> = ids
        .iter()
        .map(|id| service.runs(id).unwrap()["runs"][0].clone())
        .collect();
    assert_eq!(runs.iter().filter(|r| r["status"] == "running").count(), 4);
    assert_eq!(runs.iter().filter(|r| r["status"] == "skipped").count(), 1);
    for id in ids {
        assert_eq!(service.get(&id).unwrap().next_run_at, Some(1_920_000));
    }
}

#[test]
fn runtime_restart_reconciles_retained_runs_and_skips_only_script_backlog() {
    let fixture = Fixture::new();
    let mut service = fixture.service();
    let id = create(&mut service, "hourly");
    let run = launch(&mut service, &id);
    fixture.connection().execute_batch("INSERT INTO routines SELECT 'agent-routine',repo_id,'agent',NULL,agent,title,'prompt',permission,model,effort,preset,schedule,enabled,last_run_at,next_run_at,created_at,updated_at FROM routines LIMIT 1;").unwrap();
    drop(service);
    fixture.clock.store(2_000_000, Ordering::SeqCst);
    let mut restarted = fixture.service();
    assert_eq!(restarted.active(), 1);
    assert!(matches!(restarted.poll(true).as_slice(), [Job::Inspect { id, .. }] if *id == run));
    let history = restarted.runs(&id).unwrap();
    assert_eq!(history["runs"][0]["status"], "skipped");
    assert_eq!(history["runs"][0]["reason"], "missed_while_down");
    let agent_next: i64 = fixture
        .connection()
        .query_row(
            "SELECT next_run_at FROM routines WHERE id='agent-routine'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(agent_next, 1_860_000);
    assert_eq!(fixture.repository().list().unwrap().len(), 1);
}
