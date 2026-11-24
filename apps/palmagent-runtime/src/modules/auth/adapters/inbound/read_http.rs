//! Public read admission uses the same committed sessions as the Node login owner.
use crate::modules::auth::api::SessionReader;
use crate::platform::{
    now,
    read_http::{decode_path, error, headers},
};
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Client {
    pub enabled: bool,
    pub cookie_name: String,
    pub ttl_ms: i64,
    pub origin: String,
    reader: Arc<Mutex<Box<dyn SessionReader>>>,
}
impl Client {
    pub fn new(
        enabled: bool,
        cookie_name: String,
        ttl_ms: i64,
        origin: String,
        reader: Box<dyn SessionReader>,
    ) -> Self {
        Self {
            enabled,
            cookie_name,
            ttl_ms,
            origin,
            reader: Arc::new(Mutex::new(reader)),
        }
    }
}
fn cookie(request: &Request, name: &str) -> Option<String> {
    // Preserve first-cookie behavior and percent decoding used by Hono.
    request
        .headers()
        .get_all("cookie")
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|part| {
            let (key, value) = part.trim_matches([' ', '\t']).split_once('=')?;
            if key.trim_matches([' ', '\t']) != name {
                return None;
            }
            let value = value.trim_matches([' ', '\t']);
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value);
            if !value
                .bytes()
                .all(|byte| matches!(byte, b' ' | b'!' | b'#'..=b':' | b'<'..=b'[' | b']'..=b'~'))
            {
                return None;
            }
            Some(decode_path(value).unwrap_or_else(|| value.to_owned()))
        })
}
async fn admit(client: &Client, request: Request) -> Result<Request, Response> {
    if client.enabled && request.uri().path().starts_with("/api/") {
        if !matches!(request.method().as_str(), "GET" | "HEAD" | "OPTIONS")
            && !request
                .headers()
                .get_all("origin")
                .iter()
                .map(|v| v.as_bytes())
                .eq([client.origin.as_bytes()])
        {
            return Err(error(
                StatusCode::FORBIDDEN,
                "Same-origin request required",
                None,
            ));
        }
        let token = cookie(&request, &client.cookie_name)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized", None))?;
        let reader = client.reader.clone();
        let ttl = client.ttl_ms;
        let valid = tokio::task::spawn_blocking(move || {
            reader
                .lock()
                .map_err(|_| anyhow::anyhow!("Session reader failed"))?
                .valid(&token, now(), ttl)
        })
        .await;
        match valid {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => return Err(error(StatusCode::UNAUTHORIZED, "unauthorized", None)),
            _ => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Authentication is temporarily unavailable",
                    Some("service_unavailable"),
                ));
            }
        }
    }
    // Only explicitly mounted mutation routes carry a matched path on this listener.
    let mut versions = request.headers().get_all("x-palmagent-version").iter();
    if request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .is_some()
        && matches!(request.method().as_str(), "POST" | "PATCH" | "DELETE")
        && versions.next().is_some_and(|v| {
            versions.next().is_some()
                || (!v.is_empty() && v.as_bytes() != env!("PALMAGENT_PRODUCT_VERSION").as_bytes())
        })
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Palmagent was updated. Refresh the app before making changes.",
            Some("update-required"),
        ));
    }
    if request.method() == "HEAD" {
        return Err(error(StatusCode::NOT_FOUND, "not found", None));
    }
    if decode_path(request.uri().path()).is_none() {
        return Err(error(StatusCode::BAD_REQUEST, "invalid URL encoding", None));
    }
    if request
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > 1024 * 1024)
    {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body too large",
            None,
        ));
    }
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 1024 * 1024).await.map_err(|_| {
        error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body too large",
            None,
        )
    })?;
    Ok(Request::from_parts(parts, Body::from(bytes)))
}
pub async fn authenticate(State(client): State<Client>, request: Request, next: Next) -> Response {
    let mut response = match admit(&client, request).await {
        Ok(request) => next.run(request).await,
        Err(response) => response,
    };
    headers(&mut response, &client.origin);
    response
}
