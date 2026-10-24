//! Script routine policy. Timestamps and calendar conversion are supplied by the caller.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const SCRIPT_CAPACITY: usize = 4;
pub const DEFAULT_TIMEOUT: u64 = 300;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Script {
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}
fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT
}
impl Script {
    pub fn validate(&mut self) -> Result<(), String> {
        self.command = self.command.trim().to_owned();
        if self.command.is_empty() || self.command.encode_utf16().count() > 16_000 {
            return Err("Script command must contain 1-16000 characters".into());
        }
        if !(1..=3600).contains(&self.timeout_seconds) {
            return Err("Timeout must be 1-3600 seconds".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub repo_id: String,
    pub kind: String,
    pub script: Script,
    pub agent: String,
    pub prompt: String,
    pub permission: String,
    pub preset: String,
    pub schedule: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: i64,
    pub routine_id: String,
    pub fired_at: i64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(flatten)]
    pub result: serde_json::Map<String, serde_json::Value>,
}

pub struct Cron {
    fields: Vec<BTreeSet<u32>>,
    either_day: bool,
}
impl Cron {
    pub fn parse(expression: &str) -> Result<Self, String> {
        let parts: Vec<_> = expression.split_whitespace().collect();
        if parts.len() != 5 {
            return Err("Cron must have five fields".into());
        }
        let mut fields = Vec::new();
        for (part, (min, max)) in parts
            .iter()
            .zip([(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)])
        {
            let mut values = BTreeSet::new();
            for piece in part.split(',') {
                let pieces: Vec<_> = piece.split('/').collect();
                if pieces.len() > 2 {
                    return Err("Invalid cron field".into());
                }
                let number = |value: &str| -> Result<u32, String> {
                    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                        return Err("Invalid cron number".into());
                    }
                    value.parse().map_err(|_| "Invalid cron number".into())
                };
                let step = pieces.get(1).map(|v| number(v)).transpose()?.unwrap_or(1);
                if step == 0 {
                    return Err("Cron step must be positive".into());
                }
                let (lo, hi) = if pieces[0] == "*" {
                    (min, max)
                } else {
                    let range: Vec<_> = pieces[0].split('-').collect();
                    if range.len() > 2 {
                        return Err("Invalid cron range".into());
                    }
                    let lo = number(range[0])?;
                    let hi = range
                        .get(1)
                        .map(|v| number(v))
                        .transpose()?
                        .unwrap_or(if pieces.len() == 2 { max } else { lo });
                    (lo, hi)
                };
                if lo < min || hi > max || lo > hi {
                    return Err("Cron field is out of range".into());
                }
                values.extend((lo..=hi).step_by(step as usize));
            }
            fields.push(values);
        }
        if fields[4].remove(&7) {
            fields[4].insert(0);
        }
        Ok(Self {
            fields,
            either_day: parts[2] != "*" && parts[4] != "*",
        })
    }
    pub fn day_matches(&self, month: u32, day: u32, weekday: u32) -> bool {
        let dom = self.fields[2].contains(&day);
        let dow = self.fields[4].contains(&weekday);
        self.fields[3].contains(&month)
            && if self.either_day {
                dom || dow
            } else {
                dom && dow
            }
    }
    pub fn hour_matches(&self, hour: u32) -> bool {
        self.fields[1].contains(&hour)
    }
    pub fn minute_matches(&self, minute: u32) -> bool {
        self.fields[0].contains(&minute)
    }
}

pub fn cadence(
    preset: &str,
    schedule: Option<&str>,
    hour: Option<u32>,
    weekday: Option<u32>,
) -> Result<String, String> {
    if hour.is_some_and(|h| h > 23) || weekday.is_some_and(|d| d > 6) {
        return Err("Invalid cadence time".into());
    }
    let hour = hour.unwrap_or(9);
    let result = match preset {
        "manual" => String::new(),
        "custom" => schedule.ok_or("Schedule is required")?.to_owned(),
        "hourly" => "0 * * * *".into(),
        "daily" => format!("0 {hour} * * *"),
        "weekly" => format!("0 {hour} * * {}", weekday.unwrap_or(1)),
        "weekdays" => format!("0 {hour} * * 1-5"),
        _ => return Err("Unknown cadence preset".into()),
    };
    if preset != "manual" {
        Cron::parse(&result)?;
    }
    Ok(result)
}
