//! OS integration is selected here. The supervisor does not invoke a service manager.
//! New platforms implement process identity, isolation, transport and startup separately.
use anyhow::Result;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

use crate::contract::{Configuration, HostRecord, Identity, Kind};

mod linux;
pub mod storage;
// Local transport is selected with the platform adapter.
pub use linux::Linux as NativePlatform;
pub use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};

pub trait ProcessControl {
    fn replace(binary: &Path, data: &Path) -> Result<()>;
    fn stop_flag() -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>>;
    fn identity(pid: u32) -> Result<Option<Identity>>;
    fn signal(identity: &Identity, force: bool) -> Result<()>;
    fn detach(command: &mut Command);
    fn subreaper() -> Result<()>;
    fn reap();
}

pub trait ProcessIsolation {
    fn initialize(data: &Path, config: &Configuration) -> Result<Option<PathBuf>>;
    fn create_group(root: Option<&Path>, kind: Kind, id: &str) -> Result<Option<PathBuf>>;
    fn contain(command: &mut Command, record: &HostRecord) -> Result<()>;
    fn populated(record: &HostRecord) -> Result<bool>;
    fn terminate(record: &HostRecord) -> Result<()>;
    fn remove_group(record: &HostRecord) -> Result<()>;
}

pub trait Autostart {
    fn render(data: &Path, launcher: &Path, user: &str, group: &str) -> Result<String>;
}

pub fn alive(identity: &Identity) -> Result<bool> {
    Ok(NativePlatform::identity(identity.pid)?
        .is_some_and(|current| current.start == identity.start))
}
