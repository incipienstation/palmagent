//! SQLite implementation of the routine repository. The schema remains owned by product migrations.
use crate::{
    modules::routines::application::{Repo, Repository},
    modules::routines::domain::{Routine, Run},
};
use anyhow::{Result, ensure};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, params, params_from_iter,
    types::Value as SqlValue,
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

pub struct SqliteRepository {
    connection: Connection,
}
impl SqliteRepository {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        // A new installation initializes its schema in the web composition before requesting this service.
        connection.prepare("SELECT kind, script_json FROM routines LIMIT 0")?;
        connection.prepare("SELECT result_json FROM routine_runs LIMIT 0")?;
        Ok(Self { connection })
    }
}
fn decode_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}
fn routine(row: &Row<'_>) -> rusqlite::Result<Routine> {
    Ok(Routine {
        id: row.get("id")?,
        repo_id: row.get("repo_id")?,
        kind: row.get("kind")?,
        script: serde_json::from_str(&row.get::<_, String>("script_json")?)
            .map_err(decode_error)?,
        agent: row.get("agent")?,
        title: row.get("title")?,
        prompt: row.get("prompt")?,
        permission: row.get("permission")?,
        model: row.get("model")?,
        effort: row.get("effort")?,
        preset: row.get("preset")?,
        schedule: row.get("schedule")?,
        enabled: row.get::<_, i64>("enabled")? == 1,
        last_run_at: row.get("last_run_at")?,
        next_run_at: row.get("next_run_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
fn run(row: &Row<'_>) -> rusqlite::Result<Run> {
    let mut result = row
        .get::<_, Option<String>>("result_json")?
        .map(|text| serde_json::from_str::<serde_json::Map<String, Value>>(&text))
        .transpose()
        .map_err(decode_error)?
        .unwrap_or_default();
    for field in ["id", "routineId", "firedAt", "status", "note", "taskId"] {
        result.remove(field);
    }
    Ok(Run {
        id: row.get("id")?,
        routine_id: row.get("routine_id")?,
        fired_at: row.get("fired_at")?,
        status: row.get("status")?,
        note: row.get("note")?,
        result,
    })
}
fn values(r: &Routine) -> Result<Vec<SqlValue>> {
    Ok(vec![
        r.id.clone().into(),
        r.repo_id.clone().into(),
        r.kind.clone().into(),
        serde_json::to_string(&r.script)?.into(),
        r.agent.clone().into(),
        r.title.clone().into(),
        r.prompt.clone().into(),
        r.permission.clone().into(),
        r.model.clone().into(),
        r.effort.clone().into(),
        r.preset.clone().into(),
        r.schedule.clone().into(),
        i64::from(r.enabled).into(),
        r.last_run_at.into(),
        r.next_run_at.into(),
        r.created_at.into(),
        r.updated_at.into(),
    ])
}
const UPDATE: &str = "UPDATE routines SET repo_id=?2,kind=?3,script_json=?4,agent=?5,title=?6,prompt=?7,permission=?8,model=?9,effort=?10,preset=?11,schedule=?12,enabled=?13,last_run_at=?14,next_run_at=?15,created_at=?16,updated_at=?17 WHERE id=?1 AND kind='script'";

impl Repository for SqliteRepository {
    fn list(&self) -> Result<Vec<Routine>> {
        Ok(self
            .connection
            .prepare("SELECT * FROM routines WHERE kind='script' ORDER BY created_at")?
            .query_map([], routine)?
            .collect::<rusqlite::Result<_>>()?)
    }
    fn get(&self, id: &str) -> Result<Option<Routine>> {
        Ok(self
            .connection
            .query_row(
                "SELECT * FROM routines WHERE id=? AND kind='script'",
                [id],
                routine,
            )
            .optional()?)
    }
    fn repo(&self, id: &str) -> Result<Option<Repo>> {
        Ok(self
            .connection
            .query_row(
                "SELECT path,default_base_ref,vcs FROM repos WHERE id=?",
                [id],
                |row| {
                    Ok(Repo {
                        path: row.get(0)?,
                        base: row.get(1)?,
                        vcs: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }
    fn insert(&mut self, routine: &Routine) -> Result<()> {
        ensure!(routine.kind == "script", "Invalid routine ownership");
        self.connection.execute("INSERT INTO routines (id,repo_id,kind,script_json,agent,title,prompt,permission,model,effort,preset,schedule,enabled,last_run_at,next_run_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)", params_from_iter(values(routine)?))?;
        Ok(())
    }
    fn update(&mut self, routine: &Routine) -> Result<()> {
        ensure!(routine.kind == "script", "Invalid routine ownership");
        ensure!(
            self.connection
                .execute(UPDATE, params_from_iter(values(routine)?))?
                == 1,
            "Routine no longer exists"
        );
        Ok(())
    }
    fn remove(&mut self, id: &str) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let running: i64 = tx.query_row(
            "SELECT count(*) FROM routine_runs WHERE routine_id=? AND status='running'",
            [id],
            |r| r.get(0),
        )?;
        ensure!(running == 0, "Routine still has an active admission");
        ensure!(
            tx.execute("DELETE FROM routines WHERE id=? AND kind='script'", [id])? == 1,
            "Routine no longer exists"
        );
        tx.execute("DELETE FROM routine_runs WHERE routine_id=?", [id])?;
        tx.commit()?;
        Ok(())
    }
    fn runs(&self, id: &str, limit: usize) -> Result<Vec<Run>> {
        Ok(self.connection.prepare("SELECT * FROM routine_runs WHERE routine_id=? ORDER BY fired_at DESC,id DESC LIMIT ?")?.query_map(params![id, limit.min(100)], run)?.collect::<rusqlite::Result<_>>()?)
    }
    fn running(&self) -> Result<Vec<Run>> {
        Ok(self.connection.prepare("SELECT rr.* FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id WHERE r.kind='script' AND rr.status='running' ORDER BY rr.id")?.query_map([], run)?.collect::<rusqlite::Result<_>>()?)
    }
    fn admit(
        &mut self,
        routine: &Routine,
        status: &str,
        note: &str,
        reason: Option<&str>,
    ) -> Result<i64> {
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure!(
            tx.execute(UPDATE, params_from_iter(values(routine)?))? == 1,
            "Routine no longer exists"
        );
        tx.execute("INSERT INTO routine_runs (routine_id,fired_at,status,task_id,note,result_json) VALUES (?,?,?,NULL,?,?)",
            params![routine.id, routine.updated_at, status, note, reason.map(|r| json!({"reason":r}).to_string())])?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }
    fn finish(&mut self, id: i64, result: &Value) -> Result<()> {
        ensure!(self.connection.execute("UPDATE routine_runs SET status=?,note=?,result_json=? WHERE id=? AND routine_id IN (SELECT id FROM routines WHERE kind='script')",
            params![result["status"].as_str().context("Missing result status")?, result["note"].as_str(), result.to_string(), id])? == 1,
            "Run no longer exists");
        Ok(())
    }
}
use anyhow::Context;
