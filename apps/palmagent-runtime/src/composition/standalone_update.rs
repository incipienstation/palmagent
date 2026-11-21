use crate::modules::installation::application::{self, Host, Operation};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

pub fn run() -> Result<()> {
    let mut port = Pipe {
        input: io::stdin().lock(),
        output: io::stdout().lock(),
    };
    let request = port.receive()?;
    let outcome = application::update(&mut port, request);
    port.send(&match outcome {
        Ok(done) => json!({"done":done}),
        Err(error) => json!({"error":error.to_string()}),
    })
}
struct Pipe<R, W> {
    input: R,
    output: W,
}
impl<R: BufRead, W: Write> Pipe<R, W> {
    fn receive<T: DeserializeOwned>(&mut self) -> Result<T> {
        let mut frame = Vec::new();
        std::io::Read::take(&mut self.input, 65537).read_until(b'\n', &mut frame)?;
        ensure!(
            frame.len() <= 65536 && frame.last() == Some(&b'\n'),
            "Incomplete update response"
        );
        Ok(serde_json::from_slice(&frame)?)
    }
    fn send(&mut self, frame: &impl serde::Serialize) -> Result<()> {
        serde_json::to_writer(&mut self.output, frame)?;
        self.output.write_all(b"\n")?;
        self.output.flush()?;
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Reply {
    Success { value: Value },
    Failure { error: String },
}
impl<R: BufRead, W: Write> Host for Pipe<R, W> {
    fn call(&mut self, op: Operation<'_>) -> Result<Value> {
        self.send(&op)?;
        match self.receive().context("Update host disconnected")? {
            Reply::Success { value } => Ok(value),
            Reply::Failure { error } => bail!("{error}"),
        }
    }
}
