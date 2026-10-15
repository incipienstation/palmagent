#![cfg(target_os = "linux")]

use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

// Avoid inheriting another test thread's briefly writable executable across fork.
static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

struct Fixture {
    _exclusive: MutexGuard<'static, ()>,
    data: PathBuf,
    binary: PathBuf,
    daemon: Child,
    hosts: Vec<(String, String)>,
}

fn write(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn wait(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        thread::sleep(Duration::from_millis(30));
    }
    panic!("condition timed out");
}

impl Fixture {
    fn new() -> Self {
        let exclusive = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data =
            std::env::temp_dir().join(format!("palmagentd-test-{}-{suffix}", std::process::id()));
        for directory in [
            "",
            "daemon",
            "releases/r1",
            "runtimes",
            "executions",
            "terminals",
            "routines",
        ] {
            let path = data.join(directory);
            fs::create_dir_all(&path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let release = data.join("releases/r1");
        let binary = release.join("palmagentd");
        fs::copy(env!("CARGO_BIN_EXE_palmagentd"), &binary).unwrap();
        fs::copy("/bin/sh", data.join("runtimes/sh")).unwrap();
        for file in [
            "server.js",
            "execution-host.js",
            "terminal-host.js",
            "routine-host.js",
        ] {
            fs::write(
                release.join(file),
                "trap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
            )
            .unwrap();
        }
        fs::write(release.join("cli.js"), "printf done > update-finished\n").unwrap();
        write(
            &data.join("daemon/config.json"),
            &json!({
                "protocol": 1, "daemon": binary, "release": release, "node": data.join("runtimes/sh"),
                "environment": { "PATH": "/usr/bin:/bin" }, "isolation": "process-group",
                "limits": { "memoryHigh": 1024, "memoryMax": 2048, "tasks": 64, "webTasks": 64, "cpuPercent": 100, "nofile": 1024 }
            }),
        );
        let daemon = Command::new(&binary)
            .args(["serve", "--data-dir"])
            .arg(&data)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let fixture = Self {
            _exclusive: exclusive,
            data,
            binary,
            daemon,
            hosts: vec![],
        };
        wait(|| {
            fixture
                .try_request(json!({ "action": "status" }))
                .is_some_and(|status| status["web"]["child"]["pid"].is_u64())
        });
        fixture
    }

    fn socket(&self) -> PathBuf {
        use sha2::{Digest, Sha256};
        let hash = format!(
            "{:x}",
            Sha256::digest(self.data.as_os_str().as_encoded_bytes())
        );
        PathBuf::from(format!(
            "/tmp/palmagentd-{}-{}/control.sock",
            unsafe { libc::geteuid() },
            &hash[..20]
        ))
    }

    fn send(&self, request: Value) -> UnixStream {
        let mut stream = UnixStream::connect(self.socket()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
        writeln!(stream, "{}", json!({ "protocol": 1, "request": request })).unwrap();
        stream
    }

    fn configure_guardian(&self, binary: &Path) {
        let path = self.data.join("daemon/config.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        config["daemon"] = json!(binary);
        write(&path, &config);
        self.request(json!({ "action": "restart-web" }));
    }

    fn descriptor(&mut self, kind: &str, id: &str) {
        let directory = self.data.join(match kind {
            "terminal" => "terminals",
            "routine" => "routines",
            _ => "executions",
        });
        write(
            &directory.join(format!("{id}.json")),
            &json!({
                "protocol": 1, "id": id, "directory": directory,
                "release": self.data.join("releases/r1"), "node": self.data.join("runtimes/sh"),
            }),
        );
        self.hosts.push((kind.into(), id.into()));
    }

    fn try_request(&self, request: Value) -> Option<Value> {
        let mut command = Command::new(&self.binary)
            .args(["request", "--data-dir"])
            .arg(&self.data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        command
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let output = command.wait_with_output().unwrap();
        output
            .status
            .success()
            .then(|| serde_json::from_slice(&output.stdout).unwrap())
    }

    fn request(&self, request: Value) -> Value {
        self.try_request(request).expect("daemon request failed")
    }

    fn launch(&mut self, kind: &str, id: &str) -> Value {
        self.descriptor(kind, id);
        self.request(json!({ "action": "launch", "kind": kind, "id": id }))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Delayed test guardians may acquire ownership while cleanup is in progress.
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            for (kind, id) in &self.hosts {
                let path = self
                    .data
                    .join("daemon/hosts")
                    .join(format!("{kind}-{id}.json"));
                if let Ok(bytes) = fs::read(path) {
                    let record: Value = serde_json::from_slice(&bytes).unwrap();
                    if let Some(pid) = record["guard"]["pid"].as_i64() {
                        unsafe {
                            libc::kill(pid as i32, libc::SIGTERM);
                        }
                    }
                }
            }
            if self.try_request(json!({ "action": "stop" })).is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = fs::remove_dir(self.socket().parent().unwrap());
        let _ = fs::remove_dir_all(&self.data);
    }
}

#[test]
fn hosts_and_web_survive_daemon_replacement_and_crash_without_duplicate_launches() {
    let mut fixture = Fixture::new();
    let id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    let execution = fixture.launch("execution", id);
    let duplicate = fixture.request(json!({ "action": "launch", "kind": "execution", "id": id }));
    assert_eq!(execution["child"], duplicate["child"]);
    let routine = fixture.launch("routine", "abcd");
    let before = fixture.request(json!({ "action": "status" }));
    fixture.request(json!({ "action": "replace" }));
    wait(|| {
        fixture
            .try_request(json!({ "action": "status" }))
            .is_some_and(|status| status["instance"] != before["instance"])
    });
    let after = fixture.request(json!({ "action": "status" }));
    assert_eq!(before["pid"], after["pid"]);
    assert_eq!(before["web"]["child"], after["web"]["child"]);
    fixture.daemon.kill().unwrap();
    fixture.daemon.wait().unwrap();
    fixture.daemon = Command::new(&fixture.binary)
        .args(["serve", "--data-dir"])
        .arg(&fixture.data)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait(|| fixture.try_request(json!({ "action": "status" })).is_some());
    let recovered = fixture.request(json!({ "action": "inspect", "kind": "execution", "id": id }));
    assert_eq!(execution["child"], recovered["child"]);
    assert_eq!(
        before["web"]["child"],
        fixture.request(json!({ "action": "status" }))["web"]["child"]
    );
    fixture.request(json!({ "action": "restart-web" }));
    let recovered_routine =
        fixture.request(json!({ "action": "inspect", "kind": "routine", "id": "abcd" }));
    assert_eq!(routine["child"], recovered_routine["child"]);
    let duplicate_routine =
        fixture.request(json!({ "action": "launch", "kind": "routine", "id": "abcd" }));
    assert_eq!(routine["child"], duplicate_routine["child"]);
    assert!(fixture.try_request(json!({ "action": "stop" })).is_none());
}

#[test]
fn terminated_terminal_cannot_be_recreated_by_a_retried_launch() {
    let mut fixture = Fixture::new();
    let id = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    fixture.launch("terminal", id);
    let stopped = fixture.request(json!({ "action": "terminate", "kind": "terminal", "id": id }));
    assert_eq!(stopped["alive"], false);
    let retried = fixture.request(json!({ "action": "launch", "kind": "terminal", "id": id }));
    assert_eq!(retried["alive"], false);
    assert_eq!(retried["state"], "exited");
}

#[test]
fn lifecycle_lock_rejects_a_second_daemon_and_private_descriptors_are_required() {
    let mut fixture = Fixture::new();
    let result = Command::new(&fixture.binary)
        .args(["serve", "--data-dir"])
        .arg(&fixture.data)
        .output()
        .unwrap();
    assert!(!result.status.success());
    let id = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    fixture.launch("terminal", id);
    let forged = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    fs::copy(
        fixture.data.join("terminals").join(format!("{id}.json")),
        fixture
            .data
            .join("terminals")
            .join(format!("{forged}.json")),
    )
    .unwrap();
    assert!(
        fixture
            .try_request(json!({ "action": "launch", "kind": "terminal", "id": forged }))
            .is_none()
    );
    assert!(
        fixture
            .try_request(json!({ "action": "launch", "kind": "terminal", "id": "../../outside" }))
            .is_none()
    );
}

#[test]
fn update_executor_is_independent_and_finishes_without_a_web_request() {
    let fixture = Fixture::new();
    fixture.request(json!({ "action": "start-update" }));
    wait(|| fixture.data.join("releases/r1/update-finished").exists());
}

#[test]
fn incompatible_protocol_is_rejected_before_mutation() {
    use sha2::{Digest, Sha256};
    use std::{
        io::{BufRead, BufReader},
        os::unix::net::UnixStream,
    };
    let fixture = Fixture::new();
    let hash = format!(
        "{:x}",
        Sha256::digest(fixture.data.as_os_str().as_encoded_bytes())
    );
    let socket = PathBuf::from("/tmp").join(format!(
        "palmagentd-{}-{}/control.sock",
        unsafe { libc::geteuid() },
        &hash[..20]
    ));
    let mut stream = UnixStream::connect(socket).unwrap();
    writeln!(
        stream,
        "{}",
        json!({ "protocol": 999, "request": { "action": "stop" } })
    )
    .unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["ok"], false);
    assert_eq!(
        fixture.request(json!({ "action": "status" }))["protocol"],
        1
    );
}

#[test]
fn bootstrap_scope_preserves_isolation_and_escapes_paths() {
    let fixture = Fixture::new();
    for scope in ["user", "system"] {
        let output = Command::new(&fixture.binary)
            .args(["bootstrap-unit", "--data-dir"])
            .arg(&fixture.data)
            .args([
                "--executable",
                "/example/a % $ daemon",
                "--user",
                "owner",
                "--group",
                "owner",
                "--scope",
                scope,
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("Delegate=cpu memory pids"));
        assert!(text.contains("DelegateSubgroup=control"));
        assert!(text.contains("KillMode=process"));
        assert!(text.contains("/example/a %% $$ daemon"));
        assert_eq!(text.contains("User=owner"), scope == "system");
        assert_eq!(text.contains("WantedBy=default.target"), scope == "user");
    }
}

struct ReleaseOnDrop(PathBuf);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "continue");
    }
}

fn reply(stream: UnixStream) -> Value {
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn failed_guardian_spawn_is_terminal_and_web_recovers_after_repair() {
    let mut fixture = Fixture::new();
    let guardian = fixture.data.join("releases/r1/guardian");
    fs::copy(&fixture.binary, &guardian).unwrap();
    fixture.configure_guardian(&guardian);
    fs::set_permissions(&guardian, fs::Permissions::from_mode(0o600)).unwrap();
    let id = "bad001";
    fixture.descriptor("terminal", id);
    assert!(
        fixture
            .try_request(json!({ "action": "launch", "kind": "terminal", "id": id }))
            .is_none()
    );
    let failed = fixture.request(json!({ "action": "inspect", "kind": "terminal", "id": id }));
    assert_eq!(failed["state"], "exited");
    assert_eq!(failed["alive"], false);
    assert_eq!(failed["exitCode"], -1);
    assert!(failed["guard"].is_null());
    assert!(
        fixture
            .try_request(json!({ "action": "restart-web" }))
            .is_none()
    );
    let failed_web = fixture.request(json!({ "action": "status" }))["web"].clone();
    assert_eq!(failed_web["state"], "exited");
    assert_eq!(failed_web["alive"], false);
    fs::set_permissions(&guardian, fs::Permissions::from_mode(0o755)).unwrap();
    wait(|| fixture.request(json!({ "action": "status" }))["web"]["child"]["pid"].is_u64());
    // Repair permits a new web identity, but a repeated task identity cannot start again.
    let retried = fixture.request(json!({ "action": "launch", "kind": "terminal", "id": id }));
    assert_eq!(retried["state"], "exited");
    assert!(retried["child"].is_null());
}

#[test]
fn uncertain_reservation_remains_owned_without_relaunch() {
    let fixture = Fixture::new();
    let hosts = fixture.data.join("daemon/hosts");
    let path = fs::read_dir(&hosts)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .unwrap();
    let mut record: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    record["kind"] = json!("terminal");
    record["id"] = json!("abc001");
    record["state"] = json!("starting");
    record["guard"] = Value::Null;
    record["child"] = Value::Null;
    let path = hosts.join("terminal-abc001.json");
    write(&path, &record);
    let result = fixture.request(json!({ "action": "launch", "kind": "terminal", "id": "abc001" }));
    assert_eq!(result["state"], "unknown");
    assert_eq!(result["alive"], true);
    assert!(result["child"].is_null());
    assert!(fixture.try_request(json!({ "action": "stop" })).is_none());
    // Retire only this synthetic reservation, which never had a guardian or child.
    record["state"] = json!("exited");
    write(&path, &record);
}

#[test]
fn slow_frames_do_not_block_status_and_have_an_absolute_deadline() {
    let fixture = Fixture::new();
    let mut slow = UnixStream::connect(fixture.socket()).unwrap();
    slow.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    slow.write_all(b"{").unwrap();
    thread::sleep(Duration::from_millis(100));
    let start = Instant::now();
    fixture.request(json!({ "action": "status" }));
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "status waited for an incomplete frame"
    );
    // Keep making read progress. The overall deadline must still expire.
    for _ in 0..4 {
        thread::sleep(Duration::from_millis(350));
        slow.write_all(b" ").unwrap();
    }
    let response = reply(slow);
    assert_eq!(response["ok"], false);
    assert!(response["error"].as_str().unwrap().contains("deadline"));
    let mut oversized = UnixStream::connect(fixture.socket()).unwrap();
    oversized
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    oversized.write_all(&vec![b' '; 65_537]).unwrap();
    let response = reply(oversized);
    assert_eq!(response["ok"], false);
    assert!(response["error"].as_str().unwrap().contains("too large"));
    fixture.request(json!({ "action": "status" }));
}

#[test]
fn launch_wait_keeps_status_and_web_recovery_responsive() {
    let mut fixture = Fixture::new();
    let directory = fixture.data.join("releases/r1");
    let guardian = directory.join("delayed-guardian");
    let entered = directory.join("entered");
    let release = directory.join("release");
    let _release_on_drop = ReleaseOnDrop(release.clone());
    fs::write(&guardian, format!(
        "#!/bin/sh\nif [ \"$5\" = terminal ]; then touch '{}'; while [ ! -e '{}' ]; do sleep 0.05; done; fi\nexec '{}' \"$@\"\n",
        entered.display(), release.display(), fixture.binary.display(),
    )).unwrap();
    fs::set_permissions(&guardian, fs::Permissions::from_mode(0o700)).unwrap();
    fixture.configure_guardian(&guardian);
    let before = fixture.request(json!({ "action": "status" }));
    fixture.descriptor("terminal", "abc002");
    let launch = fixture.send(json!({ "action": "launch", "kind": "terminal", "id": "abc002" }));
    wait(|| entered.exists());
    let start = Instant::now();
    fixture.request(json!({ "action": "status" }));
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "status waited for host readiness"
    );
    unsafe {
        libc::kill(
            before["web"]["guard"]["pid"].as_i64().unwrap() as i32,
            libc::SIGTERM,
        );
    }
    wait(|| {
        let web = fixture.request(json!({ "action": "status" }))["web"].clone();
        web["child"]["pid"].is_u64() && web["child"] != before["web"]["child"]
    });
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "web recovery waited for another launch"
    );
    fs::write(&release, "continue").unwrap();
    assert_eq!(reply(launch)["ok"], true);
}

