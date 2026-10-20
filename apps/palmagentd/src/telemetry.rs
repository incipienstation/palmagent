//! Native measurements, aggregated in memory. The web process transports allowlisted deltas.
//! No network calls, identifiers, paths, command lines, or raw errors enter metric samples.
use crate::contract::{Configuration, Request};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CONTRACT: &str = include_str!("../../../packages/shared/src/telemetry-contract.json");
fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn bucket(n: usize) -> &'static str {
    match n {
        0 => "0",
        1 => "1",
        2..=4 => "2-4",
        5..=8 => "5-8",
        9..=16 => "9-16",
        _ => "17+",
    }
}
#[derive(Clone, Serialize)]
pub struct Point {
    name: &'static str,
    attributes: BTreeMap<&'static str, &'static str>,
    count: u64,
    sum: f64,
    buckets: Vec<u64>,
}
pub struct Measurement {
    start: Instant,
    operation: &'static str,
    concurrency: usize,
    epoch: u64,
}
pub struct Telemetry {
    preference: PathBuf,
    revision: Option<String>,
    checked: Instant,
    sampled: Instant,
    cpu: f64,
    epoch: u64,
    started: u64,
    bounds: Value,
    points: BTreeMap<String, Point>,
}
impl Telemetry {
    pub fn new(config: &Configuration) -> Self {
        let preference = config
            .environment
            .get("PALMAGENT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/nonexistent"))
            .join("telemetry.json");
        Self { preference, revision: None, checked: Instant::now() - Duration::from_secs(2),
            sampled: Instant::now(), cpu: cpu_seconds(), epoch: 0, started: millis(),
            bounds: serde_json::from_str::<Value>(CONTRACT).expect("checked telemetry contract")["bounds"].clone(),
            points: BTreeMap::new() }
    }
    fn choice(&self) -> Option<String> {
        let metadata = fs::symlink_metadata(&self.preference).ok()?;
        if !metadata.is_file() || metadata.len() > 4096 {
            return None;
        }
        let value: Value = serde_json::from_slice(&fs::read(&self.preference).ok()?).ok()?;
        if value["schemaVersion"] != 1 || value["enabled"] != true || value["disclosed"] != true {
            return None;
        }
        if value.as_object()?.len() != 4 {
            return None;
        }
        let revision = value["revision"].as_str()?;
        if revision.len() != 36
            || !revision.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        {
            return None;
        }
        Some(revision.into())
    }
    pub fn tick(&mut self, concurrency: usize) {
        if self.checked.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.checked = Instant::now();
        let revision = self.choice();
        if revision != self.revision || millis().saturating_sub(self.started) > 600_000 {
            self.revision = revision;
            self.points.clear();
            self.epoch += 1;
            self.started = millis();
            self.cpu = cpu_seconds();
            self.sampled = Instant::now();
        }
        if self.revision.is_none() || self.sampled.elapsed() < Duration::from_secs(15) {
            return;
        }
        let cpu = cpu_seconds();
        self.observe(
            "palmagent.process.cpu.utilization",
            (cpu - self.cpu) / self.sampled.elapsed().as_secs_f64(),
            BTreeMap::from([("concurrency", bucket(concurrency))]),
            "cpu",
        );
        if let Some(rss) = current_rss() {
            self.observe(
                "palmagent.process.memory.usage",
                rss,
                BTreeMap::from([("concurrency", bucket(concurrency))]),
                "memory",
            );
        }
        self.cpu = cpu;
        self.sampled = Instant::now();
    }
    pub fn begin(&self, request: &Request, concurrency: usize) -> Option<Measurement> {
        self.revision.as_ref()?;
        let operation = match request {
            Request::Status => return None, // Exclude periodic telemetry/status probes from operation rates.
            Request::Inspect { .. } => "daemon.inspect",
            Request::List { .. } => "daemon.list",
            Request::Launch { .. } => "daemon.launch",
            Request::Terminate { .. } => "daemon.terminate",
            Request::RestartWeb => "daemon.restart",
            _ => "daemon.request",
        };
        Some(Measurement {
            start: Instant::now(),
            operation,
            concurrency,
            epoch: self.epoch,
        })
    }
    pub fn finish(&mut self, measurement: Option<Measurement>, success: bool) {
        let Some(measurement) = measurement else {
            return;
        };
        if self.revision.is_none() || measurement.epoch != self.epoch {
            return;
        }
        self.observe(
            "palmagent.operation.duration",
            measurement.start.elapsed().as_secs_f64(),
            BTreeMap::from([
                ("concurrency", bucket(measurement.concurrency)),
                ("operation", measurement.operation),
                ("outcome", if success { "success" } else { "error" }),
            ]),
            "duration",
        );
    }
    fn observe(
        &mut self,
        name: &'static str,
        value: f64,
        attributes: BTreeMap<&'static str, &'static str>,
        kind: &str,
    ) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        let bounds = self.bounds[kind].as_array().expect("checked histogram");
        let key = format!("{name}:{attributes:?}");
        if !self.points.contains_key(&key) && self.points.len() >= 32 {
            return;
        }
        let point = self.points.entry(key).or_insert_with(|| Point {
            name,
            attributes,
            count: 0,
            sum: 0.0,
            buckets: vec![0; bounds.len() + 1],
        });
        if point.count >= 100_000 {
            return;
        }
        let index = bounds
            .iter()
            .position(|bound| value <= bound.as_f64().unwrap())
            .unwrap_or(bounds.len());
        point.buckets[index] += 1;
        point.count += 1;
        point.sum += value;
    }
    pub fn snapshot(&self) -> Value {
        // Check again before releasing a snapshot, even inside the one-second collection poll.
        if self.revision.is_none() || self.choice() != self.revision {
            return Value::Null;
        }
        json!({ "schemaVersion": 1, "revision": self.revision, "epoch": self.epoch,
            "startedAt": self.started, "sampledAt": millis(), "points": self.points.values().collect::<Vec<_>>() })
    }
}
fn cpu_seconds() -> f64 {
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return 0.0;
        }
        (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as f64
            + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as f64 / 1_000_000.0
    }
}
fn current_rss() -> Option<f64> {
    let data = fs::read_to_string("/proc/self/statm").ok()?;
    let pages: f64 = data.split_whitespace().nth(1)?.parse().ok()?;
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if size <= 0 {
        return None;
    }
    Some(pages * size as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_contract_has_the_same_boundaries_and_operations() {
        let contract: Value = serde_json::from_str(CONTRACT).unwrap();
        assert_eq!(contract["bounds"]["duration"][0], 0.001);
        assert!(
            contract["operations"]
                .as_array()
                .unwrap()
                .contains(&json!("daemon.launch"))
        );
        assert_eq!(
            [
                bucket(0),
                bucket(1),
                bucket(4),
                bucket(8),
                bucket(16),
                bucket(32)
            ],
            ["0", "1", "2-4", "5-8", "9-16", "17+"]
        );
    }
    #[test]
    fn resource_measurements_are_self_only_and_finite() {
        assert!(cpu_seconds().is_finite());
        assert!(current_rss().unwrap() > 0.0);
    }
}
