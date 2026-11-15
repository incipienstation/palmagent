//! Private read endpoint. Admission is bounded and SQLite never blocks an async worker.
use crate::modules::tasks::api::UsageReader;
use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Client {
    reader: Arc<Mutex<Box<dyn UsageReader>>>,
    slots: Arc<Semaphore>,
}
impl Client {
    pub fn new(reader: Box<dyn UsageReader>) -> Self {
        Self {
            reader: Arc::new(Mutex::new(reader)),
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}
fn unavailable() -> (StatusCode, Json<Value>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"Task usage is temporarily unavailable"})),
    )
}
pub fn router(client: Client) -> Router {
    Router::new()
        .route(
            "/v1/tasks/usage",
            get(|State(client): State<Client>| async move {
                let permit = client
                    .slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| unavailable())?;
                let usage = tokio::task::spawn_blocking(move || {
                    // Keep admission until work ends even if its HTTP caller disconnects.
                    let _permit = permit;
                    client
                        .reader
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Usage reader failed"))
                        .and_then(|mut reader| reader.usage())
                })
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())?;
                Ok::<_, (StatusCode, Json<Value>)>(Json(json!({"usage":usage})))
            }),
        )
        .with_state(client)
}
