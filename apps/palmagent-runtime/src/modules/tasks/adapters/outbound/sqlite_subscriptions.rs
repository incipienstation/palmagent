//! Persist push subscription receipts. Network delivery stays in the push adapter.
use anyhow::Result;
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Subscription {
    Save {
        endpoint: String,
        body: String,
        now: i64,
    },
    Delete {
        endpoint: String,
    },
    List,
}
pub fn apply(db: &Connection, operation: Subscription) -> Result<Value> {
    match operation {
        Subscription::Save {
            endpoint,
            body,
            now,
        } => {
            db.execute("INSERT INTO push_subs(endpoint,subscription_json,created_at) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json",params![endpoint,body,now])?;
        }
        Subscription::Delete { endpoint } => {
            db.execute("DELETE FROM push_subs WHERE endpoint=?", [endpoint])?;
        }
        Subscription::List => {
            let mut stmt = db.prepare_cached("SELECT subscription_json FROM push_subs")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(json!(rows));
        }
    }
    Ok(Value::Null)
}
