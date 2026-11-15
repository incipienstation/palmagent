//! Bounded transcript paging over an ordered, committed projection.
pub const PAGE_ITEMS: usize = 30;
pub const PAGE_BYTES: usize = 256 * 1024;
pub const MAX_CURSOR: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy)]
pub enum TranscriptQuery {
    Page {
        before: Option<i64>,
    },
    Changes {
        after: i64,
        through: Option<i64>,
        after_key: Option<i64>,
    },
}
impl TranscriptQuery {
    pub fn end(self, cursor: i64) -> i64 {
        match self {
            Self::Page { .. } => cursor,
            Self::Changes { after, through, .. } => {
                after.max(through.unwrap_or(cursor).min(cursor))
            }
        }
    }
}
pub struct ProjectionRow {
    pub key: i64,
    pub revision: i64,
    /// Canonical display JSON from the projection writer; adapters own its wire encoding.
    pub wire_json: Option<String>,
    pub bytes: usize,
}
pub struct TranscriptSnapshot {
    pub cursor: i64,
    pub activity: String,
    pub rows: Vec<ProjectionRow>,
}
pub struct TranscriptPage {
    pub rows: Vec<ProjectionRow>,
    pub before: Option<i64>,
    pub cursor: i64,
    pub activity: String,
}
pub struct TranscriptChanges {
    pub rows: Vec<ProjectionRow>,
    pub after: i64,
    pub through: i64,
    pub next_after: Option<i64>,
    pub next_key: Option<i64>,
    pub activity: Option<String>,
}
pub enum TranscriptRead {
    Page(TranscriptPage),
    Changes(TranscriptChanges),
}

pub fn project(
    query: TranscriptQuery,
    snapshot: TranscriptSnapshot,
) -> Result<TranscriptRead, &'static str> {
    let end = query.end(snapshot.cursor);
    let available = snapshot.rows.len();
    let mut rows = Vec::new();
    let mut bytes = 1024;
    for row in snapshot.rows {
        if rows.len() >= PAGE_ITEMS || bytes + row.bytes > PAGE_BYTES {
            break;
        }
        bytes += row.bytes;
        rows.push(row);
    }
    let more = available > rows.len();
    if more && rows.is_empty() {
        return Err("Projection item exceeds the page budget");
    }
    match query {
        TranscriptQuery::Page { .. } => {
            let before = if more {
                rows.last().map(|row| row.key)
            } else {
                None
            };
            rows.reverse();
            Ok(TranscriptRead::Page(TranscriptPage {
                rows,
                before,
                cursor: snapshot.cursor,
                activity: snapshot.activity,
            }))
        }
        TranscriptQuery::Changes { after, .. } => {
            let next_after = if more {
                rows.last().map(|row| row.revision)
            } else {
                None
            };
            let next_key = if more {
                rows.last().map(|row| row.key)
            } else {
                None
            };
            Ok(TranscriptRead::Changes(TranscriptChanges {
                rows,
                after,
                through: end,
                next_after,
                next_key,
                activity: if end == snapshot.cursor {
                    Some(snapshot.activity)
                } else {
                    None
                },
            }))
        }
    }
}
