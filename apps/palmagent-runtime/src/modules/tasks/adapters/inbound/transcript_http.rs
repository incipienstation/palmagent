//! Private projection reads with bounded admission and off-executor serialization.
use super::public_contract::{self, Contract};
use crate::modules::tasks::api::{
    MAX_CURSOR, StepsError, StepsPage, TranscriptQuery, TranscriptRead, TranscriptReader,
};
use crate::platform::{read_pool::ReadPool, telemetry::Observation};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::time::Duration;

#[derive(Clone)]
pub struct Client {
    readers: ReadPool<Box<dyn TranscriptReader>>,
}
impl Client {
    pub fn new(reader: Box<dyn TranscriptReader>) -> Self {
        Self::pooled(vec![reader])
    }
    pub fn pooled(readers: Vec<Box<dyn TranscriptReader>>) -> Self {
        Self {
            readers: ReadPool::new(readers, 16, Duration::from_millis(250)),
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepsRequest {
    task_id: String,
    key: i64,
    after: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Steps<'a> {
    steps: Vec<&'a RawValue>,
    next_after: Option<i64>,
    cursor: i64,
}
fn encode_steps(page: &StepsPage) -> anyhow::Result<String> {
    Ok(serde_json::to_string(&Steps {
        steps: page
            .steps
            .iter()
            .map(|step| serde_json::from_str(&step.summary))
            .collect::<serde_json::Result<_>>()?,
        next_after: page.next_after,
        cursor: page.cursor,
    })?)
}
pub(super) enum Read {
    Transcript(TranscriptQuery),
    Steps { key: i64, after: i64 },
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
pub(super) async fn read(
    client: Client,
    task_id: String,
    query: Read,
) -> Result<([(header::HeaderName, &'static str); 1], String), Failure> {
    read_encoded(client, task_id, query, None, None).await
}
pub(super) async fn read_public(
    client: Client,
    task_id: String,
    query: Read,
    contract: Contract,
    queue: Option<Observation>,
) -> Result<([(header::HeaderName, &'static str); 1], String), Failure> {
    read_encoded(client, task_id, query, Some(contract), queue).await
}
async fn read_encoded(
    client: Client,
    task_id: String,
    query: Read,
    contract: Option<Contract>,
    queue: Option<Observation>,
) -> Result<([(header::HeaderName, &'static str); 1], String), Failure> {
    if task_id.is_empty() {
        return Err(invalid());
    }
    let body = client
        .readers
        .run_observed(queue, move |reader| {
            let body = match query {
                Read::Transcript(query) => {
                    let result = reader.read(&task_id, query).map_err(|_| unavailable())?;
                    encode(&result).map_err(|_| unavailable())
                }
                Read::Steps { key, after } => {
                    let result = reader.steps(&task_id, key, after).map_err(
                        |error| match error {
                            StepsError::NotFound => (
                                StatusCode::NOT_FOUND,
                                Json(json!({"error":"Conversation item is no longer available."})),
                            ),
                            StepsError::Unavailable => unavailable(),
                        },
                    )?;
                    encode_steps(&result).map_err(|_| unavailable())
                }
            }?;
            public_contract::finish(body, contract).map_err(|_| unavailable())
        })
        .await
        .map_err(|_| unavailable())??;
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
                        Read::Transcript(TranscriptQuery::Page {
                            before: request.before,
                        }),
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
                        Read::Transcript(TranscriptQuery::Changes {
                            after: request.after,
                            through: request.through,
                            after_key: request.after_key,
                        }),
                    )
                    .await
                },
            ),
        )
        .route(
            "/v1/tasks/transcript/steps",
            get(
                |State(client): State<Client>, Query(request): Query<StepsRequest>| async move {
                    if !cursor(request.key)
                        || request.key == 0
                        || request.after.is_some_and(|v| !cursor(v))
                    {
                        return Err(invalid());
                    }
                    read(
                        client,
                        request.task_id,
                        Read::Steps {
                            key: request.key,
                            after: request.after.unwrap_or(0),
                        },
                    )
                    .await
                },
            ),
        )
        .with_state(client)
}
