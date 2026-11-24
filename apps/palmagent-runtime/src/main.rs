use anyhow::{Context, Result, ensure};
use palmagent_runtime::modules::tasks::{
    adapters::{
        inbound::{activity_http, http as task_http, transcript_http},
        outbound::{
            sqlite_activity::SqliteActivity, sqlite_transcript::SqliteTranscript,
            sqlite_usage::SqliteUsage,
        },
    },
    application::{
        Service as TaskUsageService, activity::ActivityService, transcript::TranscriptService,
    },
};
use palmagent_runtime::{
    composition,
    modules::routines::{
        adapters::{
            inbound::http::{self, Client, Message},
            outbound::{calendar, hosts::Hosts, sqlite::SqliteRepository},
        },
        application::{Environment, Service},
    },
    platform,
};
use serde_json::json;
use std::{os::unix::fs::FileTypeExt, path::PathBuf, time::Duration};

struct RuntimeEnvironment {
    db: PathBuf,
}
impl Environment for RuntimeEnvironment {
    fn now(&self) -> i64 {
        platform::now()
    }
    fn id(&self) -> Result<String> {
        platform::unique_id()
    }
    fn next_run(&self, schedule: &str, from: i64) -> std::result::Result<Option<i64>, String> {
        calendar::next_run(schedule, from)
    }
    fn updating(&self) -> bool {
        platform::maintenance(&self.db)
    }
}

