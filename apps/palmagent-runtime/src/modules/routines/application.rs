//! Routine use cases and outbound contracts. One owner serializes routine admission.
pub mod commands;
pub mod retained;
use crate::modules::routines::domain::{Routine, Run, SCRIPT_CAPACITY, Script, cadence};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Immutable input to the Tasks creation port. A lost receipt reuses the same identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub client_request_id: String,
    pub repo_id: String,
    pub agent: String,
    pub prompt: String,
    pub permission: String,
    pub title: String,
    pub isolate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct AgentDispatch {
    pub id: i64,
    pub task: AgentTask,
}

pub trait Environment: Send {
    fn now(&self) -> i64;
    fn id(&self) -> anyhow::Result<String>;
    fn request_id(&self) -> anyhow::Result<String> {
        let bits = u128::from_str_radix(&self.id()?, 16)?;
        // RFC 9562 version 4 and variant 10, using the same random source as routine IDs.
        Ok(format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            bits >> 96,
            (bits >> 80) as u16,
            (bits >> 64) as u16 & 0x0fff | 0x4000,
            (bits >> 48) as u16 & 0x3fff | 0x8000,
            bits & 0xffff_ffff_ffff
        ))
    }
    fn next_run(&self, schedule: &str, from: i64) -> std::result::Result<Option<i64>, String>;
    fn updating(&self) -> bool;
}

#[derive(Clone, Debug)]
pub struct Repo {
    pub path: String,
    pub base: String,
    pub vcs: String,
}

pub trait Repository: Send {
    fn list(&self, kind: Option<&str>) -> anyhow::Result<Vec<Routine>>;
    fn has_dispatch(&self, id: &str) -> anyhow::Result<bool>;
    fn pending_dispatch(&self) -> anyhow::Result<Option<AgentDispatch>>;
    fn settle_dispatch(
        &mut self,
        id: i64,
        task_id: Option<&str>,
        note: Option<&str>,
    ) -> anyhow::Result<()>;
    fn get(&self, id: &str) -> anyhow::Result<Option<Routine>>;
    fn repo(&self, id: &str) -> anyhow::Result<Option<Repo>>;
    fn insert(&mut self, routine: &Routine) -> anyhow::Result<()>;
    fn update(&mut self, routine: &Routine) -> anyhow::Result<()>;
    fn remove(&mut self, id: &str) -> anyhow::Result<()>;
    fn runs(&self, id: &str, limit: usize) -> anyhow::Result<Vec<Run>>;
    fn running(&self) -> anyhow::Result<Vec<Run>>;
    /// Commit the cadence and admission in one transaction before any side effect.
    fn admit(
        &mut self,
        routine: &Routine,
        status: &str,
        note: &str,
        reason: Option<&str>,
        dispatch: Option<&AgentTask>,
    ) -> anyhow::Result<i64>;
    fn finish(&mut self, id: i64, result: &Value) -> anyhow::Result<()>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    InvalidInput,
    NotFound,
    Conflict,
    Unavailable,
}

#[derive(Debug)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}
impl Error {
    pub fn bad(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::InvalidInput,
            message: message.into(),
        }
    }
    pub fn busy() -> Self {
        Self {
            kind: ErrorKind::Unavailable,
            message: "Application runtime is temporarily unavailable".into(),
        }
    }
    fn conflict(message: &str) -> Self {
        Self {
            kind: ErrorKind::Conflict,
            message: message.into(),
        }
    }
}
impl From<anyhow::Error> for Error {
    fn from(_: anyhow::Error) -> Self {
        Self::busy()
    }
}
type Result<T> = std::result::Result<T, Error>;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    repo_id: Option<String>,
    kind: Option<String>,
    script: Option<Script>,
    preset: Option<String>,
    schedule: Option<String>,
    hour: Option<u32>,
    day_of_week: Option<u32>,
    title: Option<String>,
    enabled: Option<bool>,
    agent: Option<String>,
    prompt: Option<String>,
    permission: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}
