//! Retained command execution with a pipe lease and a separate process group.
use anyhow::{Context, Result, ensure};
use std::{
    io::{self, Read},
    os::{
        fd::AsRawFd,
        unix::process::{CommandExt, ExitStatusExt},
    },
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, AtomicI32, Ordering},
    time::{Duration, Instant},
};

static STOPPED: AtomicBool = AtomicBool::new(false);
static WAKE: AtomicI32 = AtomicI32::new(-1);
extern "C" fn signal_received(signal: libc::c_int) {
    let prior_errno = unsafe { *libc::__errno_location() };
    if signal == libc::SIGTERM || signal == libc::SIGINT {
        STOPPED.store(true, Ordering::Relaxed);
    }
    let value = 1u64;
    // write is async-signal-safe. A full eventfd is already readable.
    unsafe {
        libc::write(
            WAKE.load(Ordering::Relaxed),
            (&value as *const u64).cast(),
            8,
        );
    }
    unsafe {
        *libc::__errno_location() = prior_errno;
    }
}
fn handle(signal: libc::c_int) -> Result<()> {
    if WAKE.load(Ordering::Relaxed) < 0 {
        let fd = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
        ensure!(fd >= 0, "Cannot create script signal wakeup");
        WAKE.store(fd, Ordering::Relaxed);
    }
    // An eventfd preserves a signal arriving just before poll starts.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = signal_received as *const () as usize;
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    ensure!(
        unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } == 0,
        "Cannot install script host signal handler"
    );
    Ok(())
}
pub fn host_signals() -> Result<()> {
    STOPPED.store(false, Ordering::Relaxed);
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGCHLD] {
        handle(signal)?;
    }
    Ok(())
}
fn group(pid: u32, signal: libc::c_int) {
    if pid > 1 {
        unsafe {
            libc::kill(-(pid as i32), signal);
        }
    }
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        group(self.0.id(), libc::SIGKILL);
        let _ = self.0.wait();
    }
}
fn nonblocking(fd: libc::c_int) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    ensure!(
        flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0,
        "Cannot configure script pipe"
    );
    Ok(())
}
fn poll(descriptors: &mut [libc::pollfd], millis: i32) -> Result<()> {
    let mut waiting = descriptors.to_vec();
    waiting.push(descriptor(WAKE.load(Ordering::Relaxed)));
    let result = unsafe { libc::poll(waiting.as_mut_ptr(), waiting.len() as libc::nfds_t, millis) };
    if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
        return Err(io::Error::last_os_error().into());
    }
    descriptors.copy_from_slice(&waiting[..descriptors.len()]);
    let mut value = 0u64;
    unsafe {
        libc::read(
            WAKE.load(Ordering::Relaxed),
            (&mut value as *mut u64).cast(),
            8,
        );
    }
    Ok(())
}
fn descriptor(fd: libc::c_int) -> libc::pollfd {
    libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }
}

/// The lease closes even on SIGKILL of the host. The watchdog then kills its own
/// group, including shell descendants. The enclosing daemon guardian owns cgroup cleanup.
pub fn watchdog(command: &str) -> Result<i32> {
    ensure!(
        unsafe { libc::getpgrp() } == std::process::id() as i32,
        "Script watchdog requires its own process group"
    );
    handle(libc::SIGCHLD)?;
    nonblocking(libc::STDIN_FILENO)?;
    let mut child = match Command::new("/bin/sh")
        .args(["-c", command])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("{error}");
            return Ok(127);
        }
    };
    loop {
        let mut lease = [descriptor(libc::STDIN_FILENO)];
        poll(&mut lease, 100)?;
        if lease[0].revents != 0 {
            let mut bytes = [0u8; 64];
            let count =
                unsafe { libc::read(libc::STDIN_FILENO, bytes.as_mut_ptr().cast(), bytes.len()) };
            if count == 0
                || count < 0
                    && io::Error::last_os_error().kind() != io::ErrorKind::WouldBlock
                    && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
            {
                group(std::process::id(), libc::SIGKILL);
                std::process::exit(1);
            }
        }
        if let Some(status) = child.try_wait()? {
            if let Some(signal) = status.signal() {
                eprintln!("terminated by signal {signal}");
            }
            return Ok(status.code().unwrap_or(1));
        }
    }
}

