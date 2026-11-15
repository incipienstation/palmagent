//! Activity expansion over a committed event snapshot. No execution or write ownership.

pub struct ActivityRecord {
    pub seq: i64,
    pub task_id: String,
    pub agent: String,
    pub kind: String,
    pub session_id: Option<String>,
    // Provider-owned JSON stays opaque until the inbound adapter constructs the wire event.
    pub payload_json: String,
    pub ts: i64,
}
pub struct ActivitySnapshot {
    pub cursor: i64,
    pub events: Vec<ActivityRecord>,
}
pub struct ActivityDetails {
    pub snapshot: ActivitySnapshot,
    pub from: i64,
    pub through: i64,
}
/// Read the cursor and inclusive range from one committed snapshot, in ascending sequence.
/// Filter to tool_call/tool_result; never truncate an activity to a history page.
pub trait ActivityRepository: Send {
    fn read(&mut self, task_id: &str, from: i64, through: i64) -> anyhow::Result<ActivitySnapshot>;
}
pub trait ActivityReader: Send {
    fn details(
        &mut self,
        task_id: &str,
        from: i64,
        through: i64,
    ) -> anyhow::Result<ActivityDetails>;
}
pub struct ActivityService {
    repository: Box<dyn ActivityRepository>,
}
impl ActivityService {
    pub fn new(repository: Box<dyn ActivityRepository>) -> Self {
        Self { repository }
    }
}
impl ActivityReader for ActivityService {
    fn details(
        &mut self,
        task_id: &str,
        from: i64,
        through: i64,
    ) -> anyhow::Result<ActivityDetails> {
        anyhow::ensure!(from >= 1 && through >= from, "Invalid activity range");
        let snapshot = self.repository.read(task_id, from, through)?;
        Ok(ActivityDetails {
            from,
            through: through.min(snapshot.cursor),
            snapshot,
        })
    }
}
