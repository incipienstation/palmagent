//! Private activity read endpoint. Hold admission through database read and serialization.
use crate::modules::tasks::api::{ActivityDetails, ActivityReader, ActivityRecord};
use crate::platform::read_pool::ReadPool;
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::time::Duration;

#[derive(Clone)]
pub struct Client {
    readers: ReadPool<Box<dyn ActivityReader>>,
}
impl Client {
    pub fn new(reader: Box<dyn ActivityReader>) -> Self {
        Self {
            readers: ReadPool::new(vec![reader], 16, Duration::from_millis(250)),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    task_id: String,
    from: i64,
    through: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event<'a> {
    task_id: &'a str,
    agent: &'a str,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    payload: &'a RawValue,
    ts: i64,
}
#[derive(Serialize)]
struct Row<'a> {
    seq: i64,
    event: Event<'a>,
}
#[derive(Serialize)]
struct Response<'a> {
    events: Vec<Row<'a>>,
    from: i64,
    through: i64,
    cursor: i64,
}
fn row(record: &ActivityRecord) -> anyhow::Result<Row<'_>> {
    // Raw JSON preserves duplicate keys, large numeric literals and escaped lone surrogates
    // until the existing JavaScript API boundary applies JSON.parse/JSON.stringify semantics.
    Ok(Row {
        seq: record.seq,
        event: Event {
            task_id: &record.task_id,
            agent: &record.agent,
            kind: &record.kind,
            session_id: record.session_id.as_deref(),
            ts: record.ts,
            payload: serde_json::from_str(&record.payload_json)?,
        },
    })
}
fn encode(details: &ActivityDetails) -> anyhow::Result<String> {
    Ok(serde_json::to_string(&Response {
        events: details
            .snapshot
            .events
            .iter()
            .map(row)
            .collect::<anyhow::Result<_>>()?,
        from: details.from,
        through: details.through,
        cursor: details.snapshot.cursor,
    })?)
}
fn unavailable() -> (StatusCode, Json<Value>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"Task activity is temporarily unavailable"})),
    )
}
pub fn router(client: Client) -> Router {
    Router::new()
        .route(
            "/v1/tasks/activity-details",
            get(
                |State(client): State<Client>, Query(request): Query<Request>| async move {
                    if request.task_id.is_empty()
                        || request.from < 1
                        || request.through < request.from
                        || request.through > 9_007_199_254_740_991
                    {
                        return Err((
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error":"Invalid activity range"})),
                        ));
                    }
                    read(client, request.task_id, request.from, request.through).await
                },
            ),
        )
        .with_state(client)
}

pub(super) async fn read(
    client: Client,
    task_id: String,
    from: i64,
    through: i64,
) -> Result<([(axum::http::header::HeaderName, &'static str); 1], String), (StatusCode, Json<Value>)>
{
    let body = client
        .readers
        .run(move |reader| {
            let details = reader.details(&task_id, from, through)?;
            encode(&details)
        })
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    Ok::<_, (StatusCode, Json<Value>)>((
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body,
    ))
}