impl Input {
    fn parse(value: Value, kind: &str) -> Result<Self> {
        let mut input: Self =
            serde_json::from_value(value).map_err(|_| Error::bad("Invalid routine input"))?;
        if kind == "script"
            && (input.agent.is_some()
                || input.prompt.is_some()
                || input.permission.is_some()
                || input.model.is_some()
                || input.effort.is_some())
        {
            return Err(Error::bad("Script routines do not accept agent settings"));
        }
        if kind == "agent" && input.script.is_some() {
            return Err(Error::bad("Only script routines accept script settings"));
        }
        if let Some(script) = &mut input.script {
            script.validate().map_err(Error::bad)?;
        }
        if input.hour.is_some_and(|h| h > 23) || input.day_of_week.is_some_and(|d| d > 6) {
            return Err(Error::bad("Invalid cadence time"));
        }
        Ok(input)
    }
}

#[derive(Clone, Debug)]
pub enum Job {
    Prepare {
        id: i64,
        repo: Repo,
        worktree_id: String,
    },
    Launch {
        id: i64,
        routine_id: String,
        cwd: String,
        worktree: Option<String>,
        script: Script,
    },
    Inspect {
        id: i64,
        routine_id: String,
        worktree: Option<String>,
    },
    Stop {
        id: i64,
    },
    Acknowledge {
        id: i64,
    },
}
#[derive(Clone, Debug)]
pub struct Prepared {
    pub cwd: String,
    pub worktree: Option<String>,
}
#[derive(Debug)]
pub enum Completion {
    Prepared(i64, std::result::Result<Prepared, String>),
    Launched(i64),
    Inspected(i64, Option<Value>),
    Acknowledged(i64, bool),
    Stopped(i64, bool),
}

struct Pending {
    routine_id: String,
    worktree: Option<String>,
    script: Option<Script>,
    prepared: Option<Prepared>,
    result: Option<Value>,
    busy: bool,
    recorded: bool,
    stop_requested: bool,
}

pub struct Service {
    repository: Box<dyn Repository>,
    environment: Box<dyn Environment>,
    pending: BTreeMap<i64, Pending>,
    pub revision: u64,
    next_tick: i64,
    pub stopping: bool,
}

impl Service {
    pub fn new(
        repository: Box<dyn Repository>,
        environment: Box<dyn Environment>,
    ) -> anyhow::Result<Self> {
        let mut pending = BTreeMap::new();
        for run in repository.running()? {
            pending.insert(
                run.id,
                Pending {
                    routine_id: run.routine_id,
                    worktree: run
                        .result
                        .get("worktreePath")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    script: None,
                    prepared: None,
                    result: None,
                    busy: false,
                    recorded: false,
                    stop_requested: false,
                },
            );
        }
        let mut service = Self {
            repository,
            environment,
            pending,
            revision: 0,
            next_tick: 0,
            stopping: false,
        };
        let now = service.environment.now();
        service.skip_missed("script", now)?;
        service.next_tick = now + 15_000;
        Ok(service)
    }

    fn skip_missed(&mut self, kind: &str, now: i64) -> anyhow::Result<()> {
        for mut routine in self.repository.list(Some(kind))? {
            if !routine.enabled || routine.preset == "manual" || routine.schedule.is_empty() {
                continue;
            }
            if routine.next_run_at.is_none_or(|next| next <= now) {
                let skipped = routine.next_run_at.is_some_and(|next| next <= now);
                routine.next_run_at = self
                    .environment
                    .next_run(&routine.schedule, now)
                    .map_err(anyhow::Error::msg)?;
                routine.updated_at = now;
                if skipped {
                    self.repository.admit(
                        &routine,
                        "skipped",
                        "missed while the server was down",
                        Some("missed_while_down"),
                        None,
                    )?;
                    self.revision += 1;
                } else {
                    self.repository.update(&routine)?;
                }
            }
        }
        Ok(())
    }

