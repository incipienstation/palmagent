//! Task creation and attachment index operations on the owner's connection.
//! The caller holds a write transaction during file staging and retention.
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileCommand {
    Get {
        task_id: String,
        id: String,
    },
    Digest {
        task_id: String,
        digest: String,
    },
    Insert {
        id: String,
        task_id: String,
        media_type: String,
        size: i64,
        digest: String,
    },
    Lifecycle {
        id: String,
        unused_since: Option<i64>,
        expired_at: Option<i64>,
    },
    Delete {
        id: String,
    },
    RegisterDelivery {
        task_id: String,
        path: String,
        id: String,
    },
    DeliveredImage {
        task_id: String,
        path: String,
    },
    Inventory,
    References {
        task_id: String,
    },
}
const COLUMNS: &str = "a.id,a.task_id,a.media_type,a.size,a.digest,a.unused_since,a.expired_at";
fn record(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>(0)?,"taskId":row.get::<_,String>(1)?,
        "mediaType":row.get::<_,String>(2)?,"size":row.get::<_,i64>(3)?,"digest":row.get::<_,String>(4)?,
        "unusedSince":row.get::<_,Option<i64>>(5)?,"expiredAt":row.get::<_,Option<i64>>(6)?}),
    )
}

pub fn files(db: &Connection, command: FileCommand) -> Result<Value> {
    use FileCommand::*;
    match command {
        Get { task_id, id } => Ok(db
            .query_row(
                &format!("SELECT {COLUMNS} FROM attachments a WHERE task_id=? AND id=?"),
                params![task_id, id],
                record,
            )
            .optional()?
            .unwrap_or(Value::Null)),
        Digest { task_id, digest } => Ok(db
            .query_row(
                &format!("SELECT {COLUMNS} FROM attachments a WHERE task_id=? AND digest=?"),
                params![task_id, digest],
                record,
            )
            .optional()?
            .unwrap_or(Value::Null)),
        DeliveredImage { task_id, path } => Ok(json!(db.query_row(
            "SELECT attachment_id FROM delivered_images WHERE task_id=? AND source_path=? ORDER BY id LIMIT 1",
            params![task_id, path], |row| row.get::<_, String>(0),
        ).optional()?)),
        Inventory => {
            let mut query=db.prepare(&format!("SELECT {COLUMNS},t.status,t.updated_at FROM attachments a JOIN tasks t ON t.id=a.task_id"))?;
            let items = query
                .query_map([], |row| {
                    let mut item = record(row)?;
                    item["status"] = row.get::<_, String>(7)?.into();
                    item["updatedAt"] = row.get::<_, i64>(8)?.into();
                    Ok(item)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!(items))
        }
        References { task_id } => {
            // Extract only references. Unrelated status output can exceed the size
            // of an attachment and does not need to pass through the control pipe.
            let mut refs=db.prepare("SELECT json_extract(payload_json,'$.attachments') FROM events WHERE task_id=? AND kind='status'")?;
            let mut deliveries = db.prepare("SELECT attachment_id FROM delivered_images WHERE task_id=?")?;
            let mut history = deliveries.query_map([&task_id], |row| row.get(0))?
                .collect::<rusqlite::Result<BTreeSet<String>>>()?;
            let mut pending = BTreeSet::new();
            for entry in refs.query_map([&task_id], |row| row.get::<_, Option<String>>(0))? {
                if let Some(entry) = entry? {
                    collect_refs(&serde_json::from_str(&entry)?, &mut history);
                }
            }
            let mut queued=db.prepare("SELECT json_extract(m.value,'$.attachments') FROM task_message_state q,json_each(q.state,'$.messages') m
                WHERE task_id=? AND json_extract(m.value,'$.status') NOT IN ('delivered','cancelled')")?;
            for entry in queued.query_map([&task_id], |row| row.get::<_, Option<String>>(0))? {
                if let Some(entry) = entry? {
                    collect_refs(&serde_json::from_str(&entry)?, &mut pending);
                }
            }
            Ok(json!({"history":history,"pending":pending}))
        }
        write => {
            ensure!(
                !db.is_autocommit(),
                "Attachment change requires a transaction"
            );
            match write {
                Insert {
                    id,
                    task_id,
                    media_type,
                    size,
                    digest,
                } => db.execute(
                    "INSERT INTO attachments(id,task_id,media_type,size,digest) VALUES(?,?,?,?,?)",
                    params![id, task_id, media_type, size, digest],
                )?,
                Lifecycle {
                    id,
                    unused_since,
                    expired_at,
                } => db.execute(
                    "UPDATE attachments SET unused_since=?,expired_at=? WHERE id=?",
                    params![unused_since, expired_at, id],
                )?,
                RegisterDelivery { task_id, path, id } => db.execute(
                    "INSERT INTO delivered_images(task_id,source_path,attachment_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
                    params![task_id, path, id],
                )?,
                Delete { id } => db.execute("DELETE FROM attachments WHERE id=?", [id])?,
                _ => unreachable!(),
            };
            Ok(Value::Null)
        }
    }
}

fn collect_refs(values: &Value, ids: &mut BTreeSet<String>) {
    for value in values.as_array().into_iter().flatten() {
        if let Some(id) = value["id"].as_str() {
            ids.insert(id.to_owned());
        }
        for frame in value["video"]["frames"].as_array().into_iter().flatten() {
            if let Some(id) = frame["id"].as_str() {
                ids.insert(id.to_owned());
            }
        }
    }
}
