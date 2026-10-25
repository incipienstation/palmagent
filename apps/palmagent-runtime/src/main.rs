use anyhow::{Context, Result, ensure};
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
            if ticks.try_send(Message::Tick).is_err() && ticks.is_closed() {
                break;
            }
        }
    });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let closing = sender.clone();
    let result = axum::serve(listener, http::router(client))
        .with_graceful_shutdown(async move {
            tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            let _ = sender.send(Message::Shutdown).await;
        })
        .await;
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
