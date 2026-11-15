//! A separate read-only connection: TypeScript remains the sole event/schema writer.
use crate::modules::tasks::application::activity::{
    ActivityRecord, ActivityRepository, ActivitySnapshot,
};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags, params};
use std::{path::Path, time::Duration};

pub struct SqliteActivity {
    connection: Connection,
}
impl SqliteActivity {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.prepare("SELECT e.seq, e.payload_json, e.ts, t.agent, t.session_id FROM events e JOIN tasks t ON t.id = e.task_id LIMIT 0")?;
        Ok(Self { connection })
    }
}
impl ActivityRepository for SqliteActivity {
    fn read(&mut self, task_id: &str, from: i64, through: i64) -> Result<ActivitySnapshot> {
        let tx = self.connection.transaction()?;
        let cursor = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )?;
        let events = {
            let mut statement = tx.prepare("SELECT e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
                FROM events e JOIN tasks t ON t.id = e.task_id
                WHERE e.task_id = ? AND e.seq >= ? AND e.seq <= ? AND e.kind IN ('tool_call', 'tool_result') ORDER BY e.seq")?;
            statement
                .query_map(params![task_id, from, through], |row| {
                    Ok(ActivityRecord {
                        seq: row.get(0)?,
                        task_id: row.get(1)?,
                        kind: row.get(2)?,
                        payload_json: row.get(3)?,
                        ts: row.get(4)?,
                        agent: row.get(5)?,
                        session_id: row.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(ActivitySnapshot { cursor, events })
    }
}
