//! Owner-only configuration of a separate loopback public-read listener.
//! The existing private application socket never exposes its control routes here.
use crate::modules::{
    auth::{
        adapters::{inbound::read_http as auth_http, outbound::sqlite_sessions::SqliteSessions},
        application::SessionService,
    },
    tasks::{
        adapters::{
            inbound::{
                activity_http, http as usage_http, public_reads, read_metrics, transcript_http,
            },
            outbound::{
                sqlite_activity::SqliteActivity, sqlite_read_access::SqliteReadAccess,
                sqlite_transcript::SqliteTranscript, sqlite_usage::SqliteUsage,
            },
        },
        api::{ActivityReader, TranscriptReader},
        application::{Service, activity::ActivityService, transcript::TranscriptService},
    },
};
use crate::platform::telemetry::Measurements;
use anyhow::{Result, ensure};
use axum::{Json, Router, extract::State, http::StatusCode, middleware, routing::post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Mutex, oneshot},
    task::JoinHandle,
};

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    port: u16,
    auth_enabled: bool,
    cookie_name: String,
    session_ttl_ms: i64,
    auth_origin: String,
}
impl Settings {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.session_ttl_ms > 0 && self.session_ttl_ms <= 9_007_199_254_740_991,
            "Invalid session lifetime"
        );
        ensure!(
            !self.cookie_name.is_empty()
                && self.cookie_name.len() <= 256
                && self
                    .cookie_name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)),
            "Invalid cookie name"
        );
        ensure!(
            !self.auth_enabled || self.auth_origin.starts_with("https://"),
            "Secure auth origin required"
        );
        ensure!(
            self.auth_origin.len() <= 2048
                && !self
                    .auth_origin
                    .bytes()
                    .any(|b| b.is_ascii_whitespace() || b == b';'),
            "Invalid auth origin"
        );
        if !self.auth_origin.is_empty() {
            let origin: axum::http::Uri = self.auth_origin.parse()?;
            ensure!(
                origin.scheme_str() == Some("https") && origin.authority().is_some(),
                "Invalid auth origin"
            );
        }
        Ok(())
    }
}
#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    port: Option<u16>,
}
struct Active {
    settings: Settings,
    port: u16,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
}
#[derive(Clone)]
pub struct Listener {
    db: PathBuf,
    measurements: Measurements,
    active: Arc<Mutex<Option<Active>>>,
}
impl Listener {
    pub fn new(db: PathBuf, measurements: Measurements) -> Self {
        Self {
            db,
            measurements,
            active: Arc::new(Mutex::new(None)),
        }
    }
    pub async fn configure(&self, settings: Option<Settings>) -> Result<Status> {
        if let Some(settings) = &settings {
            settings.validate()?;
        }
        let mut active = self.active.lock().await;
        if let (Some(previous), Some(settings)) = (active.as_ref(), settings.as_ref())
            && previous.settings == *settings
            && !previous.task.is_finished()
        {
            return Ok(Status {
                enabled: true,
                port: Some(previous.port),
            });
        }
        let app = if let Some(settings) = &settings {
            let db = self.db.clone();
            let settings = settings.clone();
            let measurements = self.measurements.clone();
            Some(tokio::task::spawn_blocking(move || build(&db, &settings, measurements)).await??)
        } else {
            None
        };
        if let Some(previous) = active.take() {
            stop(previous).await;
        }
        let (Some(settings), Some(app)) = (settings, app) else {
            return Ok(Status {
                enabled: false,
                port: None,
            });
        };
        let listener =
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, settings.port)).await?;
        let port = listener.local_addr()?.port();
        let (shutdown, closed) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = closed.await;
                })
                .await
        });
        *active = Some(Active {
            settings,
            port,
            shutdown,
            task,
        });
        Ok(Status {
            enabled: true,
            port: Some(port),
        })
    }
    pub async fn close(&self) {
        if let Some(active) = self.active.lock().await.take() {
            stop(active).await;
        }
    }
    pub fn control(&self) -> Router {
        Router::new().route("/v1/task-reads/http", post(|State(listener): State<Self>, Json(settings): Json<Option<Settings>>| async move {
            match listener.configure(settings).await {
                Ok(status) => (StatusCode::OK, Json(json!(status))),
                Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"Direct read listener could not be configured"}))),
            }
        })).with_state(self.clone())
    }
}
async fn stop(active: Active) {
    let _ = active.shutdown.send(());
    let mut task = active.task;
    if tokio::time::timeout(Duration::from_secs(3), &mut task)
        .await
        .is_err()
    {
        task.abort();
        let _ = task.await;
    }
}
fn build(db: &Path, settings: &Settings, measurements: Measurements) -> Result<Router> {
    let auth = auth_http::Client::new(
        settings.auth_enabled,
        settings.cookie_name.clone(),
        settings.session_ttl_ms,
        settings.auth_origin.clone(),
        Box::new(SessionService::new(Box::new(SqliteSessions::open(db)?))),
    );
    let usage = usage_http::Client::new(Box::new(Service::new(Box::new(SqliteUsage::open(db)?))));
    let mut activities: Vec<Box<dyn ActivityReader>> = Vec::new();
    let mut transcripts: Vec<Box<dyn TranscriptReader>> = Vec::new();
    for _ in 0..4 {
        activities.push(Box::new(ActivityService::new(Box::new(
            SqliteActivity::open(db)?,
        ))));
        transcripts.push(Box::new(TranscriptService::new(Box::new(
            SqliteTranscript::open(db)?.require_clean(),
        ))));
    }
    let activity = activity_http::Client::pooled(activities);
    let transcript = transcript_http::Client::pooled(transcripts);
    let client = public_reads::Client::new(
        usage,
        activity,
        transcript,
        Box::new(SqliteReadAccess::open(db)?),
    );
    Ok(public_reads::router(client)
        .layer(middleware::from_fn_with_state(
            auth,
            auth_http::authenticate,
        ))
        .layer(middleware::from_fn_with_state(
            read_metrics::Metrics::new(measurements),
            read_metrics::measure,
        )))
}
