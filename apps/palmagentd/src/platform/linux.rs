use anyhow::{Context, Result, bail, ensure};
use std::{
    fs::{self, OpenOptions},
    io,
    os::unix::{io::AsRawFd, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};

use super::{Autostart, ProcessControl, ProcessIsolation};
use crate::{
    contract::{Configuration, HostRecord, Identity, Isolation, Kind},
    storage,
};

pub struct Linux;

impl ProcessControl for Linux {
    fn replace(binary: &Path, data: &Path) -> Result<()> {
        Err(Command::new(binary)
            .args(["serve", "--data-dir"])
            .arg(data)
            .exec()
            .into())
    }

    fn stop_flag() -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        for signal in [libc::SIGTERM, libc::SIGINT] {
            signal_hook::flag::register(signal, flag.clone())?;
        }
        Ok(flag)
    }

    fn identity(pid: u32) -> Result<Option<Identity>> {
        ensure!(pid > 1, "Invalid process identity");
        let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("Cannot inspect process ownership"),
        };
        let (_, suffix) = stat.rsplit_once(')').context("Invalid process record")?;
        let fields: Vec<_> = suffix.split_whitespace().collect();
        ensure!(fields.len() > 19, "Incomplete process record");
        if fields[0] == "Z" || fields[0] == "X" {
            return Ok(None);
        }
        let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
        Ok(Some(Identity {
            pid,
            start: format!("{}:{}", boot.trim(), fields[19]),
        }))
    }

    fn signal(identity: &Identity, force: bool) -> Result<()> {
        // A pidfd binds the signal to the inspected process even if the PID is recycled.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, identity.pid, 0) as i32 };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(error).context("Cannot open process identity");
        }
        let result = (|| {
            if !super::alive(identity)? {
                return Ok(());
            }
            let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
            if unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd,
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            } < 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error.into());
                }
            }
            Ok(())
        })();
        unsafe {
            libc::close(fd);
        }
        result
    }

    fn detach(command: &mut Command) {
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    fn subreaper() -> Result<()> {
        ensure!(
            unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0,
            "Cannot become a child subreaper"
        );
        Ok(())
    }

    fn reap() {
        while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {}
    }
}

fn checked_group(path: &Path) -> Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    ensure!(
        path.starts_with("/sys/fs/cgroup") && path != Path::new("/sys/fs/cgroup"),
        "Invalid delegated cgroup"
    );
    Ok(path)
}

impl ProcessIsolation for Linux {
    fn initialize(data: &Path, config: &Configuration) -> Result<Option<PathBuf>> {
        if config.isolation == Isolation::ProcessGroup {
            return Ok(None);
        }
        let membership = fs::read_to_string("/proc/self/cgroup")?;
        let relative = membership
            .lines()
            .find_map(|line| line.strip_prefix("0::"))
            .context("cgroup v2 is required")?;
        let mut root = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
        if root.file_name().is_some_and(|name| name == "control") {
            root.pop();
        }
        let root = checked_group(&root)?;
        let members = fs::read_to_string(root.join("cgroup.procs"))?;
        ensure!(
            members
                .split_whitespace()
                .all(|pid| pid == std::process::id().to_string()),
            "The bootstrap must delegate a dedicated cgroup"
        );
        let control = root.join("control");
        fs::create_dir_all(&control)?;
        fs::write(control.join("cgroup.procs"), std::process::id().to_string())?;
        let controllers = fs::read_to_string(root.join("cgroup.controllers"))?;
        for controller in ["memory", "cpu", "pids"] {
            ensure!(
                controllers
                    .split_whitespace()
                    .any(|value| value == controller),
                "The bootstrap must delegate memory, cpu and pids controllers"
            );
        }
        fs::write(root.join("cgroup.subtree_control"), "+memory +cpu +pids")?;
        for kind in [Kind::Execution, Kind::Terminal, Kind::Web, Kind::Update] {
            let group = root.join(kind.directory());
            fs::create_dir_all(&group)?;
            if matches!(kind, Kind::Execution | Kind::Terminal) {
                fs::write(
                    group.join("memory.high"),
                    config.limits.memory_high.to_string(),
                )?;
                fs::write(
                    group.join("memory.max"),
                    config.limits.memory_max.to_string(),
                )?;
                fs::write(group.join("pids.max"), config.limits.tasks.to_string())?;
                fs::write(
                    group.join("cpu.max"),
                    format!(
                        "{} 100000",
                        config
                            .limits
                            .cpu_percent
                            .checked_mul(1000)
                            .context("Invalid CPU quota")?
                    ),
                )?;
            } else if kind == Kind::Web {
                fs::write(group.join("pids.max"), config.limits.web_tasks.to_string())?;
            }
            fs::write(group.join("cgroup.subtree_control"), "+memory +cpu +pids")?;
        }
        storage::atomic(
            &storage::state_directory(data).join("platform.json"),
            &serde_json::json!({ "cgroup": root }),
        )?;
        Ok(Some(root))
    }

