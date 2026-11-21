use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub resume: bool,
    pub automatic: bool,
    pub recover_application: bool,
}

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Operation<'a> {
    Resolve,
    RefreshPlugins,
    VerifyCurrent,
    Stage,
    OpenGateway,
    Admission,
    Preferences,
    PrepareIntent,
    NeedsSwitch,
    Configure,
    Restart,
    Verify,
    Commit,
    Restore,
    RecoveryReceipt { restored: bool },
    Record { status: &'a str, reason: &'a str },
    Report { message: String },
}
pub trait Host {
    fn call(&mut self, op: Operation<'_>) -> Result<Value>;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    eligible: bool,
    has_plugins: bool,
    refresh: bool,
    keep: bool,
}

#[derive(Deserialize)]
struct Compatibility {
    live: bool,
    rollback: bool,
}

fn record(host: &mut impl Host, status: &str, reason: &str) -> Result<()> {
    host.call(Operation::Record { status, reason })?;
    Ok(())
}

fn activate(
    host: &mut impl Host,
    req: &Request,
    policy: &Compatibility,
    changed: &mut bool,
) -> Result<bool> {
    if req.resume && !policy.live {
        bail!("Interrupted release pair no longer supports handoff");
    }
    if policy.live {
        host.call(Operation::OpenGateway)?;
    }
    let block: Option<String> = serde_json::from_value(host.call(Operation::Admission)?)?;
    if let Some(reason) = block {
        record(host, "deferred", &reason)?;
        return Ok(true);
    }
    if host.call(Operation::Preferences)? != json!(true) {
        record(host, "deferred", "settings-changed")?;
        return Ok(true);
    }
    host.call(Operation::PrepareIntent)?;
    record(
        host,
        "applying",
        if policy.live {
            "handoff-activation"
        } else {
            "application-activation"
        },
    )?;
    *changed = true;
    if !req.resume || serde_json::from_value::<bool>(host.call(Operation::NeedsSwitch)?)? {
        host.call(Operation::Configure)?;
        host.call(Operation::Restart)?;
    }
    host.call(Operation::Verify)?;
    host.call(Operation::Commit)?;
    record(host, "succeeded", "application-and-executions-verified")?;
    Ok(true)
}

pub fn update(host: &mut impl Host, req: Request) -> Result<bool> {
    if !req.resume {
        let plan: Plan = serde_json::from_value(host.call(Operation::Resolve)?)?;
        if !plan.eligible {
            if req.automatic {
                record(host, "deferred", "plugin-update-required")?;
                return Ok(true);
            }
            if !plan.has_plugins {
                bail!(
                    "Crossing a compatibility line requires --plugin-manifest for each participating installed plugin"
                );
            }
        }
        if plan.refresh {
            record(host, "applying", "plugin-update")?;
            if let Err(err) = host.call(Operation::RefreshPlugins) {
                record(host, "failed", "plugin-update-failed")?;
                host.call(Operation::Report {
                    message: err.to_string(),
                })?;
                return Ok(false);
            }
        }
        if plan.keep && !req.recover_application {
            host.call(Operation::VerifyCurrent)?;
            record(
                host,
                "succeeded",
                if plan.refresh {
                    "plugins-updated"
                } else {
                    "already-current"
                },
            )?;
            return Ok(true);
        }
        record(host, "applying", "candidate-preparation")?;
    }
    let policy = match host.call(Operation::Stage) {
        Ok(v) => serde_json::from_value(v)?,
        Err(err) if req.resume => return Err(err),
        Err(err) => {
            record(host, "failed", "candidate-preparation-failed")?;
            host.call(Operation::Report {
                message: err.to_string(),
            })?;
            return Ok(false);
        }
    };
    let mut changed = false;
    match activate(host, &req, &policy, &mut changed) {
        Ok(value) => Ok(value),
        Err(err) => {
            if changed {
                let restored = policy.rollback
                    && host
                        .call(Operation::Restore)
                        .is_ok_and(|v| v == json!(true));
                host.call(Operation::RecoveryReceipt { restored })?;
            }
            record(host, "failed", "application-activation-failed")?;
            host.call(Operation::Report {
                message: err.to_string(),
            })?;
            Ok(false)
        }
    }
}
