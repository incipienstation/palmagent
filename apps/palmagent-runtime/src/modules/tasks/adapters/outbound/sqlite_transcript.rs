//! Read only the versioned projection. Schema and projection writes remain in TypeScript.
use crate::modules::tasks::domain::steps::{Step, StepsSnapshot};
use crate::modules::tasks::{
    application::transcript::TranscriptRepository,
    domain::transcript::{
        MAX_CURSOR, PAGE_ITEMS, ProjectionRow, TranscriptQuery, TranscriptSnapshot,
    },
};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::{path::Path, time::Duration};

pub struct SqliteTranscript {
    connection: Connection,
}
impl SqliteTranscript {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.prepare("SELECT cursor, activity FROM conversation_state LIMIT 0")?;
        connection.prepare("SELECT seq, revision, wire_json FROM conversation_rows LIMIT 0")?;
        check_version(&connection)?;
        Ok(Self { connection })
    }
}
fn check_version(connection: &Connection) -> Result<()> {
    // Mirrors CONVERSATION_PROJECTION_VERSION; parity tests exercise the product bootstrap.
    let version: i64 = connection.query_row(
        "SELECT version FROM conversation_projection_version",
        [],
        |row| row.get(0),
    )?;
    ensure!(version == 6, "Unsupported conversation projection");
    Ok(())
}
fn row(row: &rusqlite::Row<'_>, changes: bool) -> rusqlite::Result<ProjectionRow> {
    let key: i64 = row.get(0)?;
    let revision: i64 = row.get(1)?;
    let wire_json: Option<String> = row.get(2)?;
    // The sole projection writer stores canonical JSON.stringify output. A change patch
    // adds this fixed envelope; page rows count just the persisted item bytes.
    let bytes = if changes {
        format!("{{\"key\":{key},\"revision\":{revision},\"item\":}}").len()
            + wire_json.as_ref().map_or(4, String::len)
    } else {
        wire_json.as_ref().map_or(0, String::len)
    };
    Ok(ProjectionRow {
        key,
        revision,
        wire_json,
        bytes,
    })
}
impl TranscriptRepository for SqliteTranscript {
    fn steps(&mut self, task_id: &str, key: i64) -> Result<Option<StepsSnapshot>> {
        let tx = self.connection.transaction()?;
        check_version(&tx)?;
        let record = tx.query_row("SELECT revision, body_json FROM conversation_rows WHERE task_id = ? AND seq = ? AND body_json IS NOT NULL",
            params![task_id, key], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).optional()?;
        let snapshot = record
            .map(|(revision, body)| decode_steps(revision, &body))
            .transpose()?;
        tx.commit()?;
        Ok(snapshot)
    }

    fn read(&mut self, task_id: &str, query: TranscriptQuery) -> Result<TranscriptSnapshot> {
        let tx = self.connection.transaction()?;
        check_version(&tx)?;
        let (cursor, activity) = tx
            .query_row(
                "SELECT cursor, activity FROM conversation_state WHERE task_id = ?",
                [task_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .unwrap_or((0, "working".into()));
        let rows = match query {
            TranscriptQuery::Page { before } => {
                let mut stmt = tx.prepare("SELECT seq, revision, wire_json FROM conversation_rows INDEXED BY conversation_visible
                    WHERE task_id = ? AND seq < ? AND wire_json IS NOT NULL ORDER BY seq DESC LIMIT ?")?;
                stmt.query_map(
                    params![task_id, before.unwrap_or(MAX_CURSOR), PAGE_ITEMS as i64 + 1],
                    |r| row(r, false),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
            }
            TranscriptQuery::Changes {
                after, after_key, ..
            } => {
                let mut stmt = tx.prepare("SELECT seq, revision, wire_json FROM conversation_rows
                    WHERE task_id = ? AND revision >= ? AND revision <= ? AND (revision > ? OR seq > ?)
                    ORDER BY revision, seq LIMIT ?")?;
                stmt.query_map(
                    params![
                        task_id,
                        after,
                        query.end(cursor),
                        after,
                        after_key.unwrap_or(MAX_CURSOR),
                        PAGE_ITEMS as i64 + 1
                    ],
                    |r| row(r, true),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        tx.commit()?;
        Ok(TranscriptSnapshot {
            cursor,
            activity,
            rows,
        })
    }
}

// Decode only the operation projection. Raw values preserve escaped lone surrogates
// and future summary fields without pulling provider payloads into the core contract.
fn decode_steps(revision: i64, body: &str) -> Result<StepsSnapshot> {
    type Fields = BTreeMap<String, Box<RawValue>>;
    let body: Fields = serde_json::from_str(body)?;
    let kind = body
        .get("type")
        .map(|value| serde_json::from_str::<String>(value.get()))
        .transpose()?;
    let operations = if kind.as_deref() == Some("activity") {
        body.get("operations")
            .map(|raw| serde_json::from_str::<Option<Vec<Fields>>>(raw.get()))
            .transpose()?
            .flatten()
            .unwrap_or_default()
    } else {
        vec![]
    };
    let mut steps = Vec::with_capacity(operations.len());
    for mut operation in operations {
        let key = serde_json::from_str(
            operation
                .get("key")
                .ok_or_else(|| anyhow::anyhow!("Missing step key"))?
                .get(),
        )?;
        operation.remove("members");
        steps.push(Step {
            key,
            summary: serde_json::to_string(&operation)?,
        });
    }
    Ok(StepsSnapshot { revision, steps })
}
