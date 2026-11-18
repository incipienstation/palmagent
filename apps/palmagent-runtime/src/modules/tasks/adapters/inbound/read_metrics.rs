//! Fixed public-read labels. Request content is used only for classification, never stored.
use crate::platform::telemetry::{Measurements, Observation, Outcome};
use axum::{
    extract::{Request, State},
    http::{Method, StatusCode},
    middleware::Next,
    response::Response,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Clone, Copy)]
enum Route {
    Usage,
    Transcript,
    Changes,
    Steps,
    Details,
}
impl Route {
    fn classify(request: &Request) -> Option<Self> {
        if request.method() != Method::GET {
            return None;
        }
        if request.uri().path() == "/api/usage" {
            return Some(Self::Usage);
        }
        let parts: Vec<_> = request.uri().path().split('/').collect();
        if !matches!(parts.len(), 5 | 6)
            || parts[1] != "api"
            || parts[2] != "tasks"
            || parts[3].is_empty()
            || parts[4] != "history"
        {
            return None;
        }
        match parts.get(5).copied().unwrap_or("") {
            "steps" => Some(Self::Steps),
            "details" => Some(Self::Details),
            kind @ ("" | "changes") => {
                // Match the public adapter's first decoded format parameter.
                let format = form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                    .find(|(key, _)| key == "format");
                if format.is_some_and(|(_, value)| value == "transcript") {
                    Some(if kind.is_empty() {
                        Self::Transcript
                    } else {
                        Self::Changes
                    })
                } else {
                    None
                }
            }
            _ => None,
        }
    }
    fn http(self) -> &'static str {
        match self {
            Self::Usage => "http.read.usage",
            Self::Transcript => "http.read.transcript",
            Self::Changes => "http.read.changes",
            Self::Steps => "http.read.steps",
            Self::Details => "http.read.details",
        }
    }
    fn queue(self) -> &'static str {
        match self {
            Self::Usage => "read.queue.usage",
            Self::Transcript => "read.queue.transcript",
            Self::Changes => "read.queue.changes",
            Self::Steps => "read.queue.steps",
            Self::Details => "read.queue.details",
        }
    }
}
#[derive(Clone)]
pub struct Metrics {
    measurements: Measurements,
    active: Arc<AtomicUsize>,
}
impl Metrics {
    pub fn new(measurements: Measurements) -> Self {
        Self {
            measurements,
            active: Arc::new(AtomicUsize::new(0)),
        }
    }
}
#[derive(Clone)]
pub struct ReadMeasurement {
    measurements: Measurements,
    route: Route,
    concurrency: usize,
}
impl ReadMeasurement {
    pub fn queue(&self) -> Observation {
        self.measurements
            .observe(self.route.queue(), self.concurrency)
    }
}
struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}
/// Measures auth, validation, waiting, reading and encoding until a response is ready.
/// It deliberately excludes socket transfer time and observes auth failures too.
pub async fn measure(State(metrics): State<Metrics>, mut request: Request, next: Next) -> Response {
    let Some(route) = Route::classify(&request) else {
        return next.run(request).await;
    };
    let concurrency = metrics.active.fetch_add(1, Ordering::Relaxed) + 1;
    let _active = Active(metrics.active.clone());
    let observation = metrics.measurements.observe(route.http(), concurrency);
    request.extensions_mut().insert(ReadMeasurement {
        measurements: metrics.measurements.clone(),
        route,
        concurrency,
    });
    let response = next.run(request).await;
    let status = response.status();
    observation.finish(if status == StatusCode::SERVICE_UNAVAILABLE {
        Outcome::Unavailable
    } else if status.is_server_error() {
        Outcome::Error
    } else if status.is_client_error() {
        Outcome::ClientError
    } else {
        Outcome::Success
    });
    response
}
