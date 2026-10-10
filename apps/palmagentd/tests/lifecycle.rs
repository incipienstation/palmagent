#![cfg(target_os = "linux")]

use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Fixture {
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
        ] {
            let path = data.join(directory);
            fs::create_dir_all(&path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let release = data.join("releases/r1");
        let binary = release.join("palmagentd");
        fs::copy(env!("CARGO_BIN_EXE_palmagentd"), &binary).unwrap();
        fs::copy("/bin/sh", data.join("runtimes/sh")).unwrap();
        for file in ["server.js", "execution-host.js", "terminal-host.js"] {
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
            data,
            binary,
            daemon,
            hosts: vec![],
        };
        wait(|| {
            fixture
                .try_request(json!({ "action": "status" }))
                .is_some_and(|status| status["web"]["alive"] == true)
        });
        fixture
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
        let directory = self.data.join(if kind == "terminal" {
            "terminals"
        } else {
            "executions"
        });
        write(
            &directory.join(format!("{id}.json")),
            &json!({ "protocol": 1, "id": id, "directory": directory,
            "release": self.data.join("releases/r1"), "node": self.data.join("runtimes/sh") }),
        );
        self.hosts.push((kind.into(), id.into()));
        self.request(json!({ "action": "launch", "kind": kind, "id": id }))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Fixture cleanup signals only recorded guardian identities from this private installation.
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
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if self.try_request(json!({ "action": "stop" })).is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
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
