//! Public routine definition routes reuse the same serial owner as the private application socket.
use super::http::Client;
use crate::modules::routines::api::{Action, Error, ErrorKind};
use crate::platform::read_http::error;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{patch, post},
};
use serde_json::{Map, Value, json, value::RawValue};
use std::collections::BTreeMap;

fn issue(field: &str, code: &str) -> Error {
    Error::bad(format!("invalid request: {field} ({code})"))
}

fn text(value: &Value, field: &str, required: bool) -> Result<(), Error> {
    let s = value.as_str().ok_or_else(|| issue(field, "invalid_type"))?;
    if required && s.is_empty() {
        return Err(issue(field, "too_small"));
    }
    Ok(())
}

fn choice(value: &Value, field: &str, allowed: &[&str]) -> Result<(), Error> {
    if value.as_str().is_some_and(|s| allowed.contains(&s)) {
        Ok(())
    } else {
        Err(issue(field, "invalid_value"))
    }
}

fn integer(value: &mut Value, field: &str, min: i64, max: i64) -> Result<(), Error> {
    let n = value
        .as_f64()
        .filter(|n| n.fract() == 0.0)
        .ok_or_else(|| issue(field, "invalid_type"))?;
    if n < min as f64 {
        return Err(issue(field, "too_small"));
    }
    if n > max as f64 {
        return Err(issue(field, "too_big"));
    }
    *value = json!(n as i64);
    Ok(())
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
}

fn script(raw: &RawValue) -> Result<Value, Error> {
    if !raw.get().starts_with('{') {
        return Err(issue("script", "invalid_type"));
    }
    let fields: BTreeMap<String, &RawValue> =
        serde_json::from_str(raw.get()).map_err(|_| Error::bad("invalid JSON body"))?;
    let value = fields.get("command").map(|v| field_value(v)).transpose()?;
    let command = value
        .as_ref()
        .and_then(Value::as_str)
        .map(js_trim)
        .ok_or_else(|| issue("script.command", "invalid_type"))?;
    if command.is_empty() {
        return Err(issue("script.command", "too_small"));
    }
    if command.chars().count() > 16_000 {
        return Err(issue("script.command", "too_big"));
    }
    let mut script = json!({"command":command});
    if let Some(raw) = fields.get("timeoutSeconds") {
        let mut timeout = field_value(raw)?;
        integer(&mut timeout, "script.timeoutSeconds", 1, 3600)?;
        script["timeoutSeconds"] = timeout;
    }
    Ok(script)
}

fn field_value(raw: &RawValue) -> Result<Value, Error> {
    // The public schemas accept only scalars here. Avoid recursively decoding rejected values.
    match raw.get().as_bytes().first() {
        Some(b'{') => Ok(json!({})),
        Some(b'[') => Ok(json!([])),
        Some(b'-' | b'0'..=b'9') => Ok(json!(
            raw.get()
                .parse::<f64>()
                .map_err(|_| Error::bad("invalid JSON body"))?
        )),
        _ => serde_json::from_str(raw.get()).map_err(|_| Error::bad("Invalid JSON request")),
    }
}

