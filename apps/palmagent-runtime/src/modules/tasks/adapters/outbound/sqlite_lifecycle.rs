use super::super::super::application::lifecycle::{Action, Change, LifecycleRepository};
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};

pub struct SqliteLifecycle<'a>(pub &'a mut Connection);

impl LifecycleRepository for SqliteLifecycle<'_> {
    fn write(&mut self, changes: &[Change]) -> Result<Option<i64>> {
        let db = super::sqlite_write::Write::begin(self.0)?;
        let pinned_at = persist(&db, changes)?;
        db.commit()?;
        Ok(pinned_at)
    }
}

pub(super) fn persist(db: &Connection, changes: &[Change]) -> Result<Option<i64>> {
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
            Action::ProviderTitle {
                title,
                first_prompt,
            } => db.execute(
                "UPDATE tasks SET provider_title=?1,prompt=coalesce(?2,prompt) WHERE id=?3",
                params![title, first_prompt, id],
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
                db.execute(
                    "UPDATE tasks SET model=?1,effort=?2,permission=?3,updated_at=?4 WHERE id=?5",
                    params![model, effort, permission, now, id],
                )?
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
    Ok(pinned_at)
}

/// The API maps its shared TaskState to the same nullable SQLite columns as
/// the retained release. Creation can include staged files in this transaction.
#[derive(serde::Deserialize)]
struct NewTask {
    id: String,
    repo_id: String,
    agent: String,
    title: Option<String>,
    provider_title: Option<String>,
    pinned_at: Option<i64>,
    prompt: String,
    status: String,
    interrupted: i64,
    session_id: Option<String>,
    branch: Option<String>,
    worktree_path: Option<String>,
    permission: String,
    model: Option<String>,
    effort: Option<String>,
    pr_url: Option<String>,
    pr_urls: Option<String>,
    pending_input: Option<String>,
    pending_approval: Option<String>,
    session_control: Option<String>,
    skills_json: Option<String>,
    created_at: i64,
    updated_at: i64,
    last_activity_at: i64,
}
pub fn create(db: &mut Connection, task: &str) -> Result<()> {
    let row: NewTask = serde_json::from_str(task)?;
    let tx = super::sqlite_write::Write::begin(db)?;
    tx.execute(
        "INSERT INTO tasks(id,repo_id,agent,title,provider_title,pinned_at,prompt,status,
        interrupted,session_id,branch,worktree_path,permission,model,effort,
        pr_url,pr_urls,pending_input,pending_approval,session_control,skills_json,created_at,
        updated_at,last_activity_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            row.id,
            row.repo_id,
            row.agent,
            row.title,
            row.provider_title,
            row.pinned_at,
            row.prompt,
            row.status,
            row.interrupted,
            row.session_id,
            row.branch,
            row.worktree_path,
            row.permission,
            row.model,
            row.effort,
            row.pr_url,
            row.pr_urls,
            row.pending_input,
            row.pending_approval,
            row.session_control,
            row.skills_json,
            row.created_at,
            row.updated_at,
            row.last_activity_at
        ],
    )?;
    if row.status == "queued" {
        tx.execute(r#"INSERT INTO task_message_state(task_id,state) VALUES (?,'{"revision":0,"paused":false,"runId":null,"messages":[],"creationReserved":true}')"#, [&row.id])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn shared_state(db: &Connection, id: &str) -> Result<(String, bool, bool)> {
    Ok(db.query_row("SELECT t.status,t.interrupted,json_extract(q.state,'$.runId') IS NOT NULL
        FROM tasks t LEFT JOIN task_message_state q ON q.task_id=t.id WHERE t.id=? AND json_extract(t.session_control,'$.owner')='shared'",[id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?)
}