    fn create_group(root: Option<&Path>, kind: Kind, id: &str) -> Result<Option<PathBuf>> {
        let Some(root) = root else {
            return Ok(None);
        };
        let group = checked_group(root)?.join(kind.directory()).join(id);
        fs::create_dir(&group).context("Host cgroup already exists or cannot be created")?;
        ensure!(
            group.join("cgroup.kill").exists(),
            "This kernel must support cgroup.kill"
        );
        Ok(Some(group))
    }

    fn contain(command: &mut Command, record: &HostRecord) -> Result<()> {
        let group_file = record
            .group
            .as_ref()
            .map(|group| -> Result<_> {
                Ok(OpenOptions::new()
                    .write(true)
                    .open(checked_group(group)?.join("cgroup.procs"))?)
            })
            .transpose()?;
        let group_fd = group_file.as_ref().map(AsRawFd::as_raw_fd);
        let nofile = record.nofile;
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                let limit = libc::rlimit {
                    rlim_cur: nofile,
                    rlim_max: nofile,
                };
                if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                    return Err(io::Error::last_os_error());
                }
                // Writing 0 moves this child before exec and before it can fork descendants.
                if let Some(fd) = group_fd
                    && libc::write(fd, b"0".as_ptr().cast(), 1) != 1
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        // Command::spawn runs pre_exec before returning. Keep the cgroup fd alive until then.
        // Store it in an extra pre_exec closure whose captured File is dropped with Command.
        if let Some(file) = group_file {
            unsafe {
                command.pre_exec(move || {
                    let _ = file.as_raw_fd();
                    Ok(())
                });
            }
        }
        Ok(())
    }

    fn populated(record: &HostRecord) -> Result<bool> {
        if let Some(group) = &record.group {
            if !group.exists() {
                return Ok(false);
            }
            let events = fs::read_to_string(checked_group(group)?.join("cgroup.events"))?;
            return Ok(events.lines().any(|line| line == "populated 1"));
        }
        // Portable development mode has process-group semantics, not cgroup containment.
        if let Some(child) = &record.child {
            if super::alive(child)? {
                return Ok(true);
            }
            let result = unsafe { libc::kill(-(child.pid as i32), 0) };
            if result == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        Ok(false)
    }

    fn terminate(record: &HostRecord) -> Result<()> {
        if let Some(group) = &record.group {
            if group.exists() {
                fs::write(checked_group(group)?.join("cgroup.kill"), "1")?;
            }
            return Ok(());
        }
        if let Some(child) = &record.child {
            // A living guardian owns the process group until cleanup. Never signal a stale group.
            if !record
                .guard
                .as_ref()
                .is_some_and(|guard| super::alive(guard).unwrap_or(false))
            {
                bail!("Cannot confirm process-group ownership; retaining the host");
            }
            if unsafe { libc::kill(-(child.pid as i32), libc::SIGKILL) } < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }

    fn remove_group(record: &HostRecord) -> Result<()> {
        if let Some(group) = &record.group
            && group.exists()
        {
            fs::remove_dir(checked_group(group)?)?;
        }
        Ok(())
    }
}

impl Autostart for Linux {
    fn render(data: &Path, launcher: &Path, user: &str, group: &str) -> Result<String> {
        ensure!(
            !user.is_empty()
                && user != "root"
                && [user, group].iter().all(|value| !value.is_empty()
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))),
            "Invalid installation owner"
        );
        fn quote(path: &Path) -> Result<String> {
            let value = path.to_str().context("Invalid bootstrap path")?;
            ensure!(
                path.is_absolute() && !value.chars().any(char::is_control),
                "Bootstrap paths must be absolute without control characters"
            );
            Ok(format!(
                "\"{}\"",
                value
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
                    .replace('$', "$$")
            ))
        }
        Ok(format!(
            "# Generated by Palmagent. Product updates do not rewrite this bootstrap.\n[Unit]\nDescription=Palmagent runtime supervisor\nAfter=network.target\n\n[Service]\nType=exec\nUser={user}\nGroup={group}\nExecStart={} start-current --data-dir {}\nRestart=on-failure\nRestartSec=2\nDelegate=cpu memory pids\nDelegateSubgroup=control\n# Hosts own independent lifetimes. The daemon controls their delegated cgroups.\n# Stopping this bootstrap stops the control plane; uninstall verifies hosts are idle.\nKillMode=process\nTasksMax=infinity\nLimitNOFILE=65536\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n",
            quote(launcher)?,
            quote(data)?
        ))
    }
}
