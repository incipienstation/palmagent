//! Axum is an inbound adapter. Requests enqueue use cases; disconnecting does not revoke admission.
use crate::modules::routines::application::{Completion, Error};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

pub enum Action {
    Status,
    List,
    Get(String),
    Create(Value),
    Update(String, Value),
    Remove(String),
    Run(String),
    Stop(String),
    Runs(String),
    Pending(String),
}
pub enum Message {
    Request(Action, oneshot::Sender<Result<Value, Error>>),
    Completed(Completion),
    Tick,
    Shutdown,
}

#[derive(Clone)]
pub struct Client {
    sender: mpsc::Sender<Message>,
}
impl Client {
    pub fn new(sender: mpsc::Sender<Message>) -> Self {
        Self { sender }
    }
    pub async fn request(&self, action: Action) -> Result<Value, Error> {
        let (send, receive) = oneshot::channel();
        self.sender
            .try_send(Message::Request(action, send))
            .map_err(|_| Error::busy())?;
        tokio::time::timeout(std::time::Duration::from_secs(10), receive)
            .await
            .map_err(|_| Error::busy())?
            .map_err(|_| Error::busy())?
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({"error":self.message})),
        )
            .into_response()
    }
}

fn body(value: Result<Json<Value>, JsonRejection>) -> Result<Value, Error> {
    value
        .map(|Json(value)| value)
        .map_err(|_| Error::bad("Invalid JSON request"))
}
pub fn router(client: Client) -> Router {
    Router::new()
        .route("/health", get(|State(client): State<Client>| async move { client.request(Action::Status).await.map(Json) }))
        .route("/v1/routines", get(|State(client): State<Client>| async move { client.request(Action::List).await.map(Json) })
            .post(|State(client): State<Client>, input: Result<Json<Value>, JsonRejection>| async move {
                client.request(Action::Create(body(input)?)).await.map(|value| (StatusCode::CREATED, Json(value)))
            }))
        .route("/v1/routines/{id}", get(|State(client): State<Client>, Path(id): Path<String>| async move { client.request(Action::Get(id)).await.map(Json) })
            .patch(|State(client): State<Client>, Path(id): Path<String>, input: Result<Json<Value>, JsonRejection>| async move { client.request(Action::Update(id, body(input)?)).await.map(Json) })
            .delete(|State(client): State<Client>, Path(id): Path<String>| async move { client.request(Action::Remove(id)).await.map(Json) }))
        .route("/v1/routines/{id}/runs", get(|State(client): State<Client>, Path(id): Path<String>| async move { client.request(Action::Runs(id)).await.map(Json) }))
        .route("/v1/routines/{id}/run", post(|State(client): State<Client>, Path(id): Path<String>| async move { client.request(Action::Run(id)).await.map(Json) }))
        .route("/v1/routines/{id}/stop", post(|State(client): State<Client>, Path(id): Path<String>| async move {
            client.request(Action::Stop(id.clone())).await?;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let state = client.request(Action::Pending(id.clone())).await?;
                if state["pending"] == false { return Ok::<_, Error>(Json(json!({"routine":state["routine"]}))); }
                if tokio::time::Instant::now() >= deadline { return Err(Error::busy()); }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                client.request(Action::Stop(id.clone())).await?;
            }
        }))
        .layer(DefaultBodyLimit::max(1_048_576)).with_state(client)
}