async fn serve(args: &[String]) -> Result<()> {
    let flag = |name: &str| {
        args.windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| PathBuf::from(&pair[1]))
            .with_context(|| format!("Missing {name}"))
    };
    let data = flag("--data-dir")?.canonicalize()?;
    platform::directory(&data)?;
    platform::directory(&data.join("application"))?;
    platform::directory(&data.join("routines"))?;
    let _lock = platform::lock(&data.join("application/owner.lock"))?;
    let release = flag("--release")?.canonicalize()?;
    let node = flag("--node")?.canonicalize()?;
    ensure!(
        release.starts_with(data.join("releases").canonicalize()?)
            && node.starts_with(data.join("runtimes").canonicalize()?),
        "Runtime artifacts must be retained"
    );
    let db = if let Some(value) = std::env::var_os("DISPATCHER_DB").filter(|v| !v.is_empty()) {
        PathBuf::from(value)
    } else if data.join("palmagent.db").exists() || !data.join("dispatcher.db").exists() {
        data.join("palmagent.db")
    } else {
        data.join("dispatcher.db")
    };
    let db = db.canonicalize()?;
    let hosts = Hosts {
        data: data.clone(),
        release,
        node,
    };
    let (sender, receiver) = tokio::sync::mpsc::channel(128);
    let measurements = platform::telemetry::Measurements::new(
        std::env::var_os("PALMAGENT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/nonexistent"))
            .join("telemetry.json"),
    );
    measurements.tick(0);
    let client = Client::new(sender.clone(), measurements.clone());
    let public_reads =
        composition::read_http::Listener::new(db.clone(), measurements.clone(), client.clone());
    let usage = task_http::Client::new(Box::new(TaskUsageService::new(Box::new(
        SqliteUsage::open(&db)?,
    ))));
    let activity = activity_http::Client::new(Box::new(ActivityService::new(Box::new(
        SqliteActivity::open(&db)?,
    ))));
    let transcript = transcript_http::Client::new(Box::new(TranscriptService::new(Box::new(
        SqliteTranscript::open(&db)?,
    ))));
    let sampler = measurements.clone();
    let (ready_send, ready_receive) = tokio::sync::oneshot::channel();
    let handle = tokio::runtime::Handle::current();
    let owner_sender = sender.clone();
    let owner = std::thread::spawn(move || {
        let service = (|| -> Result<Service> {
            Service::new(
                Box::new(SqliteRepository::open(&db)?.measured(measurements.clone())),
                Box::new(RuntimeEnvironment { db }),
            )
        })();
        match service {
            Ok(service) => {
                let instance = match platform::unique_id() {
                    Ok(id) => id,
                    Err(error) => {
                        let _ = ready_send.send(Err(error));
                        return;
                    }
                };
                let _ = ready_send.send(Ok(()));
                composition::run_owner(
                    service,
                    receiver,
                    owner_sender,
                    hosts,
                    handle,
                    composition::ObservationContext {
                        instance,
                        measurements,
                    },
                );
            }
            Err(error) => {
                let _ = ready_send.send(Err(error));
            }
        }
    });
    ready_receive.await??;
    let path = platform::socket(&data)?;
    if path.exists() {
        platform::private(&path)?;
        ensure!(
            std::fs::symlink_metadata(&path)?.file_type().is_socket(),
            "Application socket path is not a socket"
        );
        std::fs::remove_file(&path)?;
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    platform::secure_socket(&path)?;
    platform::ready()?;
    let ticks = sender.clone();
    let timer = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            // Consent and self-resource sampling continue during a busy owner pass.
            sampler.refresh();
            if ticks.try_send(Message::Tick).is_err() && ticks.is_closed() {
                break;
            }
        }
    });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let closing = sender.clone();
    let result = axum::serve(
        listener,
        http::router(client)
            .merge(task_http::router(usage))
            .merge(activity_http::router(activity))
            .merge(transcript_http::router(transcript))
            .merge(public_reads.control()),
    )
    .with_graceful_shutdown(async move {
        tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        let _ = sender.send(Message::Shutdown).await;
    })
    .await;
    public_reads.close().await;
    timer.abort();
    let _ = closing.send(Message::Shutdown).await;
    tokio::task::spawn_blocking(move || owner.join())
        .await
        .map_err(|_| anyhow::anyhow!("Runtime owner join failed"))?
        .map_err(|_| anyhow::anyhow!("Runtime owner failed"))?;
    let _ = std::fs::remove_file(path);
    result?;
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("standalone-catalog") => {
            ensure!(
                (3..=4).contains(&args.len()),
                "Invalid release catalog arguments"
            );
            let result =
                palmagent_runtime::modules::installation::adapters::outbound::catalog::select(
                    &args[1],
                    args.get(3).map(String::as_str),
                    &args[2],
                )?;
            serde_json::to_writer(std::io::stdout().lock(), &result)?;
            return Ok(());
        }
        Some("standalone-update") => return composition::standalone_update::run(),
        Some("standalone-files") => {
            return palmagent_runtime::modules::installation::adapters::outbound::archive::prepare(
                &args[1..],
            );
        }
        _ => {}
    }
    if args.first().is_some_and(|arg| arg == "task-command") {
        ensure!(
            args.len() == 2,
            "Task command requires the product database path"
        );
        return composition::task_command::run(std::path::Path::new(&args[1]));
    }
    if args.first().is_some_and(|arg| arg == "routine-host") {
        ensure!(
            args.len() == 3,
            "Usage: palmagent-runtime routine-host <directory> <id>"
        );
        return palmagent_runtime::modules::routines::adapters::outbound::retained_host::run(
            std::path::Path::new(&args[1]),
            &args[2],
        );
    }
    if args.first().is_some_and(|arg| arg == "script-watchdog") {
        ensure!(args.len() == 2, "Script watchdog requires a command");
        let code = platform::script_process::watchdog(&args[1])?;
        std::process::exit(code);
    }
    if matches!(
        args.first().map(String::as_str),
        Some("version" | "--version")
    ) {
        println!(
            "{}",
            json!({"protocol":1,"version":env!("PALMAGENT_PRODUCT_VERSION"),"sourceCommit":env!("PALMAGENT_SOURCE_COMMIT")})
        );
        return Ok(());
    }
    ensure!(
        args.first().map(String::as_str) == Some("serve"),
        "Usage: palmagent-runtime serve --data-dir <directory> --release <directory> --node <executable>"
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve(&args));
    runtime.shutdown_timeout(Duration::from_secs(1));
    result
}
