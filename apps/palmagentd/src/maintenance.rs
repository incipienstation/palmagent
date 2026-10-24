//! Incremental ownership reconciliation and retention. Never replays an invocation.
use crate::{
    contract::{HostRecord, Isolation, State},
    hosts,
    platform::{NativePlatform, ProcessIsolation, alive},
    storage,
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, ReadDir},
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

const RETAIN_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const LOG_BUDGET: u64 = 64 * 1024 * 1024;
const BATCH: usize = 8;

struct Log {
    record: PathBuf,
    path: PathBuf,
    bytes: u64,
    finished: u64,
}
struct Sweep {
    directory: ReadDir,
    reading_logs: bool,
    reading_services: bool,
    seen: BTreeSet<String>,
    logs: Vec<Log>,
    bytes: u64,
    errors: usize,
}

pub struct Maintenance {
    entries: BTreeMap<String, Value>,
    sweep: Option<Sweep>,
    pruning: VecDeque<Log>,
    next: Instant,
    checked_at: Option<u64>,
    log_bytes: u64,
    errors: usize,
}

impl Maintenance {
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            sweep: None,
            pruning: VecDeque::new(),
            next: Instant::now(),
            checked_at: None,
            log_bytes: 0,
            errors: 0,
        }
    }
    pub fn status(&self) -> Value {
        json!({ "checkedAt": self.checked_at, "scanning": self.sweep.is_some() || !self.pruning.is_empty(),
            "hosts": self.entries.len(), "inspectionErrors": self.errors,
            "orphaned": self.entries.values().filter(|v| v["lifecycle"]["supervision"] == "orphaned").count(),
            "unconfirmed": self.entries.values().filter(|v| v["lifecycle"]["supervision"] == "unconfirmed").count(),
            "logBytes": self.log_bytes, "logBudgetBytes": LOG_BUDGET,
            "overBudget": self.log_bytes > LOG_BUDGET, "retentionDays": 7 })
    }
    pub fn list(&self, after: Option<&str>) -> Result<Value> {
        use std::ops::Bound::{Excluded, Unbounded};
        ensure!(
            after.is_none_or(
                |s| s.len() <= 96 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            ),
            "Invalid host cursor"
        );
        let lower = after.map_or(Unbounded, |s| Excluded(s.to_owned()));
        let mut iter = self.entries.range((lower, Unbounded));
        let page: Vec<_> = iter.by_ref().take(32).collect();
        let next = if iter.next().is_some() {
            page.last().map(|(key, _)| (*key).clone())
        } else {
            None
        };
        Ok(
            json!({ "hosts": page.iter().map(|(_, value)| *value).collect::<Vec<_>>(),
            "next": next, "inventory": self.status() }),
        )
    }
    pub fn tick(&mut self, data: &Path, root: Option<&Path>) -> Result<()> {
        let result = self.tick_inner(data, root);
        if result.is_err() {
            self.errors += 1;
            self.sweep = None;
            self.next = Instant::now() + Duration::from_secs(2);
        }
        result
    }
    fn tick_inner(&mut self, data: &Path, root: Option<&Path>) -> Result<()> {
        // Revalidate ownership at deletion time, not just when the sweep saw the file.
        for _ in 0..BATCH {
            let Some(log) = self.pruning.pop_front() else {
                break;
            };
            match prune(&log) {
                Ok(true) => self.log_bytes = self.log_bytes.saturating_sub(log.bytes),
                Ok(false) => {}
                Err(_) => self.errors += 1,
            }
        }
        if !self.pruning.is_empty() {
            return Ok(());
        }
        if self.sweep.is_none() {
            if Instant::now() < self.next {
                return Ok(());
            }
            storage::private_directory(&storage::state_directory(data).join("logs"))?;
            storage::private_directory(&storage::state_directory(data).join("services"))?;
            self.sweep = Some(Sweep {
                directory: fs::read_dir(storage::state_directory(data).join("hosts"))?,
                reading_logs: false,
                reading_services: false,
                seen: BTreeSet::new(),
                logs: vec![],
                bytes: 0,
                errors: 0,
            });
        }
        let sweep = self.sweep.as_mut().expect("sweep was initialized");
        for _ in 0..BATCH {
            let Some(entry) = sweep.directory.next() else {
                if !sweep.reading_services && !sweep.reading_logs {
                    sweep.directory =
                        fs::read_dir(storage::state_directory(data).join("services"))?;
                    sweep.reading_services = true;
                    continue;
                }
                if !sweep.reading_logs {
                    sweep.directory = fs::read_dir(storage::state_directory(data).join("logs"))?;
                    sweep.reading_logs = true;
                    continue;
                }
                let mut sweep = self.sweep.take().expect("active sweep");
                self.entries.retain(|key, _| sweep.seen.contains(key));
                self.log_bytes = sweep.bytes;
                self.errors = sweep.errors;
                self.checked_at = Some(storage::now());
                sweep.logs.sort_by_key(|log| log.finished);
                let mut remaining = sweep.bytes;
                for log in sweep.logs {
                    if storage::now().saturating_sub(log.finished) >= RETAIN_MS
                        || remaining > LOG_BUDGET
                    {
                        remaining = remaining.saturating_sub(log.bytes);
                        self.pruning.push_back(log);
                    }
                }
                self.next = Instant::now() + Duration::from_secs(2);
                return Ok(());
            };
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(_) => {
                    sweep.errors += 1;
                    continue;
                }
            };
            if sweep.reading_logs {
                match log_bytes(&path) {
                    Ok(bytes) => sweep.bytes = sweep.bytes.saturating_add(bytes),
                    Err(_) => sweep.errors += 1,
                }
                continue;
            }
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            // Internal service records stay separate from the protocol-1 invocation inventory.
            // Older daemons/clients can still inspect retained invocations after rollback.
            if sweep.reading_services {
                match maintain_host(data, root, &path) {
                    Ok(record) => {
                        if collect_logs(data, &path, &record, sweep).is_err() {
                            sweep.errors += 1;
                        }
                    }
                    Err(_) => sweep.errors += 1,
                }
                continue;
            }
            let key = path
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_owned();
            if key.len() > 96 || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                sweep.errors += 1;
                continue;
            }
            sweep.seen.insert(key.clone());
            match maintain_host(data, root, &path) {
                Ok(record) => {
                    match hosts::describe(data, &record) {
                        Ok(mut value) => {
                            // Keep inventory frames bounded; full paths remain available through inspect.
                            value
                                .as_object_mut()
                                .expect("host object")
                                .remove("release");
                            value["kind"] = json!(record.kind);
                            value["id"] = json!(record.id);
                            self.entries.insert(key, value);
                        }
                        Err(_) => {
                            sweep.errors += 1;
                            self.entries.insert(
                                key.clone(),
                                json!({ "record": key, "error": "inspection_failed" }),
                            );
                        }
                    }
                    if collect_logs(data, &path, &record, sweep).is_err() {
                        sweep.errors += 1;
                    }
                }
                Err(_) => {
                    sweep.errors += 1;
                    self.entries.insert(
                        key.clone(),
                        json!({ "record": key, "error": "inspection_failed" }),
                    );
                }
            }
        }
        Ok(())
    }
}