#[test]
fn disconnected_restart_finishes_while_status_bypasses_serialized_mutations() {
    let mut fixture = Fixture::new();
    let directory = fixture.data.join("releases/r1");
    let entered = directory.join("stopping");
    let release = directory.join("release-stop");
    let _release_on_drop = ReleaseOnDrop(release.clone());
    fs::write(directory.join("server.js"), format!(
        "trap 'touch \"{}\"; while [ ! -e \"{}\" ]; do sleep 0.05; done; exit 0' TERM INT\nwhile :; do sleep 0.1; done\n",
        entered.display(), release.display(),
    )).unwrap();
    fixture.request(json!({ "action": "restart-web" }));
    let before = fixture.request(json!({ "action": "status" }));
    let restart = fixture.send(json!({ "action": "restart-web" }));
    wait(|| entered.exists());
    drop(restart);
    fixture.descriptor("terminal", "abc003");
    let launch = fixture.send(json!({ "action": "launch", "kind": "terminal", "id": "abc003" }));
    let start = Instant::now();
    fixture.request(json!({ "action": "status" }));
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "status waited for web shutdown"
    );
    assert!(
        !fixture
            .data
            .join("daemon/hosts/terminal-abc003.json")
            .exists(),
        "mutations overlapped the web transition"
    );
    fs::write(&release, "continue").unwrap();
    assert_eq!(reply(launch)["ok"], true);
    let after = fixture.request(json!({ "action": "status" }));
    assert_ne!(before["web"]["child"], after["web"]["child"]);
    assert!(after["web"]["child"]["pid"].is_u64());
}

