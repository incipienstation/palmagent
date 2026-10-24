use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use crate::{
    contract::{Configuration, Descriptor, HostRecord, Kind, Lifecycle, PROTOCOL, State},
    platform::{NativePlatform, ProcessControl, ProcessIsolation, alive},
    storage,
};

pub fn inspect(data: &Path, kind: Kind, id: &str) -> Result<Value> {
    let path = storage::host_path(data, kind, id)?;
    if !path.exists() {
        return Ok(json!({ "state": "absent", "alive": false }));
    }
    let record: HostRecord = storage::read(&path)?;
    ensure!(
        record.protocol == PROTOCOL && record.kind == kind && record.id == id,
        "Host identity mismatch"
    );
    describe(data, &record)
}

pub fn describe(data: &Path, record: &HostRecord) -> Result<Value> {
    let populated = NativePlatform::populated(record)?;
    let guard_alive = record
        .guard
        .as_ref()
        .map(alive)
        .transpose()?
        .unwrap_or(false);
    let state = if populated || guard_alive {
        "running"
    } else if record.state == State::Exited {
        "exited"
    } else if record.group.is_some() && record.guard.is_some() {
        "lost"
    } else {
        "unknown"
    };
    let supervision = if guard_alive {
        "guarded"
    } else if record.state == State::Exited && !populated {
        "ended"
    } else if record.guard.is_some() {
        "orphaned"
    } else {
        "unconfirmed"
    };
    let ready_at = ready_at(data, record)?;
    let stopping = storage::host_path(data, record.kind, &record.id)?
        .with_extension("stop")
        .exists();
    let phase = if record.state == State::Exited && !populated {
        "exited"
    } else if supervision != "guarded" {
        "unknown"
    } else if stopping {
        "stopping"
    } else if ready_at.is_some() {
        "ready"
    } else if record.lifecycle.readiness_required || record.child.is_none() {
        "starting"
    } else {
        "running"
    };
    Ok(
        json!({ "state": state, "alive": populated || guard_alive || state == "unknown",
        "guard": record.guard, "child": record.child, "release": record.release, "exitCode": record.exit_code,
        "lifecycle": { "phase": phase, "supervision": supervision,
            "readiness": if ready_at.is_some() { "ready" } else if record.lifecycle.readiness_required { "pending" } else { "unsupported" },
            "createdAt": record.lifecycle.created_at, "startedAt": record.lifecycle.started_at,
            "readyAt": ready_at, "finishedAt": record.lifecycle.finished_at,
            "reason": record.lifecycle.reason, "compacted": record.lifecycle.compacted } }),
    )
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    pid: u32,
    start: String,
    ready_at: u64,
}

pub fn ready_at(data: &Path, record: &HostRecord) -> Result<Option<u64>> {
    if record.lifecycle.ready_at.is_some() {
        return Ok(record.lifecycle.ready_at);
    }
    let path = storage::host_path(data, record.kind, &record.id)?.with_extension("ready");
    if !path.exists() {
        return Ok(None);
    }
    // Missing, stale or malformed evidence never proves readiness and must not prevent
    // inspection/recovery of a host that subsequently exits.
    let Ok(ready) = storage::read::<Ready>(&path) else {
        return Ok(None);
    };
    Ok(record
        .child
        .as_ref()
        .filter(|child| child.pid == ready.pid && child.start == ready.start)
        .map(|_| ready.ready_at))
}

fn readiness_required(release: &Path) -> Result<bool> {
    let path = release.join("daemon/manifest.json");
    if !path.exists() {
        return Ok(false);
    }
    ensure!(
        std::fs::metadata(&path)?.len() <= 65_536,
        "Daemon manifest is too large"
    );
    let manifest: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    Ok(manifest["hostReadiness"] == 1)
}

