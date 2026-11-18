//! Only the migrated GET routes. Other APIs are routed directly to Node by the ingress.
use super::{
    activity_http, http, public_contract::Contract, read_metrics::ReadMeasurement, transcript_http,
};
use crate::modules::tasks::api::{MAX_CURSOR, TaskReadAccess, TranscriptQuery};
use crate::platform::read_http::{decode_path, error};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Client {
    usage: http::Client,
    activity: activity_http::Client,
    transcript: transcript_http::Client,
    access: Arc<Mutex<Box<dyn TaskReadAccess>>>,
}
impl Client {
    pub fn new(
        usage: http::Client,
        activity: activity_http::Client,
        transcript: transcript_http::Client,
        access: Box<dyn TaskReadAccess>,
    ) -> Self {
        Self {
            usage,
            activity,
            transcript,
            access: Arc::new(Mutex::new(access)),
        }
    }
    async fn task(&self, task_id: &str) -> Result<(), Response> {
        let access = self.access.clone();
        let id = task_id.to_owned();
        match tokio::task::spawn_blocking(move || {
            access
                .lock()
                .map_err(|_| anyhow::anyhow!("Task reader failed"))?
                .exists(&id)
        })
        .await
        {
            Ok(Ok(true)) => Ok(()),
            Ok(Ok(false)) => Err(error(
                StatusCode::NOT_FOUND,
                &format!("no such task: {task_id}"),
                Some("not_found"),
            )),
            _ => Err(unavailable("Task reads are temporarily unavailable")),
        }
    }
}
fn unavailable(message: &str) -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        message,
        Some("service_unavailable"),
    )
}
struct RequestError {
    field: String,
    code: &'static str,
}
impl From<RequestError> for Response {
    fn from(value: RequestError) -> Self {
        error(
            StatusCode::BAD_REQUEST,
            &format!("invalid request: {} ({})", value.field, value.code),
            Some("bad_request"),
        )
    }
}
fn invalid(field: &str, code: &'static str) -> RequestError {
    RequestError {
        field: field.to_owned(),
        code,
    }
}

struct Query(BTreeMap<String, String>);
impl Query {
    fn new(raw: &str) -> Self {
        let mut values = BTreeMap::new();
        for (key, value) in form_urlencoded::parse(raw.as_bytes()) {
            values
                .entry(key.into_owned())
                .or_insert_with(|| value.into_owned());
        }
        Self(values)
    }
    fn get(&self, field: &str) -> Option<&str> {
        self.0.get(field).map(String::as_str)
    }
    fn cursor(
        &self,
        field: &str,
        minimum: i64,
        required: bool,
    ) -> Result<Option<i64>, RequestError> {
        let Some(value) = self.get(field) else {
            return if required {
                Err(invalid(field, "invalid_type"))
            } else {
                Ok(None)
            };
        };
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid(field, "invalid_format"));
        }
        // Leading zeros have JavaScript Number semantics, including arbitrarily long zero prefixes.
        let value = value.trim_start_matches('0');
        let value = if value.is_empty() {
            0
        } else {
            value.parse::<i64>().map_err(|_| invalid(field, "custom"))?
        };
        if !(minimum..=MAX_CURSOR).contains(&value) {
            return Err(invalid(field, "custom"));
        }
        Ok(Some(value))
    }
    fn details(&self) -> Result<(), RequestError> {
        if self
            .get("details")
            .is_some_and(|value| !matches!(value, "summary" | "full"))
        {
            return Err(invalid("details", "invalid_value"));
        }
        Ok(())
    }
}
type EncodedRead =
    Result<([(header::HeaderName, &'static str); 1], String), (StatusCode, Json<Value>)>;
fn response(result: EncodedRead, message: &str) -> Response {
    match result {
        Ok((headers, body)) => (headers, body).into_response(),
        Err((StatusCode::NOT_FOUND, _)) => error(
            StatusCode::NOT_FOUND,
            "Conversation item is no longer available.",
            Some("not_found"),
        ),
        Err(_) => unavailable(message),
    }
}
async fn read(client: Client, request: Request) -> Result<Response, Response> {
    let not_found = || error(StatusCode::NOT_FOUND, "not found", None);
    if request.method() != "GET" {
        return Err(not_found());
    }
    let measurement = request.extensions().get::<ReadMeasurement>().cloned();
    let queue = || measurement.as_ref().map(ReadMeasurement::queue);
    let path = request.uri().path();
    if path == "/api/usage" {
        return Ok(match http::read_observed(client.usage, queue()).await {
            Ok(value) => value.into_response(),
            Err(_) => unavailable("Task usage is temporarily unavailable"),
        });
    }
    let parts: Vec<_> = path.split('/').collect();
    if !(parts.len() == 5 || parts.len() == 6)
        || parts[1] != "api"
        || parts[2] != "tasks"
        || parts[3].is_empty()
        || parts[4] != "history"
    {
        return Err(not_found());
    }
    let task_id = decode_path(parts[3])
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "invalid URL encoding", None))?;
    let query = Query::new(request.uri().query().unwrap_or(""));
    let operation = parts.get(5).copied().unwrap_or("");
    if matches!(operation, "" | "changes") && query.get("format") != Some("transcript") {
        return Err(not_found());
    }
    let request = match operation {
        "" => {
            let before = query.cursor("before", 1, false)?;
            query.details()?;
            transcript_http::Read::Transcript(TranscriptQuery::Page { before })
        }
        "changes" => {
            let after_key = query.cursor("afterKey", 0, false)?;
            let after = query.cursor("after", 0, true)?.unwrap();
            let through = query.cursor("through", 0, false)?;
            query.details()?;
            client.task(&task_id).await?;
            if through.is_some_and(|through| through < after) {
                return Err(error(
                    StatusCode::BAD_REQUEST,
                    "through must be at least after",
                    Some("bad_request"),
                ));
            }
            return Ok(response(
                transcript_http::read_public(
                    client.transcript,
                    task_id,
                    transcript_http::Read::Transcript(TranscriptQuery::Changes {
                        after,
                        through,
                        after_key,
                    }),
                    Contract::Changes,
                    queue(),
                )
                .await,
                "Task transcript is temporarily unavailable",
            ));
        }
        "steps" => {
            let key = query.cursor("key", 1, true)?.unwrap();
            let after = query.cursor("after", 0, false)?.unwrap_or(0);
            transcript_http::Read::Steps { key, after }
        }
        "details" => {
            let from = query.cursor("from", 1, true)?.unwrap();
            let through = query.cursor("through", 1, true)?.unwrap();
            client.task(&task_id).await?;
            if through < from {
                return Err(error(
                    StatusCode::BAD_REQUEST,
                    "through must be at least from",
                    Some("bad_request"),
                ));
            }
            return Ok(response(
                activity_http::read_public(client.activity, task_id, from, through, queue()).await,
                "Task activity is temporarily unavailable",
            ));
        }
        _ => return Err(not_found()),
    };
    client.task(&task_id).await?;
    Ok(response(
        transcript_http::read_public(
            client.transcript,
            task_id,
            request,
            if operation == "steps" {
                Contract::Steps
            } else {
                Contract::Page
            },
            queue(),
        )
        .await,
        "Task transcript is temporarily unavailable",
    ))
}
pub fn router(client: Client) -> Router {
    Router::new()
        .fallback(
            |State(client): State<Client>, request: Request| async move {
                match read(client, request).await {
                    Ok(response) | Err(response) => response,
                }
            },
        )
        .with_state(client)
}
