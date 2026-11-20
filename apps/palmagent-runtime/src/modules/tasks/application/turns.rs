//! Track one logical turn per task for the lifetime of a Tasks owner.
use super::super::domain::turn::{TurnEvent, TurnEvidence};
use std::collections::BTreeMap;

/// Each retained attachment or new admission gets a new ticket. The persisted
/// run ID alone is insufficient because older executions can have no run ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    task_id: String,
    generation: u64,
}

struct Turn {
    generation: u64,
    run_id: Option<String>,
    replay_baseline: i64,
    session_mismatch: bool,
    evidence: TurnEvidence,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Disposition {
    Ignore,
    Replay,
    Publish,
    StopForSessionMismatch,
}

#[derive(Default)]
pub struct Turns {
    generation: u64,
    tasks: BTreeMap<String, Turn>,
}

impl Turns {
    pub fn track(
        &mut self,
        task_id: String,
        run_id: Option<String>,
        replay_baseline: i64,
    ) -> anyhow::Result<Ticket> {
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Turn generation overflow"))?;
        self.tasks.insert(
            task_id.clone(),
            Turn {
                generation: self.generation,
                run_id,
                replay_baseline,
                session_mismatch: false,
                evidence: TurnEvidence::default(),
            },
        );
        Ok(Ticket {
            task_id,
            generation: self.generation,
        })
    }

    pub fn may_start(&self, ticket: &Ticket, run_id: Option<&str>) -> bool {
        self.current(ticket)
            .is_some_and(|turn| turn.run_id.as_deref() == run_id)
    }

    fn current(&self, ticket: &Ticket) -> Option<&Turn> {
        self.tasks
            .get(&ticket.task_id)
            .filter(|turn| turn.generation == ticket.generation)
    }

    pub fn observe(
        &mut self,
        ticket: &Ticket,
        expected_session: Option<&str>,
        observed_session: Option<&str>,
        raw_seq: Option<i64>,
        event: TurnEvent<'_>,
    ) -> Disposition {
        let Some(turn) = self
            .tasks
            .get_mut(&ticket.task_id)
            .filter(|turn| turn.generation == ticket.generation && !turn.session_mismatch)
        else {
            return Disposition::Ignore;
        };
        if let (Some(expected), Some(observed)) = (expected_session, observed_session)
            && expected != observed
        {
            turn.session_mismatch = true;
            turn.evidence.session_mismatch();
            return Disposition::StopForSessionMismatch;
        }
        turn.evidence.observe(event);
        if raw_seq.is_some_and(|seq| seq <= turn.replay_baseline) {
            Disposition::Replay
        } else {
            Disposition::Publish
        }
    }

    /// Stale completion and cancellation callbacks cannot remove a newer turn.
    pub fn finish(&mut self, ticket: &Ticket) -> Option<TurnEvidence> {
        self.current(ticket)?;
        self.tasks.remove(&ticket.task_id).map(|turn| turn.evidence)
    }
}