pub fn launch(
    data: &Path,
    config: &Configuration,
    root: Option<&Path>,
    kind: Kind,
    id: &str,
) -> Result<bool> {
    let path = storage::host_path(data, kind, id)?;
    if path.exists() {
        return Ok(false);
    }
    let _lock = storage::lock(&path.with_extension("lock"))?;
    if path.exists() {
        return Ok(false);
    }
    let (release, node) = if matches!(kind, Kind::Execution | Kind::Terminal | Kind::Routine) {
        let directory = data.join(kind.directory());
        let descriptor: Descriptor = storage::read(&directory.join(format!("{id}.json")))?;
        ensure!(
            descriptor.protocol == PROTOCOL
                && descriptor.id == id
                && descriptor.directory == directory,
            "Invalid host descriptor"
        );
        (
            storage::retained(&descriptor.release, &data.join("releases"))?,
            storage::retained(&descriptor.node, &data.join("runtimes"))?,
        )
    } else {
        (config.release.clone(), config.node.clone())
    };
    let readiness_required = kind == Kind::Application || readiness_required(&release)?;
    let mut record = HostRecord {
        protocol: PROTOCOL,
        kind,
        id: id.into(),
        state: State::Starting,
        release,
        node,
        environment: config.environment.clone(),
        isolation: config.isolation,
        group: NativePlatform::create_group(root, kind, id)?,
        nofile: config.limits.nofile,
        guard: None,
        child: None,
        exit_code: None,
        lifecycle: Lifecycle {
            created_at: storage::now(),
            readiness_required,
            ..Default::default()
        },
    };
    // The reservation commits before spawn. Ambiguous starts never create a second invocation.
    storage::write_host(data, &record)?;
    let spawned = (|| {
        let mut command = Command::new(&config.daemon);
        command
            .args(["host", "--data-dir"])
            .arg(data)
            .arg("--kind")
            .arg(kind.name())
            .arg("--id")
            .arg(id)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(storage::log_file(data, "supervisor")?));
        NativePlatform::detach(&mut command);
        Ok::<_, anyhow::Error>(command.spawn()?)
    })();
    if let Err(error) = spawned {
        // No guardian was exec'd. Commit a terminal reservation while still holding
        // ownership, so web recovery can use a new identity without replaying this ID.
        ensure!(
            !NativePlatform::populated(&record)?,
            "Host launch cleanup is unconfirmed"
        );
        NativePlatform::remove_group(&record)?;
        record.state = State::Exited;
        record.exit_code = Some(-1);
        record.lifecycle.finished_at = Some(storage::now());
        record.lifecycle.reason = Some("guardian_spawn_failed".into());
        storage::write_host(data, &record)?;
        return Err(error).context("Cannot start host guardian");
    }
    // The guardian takes the same lock. Readiness is polled by the supervisor;
    // a successful spawn with an unconfirmed outcome must retain its reservation.
    Ok(true)
}

pub fn launch_finished(data: &Path, kind: Kind, id: &str) -> Result<bool> {
    let record: HostRecord = storage::read(&storage::host_path(data, kind, id)?)?;
    Ok(record.state == State::Exited
        || if record.lifecycle.readiness_required {
            ready_at(data, &record)?.is_some()
        } else {
            record.child.is_some()
        })
}

fn drain(data: PathBuf, name: String, mut input: impl Read) {
    let mut buffer = [0u8; 8192];
    loop {
        let count = match input.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(count) => count,
        };
        // Reopen at chunk boundaries so long-running hosts also rotate bounded logs.
        if let Ok(mut log) = storage::log_file(&data, &name) {
            let _ = log.write_all(&buffer[..count]);
        }
    }
}

pub fn run(data: &Path, kind: Kind, id: &str) -> Result<()> {
    let path = storage::host_path(data, kind, id)?;
    // The parent may still be committing its spawn; a short wait doesn't permit a second claim.
    let deadline = Instant::now() + Duration::from_secs(5);
    let _lock = loop {
        match storage::lock(&path.with_extension("lock")) {
            Ok(lock) => break lock,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(error),
        }
    };
    let mut record: HostRecord = storage::read(&path)?;
    ensure!(
        record.kind == kind && record.id == id && record.protocol == PROTOCOL,
        "Host identity mismatch"
    );
    ensure!(
        record.state == State::Starting && record.guard.is_none() && record.child.is_none(),
        "A host cannot be restarted"
    );
    record.guard = NativePlatform::identity(std::process::id())?;
    ensure!(record.guard.is_some(), "Cannot establish host ownership");
    storage::write_host(data, &record)?;
    NativePlatform::subreaper()?;
    let stopped = NativePlatform::stop_flag()?;
    let result = run_child(data, &mut record, stopped);
    if result.is_err() {
        record.exit_code = Some(-1);
        record.lifecycle.reason = Some("host_start_failed".into());
    }
    // Never release a terminal's worktree while descendants may still exist.
    NativePlatform::terminate(&record)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while NativePlatform::populated(&record)? && Instant::now() < deadline {
        NativePlatform::reap();
        thread::sleep(Duration::from_millis(20));
    }
    ensure!(
        !NativePlatform::populated(&record)?,
        "Host cleanup is unconfirmed"
    );
    NativePlatform::remove_group(&record)?;
    record.state = State::Exited;
    record.lifecycle.finished_at = Some(storage::now());
    let stop_path = path.with_extension("stop");
    if stop_path.exists() {
        let stop: Value = storage::read(&stop_path)?;
        if stop["reason"] == "readiness_timeout" {
            record.lifecycle.reason = Some("readiness_timeout".into());
        }
    }
    if record.lifecycle.reason.is_none() && record.exit_code != Some(0) {
        record.lifecycle.reason = Some("child_failed".into());
    }
    storage::write_host(data, &record)?;
    result
}

