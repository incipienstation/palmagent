//! The repository returns a single committed projection; TypeScript owns projection refresh.
use super::super::domain::transcript::{
    TranscriptQuery, TranscriptRead, TranscriptSnapshot, project,
};
/// Return at most PAGE_ITEMS + 1 candidates: descending key for pages, ascending
/// (revision, key) for changes, with head and rows from the same snapshot.
pub trait TranscriptRepository: Send {
    fn read(&mut self, task_id: &str, query: TranscriptQuery)
    -> anyhow::Result<TranscriptSnapshot>;
}
pub trait TranscriptReader: Send {
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
    fn read(&mut self, task_id: &str, query: TranscriptQuery) -> anyhow::Result<TranscriptRead> {
        project(query, self.repository.read(task_id, query)?).map_err(anyhow::Error::msg)
    }
}
