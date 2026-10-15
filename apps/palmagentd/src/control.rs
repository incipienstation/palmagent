//! Bounded, nonblocking control connections. Lifecycle ownership stays in the supervisor.
use std::{
    io::{self, Read, Write},
    time::{Duration, Instant},
};

use anyhow::{Result, ensure};
use serde_json::Value;

use crate::{
    contract::{PROTOCOL, Reply, Request},
    platform::Stream,
};

const MAX_FRAME: usize = 65_536;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(35);

pub struct Connection {
    pub id: u64,
    stream: Stream,
    phase: Phase,
}

enum Phase {
    Reading(Vec<u8>, Instant),
    Waiting(Option<Request>, Instant),
    Writing(Vec<u8>, usize, Instant),
    Closed,
}

impl Connection {
    pub fn new(id: u64, stream: Stream) -> Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(Self {
            id,
            stream,
            phase: Phase::Reading(Vec::new(), Instant::now() + IO_TIMEOUT),
        })
    }

    pub fn request(&self) -> Option<&Request> {
        match &self.phase {
            Phase::Waiting(request, _) => request.as_ref(),
            _ => None,
        }
    }

    pub fn take_request(&mut self) -> Option<Request> {
        match &mut self.phase {
            Phase::Waiting(request, _) => request.take(),
            _ => None,
        }
    }

    pub fn reply(&mut self, result: Result<Value>) {
        if self.closed() {
            return;
        }
        let mut bytes = serde_json::to_vec(&Reply::from_result(result))
            .expect("Daemon replies contain only JSON values");
        if bytes.len() >= MAX_FRAME {
            bytes = serde_json::to_vec(&Reply::from_result(Err(anyhow::anyhow!(
                "Daemon response is too large"
            ))))
            .expect("Error reply is serializable");
        }
        bytes.push(b'\n');
        self.phase = Phase::Writing(bytes, 0, Instant::now() + IO_TIMEOUT);
    }

    pub fn closed(&self) -> bool {
        matches!(self.phase, Phase::Closed)
    }

    pub fn poll(&mut self) {
        if let Err(error) = self.advance() {
            // Invalid or incomplete requests never mutate state. A disconnected client
            // does not cancel an already accepted lifecycle operation.
            self.reply(Err(error));
        }
    }

    fn advance(&mut self) -> Result<()> {
        match &mut self.phase {
            Phase::Reading(input, deadline) => {
                ensure!(
                    Instant::now() < *deadline,
                    "Daemon request deadline exceeded"
                );
                let mut chunk = [0u8; 4096];
                loop {
                    let count = match self.stream.read(&mut chunk) {
                        Ok(0) => {
                            self.phase = Phase::Closed;
                            return Ok(());
                        }
                        Ok(count) => count,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => {
                            self.phase = Phase::Closed;
                            return Ok(());
                        }
                    };
                    let end = chunk[..count].iter().position(|byte| *byte == b'\n');
                    input.extend_from_slice(&chunk[..end.map_or(count, |index| index + 1)]);
                    ensure!(input.len() <= MAX_FRAME, "Daemon request is too large");
                    if end.is_some() {
                        let envelope: Value = serde_json::from_slice(input)?;
                        ensure!(
                            envelope["protocol"] == PROTOCOL,
                            "Incompatible daemon protocol"
                        );
                        let request = serde_json::from_value(envelope["request"].clone())?;
                        self.phase =
                            Phase::Waiting(Some(request), Instant::now() + REQUEST_TIMEOUT);
                        return Ok(());
                    }
                }
            }
            Phase::Waiting(_, deadline) => {
                if Instant::now() >= *deadline {
                    self.phase = Phase::Closed;
                }
            }
            Phase::Writing(output, written, deadline) => {
                if Instant::now() >= *deadline {
                    self.phase = Phase::Closed;
                    return Ok(());
                }
                while *written < output.len() {
                    match self.stream.write(&output[*written..]) {
                        Ok(0) => break,
                        Ok(count) => *written += count,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                self.phase = Phase::Closed;
            }
            Phase::Closed => {}
        }
        Ok(())
    }
}
