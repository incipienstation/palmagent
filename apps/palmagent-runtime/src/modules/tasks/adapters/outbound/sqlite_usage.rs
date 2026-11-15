//! Read-only product database adapter. TypeScript owns schema initialization and all writes.
use crate::modules::tasks::{
    application::UsageRepository,
    domain::{Metric, UsageRecord},
};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::value::RawValue;
use std::{collections::BTreeMap, path::Path, time::Duration};

pub struct SqliteUsage {
    connection: Connection,
}
impl SqliteUsage {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.prepare("SELECT revision FROM task_usage_revision WHERE id = 1")?;
        connection.prepare(
            "SELECT t.agent, e.payload_json FROM events e JOIN tasks t ON t.id = e.task_id LIMIT 0",
        )?;
        Ok(Self { connection })
    }
}
impl UsageRepository for SqliteUsage {
    fn read(
        &mut self,
        known_revision: Option<i64>,
        record: &mut dyn FnMut(UsageRecord),
    ) -> Result<Option<i64>> {
        let tx = self.connection.transaction()?;
        let revision: i64 = tx.query_row(
            "SELECT revision FROM task_usage_revision WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        if known_revision == Some(revision) {
            tx.commit()?;
            return Ok(None);
        }
        {
            let mut statement =
                tx.prepare("SELECT agent, COUNT(*) FROM tasks GROUP BY agent ORDER BY agent")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                record(UsageRecord::Tasks {
                    agent: row.get(0)?,
                    count: row.get::<_, i64>(1)?.try_into()?,
                });
            }
            let mut statement = tx.prepare("SELECT t.agent, e.payload_json FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.kind = 'result' ORDER BY e.id")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let agent: String = row.get(0)?;
                let payload: String = row.get(1)?;
                let metrics = metrics(&agent, &payload);
                record(UsageRecord::Result { agent, metrics });
            }
        }
        tx.commit()?;
        Ok(Some(revision))
    }
}
// Read only accounting fields. Raw numbers preserve JSON.parse's handling of overflowing
// numeric literals without discarding other valid metrics or decoding transcript strings.
type Fields = BTreeMap<String, Box<RawValue>>;
fn number(raw: Option<&RawValue>) -> Option<f64> {
    raw?.get()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
}
fn metrics(agent: &str, payload: &str) -> Vec<(Metric, f64)> {
    let Ok(payload) = serde_json::from_str::<Fields>(payload) else {
        return vec![];
    };
    let tokens = payload
        .get("usage")
        .and_then(|raw| serde_json::from_str::<Fields>(raw.get()).ok())
        .unwrap_or_default();
    let token = |key: &str| number(tokens.get(key).map(Box::as_ref));
    let input = token("input_tokens").map(|input| {
        if agent == "claude" {
            input
                + token("cache_read_input_tokens").unwrap_or(0.0)
                + token("cache_creation_input_tokens").unwrap_or(0.0)
        } else {
            input
        }
    });
    [
        (
            Metric::TotalCostUsd,
            number(payload.get("total_cost_usd").map(Box::as_ref)),
        ),
        (
            Metric::DurationMs,
            number(payload.get("duration_ms").map(Box::as_ref)),
        ),
        (Metric::InputTokens, input),
        (
            Metric::CachedInputTokens,
            token(if agent == "claude" {
                "cache_read_input_tokens"
            } else {
                "cached_input_tokens"
            }),
        ),
        (Metric::OutputTokens, token("output_tokens")),
        (
            Metric::ReasoningOutputTokens,
            token("reasoning_output_tokens"),
        ),
    ]
    .into_iter()
    .filter_map(|(metric, value)| value.map(|value| (metric, value)))
    .collect()
}
