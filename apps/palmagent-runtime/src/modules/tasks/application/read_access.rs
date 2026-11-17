//! Existence checks for the public read boundary; execution stays with the Task owner.
pub trait TaskReadAccess: Send {
    fn exists(&mut self, task_id: &str) -> anyhow::Result<bool>;
}
