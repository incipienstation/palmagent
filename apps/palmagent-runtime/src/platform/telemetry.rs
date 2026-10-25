//! Optional aggregate observations. No identifiers or network work enter this boundary.
use palmagent_telemetry::{Measurement, Telemetry};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone)]
pub struct Measurements {
    aggregate: Arc<Mutex<Telemetry>>,
    active: Arc<AtomicUsize>,
}
impl Measurements {
    pub fn new(preference: PathBuf) -> Self {
        Self {
            aggregate: Arc::new(Mutex::new(
                Telemetry::new(preference).with_stream_limit(128),
            )),
            active: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub fn tick(&self, active: usize) {
        self.active.store(active, Ordering::Relaxed);
        self.refresh();
    }
    pub fn refresh(&self) {
        if let Ok(mut aggregate) = self.aggregate.try_lock() {
            aggregate.tick(self.active.load(Ordering::Relaxed));
        }
    }
    pub fn begin(&self, operation: &'static str) -> Option<Measurement> {
        self.aggregate
            .try_lock()
            .ok()?
            .begin(operation, self.active.load(Ordering::Relaxed))
    }
    pub fn finish(&self, measurement: Option<Measurement>, success: bool) {
        if let Ok(mut aggregate) = self.aggregate.try_lock() {
            aggregate.finish(measurement, success);
        }
    }
    pub fn snapshot(&self) -> Value {
        self.aggregate
            .try_lock()
            .map(|aggregate| aggregate.snapshot())
            .unwrap_or(Value::Null)
    }
    pub fn write<T>(&self, action: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
        let measurement = self.begin("routine.storage.write");
        let result = action();
        self.finish(measurement, result.is_ok());
        result
    }
}
