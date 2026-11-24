//! Catalog operations use the worker connection and the existing product schema.
use crate::modules::spaces::application::{CatalogMutation, SpaceRecord};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

/// Resolve one registration per requested path in a single committed snapshot.
pub fn discovered_repo_ids(db: &Connection, paths: &[String]) -> Result<Vec<(String, String)>> {
    let mut stmt = db.prepare_cached(
        "SELECT r.path, r.id FROM json_each(?1) AS wanted
         JOIN repos AS r ON r.rowid = (
           SELECT rowid FROM repos WHERE path = wanted.value
           ORDER BY created_at DESC, rowid DESC LIMIT 1
         )",
    )?;
    let rows = stmt.query_map([serde_json::to_string(paths)?], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn insert(db: &Connection, space: &SpaceRecord) -> Result<()> {
    db.execute(
        "INSERT INTO repos (id, name, path, vcs, default_base_ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![space.id, space.name, space.path, space.vcs, space.default_base_ref, space.created_at],
    )?;
    Ok(())
}

fn register(db: &mut Connection, space: &SpaceRecord) -> Result<Option<SpaceRecord>> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = tx.query_row(
        "SELECT id, name, path, vcs, default_base_ref, created_at FROM repos WHERE path = ?1 ORDER BY created_at, rowid LIMIT 1",
        [&space.path],
        |row| Ok(SpaceRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            vcs: if row.get::<_, String>(3)? == "none" { "none" } else { "git" }.into(),
            default_base_ref: row.get(4)?,
            created_at: row.get(5)?,
        }),
    ).optional()?;
    if existing.is_none() {
        insert(&tx, space)?;
    }
    tx.commit()?;
    Ok(existing)
}

pub fn apply(db: &mut Connection, mutation: CatalogMutation) -> Result<Option<SpaceRecord>> {
    match mutation {
        CatalogMutation::RegisterIfAbsent(space) => return register(db, &space),
        CatalogMutation::Register(space) => insert(db, &space)?,
        CatalogMutation::SetBaseRef { id, base_ref } => {
            db.execute(
                "UPDATE repos SET default_base_ref = ?1 WHERE id = ?2",
                [base_ref, id],
            )?;
        }
        CatalogMutation::Remove { id } => remove(db, &id)?,
    }
    Ok(None)
}

fn remove(db: &mut Connection, space: &str) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE repo_id=?1 AND status!='archived') OR EXISTS(SELECT 1 FROM routine_runs x JOIN routines r ON r.id=x.routine_id WHERE r.repo_id=?1 AND (x.status='running' OR x.dispatch_json IS NOT NULL))",[space],|r|r.get(0))?;
    ensure!(!active, "Space has active work");
    for sql in [
        "DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE repo_id=?)",
        "DELETE FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE repo_id=?)",
        "DELETE FROM tasks WHERE repo_id=?",
        "DELETE FROM routine_runs WHERE routine_id IN (SELECT id FROM routines WHERE repo_id=?)",
        "DELETE FROM routines WHERE repo_id=?",
        "DELETE FROM repos WHERE id=?",
    ] {
        tx.execute(sql, [space])?;
    }
    tx.commit()?;
    Ok(())
}
