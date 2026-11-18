use palmagent_runtime::platform::read_pool::{ReadError, ReadPool};
use std::{
    future::{Future, poll_fn},
    pin::Pin,
    sync::mpsc,
    task::Poll,
    time::Duration,
};
use tokio::sync::oneshot;

async fn pending<F: Future>(mut future: Pin<&mut F>) {
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounded_waiters_cancel_without_releasing_a_running_read() {
    let pool = ReadPool::new(vec![0], 1, Duration::from_secs(2));
    let (started, ready) = oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let first = pool.clone();
    let caller = tokio::spawn(async move {
        first
            .run(move |value| {
                started.send(()).unwrap();
                blocked.recv().unwrap();
                *value += 1;
            })
            .await
    });
    ready.await.unwrap();
    let mut queued = Box::pin(pool.run(|value| *value));
    pending(queued.as_mut()).await;
    assert_eq!(pool.run(|_| ()).await, Err(ReadError::Full));
    drop(queued);
    let mut replacement = Box::pin(pool.run(|value| *value));
    pending(replacement.as_mut()).await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(pool.run(|_| ()).await, Err(ReadError::Full));
    release.send(()).unwrap();
    assert_eq!(replacement.await, Ok(1));
    assert_eq!(pool.run(|value| *value).await, Ok(1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_wait_returns_its_capacity_without_running_the_read() {
    let pool = ReadPool::new(vec![0], 1, Duration::ZERO);
    let (started, ready) = oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let first = pool.clone();
    let caller = tokio::spawn(async move {
        first
            .run(move |_| {
                started.send(()).unwrap();
                blocked.recv().unwrap();
            })
            .await
    });
    ready.await.unwrap();
    for _ in 0..2 {
        assert_eq!(
            pool.run(|_| panic!("expired read must not execute")).await,
            Err(ReadError::Timeout)
        );
    }
    release.send(()).unwrap();
    assert_eq!(caller.await.unwrap(), Ok(()));
    assert_eq!(pool.run(|value| *value).await, Ok(0));
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