// Mirror the public create/update schemas before passing admitted fields to the domain.
// Unknown fields are discarded, including immutable fields on PATCH. Explicit null is invalid.
fn input(bytes: &[u8], create: bool) -> Result<Value, Error> {
    let source = String::from_utf8_lossy(bytes);
    let source = source.strip_prefix('\u{feff}').unwrap_or(&source);
    let source = if source.is_empty() { "{}" } else { source };
    let raw: &RawValue =
        serde_json::from_str(source).map_err(|_| Error::bad("invalid JSON body"))?;
    if !raw.get().starts_with('{') {
        return Err(Error::bad("body must be a JSON object"));
    }
    // Skip unknown JSON values without converting them to Rust strings or numbers.
    let object: BTreeMap<String, &RawValue> =
        serde_json::from_str(raw.get()).map_err(|_| Error::bad("invalid JSON body"))?;
    let mut admitted = Map::new();
    let specific: &[&str] = if create {
        &["repoId", "agent", "prompt", "kind", "script"]
    } else {
        &["script", "prompt"]
    };
    for &field in specific.iter().chain(&[
        "preset",
        "schedule",
        "hour",
        "dayOfWeek",
        "permission",
        "model",
        "effort",
        "title",
        "enabled",
    ]) {
        let Some(raw) = object.get(field) else {
            if field == "repoId" {
                return Err(issue(field, "invalid_type"));
            }
            continue;
        };
        if field == "script" {
            admitted.insert(field.into(), script(raw)?);
            continue;
        }
        let mut value = field_value(raw)?;
        match field {
            "repoId" | "prompt" => text(&value, field, true)?,
            "agent" => choice(&value, field, &["claude", "codex"])?,
            "kind" => choice(&value, field, &["agent", "script"])?,
            "preset" => choice(
                &value,
                field,
                &["hourly", "daily", "weekly", "weekdays", "manual", "custom"],
            )?,
            "hour" => integer(&mut value, field, 0, 23)?,
            "dayOfWeek" => integer(&mut value, field, 0, 6)?,
            "enabled" if !value.is_boolean() => return Err(issue(field, "invalid_type")),
            "enabled" => {}
            _ => text(&value, field, false)?,
        }
        admitted.insert(field.into(), value);
    }
    if create {
        if admitted.get("kind").and_then(Value::as_str) == Some("script") {
            if !admitted.contains_key("script") {
                return Err(issue("script", "custom"));
            }
            if ["agent", "prompt", "permission", "model", "effort"]
                .iter()
                .any(|&k| admitted.contains_key(k))
            {
                return Err(issue("body", "custom"));
            }
        } else {
            if !admitted.contains_key("agent")
                || admitted
                    .get("prompt")
                    .and_then(Value::as_str)
                    .is_none_or(|s| js_trim(s).is_empty())
            {
                return Err(issue("body", "custom"));
            }
            if admitted.contains_key("script") {
                return Err(issue("script", "custom"));
            }
        }
    }
    Ok(Value::Object(admitted))
}

async fn submit(client: Client, action: Result<Action, Error>, success: StatusCode) -> Response {
    let result = match action {
        Ok(action) => client.request(action).await,
        Err(err) => Err(err),
    };
    match result {
        Ok(value) => (success, Json(value)).into_response(),
        Err(err) => {
            let (status, code) = match err.kind {
                ErrorKind::InvalidInput => (StatusCode::BAD_REQUEST, "bad_request"),
                ErrorKind::NotFound => (StatusCode::NOT_FOUND, "not_found"),
                ErrorKind::Conflict => (StatusCode::CONFLICT, "conflict"),
                ErrorKind::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"),
            };
            error(status, &err.message, Some(code))
        }
    }
}

pub fn router(client: Client) -> Router {
    Router::new()
        .route(
            "/api/routines",
            post(|State(client): State<Client>, bytes: Bytes| async move {
                submit(
                    client,
                    input(&bytes, true).map(Action::Create),
                    StatusCode::CREATED,
                )
                .await
            }),
        )
        .route(
            "/api/routines/{id}",
            patch(
                |State(client): State<Client>, Path(id): Path<String>, bytes: Bytes| async move {
                    submit(
                        client,
                        input(&bytes, false).map(|v| Action::Update(id, v)),
                        StatusCode::OK,
                    )
                    .await
                },
            )
            .delete(
                |State(client): State<Client>, Path(id): Path<String>| async move {
                    submit(client, Ok(Action::Remove(id)), StatusCode::OK).await
                },
            ),
        )
        .method_not_allowed_fallback(|| async { error(StatusCode::NOT_FOUND, "not found", None) })
        .with_state(client)
}
