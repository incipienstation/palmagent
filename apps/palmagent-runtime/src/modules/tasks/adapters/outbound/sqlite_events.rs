use super::super::super::application::event_batches::{
    Assigned, Batch, DisplayRenderer, EventRepository, ImportMarker,
};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};

pub struct SqliteEvents<'a>(pub &'a mut Connection);

impl EventRepository for SqliteEvents<'_> {
    fn append(
        &mut self,
        batch: &Batch,
        renderer: &mut impl DisplayRenderer,
    ) -> Result<Vec<Assigned>> {
        let id = &batch.task_id;
        let (events, raw_seq, now) = (&batch.events, batch.raw_seq, batch.now);
        let db = super::sqlite_write::Write::begin(self.0)?;
        let version: i64 = db.query_row(
            "SELECT version FROM conversation_projection_version",
            [],
            |r| r.get(0),
        )?;
        ensure!(version == 6, "Incompatible conversation projection");
        let previous = db.query_row("SELECT last_raw_seq FROM tasks WHERE id=?", [id], |r| {
            r.get::<_, i64>(0)
        })?;
        if raw_seq.is_some_and(|seq| seq <= previous) {
            return Ok(Vec::new());
        }
        let dirty: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_dirty WHERE task_id=?)",
            [id],
            |r| r.get(0),
        )?;
        ensure!(
            !dirty,
            "Conversation requires projection repair before append"
        );
        let mut cursor: i64 = db.query_row(
            "SELECT coalesce(max(seq),0) FROM events WHERE task_id=?",
            [id],
            |r| r.get(0),
        )?;
        if let Some(session) = &batch.session {
            let mut read = db.prepare("SELECT text_length,text_hash FROM session_imports WHERE task_id=?1 AND source_id=?2")?;
            let mut save = db.prepare("INSERT INTO session_imports(task_id,source_id,text_length,text_hash) VALUES(?,?,?,?)
              ON CONFLICT(task_id,source_id) DO UPDATE SET text_length=excluded.text_length,text_hash=excluded.text_hash")?;
            for change in &session.changes {
                let previous = read
                    .query_row(params![id, change.source], |r| {
                        Ok(ImportMarker {
                            length: r.get(0)?,
                            hash: r.get(1)?,
                        })
                    })
                    .optional()?;
                ensure!(
                    previous == change.previous,
                    "Session import prefix changed before commit"
                );
                save.execute(params![
                    id,
                    change.source,
                    change.next.length,
                    change.next.hash
                ])?;
            }
            db.execute(
                "UPDATE tasks SET session_control=? WHERE id=?",
                params![session.control, id],
            )?;
        }
        if events.is_empty() {
            if batch.session.is_none() {
                db.execute("UPDATE tasks SET last_raw_seq=coalesce(?,last_raw_seq),last_activity_at=? WHERE id=?",
                    params![raw_seq,now,id])?;
            }
            db.commit()?;
            return Ok(Vec::new());
        }
        if let Some(line) = &batch.provider {
            let event = &events[0];
            let (status, interrupted, session, question) = db.query_row(
                "SELECT status,interrupted,session_id,json_extract(pending_input,'$.requestId') FROM tasks WHERE id=?",
                [id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,bool>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?)))?;
            let changes = line
                .changes(
                    event,
                    &status,
                    interrupted,
                    session.as_deref(),
                    question.as_deref(),
                    now,
                )
                .into_iter()
                .map(
                    |action| super::super::super::application::lifecycle::Change {
                        task_id: id.clone(),
                        action,
                    },
                )
                .collect::<Vec<_>>();
            super::sqlite_lifecycle::persist(&db, &changes)?;
            if event.kind == "status"
                && line.subtype.as_deref() == Some("message_delivered")
                && let Some(message) = &line.message_id
            {
                use super::super::super::application::message_queue::{Command, transition};
                super::sqlite_message_queue::update(&db, id, |queue| {
                    transition(queue, Command::Delivered { id: message })
                })
                .map_err(|err| anyhow::anyhow!("Could not commit provider receipt: {err:?}"))?;
            }
        }
        let mut assigned = Vec::with_capacity(events.len());
        {
            let mut insert = db.prepare(
                "INSERT INTO events(task_id,seq,kind,payload_json,ts) VALUES(?,?,?,?,?)",
            )?;
            let mut compact =
                db.prepare("SELECT payload_json FROM event_compact_payloads WHERE event_id=?")?;
            for event in events {
                cursor = cursor
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("Event cursor overflow"))?;
                insert.execute(params![id, cursor, event.kind, event.payload, event.ts])?;
                let row_id = db.last_insert_rowid();
                assigned.push(Assigned {
                    id: row_id,
                    seq: cursor,
                    compact: compact.query_row([row_id], |r| r.get(0)).optional()?,
                });
            }
        }
        let projection = renderer.project(&assigned)?;
        ensure!(
            projection.cursor == cursor && projection.start > 0 && projection.start <= cursor,
            "Projection does not cover the event batch"
        );
        {
            let mut save = db.prepare("INSERT INTO conversation_rows(task_id,seq,block_start,end_seq,revision,body_json,wire_json)
                VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id,seq) DO UPDATE SET block_start=excluded.block_start,
                end_seq=excluded.end_seq,revision=excluded.revision,body_json=excluded.body_json,wire_json=excluded.wire_json")?;
            for row in projection.changes {
                ensure!(
                    row.key > 0
                        && row.key <= row.end
                        && row.end <= cursor
                        && row.revision <= cursor
                        && row.body.is_some() == row.wire.is_some(),
                    "Invalid conversation row in projection"
                );
                save.execute(params![
                    id,
                    row.key,
                    row.start,
                    row.end,
                    row.revision,
                    row.body,
                    row.wire
                ])?;
            }
        }
        db.execute("INSERT INTO conversation_state(task_id,cursor,block_start,log_json,activity) VALUES(?,?,?,?,?)
          ON CONFLICT(task_id) DO UPDATE SET cursor=excluded.cursor,block_start=excluded.block_start,log_json=excluded.log_json,activity=excluded.activity",
          params![id,cursor,projection.start,projection.log,projection.activity])?;
        db.execute("DELETE FROM conversation_dirty WHERE task_id=?", [id])?;
        if let Some(pr) = projection.prs {
            db.execute("INSERT INTO task_pr_evidence VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET state_json=excluded.state_json",params![id,pr.evidence])?;
            db.execute(
                "UPDATE tasks SET pr_urls=?,pr_url=?,updated_at=coalesce(?,updated_at) WHERE id=?",
                params![pr.body, pr.first, pr.updated_at, id],
            )?;
        }
        if let Some(context) = projection.context {
            db.execute("INSERT INTO task_context_usage VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET context_usage_json=excluded.context_usage_json",params![id,context.body])?;
        }
        db.execute(
            "UPDATE tasks SET last_raw_seq=coalesce(?,last_raw_seq),last_activity_at=? WHERE id=?",
            params![raw_seq, now, id],
        )?;
        db.commit()?;
        Ok(assigned)
    }
}
