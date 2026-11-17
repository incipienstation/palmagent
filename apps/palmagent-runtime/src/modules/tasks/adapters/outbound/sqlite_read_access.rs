use crate::modules::tasks::application::read_access::TaskReadAccess;
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use std::{path::Path, time::Duration};
pub struct SqliteReadAccess {
    connection: Connection,
}
impl SqliteReadAccess {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.prepare("SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?)")?;
        Ok(Self { connection })
    }
}
impl TaskReadAccess for SqliteReadAccess {
    fn exists(&mut self, task_id: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?)",
            [task_id],
            |row| row.get(0),
        )?)
    }
}
