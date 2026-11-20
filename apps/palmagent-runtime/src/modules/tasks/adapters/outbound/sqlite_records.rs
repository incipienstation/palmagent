//! Snapshot reads for legacy history, expanded transcript items and raw execution records.
//! Embedded JSON is kept opaque so rendering and version hashes retain the shared wire format.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecordQuery {
    Item {
        key: i64,
    },
    SequenceKeys {
        before: Option<i64>,
        limit: i64,
    },
    Cursor,
    PageStart {
        before: i64,
        limit: i64,
    },
    Events {
        from: i64,
        through: i64,
        compact: bool,
        limit: i64,
    },
}

pub fn read(db: &Connection, id: &str, query: RecordQuery) -> Result<Value> {
    match query {
        RecordQuery::Item {key} => Ok(db.query_row("SELECT revision,body_json FROM conversation_rows WHERE task_id=? AND seq=? AND body_json IS NOT NULL",params![id,key],|r| Ok(json!({"revision":r.get::<_,i64>(0)?,"body_json":r.get::<_,String>(1)?}))).optional()?.unwrap_or(Value::Null)),
        RecordQuery::SequenceKeys { before, limit } => {
            let cursor = cursor(db,id)?;
            let mut stmt = db.prepare_cached("SELECT seq FROM events WHERE task_id=? AND seq<? ORDER BY seq DESC LIMIT ?")?;
            let keys = stmt.query_map(params![id,before.unwrap_or(cursor.saturating_add(1)),limit],|r| r.get::<_,i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({"cursor": cursor, "keys": keys}))
        }
        RecordQuery::Cursor => Ok(cursor(db,id)?.into()),
        RecordQuery::PageStart {before,limit} => {
            let edge = db.query_row("SELECT seq,kind FROM events WHERE task_id=? AND seq<? ORDER BY seq DESC LIMIT 1 OFFSET ?",params![id,before,limit-1],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional()?;
            Ok(match edge {
                None => 1, Some((seq,kind)) if kind == "assistant_text" => db.query_row("SELECT coalesce(max(seq),0)+1 FROM events WHERE task_id=? AND seq<? AND kind!='assistant_text'",params![id,seq],|r| r.get(0))?,
                Some((seq,_)) => seq,
            }.into())
        }
        RecordQuery::Events {from,through,compact,limit} => {
            let (payload,join) = if compact { ("coalesce(c.payload_json,e.payload_json)", "LEFT JOIN event_compact_payloads c ON c.event_id=e.id") } else { ("e.payload_json","") };
            let sql=format!("SELECT e.id,e.seq,e.task_id,e.kind,{payload},e.ts,t.agent,t.session_id FROM events e JOIN tasks t ON t.id=e.task_id {join} WHERE e.task_id=? AND e.seq BETWEEN ? AND ? ORDER BY e.seq LIMIT ?");
            let mut stmt=db.prepare_cached(&sql)?;
            let rows=stmt.query_map(params![id,from,through,limit],|r| Ok(json!({"id":r.get::<_,i64>(0)?,"seq":r.get::<_,i64>(1)?,"task_id":r.get::<_,String>(2)?,"kind":r.get::<_,String>(3)?,"payload_json":r.get::<_,String>(4)?,"ts":r.get::<_,i64>(5)?,"agent":r.get::<_,String>(6)?,"session_id":r.get::<_,Option<String>>(7)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!(rows))
        }
    }
}
fn cursor(db: &Connection, id: &str) -> rusqlite::Result<i64> {
    db.query_row(
        "SELECT coalesce(max(seq),0) FROM events WHERE task_id=?",
        [id],
        |r| r.get(0),
    )
}
