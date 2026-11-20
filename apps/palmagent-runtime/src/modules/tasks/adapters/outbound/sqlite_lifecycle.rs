use super::super::super::application::lifecycle::{Action, Change, LifecycleRepository};
use anyhow::{Result, ensure};
use rusqlite::{Connection, TransactionBehavior, params};

pub struct SqliteLifecycle<'a>(pub &'a mut Connection);

impl LifecycleRepository for SqliteLifecycle<'_> {
    fn write(&mut self, changes: &[Change]) -> Result<Option<i64>> {
        let db = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut pinned_at = None;
        for change in changes {
            let id = &change.task_id;
            let updated = match &change.action {
                Action::Pin { pinned, now } => {
                    pinned_at = db.query_row(
                        "UPDATE tasks SET pinned_at=CASE WHEN ?1 THEN
                      coalesce(pinned_at,(SELECT max(?2,coalesce(max(pinned_at)+1,?2)) FROM tasks))
                      ELSE NULL END,updated_at=?2 WHERE id=?3 RETURNING pinned_at",
                        params![pinned, now, id],
                        |row| row.get(0),
                    )?;
                    1
                }
                Action::MovePin { pinned_at, now } => db.execute(
                    "UPDATE tasks SET pinned_at=?1,updated_at=?2 WHERE id=?3",
                    params![pinned_at, now, id],
                )?,
                Action::Rename { title, now } => db.execute(
                    "UPDATE tasks SET title=?1,updated_at=?2 WHERE id=?3",
                    params![title, now, id],
                )?,
                Action::Status {
                    status,
                    interrupted,
                    now,
                } => db.execute(
                    "UPDATE tasks SET status=?1,interrupted=?2,updated_at=?3,
                    pinned_at=CASE WHEN ?1='archived' THEN NULL ELSE pinned_at END WHERE id=?4",
                    params![status, interrupted, now, id],
                )?,
                Action::Control { body } => db.execute(
                    "UPDATE tasks SET session_control=?1 WHERE id=?2",
                    params![body, id],
                )?,
                Action::Session { session_id, now } => {
                    db.execute(
                        "INSERT INTO task_context_usage(task_id,context_usage_json)
                        SELECT id,NULL FROM tasks WHERE id=?1 AND session_id IS NOT ?2
                        ON CONFLICT(task_id) DO UPDATE SET context_usage_json=NULL",
                        params![id, session_id],
                    )?;
                    db.execute(
                        "UPDATE tasks SET session_id=?1,updated_at=?2 WHERE id=?3",
                        params![session_id, now, id],
                    )?
                }
                Action::Settings {
                    model,
                    effort,
                    permission,
                    now,
                } => {
                    db.execute("UPDATE task_context_usage SET context_usage_json=json_set(context_usage_json,'$.stale',json('true'))
                       WHERE task_id=?1 AND context_usage_json IS NOT NULL AND EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND model IS NOT ?2)",params![id,model])?;
                    db.execute("UPDATE tasks SET model=?1,effort=?2,permission=?3,updated_at=?4 WHERE id=?5",params![model,effort,permission,now,id])?
                }
                Action::PullRequests { body, first, now } => db.execute(
                    "UPDATE tasks SET pr_urls=?1,pr_url=?2,updated_at=?3 WHERE id=?4",
                    params![body, first, now, id],
                )?,
                Action::PendingInput { body, now } => db.execute(
                    "UPDATE tasks SET pending_input=?1,updated_at=?2 WHERE id=?3",
                    params![body, now, id],
                )?,
                Action::PendingApproval { body, now } => db.execute(
                    "UPDATE tasks SET pending_approval=?1,updated_at=?2 WHERE id=?3",
                    params![body, now, id],
                )?,
                Action::Approval {
                    event_id,
                    body,
                    decision,
                    now,
                } => db.execute(
                    "INSERT INTO approvals(task_id,event_id,request_json,decision,decided_at)
                   VALUES (?1,?2,?3,?4,?5)",
                    params![id, event_id, body, decision, now],
                )?,
            };
            ensure!(updated == 1, "Task disappeared during lifecycle change");
        }
        db.commit()?;
        Ok(pinned_at)
    }
}

/// The API maps its shared TaskState to the same nullable SQLite columns as
/// the retained release. Creation can include staged files in this transaction.
pub fn create(db: &Connection, task: &str) -> Result<()> {
    ensure!(!db.is_autocommit(), "Task creation requires a transaction");
    db.execute("INSERT INTO tasks(id,repo_id,agent,title,pinned_at,prompt,status,interrupted,session_id,
        branch,worktree_path,permission,model,effort,pr_url,pr_urls,pending_input,pending_approval,session_control,skills_json,created_at,updated_at,last_activity_at)
        VALUES (json_extract(?1,'$.id'),json_extract(?1,'$.repo_id'),json_extract(?1,'$.agent'),json_extract(?1,'$.title'),
        json_extract(?1,'$.pinned_at'),json_extract(?1,'$.prompt'),json_extract(?1,'$.status'),json_extract(?1,'$.interrupted'),
        json_extract(?1,'$.session_id'),json_extract(?1,'$.branch'),json_extract(?1,'$.worktree_path'),json_extract(?1,'$.permission'),
        json_extract(?1,'$.model'),json_extract(?1,'$.effort'),json_extract(?1,'$.pr_url'),json_extract(?1,'$.pr_urls'),
        json_extract(?1,'$.pending_input'),json_extract(?1,'$.pending_approval'),json_extract(?1,'$.session_control'),json_extract(?1,'$.skills_json'),
        json_extract(?1,'$.created_at'),json_extract(?1,'$.updated_at'),json_extract(?1,'$.last_activity_at'))",[task])?;
    Ok(())
}
