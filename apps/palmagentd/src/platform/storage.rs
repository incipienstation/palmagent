use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::contract::{Configuration, HostRecord, Kind, PROTOCOL};

pub fn private_directory(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    private_path(path, false)?;
    ensure!(
        fs::symlink_metadata(path)?.is_dir(),
        "Expected a private directory"
    );
    Ok(())
}

use std::os::unix::fs::DirBuilderExt;

pub fn private_path(path: &Path, file: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "Private paths must not be symlinks"
    );
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0,
        "Runtime state must be private and owned by the installation user"
    );
    if file {
        ensure!(metadata.is_file(), "Expected a private regular file");
    }
    Ok(())
}

pub fn read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    private_path(path, true)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    ensure!(
        file.metadata()?.len() <= 1024 * 1024,
        "Runtime record is too large"
    );
    Ok(serde_json::from_reader(file)?)
}

pub fn atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().context("Missing state directory")?;
    private_directory(parent)?;
    let temporary = parent.join(format!(".{}.tmp", unique_id()?));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn unique_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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
    private_path(path, true)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("Runtime ownership is already held");
    }
    Ok(file)
}

pub fn state_directory(data: &Path) -> PathBuf {
    data.join("daemon")
}

pub fn socket_path(data: &Path) -> Result<PathBuf> {
    let hash = format!("{:x}", Sha256::digest(data.as_os_str().as_encoded_bytes()));
    let root = PathBuf::from(format!(
        "/tmp/palmagentd-{}-{}",
        unsafe { libc::geteuid() },
        &hash[..20]
    ));
    private_directory(&root)?;
    Ok(root.join("control.sock"))
}

pub fn host_path(data: &Path, kind: Kind, id: &str) -> Result<PathBuf> {
    ensure!(
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == b'-'),
        "Invalid host identity"
    );
    Ok(state_directory(data)
        .join("hosts")
        .join(format!("{}-{id}.json", kind.name())))
}

pub fn write_host(data: &Path, record: &HostRecord) -> Result<()> {
    atomic(&host_path(data, record.kind, &record.id)?, record)
}

pub fn configuration(data: &Path) -> Result<Configuration> {
    let config: Configuration = read(&state_directory(data).join("config.json"))?;
    ensure!(config.protocol == PROTOCOL, "Unsupported daemon protocol");
    retained(&config.release, &data.join("releases"))?;
    retained(&config.node, &data.join("runtimes"))?;
    retained(&config.daemon, &data.join("releases"))?;
    ensure!(
        config.daemon.is_file() && config.node.is_file() && config.release.is_dir(),
        "Runtime artifacts are missing"
    );
    ensure!(
        config.limits.tasks > 0
            && config.limits.web_tasks > 0
            && config.limits.nofile > 0
            && config.limits.cpu_percent > 0
            && config.limits.memory_max >= config.limits.memory_high,
        "Invalid resource limits"
    );
    Ok(config)
}

pub fn retained(path: &Path, root: &Path) -> Result<PathBuf> {
    let resolved = fs::canonicalize(path)?;
    let root = fs::canonicalize(root)?;
    ensure!(
        resolved != root && resolved.starts_with(root),
        "Artifact is outside the installation's retained tree"
    );
    Ok(resolved)
}

pub fn log_file(data: &Path, name: &str) -> Result<File> {
    let directory = state_directory(data).join("logs");
    private_directory(&directory)?;
    let path = directory.join(format!("{name}.log"));
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        private_path(&path, true)?;
        if metadata.len() > 4 * 1024 * 1024 {
            fs::rename(&path, directory.join(format!("{name}.previous.log")))?;
        }
    }
    Ok(OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?)
}

pub fn set_private(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}
