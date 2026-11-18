//! Private read endpoint. Admission is bounded and SQLite never blocks an async worker.
use crate::modules::tasks::api::UsageReader;
use crate::platform::{read_pool::ReadPool, telemetry::Observation};
use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct Client {
    readers: ReadPool<Box<dyn UsageReader>>,
}
impl Client {
    pub fn new(reader: Box<dyn UsageReader>) -> Self {
        Self {
            readers: ReadPool::new(vec![reader], 16, Duration::from_millis(250)),
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
            get(|State(client): State<Client>| async move { read(client).await }),
        )
        .with_state(client)
}

pub(super) async fn read(client: Client) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    read_observed(client, None).await
}
pub(super) async fn read_observed(
    client: Client,
    queue: Option<Observation>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let usage = client
        .readers
        .run_observed(queue, move |reader| reader.usage())
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    Ok::<_, (StatusCode, Json<Value>)>(Json(json!({"usage":usage})))
}
