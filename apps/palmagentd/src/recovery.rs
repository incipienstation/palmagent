//! Web restart policy survives control-daemon replacement. Application work is never replayed.
use crate::{contract::WEB_STARTUP_TIMEOUT, storage};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

const STABLE_MS: u64 = 30_000;
const STARTUP_MS: u64 = WEB_STARTUP_TIMEOUT.as_millis() as u64;
#[derive(Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Recovery {
    observed: Option<String>,
    failed: Option<String>,
    failures: u32,
    next_attempt_at: u64,
    stable_since: Option<u64>,
    last_failure_at: Option<u64>,
    reason: Option<String>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Start,
    StopUnready,
}
impl Recovery {
    pub fn load(data: &Path) -> Result<Self> {
        Self::load_service(data, "web")
    }
    pub fn load_service(data: &Path, service: &str) -> Result<Self> {
        let path = storage::state_directory(data).join(format!("{service}-recovery.json"));
        if path.exists() {
            storage::read(&path)
        } else {
            Ok(Self::default())
        }
    }
    pub fn status(&self) -> Value {
        json!({ "consecutiveFailures": self.failures, "nextAttemptAt": self.next_attempt_at,
            "stableSince": self.stable_since, "lastFailureAt": self.last_failure_at, "reason": self.reason })
    }
    pub fn tick(&mut self, data: &Path, id: Option<&str>, state: &Value) -> Result<Action> {
        self.tick_service(data, "web", id, state)
    }
    pub fn tick_service(
        &mut self,
        data: &Path,
        service: &str,
        id: Option<&str>,
        state: &Value,
    ) -> Result<Action> {
        let before = serde_json::to_value(&*self)?;
        let action = self.advance(storage::now(), id, state);
        if serde_json::to_value(&*self)? != before {
            storage::atomic(
                &storage::state_directory(data).join(format!("{service}-recovery.json")),
                self,
            )?;
        }
        Ok(action)
    }
    fn advance(&mut self, now: u64, id: Option<&str>, state: &Value) -> Action {
        if self.observed.as_deref() != id {
            self.observed = id.map(str::to_owned);
            self.stable_since = None;
        }
        if state["alive"] == true {
            let lifecycle = &state["lifecycle"];
            if lifecycle["supervision"] == "guarded"
                && (lifecycle["phase"] == "ready" || lifecycle["phase"] == "running")
            {
                let since = *self.stable_since.get_or_insert(now);
                if now.saturating_sub(since) >= STABLE_MS {
                    self.failures = 0;
                    self.next_attempt_at = 0;
                }
            } else {
                self.stable_since = None;
            }
            if lifecycle["phase"] == "starting"
                && lifecycle["readiness"] == "pending"
                && lifecycle["createdAt"]
                    .as_u64()
                    .is_some_and(|created| created > 0 && now.saturating_sub(created) >= STARTUP_MS)
            {
                return Action::StopUnready;
            }
            return Action::None;
        }
        self.stable_since = None;
        if id.is_some() && self.failed.as_deref() != id {
            self.failed = id.map(str::to_owned);
            self.failures = self.failures.saturating_add(1);
            let delay = (1_000u64 << self.failures.min(6)).min(60_000);
            self.next_attempt_at = now.saturating_add(delay);
            self.last_failure_at = Some(now);
            self.reason = Some(
                state["lifecycle"]["reason"]
                    .as_str()
                    .unwrap_or("host_exited")
                    .to_owned(),
            );
        }
        if now >= self.next_attempt_at {
            // Persist before attempting launch, including faults before a reservation can be written.
            self.next_attempt_at = now.saturating_add(2_000);
            return Action::Start;
        }
        Action::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backoff_caps_and_survives_replacement_then_resets_after_stability() {
        let mut state = Recovery::default();
        let mut now = 100_000;
        for attempt in 1..=8 {
            let id = format!("{attempt:x}");
            assert_eq!(
                state.advance(now, Some(&id), &json!({"alive":false})),
                Action::None
            );
            let delay = (1_000u64 << attempt.min(6)).min(60_000);
            assert_eq!(state.next_attempt_at, now + delay);
            // Replacement preserves the same deadline and does not count a failure twice.
            state = serde_json::from_value(serde_json::to_value(state).unwrap()).unwrap();
            assert_eq!(
                state.advance(now + delay - 1, Some(&id), &json!({"alive":false})),
                Action::None
            );
            now += delay;
            assert_eq!(
                state.advance(now, Some(&id), &json!({"alive":false})),
                Action::Start
            );
        }
        let ready = json!({"alive":true,"lifecycle":{"phase":"ready","supervision":"guarded"}});
        state.advance(now, Some("99"), &ready);
        state.advance(now + STABLE_MS - 1, Some("99"), &ready);
        assert_eq!(state.failures, 8);
        state.advance(now + STABLE_MS, Some("99"), &ready);
        assert_eq!(state.failures, 0);
        assert_eq!(state.next_attempt_at, 0);
    }
    #[test]
    fn only_confirmed_web_startup_can_time_out() {
        let mut recovery = Recovery::default();
        let pending = json!({"alive":true,"lifecycle":{"phase":"starting","readiness":"pending","createdAt":1000}});
        // Slow cold starts remain eligible after both former 15s/30s deadlines.
        assert_eq!(recovery.advance(22_000, Some("aa"), &pending), Action::None);
        assert_eq!(recovery.advance(42_000, Some("aa"), &pending), Action::None);
        assert_eq!(recovery.advance(60_999, Some("aa"), &pending), Action::None);
        assert_eq!(
            recovery.advance(61_000, Some("aa"), &pending),
            Action::StopUnready
        );
        assert_eq!(
            recovery.advance(
                61_000,
                Some("bb"),
                &json!({"alive":true,"lifecycle":{"phase":"unknown"}})
            ),
            Action::None
        );
        assert_eq!(
            recovery.advance(
                61_000,
                Some("cc"),
                &json!({"alive":true,"lifecycle":{"phase":"running","readiness":"unsupported"}})
            ),
            Action::None
        );
    }
}
