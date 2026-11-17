//! Match the Node adapter's shared response schemas without decoding provider-owned JSON.
use crate::modules::tasks::api::MAX_CURSOR;
use serde_json::value::RawValue;
use std::collections::BTreeMap;

type Object<'a> = BTreeMap<String, &'a RawValue>;
#[derive(Clone, Copy)]
pub enum Contract {
    Page,
    Changes,
    Steps,
    Activity,
}
fn object(raw: &RawValue) -> Option<Object<'_>> {
    serde_json::from_str(raw.get()).ok()
}
fn array(raw: &RawValue) -> Option<Vec<&RawValue>> {
    serde_json::from_str(raw.get()).ok()
}
fn number(raw: &RawValue) -> Option<f64> {
    let n = raw.get().parse::<f64>().ok()?;
    n.is_finite().then_some(n)
}
fn cursor(raw: &RawValue) -> bool {
    number(raw).is_some_and(|n| n >= 0.0 && n <= MAX_CURSOR as f64 && n.fract() == 0.0)
}
fn nullable_cursor(raw: &RawValue) -> bool {
    raw.get() == "null" || cursor(raw)
}
fn string(raw: &RawValue) -> bool {
    raw.get().starts_with('"')
}
fn one_of(raw: &RawValue, values: &[&str]) -> bool {
    serde_json::from_str::<String>(raw.get()).is_ok_and(|value| values.contains(&value.as_str()))
}
fn activity(raw: &RawValue) -> bool {
    one_of(raw, &["idle", "working", "output", "blocked", "ended"])
}
fn required(row: &Object<'_>, fields: &[&str], check: fn(&RawValue) -> bool) -> bool {
    fields
        .iter()
        .all(|field| row.get(*field).is_some_and(|raw| check(raw)))
}
fn item(raw: &RawValue) -> bool {
    object(raw).is_some_and(|row| {
        required(&row, &["key", "endSeq", "revision"], cursor)
            && row
                .get("type")
                .is_some_and(|v| one_of(v, &["message", "activity", "failure"]))
    })
}
fn all(raw: &RawValue, check: fn(&RawValue) -> bool) -> bool {
    array(raw).is_some_and(|rows| rows.into_iter().all(check))
}
fn patch(raw: &RawValue) -> bool {
    object(raw).is_some_and(|row| {
        required(&row, &["key", "revision"], cursor)
            && row
                .get("item")
                .is_some_and(|v| v.get() == "null" || item(v))
    })
}
fn step(raw: &RawValue) -> bool {
    object(raw).is_some_and(|row| {
        required(&row, &["key"], cursor)
            && required(&row, &["title"], string)
            && row
                .get("kind")
                .is_some_and(|v| one_of(v, &["tool", "reasoning", "progress", "event"]))
            && row.get("state").is_some_and(|v| {
                one_of(
                    v,
                    &["running", "completed", "error", "interrupted", "unknown"],
                )
            })
            && row.get("description").is_none_or(|v| string(v))
    })
}
fn event(raw: &RawValue) -> bool {
    let Some(row) = object(raw) else {
        return false;
    };
    let Some(event) = row.get("event").and_then(|v| object(v)) else {
        return false;
    };
    required(&row, &["seq"], cursor)
        && required(&event, &["taskId"], string)
        && event
            .get("agent")
            .is_some_and(|v| one_of(v, &["claude", "codex"]))
        && event
            .get("kind")
            .is_some_and(|v| one_of(v, &["tool_call", "tool_result"]))
        && event.get("sessionId").is_none_or(|v| string(v))
        && event.get("ts").is_some_and(|v| number(v).is_some())
}
pub fn valid(body: &str, contract: Contract) -> bool {
    let Ok(row) = serde_json::from_str::<Object<'_>>(body) else {
        return false;
    };
    let empty_events = || {
        row.get("events")
            .and_then(|v| array(v))
            .is_some_and(|v| v.is_empty())
    };
    match contract {
        Contract::Page => {
            empty_events()
                && row.get("transcript").is_some_and(|v| all(v, item))
                && required(&row, &["before"], nullable_cursor)
                && required(&row, &["cursor"], cursor)
                && required(&row, &["activity"], activity)
        }
        Contract::Changes => {
            empty_events()
                && row.get("transcript").is_some_and(|v| all(v, patch))
                && required(&row, &["after", "through"], cursor)
                && required(&row, &["nextAfter"], nullable_cursor)
                && row.get("nextKey").is_none_or(|v| cursor(v))
                && row.get("activity").is_none_or(|v| activity(v))
        }
        Contract::Steps => {
            row.get("steps").is_some_and(|v| all(v, step))
                && required(&row, &["nextAfter"], nullable_cursor)
                && required(&row, &["cursor"], cursor)
        }
        Contract::Activity => {
            row.get("events").is_some_and(|v| all(v, event))
                && required(&row, &["from", "through", "cursor"], cursor)
        }
    }
}
