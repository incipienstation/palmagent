//! Daemon-specific operation mapping; the native aggregate contract is shared.
use crate::contract::{Configuration, Request};
use palmagent_telemetry::Measurement;
use std::{
    ops::{Deref, DerefMut},
    path::PathBuf,
};

pub struct Telemetry(palmagent_telemetry::Telemetry);
impl Telemetry {
    pub fn new(config: &Configuration) -> Self {
        let path = config
            .environment
            .get("PALMAGENT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/nonexistent"))
            .join("telemetry.json");
        Self(palmagent_telemetry::Telemetry::new(path))
    }
    pub fn begin(&self, request: &Request, concurrency: usize) -> Option<Measurement> {
        let operation = match request {
            Request::Status => return None, // Exclude periodic telemetry/status probes from operation rates.
            Request::Inspect { .. } => "daemon.inspect",
            Request::List { .. } => "daemon.list",
            Request::Launch { .. } => "daemon.launch",
            Request::Terminate { .. } => "daemon.terminate",
            Request::RestartWeb => "daemon.restart",
            _ => "daemon.request",
        };
        self.0.begin(operation, concurrency)
    }
}
impl Deref for Telemetry {
    type Target = palmagent_telemetry::Telemetry;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for Telemetry {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