fn validated_record(data: &Path, path: &Path) -> Result<HostRecord> {
    let record: HostRecord = storage::read(path)?;
    ensure!(
        record.protocol == crate::contract::PROTOCOL
            && storage::host_path(data, record.kind, &record.id)? == path,
        "Host identity mismatch"
    );
    Ok(record)
}

fn maintain_host(data: &Path, root: Option<&Path>, path: &Path) -> Result<HostRecord> {
    let record = validated_record(data, path)?;
    if record
        .guard
        .as_ref()
        .map(alive)
        .transpose()?
        .unwrap_or(false)
    {
        return Ok(record);
    }
    let Ok(_lock) = storage::lock(&path.with_extension("lock")) else {
        return Ok(record);
    };
    let mut record = validated_record(data, path)?;
    if record
        .guard
        .as_ref()
        .map(alive)
        .transpose()?
        .unwrap_or(false)
    {
        return Ok(record);
    }
    // No recorded guardian means a delayed launch may still claim its reservation.
    if record.state != State::Exited && record.guard.is_some() {
        if let Some(group) = &record.group {
            ensure!(
                root.is_some_and(
                    |root| group == &root.join(record.kind.directory()).join(&record.id)
                ),
                "Orphan cgroup is outside this supervisor's delegation"
            );
        }
        ensure!(
            record.isolation != Isolation::Cgroup || record.group.is_some(),
            "Orphan cgroup identity is missing"
        );
        // A process-group guardian can die between spawn and recording its child. Its
        // unlocked record proves the guardian ended, not that the unrecorded child never ran.
        if record.isolation == Isolation::ProcessGroup && record.child.is_none() {
            if record.lifecycle.reason.as_deref() != Some("guardian_lost") {
                record.lifecycle.reason = Some("guardian_lost".into());
                storage::write_host(data, &record)?;
            }
            return Ok(record);
        }
        let populated = NativePlatform::populated(&record)?;
        if populated && record.isolation == Isolation::Cgroup {
            NativePlatform::terminate(&record)?;
        }
        // Process-group mode cannot safely kill a stale group after losing its guardian.
        // Leave it visibly orphaned until its descendants are confirmed gone.
        if !populated {
            NativePlatform::remove_group(&record)?;
            record.state = State::Exited;
            record.exit_code = Some(-1);
            record.lifecycle.finished_at = Some(storage::now());
        }
        if record.lifecycle.reason.as_deref() != Some("guardian_lost") || !populated {
            record.lifecycle.reason = Some("guardian_lost".into());
            storage::write_host(data, &record)?;
        }
    }
    if record.state == State::Exited && !NativePlatform::populated(&record)? {
        let finished = finished_at(path, &record)?;
        if storage::now().saturating_sub(finished) >= RETAIN_MS {
            if !record.lifecycle.compacted {
                record.lifecycle.ready_at = hosts::ready_at(data, &record)?;
                record.lifecycle.finished_at = Some(finished);
                record.lifecycle.compacted = true;
                record.environment.clear();
                record.guard = None;
                record.child = None;
                record.group = None;
                storage::write_host(data, &record)?;
            }
            // Retry after an interrupted cleanup even if the compact record already committed.
            for extension in ["ready", "stop"] {
                let sidecar = path.with_extension(extension);
                if sidecar.exists() {
                    storage::private_path(&sidecar, true)?;
                    fs::remove_file(sidecar)?;
                }
            }
        }
    }
    Ok(record)
}
fn finished_at(path: &Path, record: &HostRecord) -> Result<u64> {
    Ok(record.lifecycle.finished_at.unwrap_or(
        fs::metadata(path)?
            .modified()?
            .duration_since(UNIX_EPOCH)?
            .as_millis()
            .try_into()?,
    ))
}
fn log_bytes(path: &Path) -> Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    storage::private_path(path, true)?;
    Ok(fs::metadata(path)?.len())
}
fn collect_logs(data: &Path, path: &Path, record: &HostRecord, sweep: &mut Sweep) -> Result<()> {
    let completed = record.state == State::Exited
        && !record
            .guard
            .as_ref()
            .map(alive)
            .transpose()?
            .unwrap_or(false)
        && !NativePlatform::populated(record)?;
    for stream in ["out", "err"] {
        for suffix in ["log", "previous.log"] {
            let log = storage::state_directory(data).join("logs").join(format!(
                "{}-{}-{stream}.{suffix}",
                record.kind.name(),
                record.id
            ));
            let bytes = log_bytes(&log)?;
            if completed && log.exists() {
                sweep.logs.push(Log {
                    record: path.to_owned(),
                    path: log,
                    bytes,
                    finished: finished_at(path, record)?,
                });
            }
        }
    }
    Ok(())
}
fn prune(log: &Log) -> Result<bool> {
    let Ok(_lock) = storage::lock(&log.record.with_extension("lock")) else {
        return Ok(false);
    };
    let record: HostRecord = storage::read(&log.record)?;
    if record.state != State::Exited
        || record
            .guard
            .as_ref()
            .map(alive)
            .transpose()?
            .unwrap_or(false)
        || NativePlatform::populated(&record)?
    {
        return Ok(false);
    }
    if !log.path.exists() {
        return Ok(true);
    }
    storage::private_path(&log.path, true)?;
    fs::remove_file(&log.path)?;
    Ok(true)
}
