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
    contract::{Configuration, HostRecord, Kind, PROTOCOL, Request, SOURCE_COMMIT, State, VERSION},
    control::Connection,
    hosts,
    maintenance::Maintenance,
    platform::{Listener, NativePlatform, ProcessControl, ProcessIsolation, Stream},
    recovery::{Action, Recovery},
    storage,
};

pub fn request(data: &Path, request: &Request) -> Result<Value> {
    let socket = storage::socket_path(data)?;
    storage::private_path(&socket, false)?;
    let mut stream = Stream::connect(socket).context("Palmagent daemon is unavailable")?;
    stream.set_read_timeout(Some(request.control_timeout() + Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    serde_json::to_writer(
        &mut stream,
        &json!({ "protocol": PROTOCOL, "request": request }),
    )?;
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

fn current_application(data: &Path) -> Result<Option<String>> {
    let path = storage::state_directory(data).join("application.json");
    if !path.exists() {
        return Ok(None);
    }
    let id: String = storage::read(&path)?;
    storage::host_path(data, Kind::Application, &id)?;
    Ok(Some(id))
}
fn application_supported(config: &Configuration) -> Result<bool> {
    let path = config.release.join("daemon/manifest.json");
    if !path.exists() {
        return Ok(false);
    }
    ensure!(
        fs::metadata(&path)?.len() <= 65_536,
        "Daemon manifest is too large"
    );
    let manifest: Value = serde_json::from_slice(&fs::read(path)?)?;
    Ok(manifest["applicationRuntime"] == 1)
}
fn application_enabled(data: &Path, config: &Configuration) -> Result<bool> {
    let path = storage::state_directory(data).join("application-enabled.json");
    if !path.exists() || !application_supported(config)? {
        return Ok(false);
    }
    let release: Option<std::path::PathBuf> = storage::read(&path)?;
    Ok(release.as_ref() == Some(&config.release))
}
fn disable_application(data: &Path) -> Result<()> {
    storage::atomic(
        &storage::state_directory(data).join("application-enabled.json"),
        &Value::Null,
    )
}
fn start_application(
    data: &Path,
    config: &Configuration,
    root: Option<&Path>,
) -> Result<Operation> {
    if let Some(id) = current_application(data)? {
        let state = hosts::inspect(data, Kind::Application, &id)?;
        if state["alive"] == true {
            if state["lifecycle"]["phase"] == "starting" {
                return Ok(Operation::Launch(
                    Kind::Application,
                    id,
                    Instant::now() + Kind::Application.launch_timeout(),
                ));
            }
            return Ok(Operation::Reply(state, None));
        }
    }
    let id = storage::unique_id()?;
    storage::atomic(
        &storage::state_directory(data).join("application.json"),
        &id,
    )?;
    launch(data, config, root, Kind::Application, id)
}
fn stop_application(data: &Path, after: AfterStop) -> Result<Option<Operation>> {
    let Some(id) = current_application(data)? else {
        return Ok(None);
    };
    if hosts::inspect(data, Kind::Application, &id)?["alive"] == false {
        return Ok(None);
    }
    hosts::stop(data, Kind::Application, &id, true)?;
    Ok(Some(Operation::Stop(
        Kind::Application,
        id,
        Instant::now() + Duration::from_secs(15),
        after,
    )))
}
fn activate(
    data: &Path,
    config: &mut Configuration,
    root: Option<&Path>,
    candidate: Configuration,
) -> Result<Operation> {
    if candidate.release != config.release || !application_supported(&candidate)? {
        disable_application(data)?;
        if let Some(operation) = stop_application(data, AfterStop::Activate(candidate.clone()))? {
            return Ok(operation);
        }
    }
    *config = candidate;
    start_web(data, config, root)
}

fn start_web(data: &Path, config: &Configuration, root: Option<&Path>) -> Result<Operation> {
    if let Some(id) = current_web(data)? {
        let state = hosts::inspect(data, Kind::Web, &id)?;
        if state["alive"] == true {
            return Ok(Operation::Reply(state, None));
        }
    }
    let id = storage::unique_id()?;
    // Store the selected identity first, so a crashed supervisor never races an uncertain launch.
    storage::atomic(&storage::state_directory(data).join("web.json"), &id)?;
    launch(data, config, root, Kind::Web, id)
}

fn launch(
    data: &Path,
    config: &Configuration,
    root: Option<&Path>,
    kind: Kind,
    id: String,
) -> Result<Operation> {
    if hosts::launch(data, config, root, kind, &id)? {
        Ok(Operation::Launch(
            kind,
            id,
            Instant::now() + kind.launch_timeout(),
        ))
    } else {
        Ok(Operation::Reply(hosts::inspect(data, kind, &id)?, None))
    }
}

#[derive(Clone, Copy)]
enum Exit {
    Stop,
    Replace,
}

enum AfterStop {
    Inspect,
    Restart(Configuration),
    Shutdown,
    Activate(Configuration),
    Replace(String),
}

enum Operation {
    Reply(Value, Option<Exit>),
    Launch(Kind, String, Instant),
    Stop(Kind, String, Instant, AfterStop),
}

impl Operation {
    fn owns_web(&self) -> bool {
        matches!(
            self,
            Self::Launch(Kind::Web | Kind::Application, ..)
                | Self::Stop(Kind::Web | Kind::Application, ..)
        )
    }

    fn poll(
        &mut self,
        data: &Path,
        config: &mut Configuration,
        root: Option<&Path>,
    ) -> Result<Option<(Value, Option<Exit>)>> {
        match self {
            Self::Reply(value, exit) => return Ok(Some((value.take(), *exit))),
            Self::Launch(kind, id, deadline) => {
                if hosts::launch_finished(data, *kind, id)? {
                    return Ok(Some((hosts::inspect(data, *kind, id)?, None)));
                }
                ensure!(
                    Instant::now() < *deadline,
                    "Host launch is unconfirmed; its reservation is retained"
                );
            }
            Self::Stop(kind, id, deadline, after) => {
                let state = hosts::inspect(data, *kind, id)?;
                if state["alive"] == false {
                    match after {
                        AfterStop::Inspect => return Ok(Some((state, None))),
                        AfterStop::Shutdown => {
                            if *kind != Kind::Application {
                                disable_application(data)?;
                                if let Some(operation) =
                                    stop_application(data, AfterStop::Shutdown)?
                                {
                                    *self = operation;
                                    return Ok(None);
                                }
                            }
                            return Ok(Some((json!({ "stopped": true }), Some(Exit::Stop))));
                        }
                        AfterStop::Restart(candidate) => {
                            *self = activate(data, config, root, candidate.clone())?;
                        }
                        AfterStop::Activate(candidate) => {
                            *config = candidate.clone();
                            *self = start_web(data, config, root)?;
                        }
                        AfterStop::Replace(instance) => {
                            return Ok(Some((
                                json!({"replacing":true,"instance":instance}),
                                Some(Exit::Replace),
                            )));
                        }
                    }
                } else {
                    ensure!(
                        Instant::now() < *deadline,
                        "Host termination could not be confirmed"
                    );
                }
            }
        }
        Ok(None)
    }
}

fn stop_web(data: &Path, after: AfterStop) -> Result<Operation> {
    if let Some(id) = current_web(data)? {
        hosts::stop(data, Kind::Web, &id, true)?;
        Ok(Operation::Stop(
            Kind::Web,
            id,
            Instant::now() + Duration::from_secs(15),
            after,
        ))
    } else {
        disable_application(data)?;
        if let Some(operation) = stop_application(data, AfterStop::Shutdown)? {
            return Ok(operation);
        }
        Ok(Operation::Reply(
            json!({ "stopped": true }),
            Some(Exit::Stop),
        ))
    }
}

fn begin(
    request: Request,
    data: &Path,
    config: &mut Configuration,
    root: Option<&Path>,
    instance: &str,
    maintenance: &Maintenance,
    recovery: &Recovery,
) -> Result<Operation> {
    match request {
        Request::Status => Ok(Operation::Reply(
            json!({ "version": VERSION, "sourceCommit": SOURCE_COMMIT, "pid": std::process::id(), "instance": instance,
                "protocol": PROTOCOL, "isolation": config.isolation, "inventory": maintenance.status(), "recovery": recovery.status(), "web": current_web(data)?.map(|id| hosts::inspect(data, Kind::Web, &id)).transpose()?,
                "applicationRuntime": 1, "applicationRequired": application_supported(config)?, "application":current_application(data)?.map(|id| hosts::inspect(data, Kind::Application, &id)).transpose()? }),
            None,
        )),
        Request::List { after } => Ok(Operation::Reply(maintenance.list(after.as_deref())?, None)),
        Request::Inspect { kind, id } => {
            Ok(Operation::Reply(hosts::inspect(data, kind, &id)?, None))
        }
        Request::Launch { kind, id } => {
            ensure!(
                matches!(kind, Kind::Execution | Kind::Terminal | Kind::Routine),
                "Use the dedicated operation for this host kind"
            );
            launch(data, config, root, kind, id)
        }
        Request::Terminate { kind, id } => {
            ensure!(
                kind == Kind::Terminal,
                "Execution cancellation belongs to its durable command channel"
            );
            hosts::stop(data, kind, &id, false)?;
            Ok(Operation::Stop(
                kind,
                id,
                Instant::now() + Duration::from_secs(15),
                AfterStop::Inspect,
            ))
        }
        Request::RestartWeb => {
            let candidate = storage::configuration(data)?;
            ensure!(
                candidate.isolation == config.isolation,
                "Changing isolation requires an idle setup"
            );
            if current_web(data)?.is_none() {
                activate(data, config, root, candidate)
            } else {
                stop_web(data, AfterStop::Restart(candidate))
            }
        }
        Request::Replace => {
            let candidate = storage::configuration(data)?;
            ensure!(
                candidate.isolation == config.isolation,
                "Changing isolation requires an idle setup"
            );
            // Stop the old product scheduler before changing release ownership, including
            // rollback to daemons that predate this service. Invocation hosts stay alive.
            if candidate.release != config.release || !application_supported(&candidate)? {
                disable_application(data)?;
                if let Some(operation) =
                    stop_application(data, AfterStop::Replace(instance.to_owned()))?
                {
                    return Ok(operation);
                }
            }
            Ok(Operation::Reply(
                json!({ "replacing": true, "instance": instance }),
                Some(Exit::Replace),
            ))
        }
        Request::StartUpdate => launch(data, config, root, Kind::Update, storage::unique_id()?),
        Request::StartApplication { release } => {
            ensure!(
                release == config.release && application_supported(config)?,
                "Incompatible application runtime"
            );
            storage::atomic(
                &storage::state_directory(data).join("application-enabled.json"),
                &config.release,
            )?;
            // Web bootstrap requests this while its own readiness operation is pending.
            // Admit once and let the caller observe readiness without nesting lifecycle waits.
            start_application(data, config, root)?;
            let id = current_application(data)?.context("Missing application reservation")?;
            Ok(Operation::Reply(
                hosts::inspect(data, Kind::Application, &id)?,
                None,
            ))
        }
        Request::Stop => {
            for entry in fs::read_dir(storage::state_directory(data).join("hosts"))? {
                let path = entry?.path();
                if path.extension().is_none_or(|ext| ext != "json") {
                    continue;
                }
                let record: HostRecord = storage::read(&path)?;
                if matches!(
                    record.kind,
                    Kind::Execution | Kind::Terminal | Kind::Routine | Kind::Update
                ) && record.state != State::Exited
                {
                    ensure!(
                        hosts::inspect(data, record.kind, &record.id)?["alive"] == false,
                        "Active hosts must finish before stopping the installation"
                    );
                }
            }
            stop_web(data, AfterStop::Shutdown)
        }
    }
}

pub fn serve(data: &Path) -> Result<()> {
    const MAX_CONNECTIONS: usize = 32;
    let directory = storage::state_directory(data);
    storage::private_directory(&directory)?;
    storage::private_directory(&directory.join("hosts"))?;
    storage::private_directory(&directory.join("services"))?;
    let _lock = storage::lock(&directory.join("lifecycle.lock"))?;
    NativePlatform::subreaper()?;
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
    let mut telemetry = crate::telemetry::Telemetry::new(&config);
    let mut measurements = std::collections::BTreeMap::new();
    let mut maintenance = Maintenance::new();
    let mut recovery = Recovery::load(data)?;
    let mut application_recovery = Recovery::load_service(data, "application")?;
    let mut last_recovery = Instant::now() - Duration::from_secs(1);
    let mut connections: Vec<Connection> = Vec::new();
    let mut next_id = 0;
    let mut pending: Option<(u64, Operation)> = None;
    let mut exiting: Option<(u64, Exit)> = None;
    while !stopped.load(Ordering::Relaxed) {
        telemetry.tick(connections.len());
        // Admission and each frame are bounded. One slow peer cannot hold the control loop.
        for _ in 0..MAX_CONNECTIONS {
            match listener.accept() {
                Ok((stream, _)) => {
                    if connections.len() < MAX_CONNECTIONS {
                        connections.push(Connection::new(next_id, stream)?);
                        next_id += 1;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error.into()),
            }
        }
        for connection in &mut connections {
            connection.poll();
        }
        if let Some((id, mut operation)) = pending.take() {
            match operation.poll(data, &mut config, root.as_deref()) {
                Ok(None) => pending = Some((id, operation)),
                completed => {
                    let reply = match completed {
                        Ok(Some((value, exit))) => {
                            exiting = exit.map(|exit| (id, exit));
                            Ok(value)
                        }
                        Err(error) => Err(error),
                        Ok(None) => unreachable!(),
                    };
                    telemetry.finish(measurements.remove(&id).flatten(), reply.is_ok());
                    if let Some(connection) = connections
                        .iter_mut()
                        .find(|connection| connection.id == id)
                    {
                        connection.reply(reply);
                    }
                }
            }
        }
        let concurrency = connections.len();
        for connection in &mut connections {
            let read_only = matches!(
                connection.request(),
                Some(Request::Status | Request::Inspect { .. } | Request::List { .. })
            );
            let web_bootstrap =
                matches!(connection.request(), Some(Request::StartApplication { .. }))
                    && matches!(&pending, Some((_, Operation::Launch(Kind::Web, ..))));
            if !read_only && ((!web_bootstrap && pending.is_some()) || exiting.is_some()) {
                continue;
            }
            if let Some(request) = connection.take_request() {
                let is_status = matches!(request, Request::Status);
                let measurement = telemetry.begin(&request, concurrency);
                match begin(
                    request,
                    data,
                    &mut config,
                    root.as_deref(),
                    &instance,
                    &maintenance,
                    &recovery,
                ) {
                    Ok(Operation::Reply(mut value, exit)) => {
                        telemetry.finish(measurement, true);
                        if is_status {
                            value["telemetry"] = telemetry.snapshot();
                        }
                        if let Some(exit) = exit {
                            exiting = Some((connection.id, exit));
                        }
                        connection.reply(Ok(value));
                    }
                    Ok(operation) => {
                        measurements.insert(connection.id, measurement);
                        pending = Some((connection.id, operation));
                    }
                    Err(error) => {
                        telemetry.finish(measurement, false);
                        connection.reply(Err(error));
                    }
                }
            }
        }
        // Bound maintenance work per control tick, including orphan cleanup and log retention.
        if let Err(error) = maintenance.tick(data, root.as_deref())
            && let Ok(mut log) = storage::log_file(data, "supervisor")
        {
            let _ = writeln!(log, "Host maintenance deferred: {error}");
        }
        if exiting.is_none()
            && !pending
                .as_ref()
                .is_some_and(|(_, operation)| operation.owns_web())
            && last_recovery.elapsed() >= Duration::from_millis(250)
        {
            let recover = (|| -> Result<()> {
                if application_enabled(data, &config)? {
                    let id = current_application(data)?;
                    let state = id
                        .as_ref()
                        .map(|id| hosts::inspect(data, Kind::Application, id))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    match application_recovery.tick_service(
                        data,
                        "application",
                        id.as_deref(),
                        &state,
                    )? {
                        Action::Start => {
                            start_application(data, &config, root.as_deref())?;
                        }
                        Action::StopUnready => {
                            if let Some(id) = id {
                                hosts::stop_unready_kind(data, Kind::Application, &id)?;
                            }
                        }
                        Action::None => {}
                    }
                }
                Ok(())
            })();
            if let Err(error) = recover
                && let Ok(mut log) = storage::log_file(data, "supervisor")
            {
                let _ = writeln!(log, "Application recovery deferred: {error}");
            }
            let recover = (|| -> Result<()> {
                let id = current_web(data)?;
                let state = id
                    .as_ref()
                    .map(|id| hosts::inspect(data, Kind::Web, id))
                    .transpose()?
                    .unwrap_or(Value::Null);
                match recovery.tick(data, id.as_deref(), &state)? {
                    Action::Start => {
                        start_web(data, &config, root.as_deref())?;
                    }
                    Action::StopUnready => {
                        if let Some(id) = id {
                            hosts::stop_unready(data, &id)?;
                        }
                    }
                    Action::None => {}
                }
                Ok(())
            })();
            if let Err(error) = recover
                && let Ok(mut log) = storage::log_file(data, "supervisor")
            {
                let _ = writeln!(log, "Web recovery deferred: {error}");
            }
            last_recovery = Instant::now();
        }
        for connection in &mut connections {
            connection.poll();
        }
        connections.retain(|connection| !connection.closed());
        NativePlatform::reap();
        if let Some((id, action)) = exiting
            && !connections.iter().any(|connection| connection.id == id)
        {
            if matches!(action, Exit::Replace) {
                // All lifecycle waits are settled. exec keeps MainPID and retained guardians;
                // CLOEXEC drops the control sockets and lock, including incomplete peers.
                let config = storage::configuration(data)?;
                return NativePlatform::replace(&config.daemon, data)
                    .context("Cannot replace daemon; the bootstrap will recover it");
            }
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = fs::remove_file(socket);
    Ok(())
}
