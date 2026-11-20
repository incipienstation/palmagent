use super::super::super::application::{
    lifecycle::{Action as ChangeAction, Change},
    message_queue::{Command, transition},
    task_actions::{Effect, Request, State},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

pub fn creation(
    db: &Connection,
    id: &str,
    repo: &str,
    agent: &str,
    prompt: &str,
) -> Result<Option<bool>> {
    Ok(db
        .query_row(
            "SELECT repo_id=?2 AND agent=?3 AND prompt=?4 FROM tasks WHERE id=?1",
            params![id, repo, agent, prompt],
            |row| row.get(0),
        )
        .optional()?)
}
pub fn apply(db: &mut Connection, id: &str, request: &Request) -> Result<Result<Effect, String>> {
    let tx = super::sqlite_write::Write::begin(db)?;
    let before=tx.query_row("SELECT status,interrupted,json_extract(session_control,'$.owner'),coalesce(length(session_id)>0,0),
        coalesce(json_extract(q.state,'$.compaction.status')='running',0) FROM tasks t LEFT JOIN task_message_state q ON q.task_id=t.id WHERE t.id=?",[id],
        |r| Ok(State {status:r.get(0)?,interrupted:r.get(1)?,owner:r.get(2)?,session:r.get(3)?,compacting:r.get(4)?}))?;
    let effect = match before.decide(request) {
        Ok(effect) => effect,
        Err(reason) => return Ok(Err(reason)),
    };
    let queue = |cmd| {
        super::sqlite_message_queue::update(&tx, id, |q| transition(q, cmd))
            .map_err(|e| anyhow::anyhow!("Task action queue transition failed: {e:?}"))
    };
    if matches!(
        effect,
        Effect::Pause | Effect::Interrupt | Effect::Dequeue | Effect::Cancel | Effect::Archive
    ) {
        queue(Command::Pause)?;
    }
    if effect == Effect::Dequeue
        || (effect == Effect::Cancel && !request.handle && before.compacting)
    {
        queue(Command::StopWaiting)?;
    }
    let status = match effect {
        Effect::Dequeue => Some("idle"),
        Effect::Cancel => Some("cancelled"),
        Effect::Archive => Some("archived"),
        _ => None,
    };
    if let Some(status) = status {
        super::sqlite_lifecycle::persist(
            &tx,
            &[Change {
                task_id: id.into(),
                action: ChangeAction::Status {
                    status: status.into(),
                    interrupted: effect == Effect::Dequeue || before.interrupted,
                    now: request.now,
                },
            }],
        )?;
    }
    tx.commit()?;
    Ok(Ok(effect))
}
