//! Provider-neutral usage accounting. Observations and counts come through a repository port.
pub mod transcript;

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Metric {
    TotalCostUsd,
    DurationMs,
    InputTokens,
    CachedInputTokens,
    OutputTokens,
    ReasoningOutputTokens,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent: String,
    pub task_count: u64,
    pub turn_count: u64,
    pub total_cost_usd: f64,
    pub duration_ms: f64,
    pub input_tokens: f64,
    pub cached_input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_output_tokens: f64,
    pub reported: Vec<Metric>,
}

pub enum UsageRecord {
    Tasks {
        agent: String,
        count: u64,
    },
    Result {
        agent: String,
        metrics: Vec<(Metric, f64)>,
    },
}
#[derive(Default)]
pub struct Aggregate(BTreeMap<String, AgentUsage>);
impl Aggregate {
    pub fn record(&mut self, record: UsageRecord) {
        let agent = match &record {
            UsageRecord::Tasks { agent, .. } | UsageRecord::Result { agent, .. } => agent,
        };
        let usage = self.0.entry(agent.clone()).or_insert_with(|| AgentUsage {
            agent: agent.clone(),
            ..Default::default()
        });
        match record {
            UsageRecord::Tasks { count, .. } => usage.task_count = count,
            UsageRecord::Result { metrics, .. } => {
                // A result is still a turn when its payload is malformed or reports no metrics.
                usage.turn_count += 1;
                for (metric, value) in metrics {
                    if !value.is_finite() || value < 0.0 {
                        continue;
                    }
                    let total = match metric {
                        Metric::TotalCostUsd => &mut usage.total_cost_usd,
                        Metric::DurationMs => &mut usage.duration_ms,
                        Metric::InputTokens => &mut usage.input_tokens,
                        Metric::CachedInputTokens => &mut usage.cached_input_tokens,
                        Metric::OutputTokens => &mut usage.output_tokens,
                        Metric::ReasoningOutputTokens => &mut usage.reasoning_output_tokens,
                    };
                    *total += value;
                    if !usage.reported.contains(&metric) {
                        usage.reported.push(metric);
                    }
                }
            }
        }
    }
    pub fn finish(self) -> Vec<AgentUsage> {
        self.0.into_values().collect()
    }
}
