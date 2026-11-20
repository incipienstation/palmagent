use anyhow::{Context, Result, bail, ensure};
use flate2::read::MultiGzDecoder;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions, Permissions},
    io::{self, Read, Seek},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

fn regular(path: &Path) -> Result<File> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    ensure!(f.metadata()?.is_file(), "Expected a regular release file");
    Ok(f)
}

fn hash(mut source: impl Read) -> Result<String> {
    let mut digest = Sha256::new();
    io::copy(&mut source, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn same_bytes(mut file: File, archive: &mut impl Read) -> Result<bool> {
    let mut actual = [0; 32 * 1024];
    let mut expected = [0; 32 * 1024];
    loop {
        let n = archive.read(&mut expected)?;
        if n == 0 {
            return Ok(file.read(&mut actual)? == 0);
        }
        file.read_exact(&mut actual[..n])?;
        if actual[..n] != expected[..n] {
            return Ok(false);
        }
    }
}

fn inventory(root: &Path) -> Result<HashSet<PathBuf>> {
    let mut names = HashSet::new();
    let mut pending = vec![PathBuf::from("palmagent")];
    while let Some(name) = pending.pop() {
        let path = root.join(&name);
        let kind = path.symlink_metadata()?.file_type();
        names.insert(name.clone());
        if kind.is_dir() {
            for child in fs::read_dir(path)? {
                ensure!(
                    pending.len() + names.len() < 100_000,
                    "Excessive retained entries"
                );
                pending.push(name.join(child?.file_name()));
            }
        } else {
            ensure!(kind.is_file(), "Unexpected retained file type");
        }
    }
    Ok(names)
}

// A retained directory is authenticated against the same signed archive as a fresh
// extraction. A writable local index or selection receipt is insufficient evidence.
fn materialize(file: File, root: &Path, retained: bool, limit: u64) -> Result<()> {
    let mut remaining = if retained {
        inventory(root)?
    } else {
        HashSet::new()
    };
    let mut seen = HashSet::new();
    let mut bytes = 0u64;
    let mut dirs = Vec::new();
    let mut archive = tar::Archive::new(MultiGzDecoder::new(file));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let raw = entry.path_bytes();
        let raw_name = std::str::from_utf8(&raw)?;
        let name = raw_name.strip_suffix('/').unwrap_or(raw_name);
        ensure!(
            (name == "palmagent" || name.starts_with("palmagent/"))
                && !name.bytes().any(|c| c == b'\\' || c < 32 || c == 127)
                && name.split('/').all(|p| !matches!(p, "" | "." | "..")),
            "Unsafe release entry"
        );
        let name = PathBuf::from(name);
        ensure!(
            seen.len() < 100_000 && seen.insert(name.clone()),
            "Duplicate or excessive release entries"
        );
        let mode = entry.header().mode()?;
        let kind = entry.header().entry_type();
        ensure!(
            mode & 0o6000 == 0 && (kind.is_dir() || kind.is_file()),
            "Unsupported release entry"
        );
        bytes = bytes
            .checked_add(entry.size())
            .context("Release size overflow")?;
        ensure!(bytes <= limit, "Release exceeds signed unpacked size");
        let path = root.join(&name);
        if retained {
            for parent in name.ancestors() {
                remaining.remove(parent);
            }
            let meta = path.symlink_metadata()?;
            if kind.is_dir() {
                ensure!(meta.is_dir(), "Retained directory changed");
            } else {
                ensure!(
                    meta.is_file()
                        && meta.len() == entry.size()
                        && meta.permissions().mode() & 0o777 == mode & 0o777
                        && same_bytes(regular(&path)?, &mut entry)?,
                    "Retained release file changed"
                );
            }
        } else if kind.is_dir() {
            fs::create_dir_all(&path)?;
            dirs.push((path, mode));
        } else {
            fs::create_dir_all(path.parent().context("Missing release parent")?)?;
            let mut out = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)?;
            let count = io::copy(&mut entry, &mut out)?;
            ensure!(count == entry.size(), "Truncated release file");
            out.set_permissions(Permissions::from_mode(mode & 0o777))?;
        }
    }
    for required in [
        "palmagent/runtime/bin/node",
        "palmagent/app/package.json",
        "palmagent/bundle.json",
    ] {
        ensure!(
            seen.contains(Path::new(required)) && root.join(required).symlink_metadata()?.is_file(),
            "Incomplete release"
        );
    }
    ensure!(remaining.is_empty(), "Unexpected retained release entries");
    for (path, mode) in dirs.into_iter().rev() {
        fs::set_permissions(path, Permissions::from_mode(mode & 0o777))?;
    }
    Ok(())
}

pub fn prepare(args: &[String]) -> Result<()> {
    let [staging, directory, url, digest, size, unpacked] = args else {
        bail!("Invalid release file arguments")
    };
    let size: u64 = size.parse()?;
    let unpacked: u64 = unpacked.parse()?;
    ensure!(
        size > 0 && size <= 512 << 20 && unpacked > 0 && unpacked <= 2 << 30,
        "Invalid artifact limits"
    );
    let staging = Path::new(staging);
    let directory = Path::new(directory);
    let retained = directory.try_exists()?;
    if retained {
        ensure!(
            directory.symlink_metadata()?.is_dir(),
            "Invalid retained release directory"
        );
    }
    let cache = directory.join("release.tar.gz");
    let download = staging.join("release.tar.gz");
    let cached = retained && cache.try_exists()?;
    let source = if cached { &cache } else { &download };
    if !cached {
        let start = Instant::now();
        let status = Command::new("curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--connect-timeout",
                "10",
                "--max-time",
                "600",
                "--max-filesize",
                &size.to_string(),
                "--output",
            ])
            .arg(source)
            .args(["--url", url])
            .status()?;
        ensure!(status.success(), "Standalone download failed");
        eprintln!("[update] download {}ms", start.elapsed().as_millis());
    }
    let start = Instant::now();
    let mut file = regular(source)?;
    ensure!(
        file.metadata()?.len() == size && hash(&mut file)? == *digest,
        "Release archive checksum or size mismatch"
    );
    eprintln!("[update] checksum {}ms", start.elapsed().as_millis());
    file.rewind()?;
    let start = Instant::now();
    materialize(
        file,
        if retained { directory } else { staging },
        retained,
        unpacked,
    )?;
    eprintln!(
        "[update] {} {}ms",
        if retained {
            "retained-files"
        } else {
            "extract"
        },
        start.elapsed().as_millis()
    );
    if retained && !cached {
        fs::rename(download, cache)?;
    }
    Ok(())
}
