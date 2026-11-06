//! Protocol-compatible retained host for one admitted script invocation.
use crate::{
    modules::routines::{
        application::retained::{self, Host, Outcome},
        domain::Script,
    },
    platform::{self, script_process},
};
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    protocol: u32,
    id: String,
    run_id: u64,
    routine_id: String,
    directory: PathBuf,
    release: PathBuf,
    node: PathBuf,
    cwd: PathBuf,
    worktree_path: Option<PathBuf>,
    script: Script,
}
fn stopped(path: &Path) -> Result<Option<String>> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(Some(platform::read(path)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
pub fn run(directory: &Path, id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid routine host identity"
    );
    platform::directory(directory)?;
    let mut descriptor: Descriptor = platform::read(&directory.join(format!("{id}.json")))?;
    ensure!(
        descriptor.protocol == 1
            && descriptor.id == id
            && descriptor.run_id > 0
            && descriptor.run_id <= 9_007_199_254_740_991
            && format!("{:x}", descriptor.run_id) == id
            && descriptor.directory == directory
            && !descriptor.routine_id.is_empty()
            && descriptor.release.is_absolute()
            && descriptor.node.is_absolute(),
        "Routine host identity mismatch"
    );
    descriptor.script.validate().map_err(anyhow::Error::msg)?;
    script_process::host_signals()?;
    retained::run(&mut Files {
        directory: directory.to_owned(),
        id: id.to_owned(),
        descriptor,
    })
}
struct Files {
    directory: PathBuf,
    id: String,
    descriptor: Descriptor,
}
impl Host for Files {
    fn claim(&mut self) -> Result<bool> {
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.directory.join(format!("{}.claim", self.id)))
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        file.write_all(b"claimed\n")?;
        file.sync_all()?;
        File::open(&self.directory)?.sync_all()?;
        Ok(true)
    }
    fn stop_reason(&self) -> Result<Option<String>> {
        stopped(&self.directory.join(format!("{}.stop", self.id)))
    }
    fn execute(&mut self) -> Result<Outcome> {
        let result = script_process::execute(
            &self.descriptor.cwd,
            &self.descriptor.script.command,
            Duration::from_secs(self.descriptor.script.timeout_seconds),
            || self.stop_reason(),
            platform::ready,
        )?;
        Ok(Outcome {
            code: result.code,
            reason: result.reason,
            output: result.output,
        })
    }
    fn now(&self) -> i64 {
        platform::now()
    }
    fn persist(&mut self, result: &Value) -> Result<()> {
        let mut result = result.clone();
        if let Some(path) = &self.descriptor.worktree_path {
            result["worktreePath"] = json!(path);
        }
        platform::atomic(
            &self.directory.join(format!("{}.result", self.id)),
            &result,
            false,
        )
    }
    fn wait_for_storage(&self) {
        std::thread::sleep(Duration::from_secs(1));
    }
}
