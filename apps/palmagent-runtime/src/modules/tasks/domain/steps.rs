//! Operation-list pagination over normalized projection summaries.
pub const STEP_ITEMS: usize = 50;
pub struct Step {
    pub key: i64,
    /// Adapter-owned JSON summary, with internal member references already removed.
    pub summary: String,
}
pub struct StepsSnapshot {
    pub revision: i64,
    pub steps: Vec<Step>,
}
pub struct StepsPage {
    pub cursor: i64,
    pub steps: Vec<Step>,
    pub next_after: Option<i64>,
}
pub fn page(mut snapshot: StepsSnapshot, after: i64) -> StepsPage {
    snapshot.steps.retain(|step| step.key > after);
    snapshot.steps.sort_by_key(|step| step.key);
    let more = snapshot.steps.len() > STEP_ITEMS;
    snapshot.steps.truncate(STEP_ITEMS);
    let next_after = if more {
        snapshot.steps.last().map(|step| step.key)
    } else {
        None
    };
    StepsPage {
        cursor: snapshot.revision,
        steps: snapshot.steps,
        next_after,
    }
}
