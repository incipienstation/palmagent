//! Private projection reads with bounded admission and off-executor serialization.
use crate::modules::tasks::api::{MAX_CURSOR, TranscriptQuery, TranscriptRead, TranscriptReader};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Client {
    reader: Arc<Mutex<Box<dyn TranscriptReader>>>,
    slots: Arc<Semaphore>,
}
impl Client {
    pub fn new(reader: Box<dyn TranscriptReader>) -> Self {
        Self {
            reader: Arc::new(Mutex::new(reader)),
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageRequest {
    task_id: String,
    before: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesRequest {
    task_id: String,
    after: i64,
    through: Option<i64>,
    after_key: Option<i64>,
}
#[derive(Serialize)]
struct Page<'a> {
    events: [(); 0],
    transcript: Vec<&'a RawValue>,
    before: Option<i64>,
    cursor: i64,
    activity: &'a str,
}
#[derive(Serialize)]
struct Patch<'a> {
    key: i64,
    revision: i64,
    item: Option<&'a RawValue>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Changes<'a> {
    events: [(); 0],
    transcript: Vec<Patch<'a>>,
    after: i64,
    through: i64,
    next_after: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_key: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activity: Option<&'a str>,
}
fn encode(read: &TranscriptRead) -> anyhow::Result<String> {
    Ok(match read {
        TranscriptRead::Page(page) => serde_json::to_string(&Page {
            events: [],
            transcript: page
                .rows
                .iter()
                .map(|row| serde_json::from_str(row.wire_json.as_deref().unwrap_or("null")))
                .collect::<serde_json::Result<_>>()?,
            before: page.before,
            cursor: page.cursor,
            activity: &page.activity,
        })?,
        TranscriptRead::Changes(changes) => serde_json::to_string(&Changes {
            events: [],
            transcript: changes
                .rows
                .iter()
                .map(|row| {
                    Ok(Patch {
                        key: row.key,
                        revision: row.revision,
                        item: row
                            .wire_json
                            .as_deref()
                            .map(serde_json::from_str)
                            .transpose()?,
                    })
                })
                .collect::<serde_json::Result<_>>()?,
            after: changes.after,
            through: changes.through,
            next_after: changes.next_after,
            next_key: changes.next_key,
            activity: changes.activity.as_deref(),
        })?,
    })
}
type Failure = (StatusCode, Json<Value>);
fn unavailable() -> Failure {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"Task transcript is temporarily unavailable"})),
    )
}
fn invalid() -> Failure {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"Invalid transcript range"})),
    )
}
fn cursor(value: i64) -> bool {
    (0..=MAX_CURSOR).contains(&value)
}
async fn read(
    client: Client,
    task_id: String,
    query: TranscriptQuery,
) -> Result<([(header::HeaderName, &'static str); 1], String), Failure> {
    if task_id.is_empty() {
        return Err(invalid());
    }
    let permit = client
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| unavailable())?;
    let body = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = client
            .reader
            .lock()
            .map_err(|_| anyhow::anyhow!("Transcript reader failed"))?
            .read(&task_id, query)?;
        encode(&result)
    })
    .await
    .map_err(|_| unavailable())?
    .map_err(|_| unavailable())?;
    Ok(([(header::CONTENT_TYPE, "application/json")], body))
}
pub fn router(client: Client) -> Router {
    Router::new()
        .route(
            "/v1/tasks/transcript/page",
            get(
                |State(client): State<Client>, Query(request): Query<PageRequest>| async move {
                    if request.before.is_some_and(|v| !cursor(v) || v == 0) {
                        return Err(invalid());
                    }
                    read(
                        client,
                        request.task_id,
                        TranscriptQuery::Page {
                            before: request.before,
                        },
                    )
                    .await
                },
            ),
        )
        .route(
            "/v1/tasks/transcript/changes",
            get(
                |State(client): State<Client>, Query(request): Query<ChangesRequest>| async move {
                    if !cursor(request.after)
                        || request
                            .through
                            .is_some_and(|v| !cursor(v) || v < request.after)
                        || request.after_key.is_some_and(|v| !cursor(v))
                    {
                        return Err(invalid());
                    }
                    read(
                        client,
                        request.task_id,
                        TranscriptQuery::Changes {
                            after: request.after,
                            through: request.through,
                            after_key: request.after_key,
                        },
                    )
                    .await
                },
            ),
        )
        .with_state(client)
}
