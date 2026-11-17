//! Shared HTTP mechanics for the opt-in public read listener.
use axum::{
    Json,
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;

pub fn error(status: StatusCode, message: &str, code: Option<&str>) -> Response {
    let mut body = json!({"error":message});
    if let Some(code) = code {
        body["code"] = json!(code);
    }
    (status, Json(body)).into_response()
}
pub fn decode_path(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    for (i, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
        {
            return None;
        }
    }
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|text| text.into_owned())
}
pub fn headers(response: &mut Response, origin: &str) {
    let headers = response.headers_mut();
    for (key, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("x-palmagent-version", env!("PALMAGENT_PRODUCT_VERSION")),
    ] {
        headers.insert(key, HeaderValue::from_static(value));
    }
    let websocket = origin
        .parse::<axum::http::Uri>()
        .ok()
        .and_then(|uri| {
            uri.authority()
                .map(|authority| format!("wss://{authority}"))
        })
        .unwrap_or_default();
    let policy = format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' {websocket} https://api.openai.com; media-src 'self' data: blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    );
    if let Ok(value) = HeaderValue::from_str(&policy) {
        headers.insert("content-security-policy", value);
    }
}
