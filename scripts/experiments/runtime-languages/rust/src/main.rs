mod model;

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::{
    fs::PermissionsExt,
    net::{UnixListener, UnixStream},
};

#[derive(Serialize)]
struct Response {
    protocol: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<model::Catalog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}
fn handle(mut stream: UnixStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    loop {
        let mut line = Vec::new();
        // All experiment clients send bounded lines; this is not a production server.
        if reader.read_until(b'\n', &mut line).unwrap_or(0) == 0 || line.len() > 1024 * 1024 {
            return;
        }
        let (catalog, error) = match serde_json::from_slice::<serde_json::Value>(&line) {
            Ok(input) => match model::parse(&input) {
                Some(c) => (Some(c), None),
                None => (None, Some("empty_catalog")),
            },
            Err(_) => (None, Some("invalid_json")),
        };
        let response = Response {
            protocol: catalog_contract::PROTOCOL,
            catalog,
            error,
        };
        // Serialize before writing, as Go's Encoder and Node's stringify do.
        // Otherwise the comparison measures one syscall per JSON token in Rust.
        let mut encoded = serde_json::to_vec(&response).unwrap();
        encoded.push(b'\n');
        if stream.write_all(&encoded).is_err() {
            return;
        }
    }
}
fn main() {
    let path = std::env::args().nth(1).expect("socket path");
    let listener = UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    println!("ready");
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                std::thread::spawn(|| handle(s));
            }
            Err(_) => return,
        }
    }
}