pub struct Outcome {
    pub code: Option<i32>,
    pub reason: Option<String>,
    pub output: String,
}
fn collect(pipe: &mut impl Read, output: &mut Vec<u8>, truncated: &mut bool) -> Result<bool> {
    let mut bytes = [0u8; 16 * 1024];
    match pipe.read(&mut bytes) {
        Ok(0) => Ok(false),
        Ok(count) => {
            let keep = count.min((64 * 1024usize).saturating_sub(output.len()));
            output.extend_from_slice(&bytes[..keep]);
            *truncated |= keep < count;
            Ok(true)
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(true)
        }
        Err(error) => Err(error.into()),
    }
}
pub fn execute(
    cwd: &Path,
    command: &str,
    timeout: Duration,
    mut stop_reason: impl FnMut() -> Result<Option<String>>,
    ready: impl FnOnce() -> Result<()>,
) -> Result<Outcome> {
    let mut child = OwnedChild(
        Command::new(std::env::current_exe()?)
            .args(["script-watchdog", command])
            .current_dir(cwd)
            .process_group(0)
            .env_remove("PALMAGENT_HOST_READY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let _lease = child.0.stdin.take().context("Missing watchdog lease")?;
    let mut stdout = child.0.stdout.take().context("Missing script stdout")?;
    let mut stderr = child.0.stderr.take().context("Missing script stderr")?;
    nonblocking(stdout.as_raw_fd())?;
    nonblocking(stderr.as_raw_fd())?;
    ready()?;
    let deadline = Instant::now() + timeout;
    let mut check_stop = Instant::now();
    let mut force = None;
    let mut drained = None;
    let mut status: Option<ExitStatus> = None;
    let mut reason = None;
    let mut output = Vec::new();
    let mut truncated = false;
    let (mut out_open, mut err_open) = (true, true);
    loop {
        let now = Instant::now();
        if reason.is_none() && status.is_none() {
            let next = if STOPPED.load(Ordering::Relaxed) {
                Some("interrupted by host shutdown".into())
            } else if now >= deadline {
                Some("script timed out".into())
            } else if now >= check_stop {
                check_stop = now + Duration::from_millis(100);
                stop_reason()
                    .unwrap_or_else(|_| Some("interrupted by unavailable host storage".into()))
            } else {
                None
            };
            if let Some(next) = next {
                reason = Some(next);
                group(child.0.id(), libc::SIGTERM);
                force = Some(now + Duration::from_secs(1));
            }
        }
        if force.is_some_and(|at| now >= at) {
            group(child.0.id(), libc::SIGKILL);
            force = None;
        }
        if status.is_none()
            && let Some(exit) = child.0.try_wait()?
        {
            status = Some(exit);
            group(child.0.id(), libc::SIGKILL);
            drained = Some(now + Duration::from_secs(1));
        }
        if status.is_some() && ((!out_open && !err_open) || drained.is_some_and(|at| now >= at)) {
            break;
        }
        let mut pipes = [
            descriptor(if out_open { stdout.as_raw_fd() } else { -1 }),
            descriptor(if err_open { stderr.as_raw_fd() } else { -1 }),
        ];
        poll(&mut pipes, 50)?;
        if out_open && pipes[0].revents != 0 {
            out_open = collect(&mut stdout, &mut output, &mut truncated)?;
        }
        if err_open && pipes[1].revents != 0 {
            err_open = collect(&mut stderr, &mut output, &mut truncated)?;
        }
    }
    let status = status.context("Missing script completion")?;
    if reason.is_none()
        && let Some(signal) = status.signal()
    {
        reason = Some(format!("terminated by signal {signal}"));
    }
    let mut output = String::from_utf8_lossy(&output).into_owned();
    if truncated {
        output.push_str("\n[output truncated]");
    }
    Ok(Outcome {
        code: status.code(),
        reason,
        output,
    })
}