fn run_child(data: &Path, record: &mut HostRecord, stopped: Arc<AtomicBool>) -> Result<()> {
    storage::retained(&record.release, &data.join("releases"))?;
    storage::retained(&record.node, &data.join("runtimes"))?;
    let mut command = if record.kind == Kind::Application {
        let platform = if cfg!(target_arch = "aarch64") {
            "linux-arm64"
        } else {
            "linux-x64"
        };
        Command::new(
            record
                .release
                .join("daemon")
                .join(platform)
                .join("palmagent-runtime"),
        )
    } else {
        Command::new(&record.node)
    };
    let entry = match record.kind {
        Kind::Execution => "execution-host.js",
        Kind::Terminal => "terminal-host.js",
        Kind::Routine => "routine-host.js",
        Kind::Web => "server.js",
        Kind::Update => "cli.js",
        Kind::Application => "",
    };
    if record.kind == Kind::Application {
        command
            .arg("serve")
            .arg("--data-dir")
            .arg(data)
            .arg("--release")
            .arg(&record.release)
            .arg("--node")
            .arg(&record.node);
    } else {
        command.arg(record.release.join(entry));
    }
    if matches!(
        record.kind,
        Kind::Execution | Kind::Terminal | Kind::Routine
    ) {
        command
            .arg(data.join(record.kind.directory()))
            .arg(&record.id);
    } else if record.kind == Kind::Update {
        command.args(["update-request", "--data-dir"]).arg(data);
    }
    command
        .current_dir(&record.release)
        .env_clear()
        .envs(&record.environment)
        .env("PALMAGENT_DAEMON_DATA", data)
        .env("PALMAGENT_CLI_FORWARDED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if record.lifecycle.readiness_required {
        command.env(
            "PALMAGENT_HOST_READY",
            storage::host_path(data, record.kind, &record.id)?.with_extension("ready"),
        );
    }
    NativePlatform::contain(&mut command, record)?;
    let mut child = command.spawn().context("Cannot start retained runtime")?;
    record.child = NativePlatform::identity(child.id())?;
    record.state = State::Running;
    record.lifecycle.started_at = Some(storage::now());
    storage::write_host(data, record)?;
    let output_data = data.to_owned();
    let error_data = data.to_owned();
    let output_name = format!("{}-{}-out", record.kind.name(), record.id);
    let error_name = format!("{}-{}-err", record.kind.name(), record.id);
    let output = child.stdout.take().context("Missing output pipe")?;
    let error = child.stderr.take().context("Missing error pipe")?;
    let out = thread::spawn(move || drain(output_data, output_name, output));
    let err = thread::spawn(move || drain(error_data, error_name, error));
    let mut stopping_since = None;
    loop {
        if record.lifecycle.ready_at.is_none()
            && let Some(ready) = ready_at(data, record)?
        {
            record.lifecycle.ready_at = Some(ready);
            storage::write_host(data, record)?;
        }
        if let Some(status) = child.try_wait()? {
            record.exit_code = status.code().or(Some(-1));
            break;
        }
        if stopped.load(Ordering::Relaxed) {
            if stopping_since.is_none() {
                if let Some(identity) = &record.child {
                    NativePlatform::signal(identity, false)?;
                }
                stopping_since = Some(Instant::now());
            } else if stopping_since.is_some_and(|start| start.elapsed() > Duration::from_secs(10))
            {
                NativePlatform::terminate(record)?;
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    NativePlatform::terminate(record)?;
    NativePlatform::reap();
    // Descendants have been stopped before waiting for their inherited output pipes.
    let _ = out.join();
    let _ = err.join();
    Ok(())
}

pub fn stop(data: &Path, kind: Kind, id: &str, graceful: bool) -> Result<()> {
    stop_reason(data, kind, id, graceful, "requested")
}
fn stop_reason(data: &Path, kind: Kind, id: &str, graceful: bool, reason: &str) -> Result<()> {
    let path = storage::host_path(data, kind, id)?;
    let record: HostRecord = storage::read(&path)?;
    if record.state == State::Exited {
        return Ok(());
    }
    storage::atomic(
        &path.with_extension("stop"),
        &json!({ "at": storage::now(), "reason": reason }),
    )?;
    if graceful {
        if let Some(guard) = &record.guard {
            NativePlatform::signal(guard, false)?;
        }
    } else {
        NativePlatform::terminate(&record)?;
    }
    Ok(())
}

/// A readiness deadline applies only to the replaceable web service, never to user work.
pub fn stop_unready(data: &Path, id: &str) -> Result<()> {
    stop_unready_kind(data, Kind::Web, id)
}
pub fn stop_unready_kind(data: &Path, kind: Kind, id: &str) -> Result<()> {
    stop_reason(data, kind, id, true, "readiness_timeout")
}
