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

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

use crate::{
    contract::{Configuration, Descriptor, HostRecord, Kind, PROTOCOL, State},
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
    let populated = NativePlatform::populated(&record)?;
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
    Ok(
        json!({ "state": state, "alive": populated || guard_alive || state == "unknown", "guard": record.guard,
        "child": record.child, "release": record.release, "exitCode": record.exit_code }),
    )
}

pub fn launch(
    data: &Path,
    config: &Configuration,
    root: Option<&Path>,
    kind: Kind,
    id: &str,
) -> Result<Value> {
    let path = storage::host_path(data, kind, id)?;
    if path.exists() {
        return inspect(data, kind, id);
    }
    let _lock = storage::lock(&path.with_extension("lock"))?;
    if path.exists() {
        return inspect(data, kind, id);
    }
    let (release, node) = if matches!(kind, Kind::Execution | Kind::Terminal) {
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
    let record = HostRecord {
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
    };
    // The reservation commits before spawn. Ambiguous starts never create a second invocation.
    storage::write_host(data, &record)?;
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
    // The child takes the same lock, so release it before waiting for readiness.
    let spawned = command.spawn();
    drop(_lock);
    if let Err(error) = spawned {
        return Err(error).context("Host launch is uncertain; its reservation is retained");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let current: HostRecord = storage::read(&path)?;
        if current.child.is_some() || current.state == State::Exited {
            return inspect(data, kind, id);
        }
        thread::sleep(Duration::from_millis(20));
    }
    bail!("Host launch is unconfirmed; its reservation is retained")
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
    storage::write_host(data, &record)?;
    result
}

fn run_child(data: &Path, record: &mut HostRecord, stopped: Arc<AtomicBool>) -> Result<()> {
    storage::retained(&record.release, &data.join("releases"))?;
    storage::retained(&record.node, &data.join("runtimes"))?;
    let mut command = Command::new(&record.node);
    let entry = match record.kind {
        Kind::Execution => "execution-host.js",
        Kind::Terminal => "terminal-host.js",
        Kind::Web => "server.js",
        Kind::Update => "cli.js",
    };
    command.arg(record.release.join(entry));
    if matches!(record.kind, Kind::Execution | Kind::Terminal) {
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
    NativePlatform::contain(&mut command, record)?;
    let mut child = command.spawn().context("Cannot start retained runtime")?;
    record.child = NativePlatform::identity(child.id())?;
    record.state = State::Running;
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
    let path = storage::host_path(data, kind, id)?;
    let record: HostRecord = storage::read(&path)?;
    if record.state == State::Exited {
        return Ok(());
    }
    if graceful {
        if let Some(guard) = &record.guard {
            NativePlatform::signal(guard, false)?;
        }
    } else {
        NativePlatform::terminate(&record)?;
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if inspect(data, kind, id)?["alive"] == false {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    bail!("Host termination could not be confirmed")
}
