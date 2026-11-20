//! Usage reads and cache policy, independent of SQLite and transport.
pub mod activity;
pub mod message_queue;
pub mod read_access;
pub mod recovery;
pub mod transcript;
pub mod turns;

use super::domain::{AgentUsage, Aggregate, UsageRecord};

/// Stream counts and normalized observations from one committed snapshot. Return None only
/// if its revision matches known_revision; do not expose a caller's uncommitted transaction.
pub trait UsageRepository: Send {
    fn read(
        &mut self,
        known_revision: Option<i64>,
        record: &mut dyn FnMut(UsageRecord),
    ) -> anyhow::Result<Option<i64>>;
}
pub trait UsageReader: Send {
    fn usage(&mut self) -> anyhow::Result<Vec<AgentUsage>>;
}
pub struct Service {
    repository: Box<dyn UsageRepository>,
    cache: Option<(i64, Vec<AgentUsage>)>,
}
impl Service {
    pub fn new(repository: Box<dyn UsageRepository>) -> Self {
        Self {
            repository,
            cache: None,
        }
    }
}
impl UsageReader for Service {
    fn usage(&mut self) -> anyhow::Result<Vec<AgentUsage>> {
        let mut aggregate = Aggregate::default();
        let revision = self.repository.read(
            self.cache.as_ref().map(|(revision, _)| *revision),
            &mut |record| aggregate.record(record),
        )?;
        if let Some(revision) = revision {
            self.cache = Some((revision, aggregate.finish()));
        }
        // Never retain partial reads or change the cache on a repository error.
        self.cache
            .as_ref()
            .map(|(_, usage)| usage.clone())
            .ok_or_else(|| anyhow::anyhow!("Usage snapshot is missing"))
    }
}
