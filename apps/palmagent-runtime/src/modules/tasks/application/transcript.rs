//! The repository returns a single committed projection; TypeScript owns projection refresh.
use super::super::domain::steps::{StepsPage, StepsSnapshot, page};
use super::super::domain::transcript::{
    TranscriptQuery, TranscriptRead, TranscriptSnapshot, project,
};
pub trait TranscriptRepository: Send {
    /// None means the parent display record is absent or tombstoned.
    fn steps(&mut self, task_id: &str, key: i64) -> anyhow::Result<Option<StepsSnapshot>>;
    /// Return at most PAGE_ITEMS + 1 candidates: descending key for pages, ascending
    /// (revision, key) for changes, with head and rows from the same snapshot.
    fn read(&mut self, task_id: &str, query: TranscriptQuery)
    -> anyhow::Result<TranscriptSnapshot>;
}
pub enum StepsError {
    NotFound,
    Unavailable,
}

pub trait TranscriptReader: Send {
    fn steps(&mut self, task_id: &str, key: i64, after: i64) -> Result<StepsPage, StepsError>;
    fn read(&mut self, task_id: &str, query: TranscriptQuery) -> anyhow::Result<TranscriptRead>;
}
pub struct TranscriptService {
    repository: Box<dyn TranscriptRepository>,
}
impl TranscriptService {
    pub fn new(repository: Box<dyn TranscriptRepository>) -> Self {
        Self { repository }
    }
}
impl TranscriptReader for TranscriptService {
    fn steps(&mut self, task_id: &str, key: i64, after: i64) -> Result<StepsPage, StepsError> {
        let snapshot = self
            .repository
            .steps(task_id, key)
            .map_err(|_| StepsError::Unavailable)?
            .ok_or(StepsError::NotFound)?;
        Ok(page(snapshot, after))
    }
    fn read(&mut self, task_id: &str, query: TranscriptQuery) -> anyhow::Result<TranscriptRead> {
        project(query, self.repository.read(task_id, query)?).map_err(anyhow::Error::msg)
    }
}