    pub fn active(&self) -> usize {
        self.pending.len()
    }
    pub fn get(&self, id: &str) -> Result<Routine> {
        self.repository.get(id)?.ok_or(Error {
            kind: ErrorKind::NotFound,
            message: format!("no such routine: {id}"),
        })
    }
    pub fn list(&self) -> Result<Value> {
        Ok(json!({"routines":self.repository.list(None)?}))
    }
    pub fn runs(&self, id: &str) -> Result<Value> {
        self.get(id)?;
        Ok(json!({"runs":self.repository.runs(id, 20)?}))
    }
    pub fn create(&mut self, value: Value) -> Result<Value> {
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("agent")
            .to_owned();
        let input = Input::parse(value, &kind)?;
        match kind.as_str() {
            "script" if input.script.is_none() => return Err(Error::bad("Script is required")),
            "agent"
                if !matches!(input.agent.as_deref(), Some("codex" | "claude"))
                    || input
                        .prompt
                        .as_ref()
                        .is_none_or(|prompt| prompt.trim().is_empty()) =>
            {
                return Err(Error::bad("Agent and prompt are required"));
            }
            "agent" | "script" => {}
            _ => return Err(Error::bad("Unknown routine kind")),
        }
        let repo_id = input
            .repo_id
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::bad("Space is required"))?;
        if self.repository.repo(&repo_id)?.is_none() {
            return Err(Error::bad("No such space"));
        }
        let agent = input.agent.unwrap_or_else(|| "claude".into());
        let permission = input.permission.unwrap_or_else(|| {
            if agent == "codex" {
                "workspace-write"
            } else {
                "acceptEdits"
            }
            .into()
        });
        let now = self.environment.now();
        let preset = input.preset.unwrap_or_else(|| "custom".into());
        let schedule = cadence(
            &preset,
            input.schedule.as_deref(),
            input.hour,
            input.day_of_week,
        )
        .map_err(Error::bad)?;
        let enabled = input.enabled.unwrap_or(true);
        let next_run_at = if enabled && !schedule.is_empty() {
            self.environment
                .next_run(&schedule, now)
                .map_err(Error::bad)?
        } else {
            None
        };
        let routine = Routine {
            id: format!("rt{}", self.environment.id()?),
            repo_id,
            kind,
            script: input.script,
            agent,
            prompt: input.prompt.unwrap_or_default(),
            permission,
            preset,
            schedule,
            enabled,
            title: input.title,
            model: input.model,
            effort: input.effort,
            last_run_at: None,
            next_run_at,
            created_at: now,
            updated_at: now,
        };
        self.repository.insert(&routine)?;
        self.revision += 1;
        Ok(json!({"routine":routine}))
    }
    pub fn update(&mut self, id: &str, value: Value) -> Result<Value> {
        let mut routine = self.get(id)?;
        let preserve_timeout = value
            .get("script")
            .is_some_and(|script| script.get("timeoutSeconds").is_none());
        let input = Input::parse(value, &routine.kind)?;
        if input.kind.is_some() || input.repo_id.is_some() || input.agent.is_some() {
            return Err(Error::bad("Routine kind and space are fixed"));
        }
        if let Some(mut script) = input.script {
            if preserve_timeout && let Some(previous) = &routine.script {
                script.timeout_seconds = previous.timeout_seconds;
            }
            routine.script = Some(script);
        }
        if input.preset.is_some()
            || input.schedule.is_some()
            || input.hour.is_some()
            || input.day_of_week.is_some()
        {
            let preset = input.preset.unwrap_or_else(|| routine.preset.clone());
            let fields: Vec<_> = routine.schedule.split_whitespace().collect();
            let existing = |index: usize| {
                fields
                    .get(index)
                    .and_then(|field| field.parse::<u32>().ok())
            };
            routine.schedule = cadence(
                &preset,
                input.schedule.as_deref().or(Some(&routine.schedule)),
                input.hour.or(existing(1)),
                input.day_of_week.or(existing(4)),
            )
            .map_err(Error::bad)?;
            routine.preset = preset;
        }
        if let Some(prompt) = input.prompt {
            if prompt.is_empty() {
                return Err(Error::bad("prompt cannot be empty"));
            }
            routine.prompt = prompt;
        }
        if let Some(permission) = input.permission {
            routine.permission = permission;
        }
        if let Some(model) = input.model {
            routine.model = (!model.is_empty()).then_some(model);
        }
        if let Some(effort) = input.effort {
            routine.effort = (!effort.is_empty()).then_some(effort);
        }
        if let Some(title) = input.title {
            routine.title = if title.is_empty() { None } else { Some(title) };
        }
        if let Some(enabled) = input.enabled {
            routine.enabled = enabled;
        }
        routine.updated_at = self.environment.now();
        routine.next_run_at =
            if routine.enabled && routine.preset != "manual" && !routine.schedule.is_empty() {
                self.environment
                    .next_run(&routine.schedule, routine.updated_at)
                    .map_err(Error::bad)?
            } else {
                None
            };
        self.repository.update(&routine)?;
        self.revision += 1;
        Ok(json!({"routine":routine}))
    }
    pub fn remove(&mut self, id: &str) -> Result<Value> {
        let routine = self.get(id)?;
        if self.has_pending(id) {
            return Err(Error::conflict(
                "Wait for the running script before deleting this routine",
            ));
        }
        if routine.kind == "agent" && self.repository.has_dispatch(id)? {
            return Err(Error::conflict(
                "Wait for Task dispatch before deleting this routine",
            ));
        }
        self.repository.remove(id)?;
        self.revision += 1;
        Ok(json!({"routine":routine}))
    }
    pub fn run(&mut self, id: &str) -> Result<(Value, Vec<Job>)> {
        let routine = self.get(id)?;
        if routine.kind == "agent" {
            let (routine, dispatch) = self.admit_agent(routine, true)?;
            return Ok((json!({"routine":routine,"dispatch":dispatch}), Vec::new()));
        }
        let jobs = self.fire(routine, true)?;
        Ok((json!({"routine":self.get(id)?}), jobs))
    }
    pub fn stop(&mut self, id: &str) -> Result<Vec<Job>> {
        if self.get(id)?.kind == "agent" {
            return Err(Error::bad("Stop agent runs from their task"));
        }
        Ok(self
            .pending
            .iter_mut()
            .filter(|(_, p)| p.routine_id == id && !p.stop_requested)
            .map(|(id, p)| {
                p.stop_requested = true;
                Job::Stop { id: *id }
            })
            .collect())
    }
    pub fn has_pending(&self, id: &str) -> bool {
        self.pending.values().any(|p| p.routine_id == id)
    }

    fn advance(&self, routine: &mut Routine, manual: bool) -> Result<()> {
        let now = self.environment.now();
        routine.last_run_at = Some(now);
        routine.updated_at = now;
        if !manual {
            routine.next_run_at = if routine.schedule.is_empty() {
                None
            } else {
                self.environment
                    .next_run(&routine.schedule, now)
                    .map_err(Error::bad)?
            };
        }
        Ok(())
    }

    fn admit_agent(
        &mut self,
        mut routine: Routine,
        manual: bool,
    ) -> Result<(Routine, AgentDispatch)> {
        if self.stopping || self.environment.updating() {
            return Err(Error::busy());
        }
        self.advance(&mut routine, manual)?;
        let task = AgentTask {
            client_request_id: self.environment.request_id()?,
            repo_id: routine.repo_id.clone(),
            agent: routine.agent.clone(),
            prompt: routine.prompt.clone(),
            permission: routine.permission.clone(),
            model: routine.model.clone(),
            effort: routine.effort.clone(),
            isolate: true,
            title: match routine.title.as_deref() {
                Some(title) if !title.is_empty() => format!("⏱ {title}"),
                _ => format!("⏱ routine {}", routine.id),
            },
        };
        let id = self.repository.admit(
            &routine,
            if manual { "manual" } else { "fired" },
            "Awaiting Task dispatch",
            None,
            Some(&task),
        )?;
        self.revision += 1;
        Ok((routine, AgentDispatch { id, task }))
    }

    /// Agent admission requires an available Tasks coordinator. Its startup skips missed
    /// schedules but still delivers previously admitted requests with their original IDs.
    pub fn agent_tick(&mut self, startup: bool) -> Result<()> {
        let now = self.environment.now();
        if startup {
            self.skip_missed("agent", now)?;
        } else if !self.stopping && !self.environment.updating() {
            for routine in self.repository.list(Some("agent"))? {
                if routine.enabled && routine.next_run_at.is_some_and(|next| next <= now) {
                    self.admit_agent(routine, false)?;
                }
            }
        }
        Ok(())
    }
    pub fn pending_dispatch(&self) -> Result<Option<AgentDispatch>> {
        Ok(self.repository.pending_dispatch()?)
    }
    pub fn settle_dispatch(
        &mut self,
        id: i64,
        task_id: Option<&str>,
        note: Option<&str>,
    ) -> Result<()> {
        if task_id.is_some() == note.is_some() {
            return Err(Error::bad("Expected one Task dispatch outcome"));
        }
        self.repository.settle_dispatch(id, task_id, note)?;
        self.revision += 1;
        Ok(())
    }

    fn fire(&mut self, mut routine: Routine, manual: bool) -> Result<Vec<Job>> {
        if self.stopping || self.environment.updating() {
            return Err(Error::busy());
        }
        let full = self.has_pending(&routine.id) || self.pending.len() >= SCRIPT_CAPACITY;
        if full && manual {
            return Err(Error::conflict(
                "A script is already running or all 4 script slots are busy",
            ));
        }
        let preparation = if full {
            None
        } else {
            Some((
                self.repository.repo(&routine.repo_id)?,
                format!("routine-{}", self.environment.id()?),
            ))
        };
        self.advance(&mut routine, manual)?;
        let id = self.repository.admit(
            &routine,
            if full { "skipped" } else { "running" },
            if full {
                "script already running or script capacity reached"
            } else if manual {
                "manual"
            } else {
                "scheduled"
            },
            None,
            None,
        )?;
        self.revision += 1;
        if full {
            return Ok(Vec::new());
        }
        self.pending.insert(
            id,
            Pending {
                routine_id: routine.id,
                worktree: None,
                script: routine.script,
                prepared: None,
                result: None,
                busy: true,
                recorded: false,
                stop_requested: false,
            },
        );
        let (repo, worktree_id) = preparation.unwrap();
        match repo {
            Some(repo) => Ok(vec![Job::Prepare {
                id,
                repo,
                worktree_id,
            }]),
            None => {
                self.complete(Completion::Prepared(
                    id,
                    Err("Space no longer exists".into()),
                ));
                Ok(Vec::new())
            }
        }
    }

    pub fn complete(&mut self, completion: Completion) {
        match completion {
            Completion::Prepared(id, result) => {
                if let Some(pending) = self.pending.get_mut(&id) {
                    pending.busy = false;
                    match result {
                        Ok(prepared) => {
                            pending.worktree = prepared.worktree.clone();
                            pending.prepared = Some(prepared);
                        }
                        Err(note) => {
                            pending.result = Some(
                                json!({"status":"failed","note":note,"finishedAt":self.environment.now()}),
                            )
                        }
                    }
                }
            }
            Completion::Launched(id) => {
                if let Some(pending) = self.pending.get_mut(&id) {
                    pending.busy = false;
                }
            }
            Completion::Inspected(id, result) => {
                if let Some(pending) = self.pending.get_mut(&id) {
                    pending.busy = false;
                    pending.result = result;
                }
            }
            Completion::Acknowledged(id, true) => {
                self.pending.remove(&id);
            }
            Completion::Acknowledged(id, false) => {
                if let Some(pending) = self.pending.get_mut(&id) {
                    pending.busy = false;
                }
            }
            Completion::Stopped(id, false) => {
                if let Some(pending) = self.pending.get_mut(&id) {
                    pending.stop_requested = false;
                }
            }
            Completion::Stopped(_, true) => {}
        }
    }

    pub fn poll(&mut self, reconcile: bool) -> Vec<Job> {
        let mut jobs = Vec::new();
        for (&id, pending) in &mut self.pending {
            if pending.busy {
                continue;
            }
            if let Some(result) = &pending.result {
                if !pending.recorded {
                    if self.repository.finish(id, result).is_err() {
                        continue;
                    }
                    pending.recorded = true;
                    self.revision += 1;
                }
                pending.busy = true;
                jobs.push(Job::Acknowledge { id });
            } else if let Some(prepared) = &pending.prepared {
                let mut result = json!({"status":"running"});
                if let Some(path) = &prepared.worktree {
                    result["worktreePath"] = json!(path);
                }
                if self.repository.finish(id, &result).is_err() {
                    continue;
                }
                let prepared = pending.prepared.take().unwrap();
                pending.busy = true;
                jobs.push(Job::Launch {
                    id,
                    routine_id: pending.routine_id.clone(),
                    cwd: prepared.cwd,
                    worktree: prepared.worktree,
                    script: pending.script.take().unwrap(),
                });
            } else if reconcile {
                pending.busy = true;
                jobs.push(Job::Inspect {
                    id,
                    routine_id: pending.routine_id.clone(),
                    worktree: pending.worktree.clone(),
                });
            }
        }
        let now = self.environment.now();
        if now >= self.next_tick && !self.stopping && !self.environment.updating() {
            self.next_tick = now + 15_000;
            if let Ok(routines) = self.repository.list(Some("script")) {
                for routine in routines {
                    if routine.enabled
                        && routine.next_run_at.is_some_and(|next| next <= now)
                        && let Ok(admitted) = self.fire(routine, false)
                    {
                        jobs.extend(admitted);
                    }
                }
            }
        }
        jobs
    }
}
