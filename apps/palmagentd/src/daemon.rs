use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    sync::atomic::Ordering,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

use crate::{
    contract::{
        Configuration, HostRecord, Kind, PROTOCOL, Reply, Request, SOURCE_COMMIT, State, VERSION,
    },
    hosts,
    platform::{Listener, NativePlatform, ProcessControl, ProcessIsolation, Stream},
    storage,
};

pub fn request(data: &Path, request: &Request) -> Result<Value> {
    let socket = storage::socket_path(data)?;
    storage::private_path(&socket, false)?;
    let mut stream = Stream::connect(socket).context("Palmagent daemon is unavailable")?;
    stream.set_read_timeout(Some(Duration::from_secs(35)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    serde_json::to_writer(&mut stream, request)?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(stream).take(65_537).read_line(&mut line)?;
    ensure!(
        line.len() <= 65_536 && line.ends_with('\n'),
        "Invalid daemon response"
    );
    let reply: Value = serde_json::from_str(&line)?;
    ensure!(
        reply["protocol"] == PROTOCOL,
        "Incompatible daemon protocol"
    );
    if reply["ok"] != true {
        bail!(
            "{}",
            reply["error"].as_str().unwrap_or("Daemon request failed")
        );
    }
    Ok(reply["result"].clone())
}

fn current_web(data: &Path) -> Result<Option<String>> {
    let path = storage::state_directory(data).join("web.json");
    if !path.exists() {
        return Ok(None);
    }
    let id: String = storage::read(&path)?;
    storage::host_path(data, Kind::Web, &id)?;
    Ok(Some(id))
}

fn start_web(data: &Path, config: &Configuration, root: Option<&Path>) -> Result<Value> {
    if let Some(id) = current_web(data)? {
        let state = hosts::inspect(data, Kind::Web, &id)?;
        if state["alive"] == true {
            return Ok(state);
        }
    }
    let id = storage::unique_id()?;
    // Store the selected identity first, so a crashed supervisor never races an uncertain launch.
    storage::atomic(&storage::state_directory(data).join("web.json"), &id)?;
    hosts::launch(data, config, root, Kind::Web, &id)
}

fn stop_web(data: &Path) -> Result<()> {
    if let Some(id) = current_web(data)? {
        hosts::stop(data, Kind::Web, &id, true)?;
    }
    Ok(())
}

pub fn serve(data: &Path) -> Result<()> {
    let directory = storage::state_directory(data);
    storage::private_directory(&directory)?;
    storage::private_directory(&directory.join("hosts"))?;
    let _lock = storage::lock(&directory.join("lifecycle.lock"))?;
    let mut config = storage::configuration(data)?;
    let root = NativePlatform::initialize(data, &config)?;
    let socket = storage::socket_path(data)?;
    if socket.exists() {
        storage::private_path(&socket, false)?;
        fs::remove_file(&socket)?;
    }
    let listener = Listener::bind(&socket)?;
    storage::set_private(&socket)?;
    listener.set_nonblocking(true)?;
    let stopped = NativePlatform::stop_flag()?;
    let identity = NativePlatform::identity(std::process::id())?
        .context("Cannot establish daemon identity")?;
    let instance = storage::unique_id()?;
    storage::atomic(&directory.join("identity.json"), &identity)?;
    let mut last_start = Instant::now() - Duration::from_secs(3);
    let mut replace = false;
    while !stopped.load(Ordering::Relaxed) && !replace {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                let result = (|| -> Result<Value> {
                    let mut line = String::new();
                    BufReader::new(stream.try_clone()?)
                        .take(65_537)
                        .read_line(&mut line)?;
                    ensure!(
                        line.len() <= 65_536 && line.ends_with('\n'),
                        "Invalid daemon request"
                    );
                    let request: Request = serde_json::from_str(&line)?;
                    match request {
                        Request::Status => Ok(
                            json!({ "version": VERSION, "sourceCommit": SOURCE_COMMIT, "pid": std::process::id(), "instance": instance,
                            "protocol": PROTOCOL, "isolation": config.isolation, "web": current_web(data)?.map(|id| hosts::inspect(data, Kind::Web, &id)).transpose()? }),
                        ),
                        Request::Launch { kind, id } => {
                            ensure!(
                                matches!(kind, Kind::Execution | Kind::Terminal),
                                "Use the dedicated operation for this host kind"
                            );
                            hosts::launch(data, &config, root.as_deref(), kind, &id)
                        }
                        Request::Inspect { kind, id } => hosts::inspect(data, kind, &id),
                        Request::Terminate { kind, id } => {
                            ensure!(
                                kind == Kind::Terminal,
                                "Execution cancellation belongs to its durable command channel"
                            );
                            hosts::stop(data, kind, &id, false)?;
                            hosts::inspect(data, kind, &id)
                        }
                        Request::RestartWeb => {
                            let candidate = storage::configuration(data)?;
                            ensure!(
                                candidate.isolation == config.isolation,
                                "Changing isolation requires an idle setup"
                            );
                            stop_web(data)?;
                            config = candidate;
                            start_web(data, &config, root.as_deref())
                        }
                        Request::Replace => {
                            let candidate = storage::configuration(data)?;
                            ensure!(
                                candidate.isolation == config.isolation,
                                "Changing isolation requires an idle setup"
                            );
                            replace = true;
                            Ok(json!({ "replacing": true, "instance": instance }))
                        }
                        Request::StartUpdate => hosts::launch(
                            data,
                            &config,
                            root.as_deref(),
                            Kind::Update,
                            &storage::unique_id()?,
                        ),
                        Request::Stop => {
                            for entry in fs::read_dir(directory.join("hosts"))? {
                                let path = entry?.path();
                                if path.extension().is_none_or(|ext| ext != "json") {
                                    continue;
                                }
                                let record: HostRecord = storage::read(&path)?;
                                if matches!(
                                    record.kind,
                                    Kind::Execution | Kind::Terminal | Kind::Update
                                ) && record.state != State::Exited
                                {
                                    ensure!(
                                        hosts::inspect(data, record.kind, &record.id)?["alive"]
                                            == false,
                                        "Active hosts must finish before stopping the installation"
                                    );
                                }
                            }
                            stop_web(data)?;
                            stopped.store(true, Ordering::Relaxed);
                            Ok(json!({ "stopped": true }))
                        }
                    }
                })();
                let reply = Reply::from_result(result);
                let _ = serde_json::to_writer(&mut stream, &reply);
                let _ = stream.write_all(b"\n");
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25))
            }
            Err(error) => return Err(error.into()),
        }
        if !stopped.load(Ordering::Relaxed)
            && !replace
            && last_start.elapsed() >= Duration::from_secs(2)
        {
            if let Err(error) = start_web(data, &config, root.as_deref())
                && let Ok(mut log) = storage::log_file(data, "supervisor")
            {
                let _ = writeln!(log, "Web recovery deferred: {error}");
            }
            last_start = Instant::now();
        }
        NativePlatform::reap();
    }
    if replace {
        // exec preserves the bootstrap's MainPID. Independent host guardians keep their pipes,
        // pinned binaries and cgroups; CLOEXEC closes only this supervisor's lock and socket.
        let config = storage::configuration(data)?;
        return NativePlatform::replace(&config.daemon, data)
            .context("Cannot replace daemon; the bootstrap will recover it");
    }
    let _ = fs::remove_file(socket);
    Ok(())
}
