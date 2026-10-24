//! Linux adapters for private state, daemon control and the installation's local calendar.
use anyhow::{Context, Result, ensure};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
        net::UnixStream,
    },
    path::{Path, PathBuf},
    time::Duration,
};

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn unique_id() -> Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn private(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        !meta.file_type().is_symlink()
            && meta.uid() == unsafe { libc::geteuid() }
            && meta.mode() & 0o077 == 0,
        "Runtime state must be private and owned by the installation user"
    );
    Ok(())
}
pub fn directory(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    private(path)?;
    ensure!(path.is_dir(), "Expected a private directory");
    Ok(())
}
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    private(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= 1_048_576,
        "Invalid runtime record"
    );
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn atomic(path: &Path, value: &impl Serialize, exclusive: bool) -> Result<()> {
    let parent = path.parent().context("Missing parent directory")?;
    directory(parent)?;
    let temporary = parent.join(format!(".{}.tmp", unique_id()?));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        if exclusive {
            fs::hard_link(&temporary, path)?;
        } else {
            fs::rename(&temporary, path)?;
        }
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
pub fn lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    private(path)?;
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "Runtime ownership is already held"
    );
    Ok(file)
}
pub fn socket(data: &Path) -> Result<PathBuf> {
    let hash = format!("{:x}", Sha256::digest(data.as_os_str().as_encoded_bytes()));
    let root = PathBuf::from(format!(
        "/tmp/palmagentd-{}-{}",
        unsafe { libc::geteuid() },
        &hash[..20]
    ));
    directory(&root)?;
    Ok(root.join("application.sock"))
}
pub fn daemon(data: &Path, request: Value) -> Result<Value> {
    let path = socket(data)?.with_file_name("control.sock");
    private(&path)?;
    let mut stream = UnixStream::connect(&path)?;
    stream.set_read_timeout(Some(Duration::from_secs(35)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    serde_json::to_writer(&mut stream, &json!({"protocol":1,"request":request}))?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(stream).take(65_537).read_line(&mut line)?;
    ensure!(
        line.len() <= 65_536 && line.ends_with('\n'),
        "Invalid daemon response"
    );
    let reply: Value = serde_json::from_str(&line)?;
    ensure!(
        reply["protocol"] == 1 && reply["ok"] == true,
        "Daemon operation was not confirmed"
    );
    Ok(reply["result"].clone())
}
pub fn identity(pid: u32) -> Result<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let start = stat[stat.rfind(')').context("Invalid process identity")? + 2..]
        .split_whitespace()
        .nth(19)
        .context("Missing process start")?;
    Ok(format!(
        "{}:{start}",
        fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim()
    ))
}
pub fn ready() -> Result<()> {
    if let Some(path) = std::env::var_os("PALMAGENT_HOST_READY") {
        atomic(
            Path::new(&path),
            &json!({"pid":std::process::id(),"start":identity(std::process::id())?,"readyAt":now()}),
            false,
        )?;
    }
    Ok(())
}
pub fn maintenance(db: &Path) -> bool {
    let path = db.with_file_name("update-maintenance.json");
    if !path.exists() {
        return false;
    }
    let Ok(value) = read::<Value>(&path) else {
        return true;
    };
    let Some(pid) = value["pid"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
    else {
        return true;
    };
    if value["schemaVersion"] != 1 {
        return true;
    }
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        return std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    }
    match (value["identity"].as_str(), identity(pid as u32)) {
        (Some(expected), Ok(actual)) => expected == actual,
        _ => true,
    }
}

pub fn secure_socket(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    private(path)
}
