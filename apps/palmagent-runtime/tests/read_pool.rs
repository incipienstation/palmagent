use palmagent_runtime::platform::{
    read_pool::{ReadError, ReadPool},
    telemetry::Measurements,
};
use serde_json::{Value, json};
use std::{
    future::{Future, poll_fn},
    pin::Pin,
    sync::mpsc,
    task::Poll,
    time::Duration,
};
use tokio::sync::oneshot;

struct Metrics {
    path: std::path::PathBuf,
    measurements: Measurements,
}
impl Metrics {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "read-pool-metrics-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, json!({"schemaVersion":2,"enabled":true,"disclosed":true,"revision":"00000000-0000-4000-8000-000000000001"}).to_string()).unwrap();
        let measurements = Measurements::new(path.clone());
        measurements.tick(0);
        Self { path, measurements }
    }
    fn counts(&self) -> Value {
        let mut counts = serde_json::Map::new();
        let snapshot = self.measurements.snapshot();
        assert!(
            !snapshot.is_null(),
            "missing snapshot; preference: {:?}",
            std::fs::read_to_string(&self.path)
        );
        for p in snapshot["points"].as_array().unwrap() {
            assert_eq!(p["attributes"]["operation"], "read.queue.transcript");
            assert_eq!(p["attributes"]["concurrency"], "2-4");
            assert_eq!(
                p["count"].as_u64().unwrap(),
                p["buckets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap())
                    .sum::<u64>()
            );
            counts.insert(
                p["attributes"]["outcome"].as_str().unwrap().into(),
                p["count"].clone(),
            );
        }
        Value::Object(counts)
    }
}
impl Drop for Metrics {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn pending<F: Future>(mut future: Pin<&mut F>) {
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounded_waiters_cancel_without_releasing_a_running_read() {
    let metrics = Metrics::new();
    let measurements = metrics.measurements.clone();
    let worker_metrics = measurements.clone();
    let queue = || Some(measurements.observe("read.queue.transcript", 4));
    let pool = ReadPool::new(vec![0], 1, Duration::from_secs(2));
    let (started, ready) = oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let first = pool.clone();
    let caller = tokio::spawn(async move {
        first
            .run_observed(
                Some(worker_metrics.observe("read.queue.transcript", 4)),
                move |value| {
                    started.send(()).unwrap();
                    blocked.recv().unwrap();
                    *value += 1;
                },
            )
            .await
    });
    ready.await.unwrap();
    let mut queued = Box::pin(pool.run_observed(queue(), |value| *value));
    pending(queued.as_mut()).await;
    assert_eq!(
        pool.run_observed(queue(), |_| ()).await,
        Err(ReadError::Full)
    );
    drop(queued);
    let mut replacement = Box::pin(pool.run_observed(queue(), |value| *value));
    pending(replacement.as_mut()).await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(
        pool.run_observed(queue(), |_| ()).await,
        Err(ReadError::Full)
    );
    release.send(()).unwrap();
    assert_eq!(replacement.await, Ok(1));
    assert_eq!(pool.run_observed(queue(), |value| *value).await, Ok(1));
    assert_eq!(
        metrics.counts(),
        json!({"success":3,"rejected":2,"cancelled":1})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_wait_returns_its_capacity_without_running_the_read() {
    let metrics = Metrics::new();
    let measurements = metrics.measurements.clone();
    let worker_metrics = measurements.clone();
    let queue = || Some(measurements.observe("read.queue.transcript", 4));
    let pool = ReadPool::new(vec![0], 1, Duration::ZERO);
    let (started, ready) = oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let first = pool.clone();
    let caller = tokio::spawn(async move {
        first
            .run_observed(
                Some(worker_metrics.observe("read.queue.transcript", 4)),
                move |_| {
                    started.send(()).unwrap();
                    blocked.recv().unwrap();
                },
            )
            .await
    });
    ready.await.unwrap();
    for _ in 0..2 {
        assert_eq!(
            pool.run_observed(queue(), |_| panic!("expired read must not execute"))
                .await,
            Err(ReadError::Timeout)
        );
    }
    release.send(()).unwrap();
    assert_eq!(caller.await.unwrap(), Ok(()));
    assert_eq!(pool.run_observed(queue(), |value| *value).await, Ok(0));
    assert_eq!(metrics.counts(), json!({"success":2,"timeout":2}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_readers_overlap_and_a_panicked_reader_is_not_reused() {
    let pool = ReadPool::new(vec![10, 20], 1, Duration::from_secs(2));
    let mut jobs = Vec::new();
    let mut releases = Vec::new();
    let mut starts = Vec::new();
    for _ in 0..2 {
        let (started, ready) = oneshot::channel();
        let (release, blocked) = mpsc::channel();
        let worker = pool.clone();
        jobs.push(tokio::spawn(async move {
            worker
                .run(move |value| {
                    started.send(()).unwrap();
                    blocked.recv().unwrap();
                    *value
                })
                .await
        }));
        starts.push(ready);
        releases.push(release);
    }
    // Both readers must start before either is released; a single mutex cannot pass.
    for ready in starts {
        tokio::time::timeout(Duration::from_secs(2), ready)
            .await
            .unwrap()
            .unwrap();
    }
    for release in releases {
        release.send(()).unwrap();
    }
    let mut values = Vec::new();
    for job in jobs {
        values.push(job.await.unwrap().unwrap());
    }
    values.sort();
    assert_eq!(values, [10, 20]);
    assert_eq!(
        pool.run(|value| {
            *value = 99;
            panic!("synthetic reader failure")
        })
        .await,
        Err(ReadError::Failed)
    );
    assert_ne!(pool.run(|value| *value).await.unwrap(), 99);
}
