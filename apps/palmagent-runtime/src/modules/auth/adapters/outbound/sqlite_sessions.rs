//! Login, revocation and session cleanup remain with the Node auth owner.
use crate::modules::auth::application::SessionRepository;
use crate::modules::auth::domain::Session;
use anyhow::Result;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{path::Path, time::Duration};

pub struct SqliteSessions {
    connection: Connection,
}
impl SqliteSessions {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.prepare("SELECT created_at, expires_at FROM auth_sessions WHERE token = ?")?;
        Ok(Self { connection })
    }
}
impl SessionRepository for SqliteSessions {
    fn session(&mut self, token: &str) -> Result<Option<Session>> {
        Ok(self
            .connection
            .query_row(
                "SELECT created_at, expires_at FROM auth_sessions WHERE token = ?",
                [token],
                |row| {
                    Ok(Session {
                        created_at: row.get(0)?,
                        expires_at: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }
}