fn host_record(fixture: &Fixture, kind: &str, id: &str) -> (PathBuf, Value) {
    let path = fixture
        .data
        .join("daemon/hosts")
        .join(format!("{kind}-{id}.json"));
    let value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    (path, value)
}
fn readiness_manifest(fixture: &Fixture) {
    fs::create_dir_all(fixture.data.join("releases/r1/daemon")).unwrap();
    fs::write(
        fixture.data.join("releases/r1/daemon/manifest.json"),
        r#"{"hostReadiness":1}"#,
    )
    .unwrap();
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[test]
fn readiness_requires_the_actual_host_identity_and_survives_daemon_replacement() {
    let mut fixture = Fixture::new();
    readiness_manifest(&fixture);
    fixture.descriptor("terminal", "abc004");
    let stream = fixture.send(json!({"action":"launch","kind":"terminal","id":"abc004"}));
    wait(|| {
        fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc004"}))["child"]["pid"]
            .is_u64()
    });
    let before = fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc004"}));
    assert_eq!(before["lifecycle"]["phase"], "starting");
    let (path, record) = host_record(&fixture, "terminal", "abc004");
    write(
        &path.with_extension("ready"),
        &json!({"pid":record["child"]["pid"],"start":"wrong-identity","readyAt":now_ms()}),
    );
    assert_eq!(
        fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc004"}))["lifecycle"]["phase"],
        "starting"
    );
    fs::write(path.with_extension("ready"), "invalid readiness").unwrap();
    assert_eq!(
        fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc004"}))["lifecycle"]["phase"],
        "starting"
    );
    let mut ready = record["child"].clone();
    ready["readyAt"] = json!(now_ms());
    write(&path.with_extension("ready"), &ready);
    assert_eq!(reply(stream)["result"]["lifecycle"]["phase"], "ready");
    let instance = fixture.request(json!({"action":"status"}))["instance"].clone();
    fixture.request(json!({"action":"replace"}));
    wait(|| {
        fixture
            .try_request(json!({"action":"status"}))
            .is_some_and(|s| s["instance"] != instance)
    });
    let after = fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc004"}));
    assert_eq!(after["child"], before["child"]);
    assert_eq!(after["lifecycle"]["phase"], "ready");
}

#[test]
fn web_startup_deadline_records_the_reason_and_preserves_other_hosts() {
    let mut fixture = Fixture::new();
    let terminal = fixture.launch("terminal", "abc005");
    readiness_manifest(&fixture);
    let web = fixture.request(json!({"action":"status"}))["web"].clone();
    unsafe {
        libc::kill(web["guard"]["pid"].as_i64().unwrap() as i32, libc::SIGTERM);
    }
    wait(|| fixture.request(json!({"action":"status"}))["web"]["lifecycle"]["phase"] == "starting");
    let id: String =
        serde_json::from_slice(&fs::read(fixture.data.join("daemon/web.json")).unwrap()).unwrap();
    wait(|| fixture.request(json!({"action":"status"}))["web"]["child"]["pid"].is_u64());
    let (path, mut record) = host_record(&fixture, "web", &id);
    record["lifecycle"]["createdAt"] = json!(now_ms() - 31_000);
    write(&path, &record);
    // The supervisor stops only the unready web host; the guardian commits the cause.
    wait(|| {
        let state = fixture.request(json!({"action":"inspect","kind":"web","id":id}));
        state["alive"] == false && state["lifecycle"]["reason"] == "readiness_timeout"
    });
    assert_eq!(
        fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc005"}))["child"],
        terminal["child"]
    );
    fs::remove_file(fixture.data.join("releases/r1/daemon/manifest.json")).unwrap();
}

#[test]
fn crash_backoff_is_durable_and_a_repaired_web_recovers() {
    let fixture = Fixture::new();
    let script = fixture.data.join("releases/r1/server.js");
    fs::write(&script, "exit 17\n").unwrap();
    fixture.request(json!({"action":"restart-web"}));
    wait(|| {
        fixture.request(json!({"action":"status"}))["recovery"]["consecutiveFailures"]
            .as_u64()
            .unwrap()
            >= 2
    });
    let before = fixture.request(json!({"action":"status"}));
    let deadline = before["recovery"]["nextAttemptAt"].as_u64().unwrap();
    assert!(deadline > now_ms() + 2_000);
    fixture.request(json!({"action":"replace"}));
    wait(|| {
        fixture
            .try_request(json!({"action":"status"}))
            .is_some_and(|s| s["instance"] != before["instance"])
    });
    assert_eq!(
        fixture.request(json!({"action":"status"}))["recovery"]["nextAttemptAt"],
        deadline
    );
    fs::write(
        &script,
        "trap 'exit 0' TERM INT\nwhile :; do sleep 0.1; done\n",
    )
    .unwrap();
    wait(|| fixture.request(json!({"action":"status"}))["web"]["lifecycle"]["phase"] == "running");
}

#[test]
fn dead_guardian_records_reconcile_without_replaying_the_invocation() {
    let mut fixture = Fixture::new();
    fixture.launch("terminal", "abc006");
    fixture.request(json!({"action":"terminate","kind":"terminal","id":"abc006"}));
    let (path, mut record) = host_record(&fixture, "terminal", "abc006");
    // Model a guardian that died before committing its terminal record, with no remaining child.
    record["state"] = json!("running");
    record["lifecycle"]["finishedAt"] = Value::Null;
    write(&path, &record);
    wait(|| {
        fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc006"}))["lifecycle"]["reason"]
            == "guardian_lost"
    });
    let retried = fixture.request(json!({"action":"launch","kind":"terminal","id":"abc006"}));
    assert_eq!(retried["state"], "exited");
    assert_eq!(retried["child"], record["child"]);
    // In development mode, a missing child identity cannot prove no child escaped spawn.
    let ambiguous_path = fixture.data.join("daemon/hosts/terminal-abc009.json");
    record["id"] = json!("abc009");
    record["child"] = Value::Null;
    write(&ambiguous_path, &record);
    wait(|| {
        fixture.request(json!({"action":"inspect","kind":"terminal","id":"abc009"}))["lifecycle"]["reason"]
            == "guardian_lost"
    });
    let ambiguous = fixture.request(json!({"action":"launch","kind":"terminal","id":"abc009"}));
    assert_eq!(ambiguous["state"], "unknown");
    assert_eq!(ambiguous["alive"], true);
    record["state"] = json!("exited");
    write(&ambiguous_path, &record);
}

#[test]
fn retention_compacts_completed_records_but_keeps_deduplication_and_uncertain_logs() {
    let mut fixture = Fixture::new();
    fixture.launch("terminal", "abc007");
    fixture.request(json!({"action":"terminate","kind":"terminal","id":"abc007"}));
    let (_, template) = host_record(&fixture, "terminal", "abc007");
    let logs = fixture.data.join("daemon/logs");
    for number in 0..40 {
        let id = format!("d{number:04x}");
        let mut record = template.clone();
        record["id"] = json!(id);
        record["guard"] = Value::Null;
        record["child"] = Value::Null;
        record["environment"] = json!({"RETIRED_TEST_VALUE":"discard"});
        record["lifecycle"]["finishedAt"] = json!(now_ms() - 8 * 24 * 60 * 60 * 1000);
        write(
            &fixture
                .data
                .join("daemon/hosts")
                .join(format!("terminal-{id}.json")),
            &record,
        );
        write(
            &logs.join(format!("terminal-{id}-out.log")),
            &json!("old log"),
        );
    }
    let mut uncertain = template.clone();
    uncertain["id"] = json!("ee000");
    uncertain["state"] = json!("starting");
    uncertain["guard"] = Value::Null;
    uncertain["child"] = Value::Null;
    uncertain["lifecycle"]["finishedAt"] = Value::Null;
    let uncertain_path = fixture.data.join("daemon/hosts/terminal-ee000.json");
    write(&uncertain_path, &uncertain);
    let protected = logs.join("terminal-ee000-out.log");
    write(&protected, &json!("keep"));
    wait(|| !logs.join("terminal-d0027-out.log").exists());
    assert!(protected.exists());
    let (_, compacted) = host_record(&fixture, "terminal", "d0000");
    assert_eq!(compacted["environment"], json!({}));
    assert_eq!(compacted["lifecycle"]["compacted"], true);
    assert_eq!(
        fixture.request(json!({"action":"launch","kind":"terminal","id":"d0000"}))["state"],
        "exited"
    );
    let page = fixture.request(json!({"action":"list"}));
    assert_eq!(page["hosts"].as_array().unwrap().len(), 32);
    let next = fixture.request(json!({"action":"list","after":page["next"]}));
    assert!(next["hosts"].as_array().unwrap().len() >= 10);
    assert!(next["next"].is_null());
    assert!(serde_json::to_vec(&page).unwrap().len() < 65_000);
    uncertain["state"] = json!("exited");
    write(&uncertain_path, &uncertain);
}

#[test]
fn total_log_budget_removes_oldest_completed_logs_and_protects_active_output() {
    let mut fixture = Fixture::new();
    fixture.launch("terminal", "abc008");
    fixture.request(json!({"action":"terminate","kind":"terminal","id":"abc008"}));
    let (_, template) = host_record(&fixture, "terminal", "abc008");
    let logs = fixture.data.join("daemon/logs");
    let active: String =
        serde_json::from_slice(&fs::read(fixture.data.join("daemon/web.json")).unwrap()).unwrap();
    let protected = logs.join(format!("web-{active}-out.log"));
    fs::File::create(&protected)
        .unwrap()
        .set_len(4 * 1024 * 1024)
        .unwrap();
    fs::set_permissions(&protected, fs::Permissions::from_mode(0o600)).unwrap();
    for number in 0..17 {
        let id = format!("f{number:04x}");
        let mut record = template.clone();
        record["id"] = json!(id);
        record["guard"] = Value::Null;
        record["child"] = Value::Null;
        record["lifecycle"]["finishedAt"] = json!(now_ms() - 100_000 + number);
        write(
            &fixture
                .data
                .join("daemon/hosts")
                .join(format!("terminal-{id}.json")),
            &record,
        );
        let log = logs.join(format!("terminal-{id}-out.log"));
        fs::File::create(&log)
            .unwrap()
            .set_len(4 * 1024 * 1024)
            .unwrap();
        fs::set_permissions(&log, fs::Permissions::from_mode(0o600)).unwrap();
    }
    wait(|| !logs.join("terminal-f0000-out.log").exists());
    wait(|| fixture.request(json!({"action":"status"}))["inventory"]["overBudget"] == false);
    assert!(protected.exists());
    assert!(logs.join("terminal-f0010-out.log").exists());
    assert_eq!(
        fixture.request(json!({"action":"launch","kind":"terminal","id":"f0000"}))["state"],
        "exited"
    );
}
