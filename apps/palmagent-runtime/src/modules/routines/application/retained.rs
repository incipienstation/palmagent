//! One-shot invocation ownership and completion policy, independent of process and file APIs.
use anyhow::Result;
use serde_json::{Value, json};

pub struct Outcome {
    pub code: Option<i32>,
    pub reason: Option<String>,
    pub output: String,
}
pub trait Host {
    fn claim(&mut self) -> Result<bool>;
    fn stop_reason(&self) -> Result<Option<String>>;
    fn execute(&mut self) -> Result<Outcome>;
    fn now(&self) -> i64;
    fn persist(&mut self, result: &Value) -> Result<()>;
    fn wait_for_storage(&self);
}
pub fn run(host: &mut impl Host) -> Result<()> {
    if !host.claim()? {
        return Ok(());
    }
    let mut result = if let Some(reason) = host.stop_reason()? {
        json!({"status":"interrupted","note":reason})
    } else {
        match host.execute() {
            Ok(outcome) => {
                let status = if outcome
                    .reason
                    .as_deref()
                    .is_some_and(|r| r.starts_with("interrupted"))
                {
                    "interrupted"
                } else if outcome.code == Some(0) && outcome.reason.is_none() {
                    "succeeded"
                } else {
                    "failed"
                };
                let mut value = json!({"status":status,"output":outcome.output});
                if let Some(code) = outcome.code {
                    value["exitCode"] = json!(code);
                }
                if let Some(reason) = outcome.reason {
                    value["note"] = json!(reason);
                }
                value
            }
            Err(error) => json!({"status":"failed","note":error.to_string()}),
        }
    };
    result["finishedAt"] = json!(host.now());
    // Keep the original completion and its timestamp; never execute again on a storage failure.
    while host.persist(&result).is_err() {
        host.wait_for_storage();
    }
    Ok(())
}
