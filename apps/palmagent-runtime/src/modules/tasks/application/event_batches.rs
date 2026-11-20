//! Committed provider batches. The shared display renderer receives assigned
//! sequences and compact payloads while the repository holds the transaction.
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct Event {
    pub kind: String,
    pub payload: String,
    pub ts: i64,
}

#[derive(Deserialize, PartialEq, Eq)]
pub struct ImportMarker {
    pub length: Option<i64>,
    pub hash: Option<String>,
}
#[derive(Deserialize)]
pub struct ImportChange {
    pub source: String,
    pub previous: Option<ImportMarker>,
    pub next: ImportMarker,
}
#[derive(Deserialize)]
pub struct SessionImport {
    pub control: Option<String>,
    pub changes: Vec<ImportChange>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub task_id: String,
    pub events: Vec<Event>,
    pub raw_seq: Option<i64>,
    pub now: i64,
    pub session: Option<SessionImport>,
}

#[derive(Serialize)]
pub struct Assigned {
    pub id: i64,
    pub seq: i64,
    pub compact: Option<String>,
}

#[derive(Deserialize)]
pub struct DisplayChange {
    pub key: i64,
    pub start: i64,
    pub end: i64,
    pub revision: i64,
    pub body: Option<String>,
    pub wire: Option<String>,
}
#[derive(Deserialize)]
pub struct ContextChange {
    pub body: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrChange {
    pub evidence: String,
    pub body: String,
    pub first: Option<String>,
    pub updated_at: Option<i64>,
}
#[derive(Deserialize)]
pub struct Projection {
    pub cursor: i64,
    pub start: i64,
    pub log: String,
    pub activity: String,
    pub changes: Vec<DisplayChange>,
    pub context: Option<ContextChange>,
    pub prs: Option<PrChange>,
}

pub trait DisplayRenderer {
    fn project(&mut self, rows: &[Assigned]) -> anyhow::Result<Projection>;
}
pub trait EventRepository {
    fn append(
        &mut self,
        batch: &Batch,
        renderer: &mut impl DisplayRenderer,
    ) -> anyhow::Result<Vec<Assigned>>;
}
