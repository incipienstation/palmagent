//! Bounded blocking reads. Waiting requests use async permits, never blocking threads.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

struct State<T> {
    available: Mutex<Vec<T>>,
    workers: Arc<Semaphore>,
    admitted: Arc<Semaphore>,
    wait: Duration,
}
pub struct ReadPool<T> {
    state: Arc<State<T>>,
}
impl<T> Clone for ReadPool<T> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    Full,
    Timeout,
    Failed,
}

impl<T: Send + 'static> ReadPool<T> {
    pub fn new(readers: Vec<T>, waiting: usize, wait: Duration) -> Self {
        assert!(!readers.is_empty());
        let count = readers.len();
        Self {
            state: Arc::new(State {
                available: Mutex::new(readers),
                workers: Arc::new(Semaphore::new(count)),
                admitted: Arc::new(Semaphore::new(count + waiting)),
                wait,
            }),
        }
    }
    pub async fn run<R: Send + 'static>(
        &self,
        work: impl FnOnce(&mut T) -> R + Send + 'static,
    ) -> Result<R, ReadError> {
        let admitted = self
            .state
            .admitted
            .clone()
            .try_acquire_owned()
            .map_err(|_| ReadError::Full)?;
        let worker =
            tokio::time::timeout(self.state.wait, self.state.workers.clone().acquire_owned())
                .await
                .map_err(|_| ReadError::Timeout)?
                .map_err(|_| ReadError::Failed)?;
        let reader = self
            .state
            .available
            .lock()
            .map_err(|_| ReadError::Failed)?
            .pop()
            .ok_or(ReadError::Failed)?;
        let lease = Lease {
            reader: Some(reader),
            state: self.state.clone(),
            worker: Some(worker),
            _admitted: admitted,
        };
        // The blocking task owns both permits. Dropping its HTTP future cannot release
        // capacity while the database read or response encoding is still running.
        tokio::task::spawn_blocking(move || {
            let mut lease = lease;
            work(lease.reader.as_mut().unwrap())
        })
        .await
        .map_err(|_| ReadError::Failed)
    }
}
struct Lease<T> {
    reader: Option<T>,
    state: Arc<State<T>>,
    worker: Option<OwnedSemaphorePermit>,
    _admitted: OwnedSemaphorePermit,
}
impl<T> Drop for Lease<T> {
    fn drop(&mut self) {
        if !std::thread::panicking()
            && let Ok(mut available) = self.state.available.lock()
        {
            available.push(self.reader.take().unwrap());
            return;
        }
        // Never reuse a reader after an unexpected panic. Other workers remain usable;
        // this slot stays unavailable until the listener is reconstructed.
        if let Some(permit) = self.worker.take() {
            permit.forget();
        }
    }
}
