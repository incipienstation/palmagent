//! Atomic removal of the archived Task and routine data owned by a Space.
use anyhow::{Result, ensure};
use rusqlite::{Connection, TransactionBehavior};

pub fn remove(db: &mut Connection, space: &str) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE repo_id=?1 AND status!='archived') OR EXISTS(SELECT 1 FROM routine_runs x JOIN routines r ON r.id=x.routine_id WHERE r.repo_id=?1 AND x.status='running')",[space],|r|r.get(0))?;
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
