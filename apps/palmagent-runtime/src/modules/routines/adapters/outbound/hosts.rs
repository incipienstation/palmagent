//! Retained script-host adapter. Launch is attempted once; reconciliation never replays it.
use crate::{
    modules::routines::application::{Completion, Job, Prepared},
    platform,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Hosts {
    pub data: PathBuf,
    pub release: PathBuf,
    pub node: PathBuf,
}
impl Hosts {
    fn path(&self, id: i64, suffix: &str) -> PathBuf {
        self.data.join("routines").join(format!("{id:x}.{suffix}"))
    }
    pub fn execute(&self, job: Job) -> Completion {
        match job {
            Job::Prepare {
                id,
                repo,
                worktree_id,
            } => {
                let result = (|| -> Result<Prepared> {
                    if repo.vcs == "none" {
                        return Ok(Prepared {
                            cwd: repo.path,
                            worktree: None,
                        });
                    }
                    let path = Path::new(&repo.path)
                        .join(".palmagent/worktrees")
                        .join(&worktree_id);
                    // Match existing worktree retention and local exclude behavior.
                    let exclude = Path::new(&repo.path).join(".git/info/exclude");
                    if let Ok(current) = fs::read_to_string(&exclude)
                        && !current.lines().any(|line| line == ".palmagent/")
                        && let Ok(mut file) = OpenOptions::new().append(true).open(&exclude)
                    {
                        let _ = writeln!(file, "\n.palmagent/");
                    }
                    let mut child = Command::new("git")
                        .args(["-C", &repo.path, "worktree", "add"])
                        .arg(&path)
                        .args(["-b", &format!("agent/{worktree_id}"), &repo.base])
                        .env_remove("PALMAGENT_HOST_READY")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()?;
                    let deadline = Instant::now() + Duration::from_secs(30);
                    loop {
                        if let Some(status) = child.try_wait()? {
                            ensure!(status.success(), "Cannot create isolated worktree");
                            break;
                        }
                        if Instant::now() >= deadline {
                            let _ = child.kill();
                            let _ = child.wait();
                            anyhow::bail!("Worktree creation timed out");
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    let path = path
                        .to_str()
                        .context("Worktree path must be UTF-8")?
                        .to_owned();
                    Ok(Prepared {
                        cwd: path.clone(),
                        worktree: Some(path),
                    })
                })();
                Completion::Prepared(id, result.map_err(|e| e.to_string()))
            }
            Job::Launch {
                id,
                routine_id,
                cwd,
                worktree,
                script,
            } => {
                let result = (|| -> Result<()> {
                    let mut descriptor = json!({"protocol":1,"id":format!("{id:x}"),"runId":id,"routineId":routine_id,
                        "directory":self.data.join("routines"),"release":self.release,"node":self.node,"cwd":cwd,"script":script});
                    if let Some(path) = worktree {
                        descriptor["worktreePath"] = json!(path);
                    }
                    platform::atomic(&self.path(id, "json"), &descriptor, true)?;
                    platform::daemon(
                        &self.data,
                        json!({"action":"launch","kind":"routine","id":format!("{id:x}")}),
                    )?;
                    Ok(())
                })();
                // Both failures and success proceed to inspection. An uncertain reservation
                // is retained even when the original caller never received a launch reply.
                let _ = result;
                Completion::Launched(id)
            }
            Job::Inspect {
                id,
                routine_id,
                worktree,
            } => {
                let result = (|| -> Result<Option<Value>> {
                    let descriptor = self.path(id, "json");
                    if descriptor.exists() {
                        let value: Value = platform::read(&descriptor)?;
                        ensure!(
                            value["protocol"] == 1
                                && value["id"] == format!("{id:x}")
                                && value["routineId"] == routine_id
                                && value["runId"] == id
                                && value["directory"]
                                    == self.data.join("routines").to_str().unwrap_or(""),
                            "Routine ownership mismatch"
                        );
                    }
                    let state = platform::daemon(
                        &self.data,
                        json!({"action":"inspect","kind":"routine","id":format!("{id:x}")}),
                    )?;
                    if state["alive"] != false {
                        return Ok(None);
                    }
                    let path = self.path(id, "result");
                    let mut value = if descriptor.exists() && path.exists() {
                        let value: Value = platform::read(&path)?;
                        ensure!(
                            matches!(
                                value["status"].as_str(),
                                Some("succeeded" | "failed" | "interrupted")
                            ) && value["finishedAt"].is_number(),
                            "Invalid routine result"
                        );
                        value
                    } else {
                        json!({"status":"interrupted","note":"script host ended before completion was recorded","finishedAt":platform::now()})
                    };
                    if let Some(path) = worktree {
                        value["worktreePath"] = json!(path);
                    }
                    Ok(Some(value))
                })();
                Completion::Inspected(id, result.ok().flatten())
            }
            Job::Stop { id } => Completion::Stopped(
                id,
                platform::atomic(&self.path(id, "stop"), &"interrupted by user", false).is_ok(),
            ),
            Job::Acknowledge { id } => Completion::Acknowledged(
                id,
                platform::atomic(&self.path(id, "recorded"), &"recorded", false).is_ok(),
            ),
        }
    }
}
